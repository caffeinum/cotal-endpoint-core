/**
 * PURE routing + sticky targets + chunking — no network, no mesh, no I/O, no channel SDK. Unit-tested.
 *
 * inbound → mesh precedence (routeInbound):
 *   1. reply-threading — the message replies to a bot message we recorded → DM the mapped agent
 *   2. leading sigil (each LATCHES the chat's sticky target):
 *        @name msg    — DM that agent
 *        @all msg     — broadcast to EVERY present (non-endpoint) peer (count = how many)
 *        #channel msg — broadcast to that channel
 *        ?role msg    — anycast to ONE agent of that role (a single answer, not N)
 *   3. sticky target — the chat's LAST destination (dm / channel / all / anycast), persisted so a
 *                      restart remembers it
 *   4. no sticky yet — default to @all (a fresh chat "just works"; a first message is never dropped)
 *
 * mesh → channel line (formatOutbound): "<from>: <text>".
 *
 * Allowlist (classifyChat): a chat is allowed (seeded or previously learned), learnable ONLY when the
 * operator opted into first-sender learning AND the list is empty, else ignored — so by default a random
 * stranger who texts the bot first is NOT auto-trusted onto your mesh.
 */
import type { CotalMessage } from "@cotal-ai/core";
import type { ButtonChoice, Inbound } from "./transport.js";

/**
 * A chat's sticky (last) destination — persisted per chat so a restart remembers it.
 *   - dm      — the last agent this chat @named / replied to
 *   - channel — the last #channel this chat broadcast to
 *   - all     — @all: every present non-endpoint peer
 *   - anycast — ?role: one agent of that role
 * `undefined` (unset) is the FIRST-EVER / forgotten case → routing defaults to @all.
 */
export type StickyTarget =
  | { kind: "dm"; name: string }
  | { kind: "channel"; channel: string }
  | { kind: "all" }
  | { kind: "anycast"; role: string };

/** Human label for a sticky target's KIND (for /here). Pure. */
export function stickyLabel(t: StickyTarget): string {
  switch (t.kind) {
    case "dm":
      return `@${t.name}`;
    case "channel":
      return `#${t.channel}`;
    case "all":
      return "📢 all";
    case "anycast":
      return `?${t.role}`;
  }
}

/** Validate an untrusted (persisted-JSON) value into a StickyTarget, or undefined if malformed. Pure —
 *  so a corrupt sticky file degrades to "no sticky" (→ @all default) instead of injecting a bad target. */
export function parseStickyTarget(v: unknown): StickyTarget | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (o.kind === "dm" && typeof o.name === "string" && o.name) return { kind: "dm", name: o.name };
  if (o.kind === "channel" && typeof o.channel === "string" && o.channel) return { kind: "channel", channel: o.channel };
  if (o.kind === "all") return { kind: "all" };
  if (o.kind === "anycast" && typeof o.role === "string" && o.role) return { kind: "anycast", role: o.role };
  return undefined;
}

/**
 * Callback-data wire format for tap-to-switch — pipe-delimited, STATELESS, ≤64 bytes (Telegram's
 * callback_data cap):
 *   sw|dm|<name> · sw|all · sw|ch|<channel> · sw|role|<role>
 *
 * Stateless is correct: a sticky target is ALWAYS re-resolved on the LIVE roster at dispatch, so a
 * departed agent is caught at send time — the callback only needs to name the target, not carry state.
 */

/** Encode a sticky target as callback-data. Throws if the result exceeds Telegram's 64-byte cap
 *  (fail loud — never silently truncate a name/channel/role into a different target). Pure. */
export function encodeSwitchTarget(t: StickyTarget): string {
  // The wire format is pipe-delimited, so a value containing "|" can't round-trip (parseSwitchData would
  // split it into the wrong number of parts). Fail loud rather than emit a button that decodes to a
  // different/undefined target. switchChoices catches this and simply drops the offending entry.
  const val = t.kind === "dm" ? t.name : t.kind === "channel" ? t.channel : t.kind === "anycast" ? t.role : undefined;
  if (val !== undefined && val.includes("|")) {
    throw new Error(`encodeSwitchTarget: "${val}" contains the "|" delimiter — cannot encode a switch target for it`);
  }
  let data: string;
  switch (t.kind) {
    case "dm":
      data = `sw|dm|${t.name}`;
      break;
    case "channel":
      data = `sw|ch|${t.channel}`;
      break;
    case "all":
      data = "sw|all";
      break;
    case "anycast":
      data = `sw|role|${t.role}`;
      break;
  }
  const bytes = Buffer.byteLength(data, "utf8");
  if (bytes > 64) {
    throw new Error(`encodeSwitchTarget: callback data is ${bytes} bytes, over Telegram's 64-byte cap: ${data}`);
  }
  return data;
}

/** Decode callback-data back into a sticky target. STRICT — any unknown prefix, wrong arity, or empty
 *  name/channel/role → undefined (never a fabricated target). Pure. */
export function parseSwitchData(data: string): StickyTarget | undefined {
  const parts = data.split("|");
  if (parts[0] !== "sw") return undefined;
  switch (parts[1]) {
    case "dm":
      if (parts.length === 3 && parts[2]) return { kind: "dm", name: parts[2] };
      return undefined;
    case "ch":
      if (parts.length === 3 && parts[2]) return { kind: "channel", channel: parts[2] };
      return undefined;
    case "all":
      if (parts.length === 2) return { kind: "all" };
      return undefined;
    case "role":
      if (parts.length === 3 && parts[2]) return { kind: "anycast", role: parts[2] };
      return undefined;
    default:
      return undefined;
  }
}

/** Build the /switch button set: one @name per present agent, then 📢 all, then #<defaultChannel>.
 *  Labels reuse stickyLabel; data reuses encodeSwitchTarget (which enforces the 64-byte cap). Pure. */
export function switchChoices(agents: { name: string }[], defaultChannel: string): ButtonChoice[] {
  const targets: StickyTarget[] = [
    ...agents.map((a): StickyTarget => ({ kind: "dm", name: a.name })),
    { kind: "all" },
    { kind: "channel", channel: defaultChannel },
  ];
  const choices: ButtonChoice[] = [];
  for (const t of targets) {
    try {
      choices.push({ label: stickyLabel(t), data: encodeSwitchTarget(t) });
    } catch {
      // An un-encodable target (name over Telegram's 64-byte cap, or containing the "|" delimiter) is
      // inherently un-switchable via a button — DROP it rather than throw and take the whole menu down
      // (the transport run-loop is poison-guarded, so a throw here would silently render zero buttons).
      // The dropped agent is still reachable via `/to <name>`.
    }
  }
  return choices;
}

export interface ReplyRef {
  name: string;
  id: string;
}

/**
 * Bounded insertion-order map: (chatId, bot message_id) → the agent it came from, for reply-threading.
 *
 * Keyed by the (chatId, message_id) PAIR — channel message ids are per-CHAT, so with >1 allowlisted
 * chat a bare-message_id key would let a swipe-reply in chat B resolve chat A's stored ref → thread to
 * the wrong agent. The composite key scopes each ref to the chat it was sent in.
 */
export class ReplyMap {
  private readonly map = new Map<string, ReplyRef>();
  constructor(private readonly cap = 1000) {}
  private key(chatId: number, messageId: number): string {
    return `${chatId}:${messageId}`;
  }
  set(chatId: number, messageId: number, ref: ReplyRef): void {
    const k = this.key(chatId, messageId);
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, ref);
    while (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
  }
  get(chatId: number, messageId: number): ReplyRef | undefined {
    return this.map.get(this.key(chatId, messageId));
  }
  get size(): number {
    return this.map.size;
  }
}

/** A sensible default max message length (Telegram's 4096) for a caller that doesn't pass one. The
 *  bridge always passes the transport's own `maxLen`; this default only serves direct callers/tests. */
export const DEFAULT_MAX = 4096;

/**
 * Split `text` into chunks no longer than `limit`. Prefers a newline boundary within the limit, else a
 * space boundary, else a hard cut — so a long agent message is delivered as multiple readable pieces
 * instead of failing (an over-limit send is typically a permanent error → would nak-loop). The boundary
 * whitespace it splits ON is consumed (not duplicated into the next chunk).
 */
export function chunkMessage(text: string, limit = DEFAULT_MAX): string[] {
  if (limit <= 0) throw new Error("chunkMessage: limit must be positive");
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut <= 0) cut = rest.lastIndexOf(" ", limit);
    const hardCut = cut <= 0;
    if (hardCut) cut = limit; // no whitespace to split on → hard cut, keep every char
    chunks.push(rest.slice(0, cut));
    // Consume the single boundary whitespace char we split on; a hard cut keeps every char.
    rest = hardCut ? rest.slice(cut) : rest.slice(cut + 1);
  }
  if (rest.length) chunks.push(rest);
  return chunks;
}

export interface RouteCtx {
  replyMap: ReplyMap;
  /** Per-chat sticky destination (last target this chat addressed — dm/channel/all/anycast). */
  sticky: Map<number, StickyTarget>;
}

/**
 * A routed inbound message.
 *   - dm      — unicast to one agent (resolved on the roster at dispatch)
 *   - channel — multicast to a channel
 *   - all     — broadcast to EVERY present non-endpoint peer (fan-out + count at dispatch)
 *   - anycast — deliver to ONE agent of a role (a single answer)
 *   - ignore  — a text-less / empty message
 */
export type Action =
  | { kind: "dm"; target: string; text: string; chatId: number }
  | { kind: "channel"; channel: string; text: string; chatId: number }
  | { kind: "all"; text: string; chatId: number }
  | { kind: "anycast"; role: string; text: string; chatId: number }
  | { kind: "ignore"; reason: string };

/** Concatenate a cotal message's parts into a display line. Text parts pass through; `data` parts are
 *  JSON-stringified; any other (extension) part is LABELLED `[<kind>]` rather than deref'ing a `.data`
 *  it doesn't have — which would JSON.stringify(undefined) → the literal "undefined". */
export function textOf(msg: CotalMessage): string {
  return msg.parts
    .map((p) => {
      if (p.kind === "text") return p.text;
      if (p.kind === "data") return JSON.stringify((p as { data: unknown }).data);
      return `[${p.kind}]`;
    })
    .join(" ");
}

/**
 * The RAW `<from>: ` / `[#channel] <from>: ` label prefixed to a mesh → channel line. Kept SEPARATE
 * from the body so the outbound formatter can escape the (untrusted) sender NAME as neutral text while
 * markdown-converting only the body (a hostile agent name like `a_b`/`*x*` can't corrupt the markup).
 */
export function outboundLabel(msg: CotalMessage, kind: "dm" | "channel" | "anycast"): string {
  const from = msg.from.name;
  if (kind === "channel" && "channel" in msg && msg.channel) return `[#${msg.channel}] ${from}: `;
  return `${from}: `;
}

/** mesh → channel line (RAW text, no formatting). Channel messages are prefixed with their channel. */
export function formatOutbound(msg: CotalMessage, kind: "dm" | "channel" | "anycast"): string {
  return outboundLabel(msg, kind) + textOf(msg);
}

export type ChatVerdict = "allow" | "learn" | "ignore";

/**
 * Decide what to do with an inbound chat.
 *   - already allowlisted → "allow"
 *   - unknown AND the list is empty AND the operator opted into first-sender learning → "learn"
 *   - otherwise → "ignore"
 *
 * `learnFirstChat` defaults to FALSE: with no seeded chat and no opt-in, an empty allowlist trusts
 * NOBODY (so a stranger who finds the enumerable bot username first can't inject onto the mesh / hijack
 * every DM). The operator opts into bootstrap-on-first-text explicitly.
 */
export function classifyChat(
  chatId: number,
  allow: ReadonlySet<number>,
  learnFirstChat = false,
): ChatVerdict {
  if (allow.has(chatId)) return "allow";
  if (allow.size === 0 && learnFirstChat) return "learn";
  return "ignore";
}

/** Turn a sticky target into the Action a plain (untagged) line routes to. Pure. */
function actionForSticky(t: StickyTarget, text: string, chatId: number): Action {
  switch (t.kind) {
    case "dm":
      return { kind: "dm", target: t.name, text, chatId };
    case "channel":
      return { kind: "channel", channel: t.channel, text, chatId };
    case "all":
      return { kind: "all", text, chatId };
    case "anycast":
      return { kind: "anycast", role: t.role, text, chatId };
  }
}

/**
 * Route one inbound message onto the mesh. EVERY resolved sigil (@name / @all / #channel / ?role) and a
 * reply-thread LATCHES the chat's sticky target, so a following plain line repeats it. An untagged line
 * with NO sticky yet defaults to @all (a fresh/forgotten chat broadcasts — never dropped, never silently
 * pinned to one agent). Returns an ignore Action for a text-less / empty message.
 */
export function routeInbound(inbound: Inbound, ctx: RouteCtx): Action {
  const chatId = inbound.chatId;
  const text = (inbound.text ?? "").trim();
  if (!text) return { kind: "ignore", reason: "empty" };

  // 1. Reply-threading (primary): the message replies to a bot message we recorded (in THIS chat).
  const replyToId = inbound.replyToId;
  if (replyToId !== undefined) {
    const ref = ctx.replyMap.get(chatId, replyToId);
    if (ref) {
      ctx.sticky.set(chatId, { kind: "dm", name: ref.name });
      return { kind: "dm", target: ref.name, text, chatId };
    }
  }

  // 2. Leading sigil — @name / @all (DM or broadcast-all), #channel (broadcast), ?role (anycast). Each
  //    latches the chat's sticky target. `@all` (case-insensitive) is the everyone keyword.
  const sigil = text.match(/^([@#?])(\S+)\s*([\s\S]*)$/);
  if (sigil) {
    const [, mark, token, rest] = sigil;
    const body = rest.trim();
    if (mark === "@") {
      if (token.toLowerCase() === "all") {
        ctx.sticky.set(chatId, { kind: "all" });
        return { kind: "all", text: body, chatId };
      }
      ctx.sticky.set(chatId, { kind: "dm", name: token });
      return { kind: "dm", target: token, text: body, chatId };
    }
    if (mark === "#") {
      ctx.sticky.set(chatId, { kind: "channel", channel: token });
      return { kind: "channel", channel: token, text: body, chatId };
    }
    // mark === "?"  → anycast to a role (one answer, not N)
    ctx.sticky.set(chatId, { kind: "anycast", role: token });
    return { kind: "anycast", role: token, text: body, chatId };
  }

  // 3. Sticky target for this chat.
  const sticky = ctx.sticky.get(chatId);
  if (sticky) return actionForSticky(sticky, text, chatId);

  // 4. No sticky yet → default to @all (a first message "just works" — broadcast, never dropped).
  return { kind: "all", text, chatId };
}
