/**
 * Hermetic checks for the ROUTING + SEND-SIGNAL layer through the bridge with fakes: where a message
 * goes (dm / #channel / @all / ?role / sticky / first-message default) and the acknowledgement the user
 * sees (👀 reaction for a single recipient; ⚡ reaction for a broadcast — no text echo). Plus sticky
 * persistence across a restart and best-effort reaction failure. Channel-agnostic.
 * `tsx --test test/signal.test.ts`.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runBridge, type EndpointConfig } from "../src/index.js";
import { agent, FakeEndpoint, FakeTransport, inbound, tick } from "./fakes.js";

function cfgIn(dir: string, over: Partial<EndpointConfig> = {}): EndpointConfig {
  return { space: "t", server: "nats://127.0.0.1:4222", name: "telegram", channel: "general", stateRoot: dir, seedChats: [42], learnFirstChat: false, ...over };
}

async function drive(dir: string, ep: FakeEndpoint, tp: FakeTransport, over: Partial<EndpointConfig> = {}) {
  const bridge = await runBridge(cfgIn(dir, over), tp, { buildEndpoint: () => ep as never, log: () => {} });
  await tick();
  await tick();
  await bridge.stop();
}

// ── DM → 👀 ────────────────────────────────────────────────────────────────────────────────────
test("@name → DM the agent + react 👀 on the user's message (no broadcast echo)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sig-"));
  const ep = new FakeEndpoint();
  ep.roster = [agent("bob")];
  const tp = new FakeTransport();
  tp.inbounds.push(inbound("@bob ship it", { messageId: 7 }));
  await drive(dir, ep, tp);
  assert.deepEqual(ep.unicasts, [{ id: "id-bob", text: "ship it" }]);
  assert.deepEqual(tp.reactions, [{ chatId: 42, messageId: 7, reaction: "👀" }], "single-recipient DM reacts 👀");
  assert.ok(!tp.sends.some((s) => s.text.startsWith("📢")), "a DM gets NO 📢 broadcast echo");
});

// ── #channel → ⚡ reaction only (no echo) ───────────────────────────────────────────────────────────
test("#channel → multicast + ⚡ reaction, NO text echo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sig-"));
  const ep = new FakeEndpoint();
  const tp = new FakeTransport();
  tp.inbounds.push(inbound("#eng deploying", { messageId: 8 }));
  await drive(dir, ep, tp);
  assert.deepEqual(ep.multicasts, [{ text: "deploying", channel: "eng" }]);
  assert.ok(!tp.sends.some((s) => s.text.startsWith("📢")), "a broadcast sends NO 📢 echo");
  assert.deepEqual(tp.reactions, [{ chatId: 42, messageId: 8, reaction: "⚡" }], "a broadcast reacts ⚡ (the only signal)");
});

// ── @all → every present agent, ⚡ reaction only ────────────────────────────────────────────────────
test("@all → unicast to EVERY present non-endpoint peer + ⚡ reaction, NO count echo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sig-"));
  const ep = new FakeEndpoint();
  // three agents + one endpoint (excluded) + one offline agent (excluded)
  ep.roster = [agent("a"), agent("b"), agent("c"), { card: { id: "id-x", name: "otherbridge", kind: "endpoint" }, status: "idle" }, agent("d", undefined, "offline")];
  const tp = new FakeTransport();
  tp.inbounds.push(inbound("@all standup", { messageId: 9 }));
  await drive(dir, ep, tp);
  assert.deepEqual(ep.unicasts.map((u) => u.id).sort(), ["id-a", "id-b", "id-c"], "went to the 3 present agents, not the endpoint/offline");
  assert.ok(ep.unicasts.every((u) => u.text === "standup"));
  assert.ok(!tp.sends.some((s) => s.text.startsWith("📢")), "no count echo — the reaction is the only signal");
  assert.deepEqual(tp.reactions, [{ chatId: 42, messageId: 9, reaction: "⚡" }], "a broadcast reacts ⚡");
});

// ── first message / no sticky → @all default ─────────────────────────────────────────────────────
test("first-ever message (no sticky, no tag) defaults to @all — a fresh chat just works", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sig-"));
  const ep = new FakeEndpoint();
  ep.roster = [agent("a"), agent("b")];
  const tp = new FakeTransport();
  tp.inbounds.push(inbound("hello team", { messageId: 1 }));
  await drive(dir, ep, tp);
  assert.deepEqual(ep.unicasts.map((u) => u.id).sort(), ["id-a", "id-b"], "a plain first message broadcasts to all present");
  assert.ok(!tp.sends.some((s) => s.text.startsWith("📢")), "no echo — ⚡ reaction only");
  assert.deepEqual(tp.reactions, [{ chatId: 42, messageId: 1, reaction: "⚡" }]);
});

test("@all with nobody present → ⚡ reaction, no unicasts, no echo (never dropped)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sig-"));
  const ep = new FakeEndpoint(); // empty roster
  const tp = new FakeTransport();
  tp.inbounds.push(inbound("@all anyone?", { messageId: 2 }));
  await drive(dir, ep, tp);
  assert.equal(ep.unicasts.length, 0);
  assert.ok(!tp.sends.some((s) => s.text.startsWith("📢")), "no echo");
  assert.deepEqual(tp.reactions, [{ chatId: 42, messageId: 2, reaction: "⚡" }], "still signals ⚡ even to 0 present");
});

// ── no-tag → last sticky ─────────────────────────────────────────────────────────────────────────
test("a plain line after @bob repeats the sticky DM (and re-reacts 👀)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sig-"));
  const ep = new FakeEndpoint();
  ep.roster = [agent("bob")];
  const tp = new FakeTransport();
  tp.inbounds.push(inbound("@bob hi", { messageId: 1 }));
  tp.inbounds.push(inbound("any update?", { messageId: 2 }));
  await drive(dir, ep, tp);
  assert.deepEqual(ep.unicasts, [
    { id: "id-bob", text: "hi" },
    { id: "id-bob", text: "any update?" },
  ], "the plain line follows the sticky DM target");
  assert.deepEqual(tp.reactions, [
    { chatId: 42, messageId: 1, reaction: "👀" },
    { chatId: 42, messageId: 2, reaction: "👀" },
  ]);
});

// ── sticky persists across a restart ─────────────────────────────────────────────────────────────
test("sticky target persists across a bridge RESTART (a plain line still hits the last @bob)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sig-"));
  // Run 1: latch @bob.
  const ep1 = new FakeEndpoint();
  ep1.roster = [agent("bob")];
  const tp1 = new FakeTransport();
  tp1.inbounds.push(inbound("@bob hi", { messageId: 1 }));
  await drive(dir, ep1, tp1);
  assert.deepEqual(ep1.unicasts, [{ id: "id-bob", text: "hi" }]);

  // Run 2: brand-new bridge over the SAME state dir → a PLAIN line must still DM bob (sticky loaded).
  const ep2 = new FakeEndpoint();
  ep2.roster = [agent("bob")];
  const tp2 = new FakeTransport();
  tp2.inbounds.push(inbound("still there?", { messageId: 2 }));
  await drive(dir, ep2, tp2);
  assert.deepEqual(ep2.unicasts, [{ id: "id-bob", text: "still there?" }], "the restarted bridge remembered the @bob sticky");
});

// ── reply-thread still wins + reacts ─────────────────────────────────────────────────────────────
test("swipe-reply to an agent's message threads back to it (highest precedence) + 👀", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sig-"));
  const ep = new FakeEndpoint();
  ep.roster = [agent("alice")];
  const tp = new FakeTransport();
  const bridge = await runBridge(cfgIn(dir), tp, { buildEndpoint: () => ep as never, log: () => {} });
  await tick();
  // alice DMs the human → the bot forwards it and records the reply-map under the sent message id.
  ep.emit("message",
    { id: "m", ts: Date.now(), space: "s", from: { id: "id-alice", name: "alice" }, parts: [{ kind: "text", text: "which env?" }], to: "me" } as never,
    { ack: () => {}, nak: () => {}, durable: true },
    { historical: false, kind: "dm" });
  await tick();
  const botMsgId = tp.nextId - 1; // the id the forwarded "alice: which env?" got
  tp.inbounds.push(inbound("prod", { messageId: 3, replyToId: botMsgId })); // a swipe-reply to that bot message
  await tick();
  await tick();
  await bridge.stop();
  assert.deepEqual(ep.unicasts, [{ id: "id-alice", text: "prod" }], "the reply threaded to alice");
  assert.ok(tp.reactions.some((r) => r.messageId === 3 && r.reaction === "👀"), "the threaded DM reacts 👀");
});

// ── best-effort reaction failure ─────────────────────────────────────────────────────────────────
test("a setReaction FAILURE is swallowed — routing still delivers the DM", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sig-"));
  const ep = new FakeEndpoint();
  ep.roster = [agent("bob")];
  const tp = new FakeTransport();
  tp.reactThrows = true; // every reaction attempt throws
  tp.inbounds.push(inbound("@bob deploy", { messageId: 5 }));
  await drive(dir, ep, tp);
  assert.deepEqual(ep.unicasts, [{ id: "id-bob", text: "deploy" }], "the DM is delivered despite the reaction throwing");
});

// ── ?role anycast (single answer) ────────────────────────────────────────────────────────────────
test("?role → anycast to ONE agent of that role + 👀 (a single answer, not N)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sig-"));
  const ep = new FakeEndpoint();
  ep.roster = [agent("r1", "reviewer"), agent("r2", "reviewer"), agent("p", "planner")];
  const tp = new FakeTransport();
  tp.inbounds.push(inbound("?reviewer look at PR", { messageId: 6 }));
  await drive(dir, ep, tp);
  assert.deepEqual(ep.anycasts, [{ service: "reviewer", text: "look at PR" }], "one anycast, not N unicasts");
  assert.equal(ep.unicasts.length, 0);
  assert.ok(tp.reactions.some((r) => r.messageId === 6 && r.reaction === "👀"), "single responder → 👀");
});

test("?role with NO present agent of that role fails loud to the chat (no silent anycast)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sig-"));
  const ep = new FakeEndpoint();
  ep.roster = [agent("p", "planner")];
  const tp = new FakeTransport();
  tp.inbounds.push(inbound("?reviewer anyone", { messageId: 4 }));
  await drive(dir, ep, tp);
  assert.equal(ep.anycasts.length, 0, "must NOT anycast to a role nobody serves");
  assert.ok(tp.sends.some((s) => /no agent with role "reviewer" present/.test(s.text)), "fails loud to the chat");
});
