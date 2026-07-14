/**
 * The daemon: two self-healing legs bridging the cotal mesh and a channel transport (Telegram, Slack…).
 * Channel-AGNOSTIC — it talks only to {@link Transport} + {@link Formatter} + {@link Transcriber}.
 *
 *   mesh → channel: ep.on("message") for a live DM/channel post → transport.send to every allowlisted
 *                   chat, record the sent message id → sender in the replyMap (reply-threading), then ack
 *                   (nak on a transient send failure so JetStream redelivers).
 *   channel → mesh: transport.run(onInbound) drives one normalized {@link Inbound} at a time → classify
 *                   the chat (allow/learn/ignore) → (transcribe voice) → command router OR routeInbound →
 *                   resolve the target on the roster → unicast/multicast/anycast (or reply the error back
 *                   to the chat). The bridge CANNOT spawn — a bare endpoint has no manager authority — so
 *                   an unknown/offline name fails loud to the chat.
 */
import { basename } from "node:path";
import type { CotalEndpoint, CotalMessage } from "@cotal-ai/core";
import {
  readAllowlist,
  readSticky,
  resolveFilesChannel,
  resolveFilesDir,
  writeAllowlist,
  writeSticky,
  type EndpointConfig,
} from "./config.js";
import {
  appendFileManifest,
  FILE_PART_PROTO,
  formatFileAnnouncement,
  parseFileDirective,
  saveInboundFile,
  type FileEntry,
} from "./files.js";
import { broadcastPeers, buildEndpoint, presentRoster, resolveTargetId, rolePresent, rosterNames } from "./mesh.js";
import {
  chunkMessage,
  classifyChat,
  outboundLabel,
  ReplyMap,
  routeInbound,
  textOf,
  type Action,
  type ReplyRef,
  type StickyTarget,
} from "./router.js";
import { commandMenu, parseCommand, runCommand, type CommandEnv } from "./commands.js";
import { SendError, type Inbound, type Transport } from "./transport.js";
import type { Transcriber } from "./transcribe.js";

export interface BridgeDeps {
  buildEndpoint?: (cfg: EndpointConfig) => CotalEndpoint;
  /** Injectable voice transcriber. Omitted → voice messages are skipped gracefully (logged, not fatal).
   *  Tests inject a fake. */
  transcriber?: Transcriber;
  log?: (msg: string) => void;
}

export interface BridgeHandle {
  stop(): Promise<void>;
}

export async function runBridge(
  cfg: EndpointConfig,
  transport: Transport,
  deps: BridgeDeps = {},
): Promise<BridgeHandle> {
  const log = deps.log ?? ((m: string) => console.error(`[cotal-endpoint] ${m}`));
  const ep = (deps.buildEndpoint ?? buildEndpoint)(cfg);
  const transcriber = deps.transcriber;

  const replyMap = new ReplyMap();
  // Per-chat sticky destination (dm/channel/all/anycast), loaded from disk so a restart REMEMBERS where
  // each chat last spoke; a plain line with no sticky yet defaults to @all.
  const sticky = readSticky(cfg, log);
  const allow = readAllowlist(cfg, log);
  let lastHeldLog = 0;

  // Identity smoke — fail loud early if the credential is bad; the label is a human handle for logs, and
  // the transport does its own first-run setup here (e.g. drop a stale poll backlog).
  const { label } = await transport.init();
  log(`bot ${label}`);
  log(transcriber ? "voice transcription enabled" : "voice transcription disabled (no transcriber configured)");

  // Register the `/` autocomplete menu from the ONE command table — best-effort: a channel hiccup here
  // must not stop the bridge (the commands still work; only the native menu is missing). We register on
  // BOTH the default scope AND the private-chat scope. WHY the double registration: a private-chat scope
  // OVERRIDES the default scope in DMs, so if a PRIOR bot on this credential left a stale private-scope
  // command list, our default-scope menu would be hidden in PMs. Registering our menu on the private
  // scope too guarantees PMs show the current commands regardless of a stale scoped list. (The Telegram
  // scope-precedence gotcha that caused the stale-menu bug — kept channel-agnostic via CommandScope.)
  try {
    const menu = commandMenu();
    await transport.setCommands?.(menu); // default scope (all chats)
    await transport.setCommands?.(menu, "private"); // private-chat scope — beats a stale scoped list in PMs
    log(`registered ${menu.length} bot commands (/${menu.map((c) => c.command).join(" /")})`);
  } catch (e) {
    log(`setCommands failed (menu not registered, commands still work): ${(e as Error).message}`);
  }

  // Send ONE already-chunked piece to a chat. The formatter renders it into the channel's rich format
  // (with an optional `mode`); if the transport reports the FORMATTED send was rejected for a formatting
  // reason (SendError.formatRejected — a converter bug or hostile input), it's AUTO-RETRIED as PLAIN
  // TEXT (the raw chunk, no `mode`) so a formatting bug can NEVER lose a message. This is distinct from
  // the permanent/transient split: a format-rejection is "retry-as-plain", only a plain-send failure is
  // classified permanent/transient. Returns the outcome + (on success) the message id for reply-threading.
  async function sendChunk(
    chatId: number,
    chunk: string,
    label: string | undefined,
  ): Promise<{ result: "ok"; messageId: number } | { result: "permanent" | "transient" }> {
    const rendered = transport.formatter.render(chunk, label);
    try {
      const sent = await transport.send(chatId, rendered.text, { mode: rendered.mode });
      return { result: "ok", messageId: sent.messageId };
    } catch (e) {
      // A formatted send rejected for a formatting reason → retry the SAME message as plain text.
      if (rendered.mode && e instanceof SendError && e.formatRejected) {
        log(`chat ${chatId}: formatted send rejected (${e.message}) — retrying as plain text`);
        try {
          const sent = await transport.send(chatId, chunk);
          return { result: "ok", messageId: sent.messageId };
        } catch (e2) {
          return classifySendError(chatId, e2);
        }
      }
      return classifySendError(chatId, e);
    }
  }

  function classifySendError(chatId: number, e: unknown): { result: "permanent" | "transient" } {
    if (e instanceof SendError && e.permanent) {
      log(`send to chat ${chatId} permanently rejected (${e.message}) — dropping`);
      return { result: "permanent" };
    }
    log(`send to chat ${chatId} failed (transient): ${(e as Error).message}`);
    return { result: "transient" };
  }

  // Deliver one outbound mesh line to EVERY allowlisted chat. The line is CHUNKED on its RAW text to the
  // transport's max length and each chunk is formatted INDEPENDENTLY (so a markup span split across a
  // chunk boundary degrades to literal text — a chunk can never emit a half-open tag). `label` (the
  // `<from>: ` prefix) rides the first chunk and is escaped as neutral text. Tracks per-chat outcome:
  // PERMANENT (futile to redeliver) vs TRANSIENT (worth a nak+redeliver). Partial success still ACKS.
  async function deliverToChats(
    label: string,
    body: string,
    ref: ReplyRef,
  ): Promise<{ delivered: number; permanent: number; transient: number }> {
    // OUTBOUND FILE: an agent embeds `[[file:<abs-path>]]` (optionally `[[file:<path>|<caption>]]`) to send
    // a local file back to the chat. If the transport supports uploads, strip the directive and upload the
    // file (any remaining text becomes the caption). If it DOESN'T, fall through and send the text as-is so
    // the path is at least visible — graceful degradation, never a lost message.
    const directive = parseFileDirective(body);
    if (directive && transport.sendFile) {
      return deliverFileToChats(label, directive, ref);
    }
    const chunks = chunkMessage(label + body, transport.maxLen);
    let delivered = 0;
    let permanent = 0;
    let transient = 0;
    for (const chatId of allow) {
      for (let i = 0; i < chunks.length; i++) {
        const outcome = await sendChunk(chatId, chunks[i], i === 0 ? label : undefined);
        if (outcome.result === "ok") {
          replyMap.set(chatId, outcome.messageId, ref);
          delivered++;
        } else {
          if (outcome.result === "permanent") permanent++;
          else transient++;
          break; // a failed chat won't take the remaining chunks either — stop spamming it
        }
      }
    }
    return { delivered, permanent, transient };
  }

  // Upload an agent's `[[file:…]]` to EVERY allowlisted chat via transport.sendFile. The caption is the
  // inline `|<caption>` (or the leftover text), prefixed with the same `<from>: ` label an outbound text
  // carries. Same per-chat permanent/transient bookkeeping as deliverToChats. Only called when
  // transport.sendFile exists (the fallback is handled by the caller).
  async function deliverFileToChats(
    label: string,
    directive: NonNullable<ReturnType<typeof parseFileDirective>>,
    ref: ReplyRef,
  ): Promise<{ delivered: number; permanent: number; transient: number }> {
    const captionBody = directive.caption ?? directive.rest;
    const caption = (label + (captionBody ?? "")).trimEnd() || undefined;
    let delivered = 0;
    let permanent = 0;
    let transient = 0;
    for (const chatId of allow) {
      try {
        const sent = await transport.sendFile!(chatId, { path: directive.path, caption });
        replyMap.set(chatId, sent.messageId, ref);
        delivered++;
      } catch (e) {
        const outcome = classifySendError(chatId, e);
        if (outcome.result === "permanent") permanent++;
        else transient++;
      }
    }
    return { delivered, permanent, transient };
  }

  // ── mesh → channel ───────────────────────────────────────────────────────────────────────────────
  ep.on("error", (e: Error) => log(`mesh error (self-healing): ${e.message}`));
  ep.on("message", (msg: CotalMessage, delivery: { ack(): void; nak(): void; durable: boolean }, meta: { historical: boolean; kind: "dm" | "channel" | "anycast" }) => {
    void (async () => {
      // Only live DMs and channel posts forward; skip replayed history and role work-queue messages.
      if (meta.historical || meta.kind === "anycast") {
        delivery.ack();
        return;
      }
      // Our own broadcast echoes back on the channel we joined — never send the human their own line.
      if (meta.kind === "channel" && msg.from.id === ep.card.id) {
        delivery.ack();
        return;
      }
      if (allow.size === 0) {
        // Nowhere to deliver yet — a bot can't initiate a chat. A DM is HELD unacked (no ack, no nak) so
        // JetStream's AckWait paces redelivery and it lands once a chat is bound; a channel post is
        // dropped (acked) — broadcast is best-effort and holding a busy channel would wedge the consumer.
        const now = Date.now();
        if (now - lastHeldLog > 30000) {
          const fate = meta.kind === "dm" ? "held (unacked)" : "dropped";
          log(`no chat bound — ${meta.kind} from ${msg.from.name} ${fate}; seed one (--chat <id>) or enable first-chat learning, then message the bot`);
          lastHeldLog = now;
        }
        if (meta.kind === "channel") delivery.ack();
        return;
      }
      const label = outboundLabel(msg, meta.kind);
      const body = textOf(msg);
      const { delivered, permanent, transient } = await deliverToChats(label, body, { name: msg.from.name, id: msg.from.id });
      if (delivered > 0) {
        if (permanent + transient > 0) log(`${meta.kind} delivered to ${delivered} chunk(s), ${permanent + transient} failed — acking (not redelivering, would duplicate)`);
        delivery.ack();
      } else if (transient > 0) {
        log(`${meta.kind} delivery failed (transient) to all chat(s), will redeliver`);
        delivery.nak();
      } else {
        // Every failure was PERMANENT (or there was nothing to deliver) — redelivering would nak-loop
        // forever on an unsendable message. Ack to DROP it and keep the durable consumer moving.
        log(`${meta.kind} delivery permanently rejected by all chat(s) — acking to drop (won't redeliver)`);
        delivery.ack();
      }
    })();
  });

  await ep.start();
  log(`joined space "${cfg.space}" as "${cfg.name}" (server ${cfg.server})`);

  // ── channel → mesh ───────────────────────────────────────────────────────────────────────────────
  // The SEND SIGNAL — react on the USER's inbound message so they see, with no confirmation step, where
  // it went. EVERY send carries a reaction and NOTHING ELSE (no text echo): a single-recipient route
  // (dm / anycast) gets 👀; a broadcast (@all / #channel) gets ⚡. Telegram's reaction set is FIXED —
  // 📢/📣 and keycap-digit emoji are REACTION_INVALID for a regular bot (verified live), so a broadcast's
  // count simply can't be shown; per the operator's call it's dropped rather than mirrored as a message.
  // BEST-EFFORT: a reaction failure logs and never breaks the actual routing.
  const CAST = "⚡"; // in-set, reads "fan-out"; the broadcast reaction
  async function react(chatId: number, messageId: number, emoji: string): Promise<void> {
    try {
      await transport.setReaction?.(chatId, messageId, emoji);
    } catch (e) {
      log(`setReaction ${emoji} on chat ${chatId} failed (best-effort, ignored): ${(e as Error).message}`);
    }
  }

  async function dispatch(action: Action, messageId: number): Promise<void> {
    if (action.kind === "ignore") return;
    if (action.kind === "channel") {
      await ep.multicast(action.text, { channel: action.channel });
      log(`→ #${action.channel}: ${action.text}`);
      await react(action.chatId, messageId, CAST); // broadcast → ⚡
      return;
    }
    if (action.kind === "all") {
      const peers = broadcastPeers(ep); // present, non-endpoint agents — the @all fan-out
      for (const p of peers) await ep.unicast(p.id, action.text);
      log(`→ @all (${peers.length}): ${action.text}`);
      await react(action.chatId, messageId, CAST); // broadcast → ⚡
      return;
    }
    if (action.kind === "anycast") {
      if (!rolePresent(ep, action.role)) {
        // Fail loud instead of publishing to a queue-group nobody serves (a misfired `?role` vanishes).
        await transport.send(action.chatId, `no agent with role "${action.role}" present on the mesh`);
        log(`no role "${action.role}" present — not routing`);
        return;
      }
      await ep.anycast(action.role, action.text);
      log(`→ ?${action.role} (anycast): ${action.text}`);
      await react(action.chatId, messageId, "👀"); // single responder → 👀
      return;
    }
    const tgt = resolveTargetId(ep, action.target);
    if (!tgt) {
      const present = rosterNames(ep).join(", ") || "(none)";
      await transport.send(action.chatId, `no peer "${action.target}" on the mesh — present: ${present}`);
      log(`no peer "${action.target}" — not routing`);
      return;
    }
    await ep.unicast(tgt.id, action.text);
    log(`→ @${tgt.name}: ${action.text}`);
    await react(action.chatId, messageId, "👀"); // single recipient DM → 👀
  }

  // Build the seam a slash-command handler talks through, bound to the originating chat.
  function commandEnv(chatId: number): CommandEnv {
    return {
      roster: () => presentRoster(ep),
      resolveTarget: (name) => resolveTargetId(ep, name),
      unicast: async (id, text) => {
        await ep.unicast(id, text);
      },
      multicast: async (text, channel) => {
        await ep.multicast(text, { channel });
      },
      reply: async (text) => {
        await transport.send(chatId, text);
      },
      getSticky: () => sticky.get(chatId),
      setSticky: (target: StickyTarget) => {
        sticky.set(chatId, target);
        writeSticky(cfg, sticky); // persist a /to change so a restart remembers it
      },
      identity: { name: cfg.name, space: cfg.space, server: cfg.server, defaultChannel: cfg.channel },
    };
  }

  // Announce a received file on the DEDICATED #files channel (in ADDITION to the normal sticky/@name
  // route below): append it to the local manifest AND multicast a FileEntry `data` part so any mesh
  // subscriber gets a structured, path-carrying feed of every inbound file. BOTH legs are best-effort —
  // the bytes are already safely on disk, so an announce/manifest failure only LOGS; it never naks,
  // duplicates, or breaks the primary route (publish-only — the endpoint doesn't subscribe to #files).
  async function announceFile(entry: FileEntry): Promise<void> {
    try {
      appendFileManifest(resolveFilesDir(cfg), entry);
    } catch (e) {
      log(`file manifest append failed (best-effort, ignored): ${(e as Error).message}`);
    }
    try {
      // core's multicast DISCARDS the `text` arg when `parts` is supplied (parts ?? [{text}]), so the
      // readable line MUST ride as an explicit text part — else `cotal_join("files")` live watchers get
      // an empty-text message. The text part is first (human-visible), the FileEntry data part second.
      await ep.multicast(formatFileAnnouncement(entry), {
        channel: resolveFilesChannel(cfg),
        parts: [
          { kind: "text", text: formatFileAnnouncement(entry) },
          { kind: "data", data: { proto: FILE_PART_PROTO, ...entry } },
        ],
      });
    } catch (e) {
      log(`#files announce failed (best-effort, ignored): ${(e as Error).message}`);
    }
  }

  async function handleInbound(inb: Inbound): Promise<void> {
    const chatId = inb.chatId;
    const verdict = classifyChat(chatId, allow, cfg.learnFirstChat);
    if (verdict === "ignore") {
      if (allow.size === 0) {
        // No chat is bound and first-chat learning wasn't opted into — DROP loudly rather than
        // auto-trusting whoever texted first (an enumerable bot username is reachable by strangers).
        log(`no chat bound (seed --chat <id>, or enable first-chat learning) — dropping inbound from chat ${chatId}`);
      } else {
        log(`ignoring inbound from non-allowlisted chat ${chatId}`);
      }
      return;
    }
    if (verdict === "learn") {
      allow.add(chatId);
      writeAllowlist(cfg, allow);
      log(`learned first chat ${chatId}`);
    }

    // VOICE → TEXT: an audio message is transcribed and then routed EXACTLY like a typed message — the
    // transcript becomes the effective text, so @name / reply-threading / sticky / slash-commands all
    // apply below. Returning early here (no throw) drops the update gracefully — never a crash/nak-loop.
    let text = inb.text;
    if (inb.audio) {
      if (!transcriber) {
        log(`voice received but transcription disabled — configure a transcriber to enable`);
        return;
      }
      let transcript: string;
      try {
        const { bytes, filename } = await inb.audio.fetch();
        transcript = (await transcriber.transcribe(bytes, filename)).trim();
      } catch (e) {
        // A real transcription/download error: surface it to the chat + return (the transport advances
        // its cursor regardless → no infinite redelivery).
        log(`transcription failed (chat ${chatId}): ${(e as Error).message}`);
        await transport.send(chatId, `🎙 transcription failed: ${(e as Error).message}`, {
          replyTo: inb.messageId,
        }).catch(() => {});
        return;
      }
      if (!transcript) {
        await transport.send(chatId, "🎙 (heard nothing — empty transcript)", {
          replyTo: inb.messageId,
        }).catch(() => {});
        return;
      }
      // Route the transcript through the UNIFIED path below EXACTLY like a typed message — no "🎙 heard:"
      // text mirror. The send-signal reaction (👀 dm / ⚡ broadcast) on the voice message's id IS the receipt.
      text = transcript;
    }

    // FILE (document/photo) → a SAVED path routed as text. The binary NEVER crosses the mesh: the transport
    // downloads it, the bridge saves it to the per-space downloads dir under a SAFE, collision-free name,
    // then routes a text reference `📎 <name> saved to <abs-path>` (prefixed by any caption) EXACTLY like a
    // typed message — so @name / reply-threading / sticky / the send-signal reaction all apply below. A LOCAL
    // agent can just read that path. Skipped when audio is present (voice wins). A download error is surfaced
    // to the chat + returns (the loop advances → no redelivery loop), never a crash.
    if (inb.file && !inb.audio) {
      let saved: string;
      let bytesLen: number | undefined;
      try {
        const { bytes, filename } = await inb.file.fetch();
        bytesLen = bytes.length;
        saved = saveInboundFile(resolveFilesDir(cfg), filename, bytes);
      } catch (e) {
        log(`file download/save failed (chat ${chatId}): ${(e as Error).message}`);
        await transport.send(chatId, `📎 file download failed: ${(e as Error).message}`, {
          replyTo: inb.messageId,
        }).catch(() => {});
        return;
      }
      const savedName = basename(saved);
      const captionText = inb.text.trim();
      // ADDITIVE #files feed: announce the received file (manifest + a FileEntry data-part multicast)
      // BEFORE the primary route — best-effort, never blocks or alters the sticky/@name dispatch below.
      const entry: FileEntry = {
        v: 1,
        ts: Date.now(),
        name: savedName,
        path: saved,
        size: bytesLen ?? inb.file.size,
        mime: inb.file.mimeType,
        caption: captionText || undefined,
        source: cfg.name,
        chatId,
      };
      // Fire-and-forget: the manifest append inside runs synchronously (before the first await), but the
      // multicast round-trip must NOT gate the primary sticky/@name route below if the mesh is slow.
      void announceFile(entry);
      const reference = `📎 ${savedName} saved to ${saved}`;
      text = captionText ? `${captionText}\n${reference}` : reference;
      log(`saved inbound file → ${saved}`);
    }

    const effective: Inbound = { ...inb, text };

    // REPLY-THREADING WINS over command parsing: a swipe-reply to a known agent message is a threaded
    // reply to THAT agent even if its text starts with `/` (e.g. reply "/deploy now"). A `/command` with
    // NO reply context is still a command.
    const isThreadedReply = inb.replyToId !== undefined && replyMap.get(chatId, inb.replyToId) !== undefined;

    // COMMAND ROUTER runs BEFORE the address router (unless this is a threaded reply): a leading-`/`
    // message is a command, never a routed peer message. Unknown → a /help pointer (in runCommand).
    if (!isThreadedReply) {
      const parsed = parseCommand(text);
      if (parsed) {
        log(`/${parsed.name}${parsed.args ? " " + parsed.args : ""} (chat ${chatId})`);
        await runCommand(parsed, commandEnv(chatId));
        return;
      }
    }
    const action = routeInbound(effective, { replyMap, sticky });
    await dispatch(action, effective.messageId);
    writeSticky(cfg, sticky); // a resolved route may have latched a new sticky — persist across restart
  }

  const abort = new AbortController(); // cancels the transport's inbound loop on stop()
  const loop = transport.run(handleInbound, abort.signal).catch((e) => {
    log(`inbound loop ended: ${(e as Error).message}`);
  });

  return {
    async stop() {
      abort.abort();
      await ep.stop().catch(() => {});
      await loop.catch(() => {});
    },
  };
}
