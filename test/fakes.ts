/**
 * Shared hermetic fakes for the endpoint-core suite: a fake cotal endpoint + a fake channel Transport,
 * so the whole routing / send-signal / command / voice chain is exercised with no network, no mesh, no
 * real channel. (This file is NOT a `*.test.ts`, so the runner never treats it as a test.)
 */
import { EventEmitter } from "node:events";
import type {
  CommandDesc,
  CommandScope,
  Formatter,
  Inbound,
  RenderedMessage,
  Transport,
} from "../src/index.js";

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
  unicasts: { id: string; text: string }[] = [];
  multicasts: { text: string; channel?: string }[] = [];
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
  async unicast(id: string, text: string) {
    this.unicasts.push({ id, text });
    return {} as never;
  }
  async multicast(text: string, opts?: { channel?: string }) {
    this.multicasts.push({ text, channel: opts?.channel });
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
  reactions: { chatId: number; messageId: number; reaction: string | undefined }[] = [];
  commandsSet: { cmds: CommandDesc[]; scope?: CommandScope }[] = [];
  nextId = 1000;
  label = "@candlestick_dev_bot (id 1)";
  reactThrows = false;
  /** Override to simulate send failures (throw a SendError) or record with custom shape. */
  sendImpl?: (chatId: number, text: string, opts?: { mode?: string; replyTo?: number }) => Promise<{ messageId: number }>;

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
  async run(onInbound: (i: Inbound) => Promise<void>, signal: AbortSignal) {
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
      await new Promise((r) => setTimeout(r, 5)); // idle like an empty long-poll
    }
  }
}

/** Build an Inbound (channel-agnostic) — the fake-transport analogue of the old `upd()`. */
export function inbound(text: string, over: Partial<Inbound> = {}): Inbound {
  return { chatId: 42, messageId: over.messageId ?? 1, userId: 42, text, ...over };
}

export const tick = () => new Promise((r) => setTimeout(r, 30));
