/**
 * Hermetic checks for the bridge ORCHESTRATION (src/bridge.ts) with a fake Transport + fake cotal
 * endpoint: allowlist gating, mesh → channel delivery + reply-map, the endpoint's own-echo filter,
 * partial/permanent/transient ack-nak, chunking, the format-rejection plain-retry, and reply-threading
 * over command parsing. Channel-agnostic (no Telegram). `tsx --test test/bridge.test.ts`.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { CotalMessage } from "@cotal-ai/core";
import { runBridge, SendError, type EndpointConfig } from "../src/index.js";
import { FakeEndpoint, FakeTransport, inbound, richFormatter, tick } from "./fakes.js";

function cfgIn(dir: string, over: Partial<EndpointConfig> = {}): EndpointConfig {
  return { space: "t", server: "nats://127.0.0.1:4222", name: "telegram", channel: "general", stateRoot: dir, seedChats: [], learnFirstChat: false, ...over };
}

const dm = (from: string, text: string): CotalMessage =>
  ({ id: "m1", ts: Date.now(), space: "s", from: { id: "id-" + from, name: from }, parts: [{ kind: "text", text }], to: "me" }) as CotalMessage;

// ── allowlist gating ──────────────────────────────────────────────────────────────────────────────
test("with first-chat learning, first sender is learned + a later stranger is dropped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ep-"));
  const ep = new FakeEndpoint();
  ep.roster = [{ card: { id: "id-bob", name: "bob" }, status: "idle" }];
  const tp = new FakeTransport();
  tp.inbounds.push(inbound("@bob hi", { chatId: 42, userId: 42 }));
  tp.inbounds.push(inbound("@bob sneaky", { chatId: 77, userId: 77, messageId: 2 }));
  const bridge = await runBridge(cfgIn(dir, { learnFirstChat: true }), tp, { buildEndpoint: () => ep as never, log: () => {} });
  await tick();
  await tick();
  await bridge.stop();
  assert.equal(ep.unicasts.length, 1);
  assert.deepEqual(ep.unicasts[0], { id: "id-bob", text: "hi" });
});

test("DEFAULT (no opt-in, no seed) does NOT auto-trust the first sender", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ep-"));
  const ep = new FakeEndpoint();
  ep.roster = [{ card: { id: "id-bob", name: "bob" }, status: "idle" }];
  const tp = new FakeTransport();
  tp.inbounds.push(inbound("@bob hi", { chatId: 42, userId: 42 }));
  const bridge = await runBridge(cfgIn(dir), tp, { buildEndpoint: () => ep as never, log: () => {} });
  await tick();
  await tick();
  await bridge.stop();
  assert.equal(ep.unicasts.length, 0); // unknown chat, no learning → dropped
});

test("seeded chat routes without any learning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ep-"));
  const ep = new FakeEndpoint();
  ep.roster = [{ card: { id: "id-bob", name: "bob" }, status: "idle" }];
  const tp = new FakeTransport();
  tp.inbounds.push(inbound("@bob hi", { chatId: 42, userId: 42 }));
  const bridge = await runBridge(cfgIn(dir, { seedChats: [42] }), tp, { buildEndpoint: () => ep as never, log: () => {} });
  await tick();
  await tick();
  await bridge.stop();
  assert.deepEqual(ep.unicasts, [{ id: "id-bob", text: "hi" }]);
});

// ── mesh → channel ────────────────────────────────────────────────────────────────────────────────
test("mesh DM → channel send + records reply-map", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ep-"));
  const ep = new FakeEndpoint();
  const tp = new FakeTransport();
  const bridge = await runBridge(cfgIn(dir, { seedChats: [42] }), tp, { buildEndpoint: () => ep as never, log: () => {} });
  await tick();
  let acked = false;
  ep.emit("message", dm("alice", "PR is up"), { ack: () => { acked = true; }, nak: () => {}, durable: true }, { historical: false, kind: "dm" });
  await tick();
  await bridge.stop();
  const delivered = tp.sends.find((s) => s.chatId === 42 && s.text === "alice: PR is up");
  assert.ok(delivered, "expected 'alice: PR is up' delivered to seeded chat 42");
  assert.ok(acked, "expected the DM to be acked after delivery");
});

test("channel post forwards; the endpoint's OWN echo is filtered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ep-"));
  const ep = new FakeEndpoint(); // card.id = "telegram-id"
  const tp = new FakeTransport();
  const bridge = await runBridge(cfgIn(dir, { seedChats: [42] }), tp, { buildEndpoint: () => ep as never, log: () => {} });
  await tick();
  const chan = { id: "c1", ts: Date.now(), space: "s", from: { id: "id-alice", name: "alice" }, parts: [{ kind: "text", text: "deploying" }], channel: "general" } as CotalMessage;
  let ack1 = false;
  ep.emit("message", chan, { ack: () => { ack1 = true; }, nak: () => {}, durable: true }, { historical: false, kind: "channel" });
  const echo = { id: "c2", ts: Date.now(), space: "s", from: { id: "telegram-id", name: "telegram" }, parts: [{ kind: "text", text: "human broadcast" }], channel: "general" } as CotalMessage;
  let ack2 = false;
  ep.emit("message", echo, { ack: () => { ack2 = true; }, nak: () => {}, durable: true }, { historical: false, kind: "channel" });
  await tick();
  await bridge.stop();
  assert.deepEqual(tp.sends.filter((s) => s.chatId === 42).map((s) => s.text), ["[#general] alice: deploying"]);
  assert.ok(ack1 && ack2, "both channel messages acked (forwarded one + filtered echo)");
});

test("partial multi-chat send ACKS (no nak → delivered chat isn't duplicated on redelivery)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ep-"));
  const ep = new FakeEndpoint();
  const tp = new FakeTransport();
  // chat 99 always fails; chat 42 succeeds.
  tp.sendImpl = async (chatId: number, text: string) => {
    if (chatId === 99) throw new SendError("blocked in chat 99", true);
    tp.sends.push({ chatId, text });
    return { messageId: tp.nextId++ };
  };
  const bridge = await runBridge(cfgIn(dir, { seedChats: [42, 99] }), tp, { buildEndpoint: () => ep as never, log: () => {} });
  await tick();
  let acked = false;
  let naked = false;
  ep.emit("message", dm("alice", "PR up"), { ack: () => { acked = true; }, nak: () => { naked = true; }, durable: true }, { historical: false, kind: "dm" });
  await tick();
  await bridge.stop();
  assert.ok(acked, "≥1 chat delivered → ack");
  assert.ok(!naked, "must NOT nak — redelivery would double-surface the delivered chat");
  assert.equal(tp.sends.filter((s) => s.chatId === 42).length, 1, "chat 42 got exactly one copy");
});

test("a >maxLen outbound DM is chunked into multiple sends", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ep-"));
  const ep = new FakeEndpoint();
  const tp = new FakeTransport();
  const bridge = await runBridge(cfgIn(dir, { seedChats: [42] }), tp, { buildEndpoint: () => ep as never, log: () => {} });
  await tick();
  let acked = false;
  const huge = "z".repeat(9000); // formatOutbound prepends "alice: " → well over two 4096 chunks
  ep.emit("message", dm("alice", huge), { ack: () => { acked = true; }, nak: () => {}, durable: true }, { historical: false, kind: "dm" });
  await tick();
  await bridge.stop();
  const toChat = tp.sends.filter((s) => s.chatId === 42);
  assert.ok(toChat.length >= 3, `expected ≥3 chunks for a 9000-char body, got ${toChat.length}`);
  assert.ok(toChat.every((s) => s.text.length <= 4096), "no chunk exceeds the 4096 limit");
  assert.ok(acked, "chunked delivery acks");
});

test("a PERMANENT send rejection ACKS-and-drops (no infinite redelivery)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ep-"));
  const ep = new FakeEndpoint();
  const tp = new FakeTransport();
  tp.sendImpl = async () => { throw new SendError("chat not found", true); };
  const bridge = await runBridge(cfgIn(dir, { seedChats: [42] }), tp, { buildEndpoint: () => ep as never, log: () => {} });
  await tick();
  let acked = false;
  let naked = false;
  ep.emit("message", dm("alice", "PR up"), { ack: () => { acked = true; }, nak: () => { naked = true; }, durable: true }, { historical: false, kind: "dm" });
  await tick();
  await bridge.stop();
  assert.ok(acked, "a permanent rejection must ACK to drop the unsendable message");
  assert.ok(!naked, "must NOT nak — that would redeliver an unsendable message forever");
});

test("a TRANSIENT send failure NAKS for redelivery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ep-"));
  const ep = new FakeEndpoint();
  const tp = new FakeTransport();
  tp.sendImpl = async () => { throw new SendError("internal", false); };
  const bridge = await runBridge(cfgIn(dir, { seedChats: [42] }), tp, { buildEndpoint: () => ep as never, log: () => {} });
  await tick();
  let acked = false;
  let naked = false;
  ep.emit("message", dm("alice", "PR up"), { ack: () => { acked = true; }, nak: () => { naked = true; }, durable: true }, { historical: false, kind: "dm" });
  await tick();
  await bridge.stop();
  assert.ok(naked, "a transient failure must nak for redelivery");
  assert.ok(!acked, "must not ack a transient failure (it would drop a deliverable message)");
});

test("a FORMATTED send that is format-rejected is auto-retried as PLAIN (no mode), never dropped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ep-"));
  const ep = new FakeEndpoint();
  const tp = new FakeTransport(richFormatter());
  const calls: { text: string; mode?: string }[] = [];
  // The FIRST attempt (with a mode) is format-rejected; the PLAIN retry (no mode) succeeds.
  tp.sendImpl = async (_chatId: number, text: string, opts?: { mode?: string }) => {
    calls.push({ text, mode: opts?.mode });
    if (opts?.mode) throw new SendError("can't parse entities", true, /* formatRejected */ true);
    return { messageId: tp.nextId++ };
  };
  const bridge = await runBridge(cfgIn(dir, { seedChats: [42] }), tp, { buildEndpoint: () => ep as never, log: () => {} });
  await tick();
  let acked = false;
  let naked = false;
  ep.emit("message", dm("alice", "done **now**"), { ack: () => { acked = true; }, nak: () => { naked = true; }, durable: true }, { historical: false, kind: "dm" });
  await tick();
  await bridge.stop();
  assert.equal(calls.length, 2, "one rich attempt + one plain retry");
  assert.equal(calls[0].mode, "RICH", "first attempt uses the formatter's mode");
  assert.equal(calls[1].mode, undefined, "the retry OMITS the mode (plain text)");
  assert.equal(calls[1].text, "alice: done **now**", "the plain retry sends the RAW chunk, not the rendered form");
  assert.ok(acked, "the retried-plain delivery acks — the message is NOT lost to a format 400");
  assert.ok(!naked, "must not nak (it was delivered on the plain retry)");
});

test("a `/`-leading swipe-reply threads to the agent instead of command-parsing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ep-"));
  const ep = new FakeEndpoint();
  ep.roster = [{ card: { id: "id-alice", name: "alice" }, status: "idle" }];
  const tp = new FakeTransport();
  const bridge = await runBridge(cfgIn(dir, { seedChats: [42] }), tp, { buildEndpoint: () => ep as never, log: () => {} });
  await tick();
  // alice DMs the human → recorded in the reply map under (chat 42, the bot's sent message id).
  ep.emit("message", dm("alice", "which env?"), { ack: () => {}, nak: () => {}, durable: true }, { historical: false, kind: "dm" });
  await tick();
  const sent = tp.sends.find((s) => s.chatId === 42);
  assert.ok(sent, "expected the outbound to chat 42");
  const botMsgId = tp.nextId - 1; // the message id send returned for that outbound
  // Human swipe-replies with text that STARTS WITH `/` — must thread to alice, not parse as a command.
  tp.inbounds.push(inbound("/deploy now", { chatId: 42, messageId: 500, replyToId: botMsgId }));
  await tick();
  await tick();
  await bridge.stop();
  assert.deepEqual(ep.unicasts, [{ id: "id-alice", text: "/deploy now" }], "the /-leading reply threads to alice verbatim");
  assert.ok(!tp.sends.some((s) => /unknown command/.test(s.text)), "must NOT reply an unknown-command pointer");
});
