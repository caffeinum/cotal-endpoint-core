/**
 * The channel-agnostic transport seam. A concrete channel (Telegram, Slack, Discord, SMS…) implements
 * {@link Transport} + {@link Formatter}; everything else in this package (routing, sticky targets, the
 * command layer, the bridge orchestration) is written against these interfaces and never imports a
 * channel SDK. The existing Telegram tests fake this seam, so a factoring is correct iff the generic
 * suite still passes against a fake transport.
 */

/** A rendered outbound message: the wire `text` plus an optional channel-specific `mode` (e.g. Telegram
 *  "HTML"). `mode` undefined → send as plain text with no formatting directive. */
export interface RenderedMessage {
  text: string;
  mode?: string;
}

/**
 * Render agent markdown into the channel's rich format (+ a neutral, escaped label prefix). PURE — no
 * I/O. The bridge converts each ALREADY-CHUNKED piece independently, so a span split across a chunk
 * boundary degrades to literal text on each side (a chunk can never emit a half-open tag). A formatter
 * that returns a `mode` opts the send into rich formatting; the bridge auto-retries as plain text if the
 * transport reports the formatted send was rejected for a formatting reason ({@link SendError.formatRejected}).
 */
export interface Formatter {
  /** `label` (the `<from>: ` prefix) is passed only for the first chunk of a message; it must be rendered
   *  as neutral, escaped text (a hostile agent name can't corrupt the markup). */
  render(chunk: string, label: string | undefined): RenderedMessage;
}

/** A `{command, description}` entry for the channel's slash-command menu. */
export interface CommandDesc {
  command: string;
  description: string;
}

/**
 * WHERE a command menu is registered. Channel-agnostic:
 *   - "default" (or undefined) — the catch-all scope.
 *   - "private" — the direct-message / private-chat scope. The bridge registers on BOTH so a stale
 *     private-scope list can't override (and hide) the default menu in PMs (see the bridge's command
 *     registration + the Telegram scope-precedence note).
 * The transport maps these to the channel's native scope object (Telegram BotCommandScope, etc.).
 */
export type CommandScope = "default" | "private";

/** Voice/audio attached to an inbound message. The DOWNLOAD stays in the transport (channel-specific);
 *  core only orchestrates transcription through this thunk, so the flow is channel-agnostic. */
export interface AudioRef {
  /** Fetch the raw audio bytes + a filename whose extension hints the container to the transcriber. */
  fetch(): Promise<{ bytes: Uint8Array; filename: string }>;
}

/** A document/photo attached to an inbound message. Like {@link AudioRef}, the DOWNLOAD stays in the
 *  transport (channel-specific) — core only orchestrates the save through this thunk, so the flow is
 *  channel-agnostic. The bridge writes the fetched bytes to a per-space downloads dir and routes a
 *  text reference to the mesh so a LOCAL agent can just read the saved path (no binary crosses the mesh). */
export interface FileRef {
  /** Fetch the raw file bytes + a filename (used as the download's basename after sanitization). */
  fetch(): Promise<{ bytes: Uint8Array; filename: string }>;
  /** The claimed filename (the transport's best label — sanitized before use as a path). */
  filename: string;
  /** The declared MIME type, if the channel provides one (informational). */
  mimeType?: string;
  /** The declared byte size, if the channel provides one (informational). */
  size?: number;
}

/**
 * One inbound message, normalized by the transport from its native update shape.
 *   - `text` is "" for a pure-voice message (core splices the transcript in before routing).
 *   - `replyToId` is the id of the message this replies to (for reply-threading), if any.
 *   - `audio` carries voice for transcription (undefined for a plain text message).
 *   - `file` carries a document/photo (undefined for a message with no attachment). A caption becomes `text`.
 */
export interface Inbound {
  chatId: number;
  userId?: number;
  messageId: number;
  text: string;
  replyToId?: number;
  audio?: AudioRef;
  file?: FileRef;
}

/**
 * The channel transport. Owns its OWN inbound loop (long-poll / websocket / webhook) via {@link run},
 * and exposes the send/react/commands/typing primitives the bridge drives. The Formatter + max message
 * length ride on the transport so the bridge stays channel-agnostic.
 */
export interface Transport {
  /** Renders agent markdown into this channel's format. */
  readonly formatter: Formatter;
  /** Hard per-message length limit — the bridge chunks outbound text to this. */
  readonly maxLen: number;
  /** Identity smoke: fail loud early on a bad credential, and return a human label for logging (e.g.
   *  "@mybot (id 123)"). Also the transport's chance to do first-run setup (drop a stale poll backlog). */
  init(): Promise<{ label: string }>;
  /** Send one message to a chat. Throws {@link SendError} on failure so the bridge can classify it. */
  send(chatId: number, text: string, opts?: { mode?: string; replyTo?: number }): Promise<{ messageId: number }>;
  /** Set (or, with `undefined`, clear) a single reaction on a message. Best-effort at the call site. */
  setReaction?(chatId: number, messageId: number, reaction: string | undefined): Promise<void>;
  /** Register the channel's command menu at a scope (default when omitted). Best-effort at the call site. */
  setCommands?(cmds: CommandDesc[], scope?: CommandScope): Promise<void>;
  /** Upload a LOCAL file (read from `opts.path`) to a chat, with an optional filename + caption. Optional
   *  like {@link setReaction}/{@link setCommands} — a channel without file upload simply omits it, and the
   *  bridge falls back to sending the agent's `[[file:…]]` text as-is. Throws {@link SendError} on failure. */
  sendFile?(chatId: number, opts: { path: string; filename?: string; caption?: string }): Promise<{ messageId: number }>;
  /** Signal "typing…" to a chat (optional; not all channels support it). */
  setTyping?(chatId: number): Promise<void>;
  /**
   * Own the inbound loop. Drive `onInbound` once per normalized message and advance the transport's
   * internal cursor after each — POISON-GUARDED: a throwing `onInbound` is logged and skipped, never
   * wedging the loop. Resolve/return when `signal` aborts (so bridge.stop() doesn't block).
   */
  run(onInbound: (inbound: Inbound) => Promise<void>, signal: AbortSignal): Promise<void>;
}

/**
 * A transport send failure, classified so the bridge's ack/nak logic is channel-agnostic:
 *   - `permanent` — retrying/redelivering is futile (a 4xx like bad-request/blocked/not-found); the
 *     bridge ACKS to drop it rather than nak-looping forever.
 *   - `formatRejected` — the FORMATTED send was rejected for a formatting reason (a converter bug or
 *     hostile input); the bridge retries the SAME message as plain text (no `mode`) so a formatting
 *     glitch can never lose a message. Only meaningful when the send used a `mode`.
 * A non-permanent, non-format failure (rate-limit / 5xx / network) → transient → the bridge NAKS for
 * redelivery. A thrown error that is NOT a SendError is treated as transient.
 */
export class SendError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
    readonly formatRejected = false,
  ) {
    super(message);
    this.name = "SendError";
  }
}
