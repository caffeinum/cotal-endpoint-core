/**
 * Shared hermetic fakes for the endpoint-core suite: a fake cotal endpoint + a fake channel Transport,
 * so the whole routing / send-signal / command / voice chain is exercised with no network, no mesh, no
 * real channel. (This file is NOT a `*.test.ts`, so the runner never treats it as a test.)
 */
import { EventEmitter } from "node:events";
import type {
  ButtonChoice,
  CallbackQuery,
  CommandDesc,
  CommandScope,
  Formatter,
  Inbound,
  RenderedMessage,
  Transport,
} from "../src/index.js";

/** A mesh message part, mirroring @cotal-ai/core's `Part` closely enough for the fake to record. */
type Part = { kind: string; [key: string]: unknown };

/** A roster row shaped like a cotal Presence: card.{id,name,kind?,role?} + status. */
export interface Row {
  card: { id: string; name: string; kind?: "agent" | "endpoint"; role?: string };
  status: string;
}
export const agent = (name: string, role?: string, status = "idle"): Row => ({
  card: { id: "id-" + name, name, kind: "agent", role },
  status,
});

/** A fake CotalEndpoint: records unicast/multicast/anycast and lets a test emit inbound mesh messages. */
export class FakeEndpoint extends EventEmitter {
  card = { id: "telegram-id", name: "telegram", kind: "endpoint" as const };
  roster: Row[] = [];
  unicasts: { id: string; text: string; parts?: Part[] }[] = [];
  multicasts: { text: string; channel?: string; parts?: Part[] }[] = [];
  anycasts: { service: string; text: string }[] = [];
  /** Legacy accessor mirroring the old fake's `sent.{unicast,multicast}` shape. */
  get sent() {
    return { unicast: this.unicasts, multicast: this.multicasts };
  }
  getRoster() {
    return this.roster as never;
  }
  async start() {}
  async stop() {}
  async unicast(id: string, text: string, opts?: { parts?: Part[] }) {
    // Only attach `parts` when present so existing deepEqual assertions on {id,text} still hold (a strict
    // deepEqual distinguishes an own `parts: undefined` key from a missing one) — mirrors multicast.
    const rec: { id: string; text: string; parts?: Part[] } = { id, text };
    if (opts?.parts) rec.parts = opts.parts;
    this.unicasts.push(rec);
    return {} as never;
  }
  async multicast(text: string, opts?: { channel?: string; parts?: Part[] }) {
    // Only attach `parts` when present so existing deepEqual assertions on {text,channel} still hold
    // (a strict deepEqual distinguishes an own `parts: undefined` key from a missing one).
    const rec: { text: string; channel?: string; parts?: Part[] } = { text, channel: opts?.channel };
    if (opts?.parts) rec.parts = opts.parts;
    this.multicasts.push(rec);
    return {} as never;
  }
  async anycast(service: string, text: string) {
    this.anycasts.push({ service, text });
    return {} as never;
  }
}

/** An identity formatter (plain text, no mode) — the default for bridge orchestration tests. */
export const plainFormatter: Formatter = {
  render(chunk: string): RenderedMessage {
    return { text: chunk };
  },
};

/** A "rich" formatter that converts **bold** → <b>bold</b> and sets a `mode` — for the format-retry path.
 *  The label (if present and leading) is kept literal so the "<from>: " prefix stays neutral. */
export function richFormatter(): Formatter {
  const md = (s: string) => s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  return {
    render(chunk: string, label: string | undefined): RenderedMessage {
      if (label !== undefined && chunk.startsWith(label)) {
        return { text: label + md(chunk.slice(label.length)), mode: "RICH" };
      }
      return { text: md(chunk), mode: "RICH" };
    },
  };
}

/**
 * A fake channel Transport. Queue {@link inbounds} to drive the channel → mesh leg; records sends,
 * reactions, and command registrations. `run` polls the queue (like a long-poll) until the signal aborts,
 * and is POISON-GUARDED (a throwing handler is swallowed, mirroring the real transport loops).
 */
export class FakeTransport implements Transport {
  formatter: Formatter;
  maxLen = 4096;
  inbounds: Inbound[] = [];
  sends: { chatId: number; text: string; mode?: string; replyTo?: number }[] = [];
  fileSends: { chatId: number; path: string; filename?: string; caption?: string }[] = [];
  reactions: { chatId: number; messageId: number; reaction: string | undefined }[] = [];
  commandsSet: { cmds: CommandDesc[]; scope?: CommandScope }[] = [];
  /** Recorders for the inline-keyboard / callback capability (the /switch flow). */
  buttonSends: { chatId: number; prompt: string; choices: ButtonChoice[]; messageId: number }[] = [];
  edits: { chatId: number; messageId: number; text: string; mode?: string }[] = [];
  answered: { callbackId: string; text?: string }[] = [];
  /** Queue driven through run()'s 3rd arg (onCallback), like {@link inbounds} for the inbound leg. */
  callbacks: CallbackQuery[] = [];
  nextId = 1000;
  label = "@candlestick_dev_bot (id 1)";
  reactThrows = false;
  /** Override to simulate send failures (throw a SendError) or record with custom shape. */
  sendImpl?: (chatId: number, text: string, opts?: { mode?: string; replyTo?: number }) => Promise<{ messageId: number }>;
  /** Optional file upload — records into {@link fileSends}. Set to `undefined` in a test to simulate a
   *  transport with NO upload support (the bridge's graceful text-fallback path). Override to throw. */
  sendFile?: (chatId: number, opts: { path: string; filename?: string; caption?: string }) => Promise<{ messageId: number }> = async (
    chatId,
    opts,
  ) => {
    this.fileSends.push({ chatId, ...opts });
    return { messageId: this.nextId++ };
  };

  constructor(formatter: Formatter = plainFormatter) {
    this.formatter = formatter;
  }
  async init() {
    return { label: this.label };
  }
  async send(chatId: number, text: string, opts?: { mode?: string; replyTo?: number }) {
    if (this.sendImpl) return this.sendImpl(chatId, text, opts);
    this.sends.push({ chatId, text, mode: opts?.mode, replyTo: opts?.replyTo });
    return { messageId: this.nextId++ };
  }
  async setReaction(chatId: number, messageId: number, reaction: string | undefined) {
    if (this.reactThrows) throw new Error("setReaction failed: REACTION_INVALID");
    this.reactions.push({ chatId, messageId, reaction });
  }
  async setCommands(cmds: CommandDesc[], scope?: CommandScope) {
    this.commandsSet.push({ cmds, scope });
  }
  async sendButtons(chatId: number, prompt: string, choices: ButtonChoice[]) {
    const messageId = this.nextId++;
    this.buttonSends.push({ chatId, prompt, choices, messageId });
    return { messageId };
  }
  async editText(chatId: number, messageId: number, text: string, opts?: { mode?: string }) {
    this.edits.push({ chatId, messageId, text, mode: opts?.mode });
  }
  async answerCallback(callbackId: string, opts?: { text?: string }) {
    this.answered.push({ callbackId, text: opts?.text });
  }
  async run(
    onInbound: (i: Inbound) => Promise<void>,
    signal: AbortSignal,
    onCallback?: (cb: CallbackQuery) => Promise<void>,
  ) {
    while (!signal.aborted) {
      const inb = this.inbounds.shift();
      if (inb) {
        try {
          await onInbound(inb);
        } catch {
          // poison-guard: a throwing handler must not wedge the loop
        }
        continue;
      }
      // A callback (button tap) is delivered under the SAME poison-guard. Only drained when a caller
      // passed onCallback (a 2-arg caller never invokes it — mirrors the real transport).
      if (onCallback && this.callbacks.length) {
        const cb = this.callbacks.shift()!;
        try {
          await onCallback(cb);
        } catch {
          // poison-guard
        }
        continue;
      }
      await new Promise((r) => setTimeout(r, 5)); // idle like an empty long-poll
    }
  }
}

/** Build an Inbound (channel-agnostic) — the fake-transport analogue of the old `upd()`. */
export function inbound(text: string, over: Partial<Inbound> = {}): Inbound {
  return { chatId: 42, messageId: over.messageId ?? 1, userId: 42, text, ...over };
}

/** Build a file (document/photo) Inbound: a `file` FileRef whose fetch() returns canned bytes + the given
 *  filename. `text` is the caption (default ""); `fetched` counts downloads. Channel-agnostic. */
export function fileInbound(
  filename: string,
  over: Partial<Inbound> = {},
  bytes: Uint8Array = new Uint8Array([1, 2, 3]),
  fetched = { n: 0 },
): Inbound {
  return {
    chatId: 42,
    messageId: over.messageId ?? 1,
    userId: 42,
    text: over.text ?? "",
    file: {
      filename,
      async fetch() {
        fetched.n++;
        return { bytes, filename };
      },
    },
    ...over,
  };
}

export const tick = () => new Promise((r) => setTimeout(r, 30));
