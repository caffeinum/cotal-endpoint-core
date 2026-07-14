/**
 * Hermetic checks for voice-message transcription → mesh routing through the bridge. A fake Transcriber
 * returns a canned transcript and a fake inbound carries an `audio` thunk, so the whole voice →
 * transcribe → route chain is unit-testable with no network. Channel-agnostic (the real Groq request
 * shape + the .oga→.ogg filename fix are Telegram-package tests). `tsx --test test/transcribe.test.ts`.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runBridge, type EndpointConfig, type Inbound, type Transcriber } from "../src/index.js";
import { FakeEndpoint, FakeTransport, tick } from "./fakes.js";

function cfgIn(dir: string, over: Partial<EndpointConfig> = {}): EndpointConfig {
  return { space: "t", server: "nats://127.0.0.1:4222", name: "telegram", channel: "general", stateRoot: dir, seedChats: [42], learnFirstChat: false, ...over };
}

const fakeTranscriber = (text: string): Transcriber => ({ async transcribe() { return text; } });
const throwingTranscriber = (msg: string): Transcriber => ({ async transcribe() { throw new Error(msg); } });

/** A voice inbound from chat 42 — an `audio` thunk that records how many times it was fetched. */
const voiceInbound = (over: Partial<Inbound> = {}, fetched = { n: 0 }): Inbound => ({
  chatId: 42,
  messageId: over.messageId ?? 1,
  userId: 42,
  text: "",
  audio: {
    async fetch() {
      fetched.n++;
      return { bytes: new Uint8Array([1, 2, 3]), filename: "voice/file.ogg" };
    },
  },
  ...over,
});

test("voice message: transcript '@x hi' routes as a DM to x AND reacts 👀 (no 🎙 heard mirror)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "voice-"));
  const ep = new FakeEndpoint();
  ep.roster = [{ card: { id: "id-x", name: "x" }, status: "idle" }];
  const tp = new FakeTransport();
  const fetched = { n: 0 };
  tp.inbounds.push(voiceInbound({}, fetched));
  const bridge = await runBridge(cfgIn(dir), tp, { buildEndpoint: () => ep as never, transcriber: fakeTranscriber("@x hi"), log: () => {} });
  await tick();
  await tick();
  await bridge.stop();
  assert.deepEqual(ep.unicasts, [{ id: "id-x", text: "hi" }], "transcript routed as a DM to x with body 'hi'");
  assert.equal(fetched.n, 1, "the audio was fetched (downloaded) once");
  // The DM send-signal is a 👀 reaction on the VOICE message (message id 1), not a text mirror.
  assert.deepEqual(tp.reactions, [{ chatId: 42, messageId: 1, reaction: "👀" }], "voice DM reacts 👀 on the voice message");
  assert.ok(!tp.sends.some((s) => s.text.startsWith("🎙 heard:")), "NO '🎙 heard:' text mirror on a successful transcript");
});

test("voice message: a spoken slash-command runs as a command (transcript '/who')", async () => {
  const dir = mkdtempSync(join(tmpdir(), "voice-"));
  const ep = new FakeEndpoint();
  ep.roster = [{ card: { id: "id-x", name: "x" }, status: "idle" }];
  const tp = new FakeTransport();
  tp.inbounds.push(voiceInbound());
  const bridge = await runBridge(cfgIn(dir), tp, { buildEndpoint: () => ep as never, transcriber: fakeTranscriber("/who"), log: () => {} });
  await tick();
  await tick();
  await bridge.stop();
  // /who replies a roster to the chat; it must NOT be routed as a mesh DM/broadcast.
  assert.equal(ep.unicasts.length, 0);
  assert.equal(ep.multicasts.length, 0);
  assert.ok(tp.sends.some((s) => /x/.test(s.text) && !s.text.startsWith("🎙")), "the /who roster was replied to the chat");
});

test("voice swipe-reply threads the transcript to the replied-to agent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "voice-"));
  const ep = new FakeEndpoint();
  ep.roster = [{ card: { id: "id-alice", name: "alice" }, status: "idle" }];
  const tp = new FakeTransport();
  const bridge = await runBridge(cfgIn(dir), tp, { buildEndpoint: () => ep as never, transcriber: fakeTranscriber("sounds good"), log: () => {} });
  await tick();
  // record an agent message so a reply to the bot's forwarded message threads to alice
  ep.emit("message",
    { id: "m", ts: Date.now(), space: "s", from: { id: "id-alice", name: "alice" }, parts: [{ kind: "text", text: "PR up" }], to: "me" } as never,
    { ack: () => {}, nak: () => {}, durable: true },
    { historical: false, kind: "dm" });
  await tick();
  assert.ok(tp.sends.some((s) => s.text === "alice: PR up"), "the agent DM was forwarded to the chat");
  const botMsgId = tp.nextId - 1;
  // a voice message that swipe-replies to the bot's "alice: PR up"
  tp.inbounds.push(voiceInbound({ messageId: 2, replyToId: botMsgId }));
  await tick();
  await tick();
  await bridge.stop();
  assert.deepEqual(ep.unicasts, [{ id: "id-alice", text: "sounds good" }], "voice reply threads to alice");
});

// ── graceful degradation + error surfacing ───────────────────────────────────────────────────────
test("no transcriber (no key): voice is skipped gracefully — logged, dropped, nothing routed/fetched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "voice-"));
  const ep = new FakeEndpoint();
  const tp = new FakeTransport();
  const logs: string[] = [];
  const fetched = { n: 0 };
  tp.inbounds.push(voiceInbound({}, fetched));
  const bridge = await runBridge(cfgIn(dir), tp, { buildEndpoint: () => ep as never, transcriber: undefined, log: (m) => logs.push(m) });
  await tick();
  await tick();
  await bridge.stop();
  assert.equal(ep.unicasts.length, 0, "nothing routed onto the mesh");
  assert.equal(fetched.n, 0, "no download attempted");
  assert.ok(logs.some((l) => /transcription disabled/.test(l)), "logged 'transcription disabled'");
});

test("transcription error: surfaced to the chat, nothing routed (loop advances → no redelivery)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "voice-"));
  const ep = new FakeEndpoint();
  const tp = new FakeTransport();
  tp.inbounds.push(voiceInbound());
  const bridge = await runBridge(cfgIn(dir), tp, { buildEndpoint: () => ep as never, transcriber: throwingTranscriber("groq 500 upstream"), log: () => {} });
  await tick();
  await tick();
  await bridge.stop();
  assert.equal(ep.unicasts.length, 0, "nothing routed on a failed transcription");
  const err = tp.sends.find((s) => /transcription failed/.test(s.text));
  assert.ok(err && /groq 500 upstream/.test(err.text), "the transcription error is surfaced to the chat");
});
