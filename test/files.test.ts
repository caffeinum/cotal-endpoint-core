/**
 * Hermetic checks for FILE support — both directions — through the bridge with fakes, plus the pure
 * helpers (sanitizeFilename / parseFileDirective / saveInboundFile).
 *   INBOUND  (channel → mesh): a document/photo is SAVED to the per-space downloads dir under a safe name
 *            and routed as a text reference (`📎 <name> saved to <abs-path>`, caption prefixed), with the
 *            normal send-signal reaction (👀 dm / ⚡ broadcast). No binary crosses the mesh.
 *   OUTBOUND (mesh → channel): an agent's `[[file:<path>]]` / `[[file:<path>|<caption>]]` calls
 *            transport.sendFile with the path + caption and the directive is stripped; with NO sendFile the
 *            text is sent as-is (graceful).
 * Channel-agnostic (no Telegram). `tsx --test test/files.test.ts`.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { CotalMessage } from "@cotal-ai/core";
import { parseFileDirective, resolveFilesDir, runBridge, sanitizeFilename, saveInboundFile, type EndpointConfig } from "../src/index.js";
import { agent, fileInbound, FakeEndpoint, FakeTransport, tick } from "./fakes.js";

function cfgIn(dir: string, over: Partial<EndpointConfig> = {}): EndpointConfig {
  return { space: "t", server: "nats://127.0.0.1:4222", name: "telegram", channel: "general", stateRoot: dir, seedChats: [42], learnFirstChat: false, ...over };
}

async function drive(dir: string, ep: FakeEndpoint, tp: FakeTransport, over: Partial<EndpointConfig> = {}) {
  const bridge = await runBridge(cfgIn(dir, over), tp, { buildEndpoint: () => ep as never, log: () => {} });
  await tick();
  await tick();
  await bridge.stop();
}

const dm = (from: string, text: string): CotalMessage =>
  ({ id: "m1", ts: Date.now(), space: "s", from: { id: "id-" + from, name: from }, parts: [{ kind: "text", text }], to: "me" }) as CotalMessage;

// ── pure helpers ──────────────────────────────────────────────────────────────────────────────────
test("sanitizeFilename: basename only, strips traversal/separators/control, falls back when empty", () => {
  assert.equal(sanitizeFilename("report.pdf"), "report.pdf");
  assert.equal(sanitizeFilename("../../etc/passwd"), "passwd", "path traversal reduced to basename");
  assert.equal(sanitizeFilename("a/b/c.png"), "c.png");
  assert.equal(sanitizeFilename("evil\\win.exe"), "win.exe", "windows separators too");
  assert.equal(sanitizeFilename(".."), "file", "an all-dots name → fallback");
  assert.equal(sanitizeFilename("/"), "file", "a bare separator → fallback");
  assert.equal(sanitizeFilename(".hidden"), "hidden", "leading dots stripped");
});

test("parseFileDirective: parses path + optional inline caption; strips the token; undefined when none", () => {
  assert.equal(parseFileDirective("no file here"), undefined);
  assert.deepEqual(parseFileDirective("[[file:/tmp/x.txt]]"), { path: "/tmp/x.txt", caption: undefined, rest: "" });
  assert.deepEqual(parseFileDirective("[[file:/tmp/x.txt|here you go]]"), { path: "/tmp/x.txt", caption: "here you go", rest: "" });
  assert.deepEqual(parseFileDirective("see this [[file:/a/b.png]] ok"), { path: "/a/b.png", caption: undefined, rest: "see this  ok" });
  assert.equal(parseFileDirective("[[file:]]"), undefined, "empty path is not a directive");
});

test("saveInboundFile: writes bytes under a safe name; collision gets a numeric suffix", () => {
  const dir = mkdtempSync(join(tmpdir(), "fsave-"));
  const p1 = saveInboundFile(dir, "../../doc.txt", new Uint8Array([1, 2]));
  assert.ok(p1.endsWith("/doc.txt"), "traversal reduced to a basename in dir");
  assert.deepEqual([...readFileSync(p1)], [1, 2]);
  const p2 = saveInboundFile(dir, "doc.txt", new Uint8Array([3]));
  assert.ok(p2.endsWith("/doc (1).txt"), "a colliding name gets a ` (1)` suffix");
  assert.notEqual(p1, p2);
});

// ── INBOUND: document/photo → saved + routed reference ─────────────────────────────────────────────
test("inbound file with an @name caption → saved to disk + DM the agent with the path + 👀", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fin-"));
  const ep = new FakeEndpoint();
  ep.roster = [agent("bob")];
  const tp = new FakeTransport();
  tp.inbounds.push(fileInbound("report.pdf", { text: "@bob review this", messageId: 7 }, new Uint8Array([9, 9, 9])));
  await drive(dir, ep, tp);

  assert.equal(ep.unicasts.length, 1, "routed as a DM to bob");
  const routed = ep.unicasts[0];
  assert.equal(routed.id, "id-bob");
  const savedPath = join(resolveFilesDir(cfgIn(dir)), "report.pdf");
  assert.ok(existsSync(savedPath), "the file was written to the downloads dir");
  assert.deepEqual([...readFileSync(savedPath)], [9, 9, 9], "the downloaded bytes landed on disk");
  assert.equal(routed.text, `review this\n📎 report.pdf saved to ${savedPath}`, "caption (minus @bob) + the saved-path reference");
  assert.deepEqual(tp.reactions, [{ chatId: 42, messageId: 7, reaction: "👀" }], "a single-recipient DM reacts 👀");
  assert.equal(tp.fileSends.length, 0, "inbound never uploads back — it only saves + routes text");
});

test("inbound file with NO caption → broadcast (@all default) with just the reference + ⚡", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fin-"));
  const ep = new FakeEndpoint();
  ep.roster = [agent("a"), agent("b")];
  const tp = new FakeTransport();
  tp.inbounds.push(fileInbound("photo_XY.jpg", { messageId: 3 }));
  await drive(dir, ep, tp);

  const savedPath = join(resolveFilesDir(cfgIn(dir)), "photo_XY.jpg");
  assert.ok(existsSync(savedPath), "saved");
  assert.deepEqual(ep.unicasts.map((u) => u.id).sort(), ["id-a", "id-b"], "no caption → @all broadcast to present agents");
  assert.ok(ep.unicasts.every((u) => u.text === `📎 photo_XY.jpg saved to ${savedPath}`), "the reference line is the routed text");
  assert.deepEqual(tp.reactions, [{ chatId: 42, messageId: 3, reaction: "⚡" }], "a broadcast reacts ⚡");
});

test("inbound file with a malicious filename is saved INSIDE the downloads dir (no traversal)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fin-"));
  const ep = new FakeEndpoint();
  ep.roster = [agent("bob")];
  const tp = new FakeTransport();
  tp.inbounds.push(fileInbound("../../../../etc/evil.sh", { text: "@bob", messageId: 1 }));
  await drive(dir, ep, tp);
  const filesDir = resolveFilesDir(cfgIn(dir));
  const written = readdirSync(filesDir);
  assert.deepEqual(written, ["evil.sh"], "only the sanitized basename is written, inside the downloads dir");
});

test("inbound file download failure is surfaced to the chat, nothing routed (loop advances)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fin-"));
  const ep = new FakeEndpoint();
  ep.roster = [agent("bob")];
  const tp = new FakeTransport();
  tp.inbounds.push({
    chatId: 42,
    messageId: 5,
    userId: 42,
    text: "@bob",
    file: { filename: "x.bin", async fetch() { throw new Error("network down"); } },
  });
  await drive(dir, ep, tp);
  assert.equal(ep.unicasts.length, 0, "a failed download routes nothing onto the mesh");
  assert.ok(tp.sends.some((s) => /file download failed: network down/.test(s.text)), "the error is surfaced to the chat");
});

// ── OUTBOUND: [[file:…]] → sendFile ────────────────────────────────────────────────────────────────
test("outbound [[file:<path>]] → sendFile called with the path; directive stripped (no text send)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fout-"));
  const ep = new FakeEndpoint();
  const tp = new FakeTransport();
  const bridge = await runBridge(cfgIn(dir, { seedChats: [42] }), tp, { buildEndpoint: () => ep as never, log: () => {} });
  await tick();
  ep.emit("message", dm("alice", "[[file:/tmp/out.pdf]]"), { ack: () => {}, nak: () => {}, durable: true }, { historical: false, kind: "dm" });
  await tick();
  await bridge.stop();
  assert.deepEqual(tp.fileSends, [{ chatId: 42, path: "/tmp/out.pdf", caption: "alice:" }], "uploaded the file with the label caption");
  assert.equal(tp.sends.length, 0, "the directive was stripped — no text send");
});

test("outbound [[file:<path>|<caption>]] → sendFile caption = label + inline caption", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fout-"));
  const ep = new FakeEndpoint();
  const tp = new FakeTransport();
  const bridge = await runBridge(cfgIn(dir, { seedChats: [42] }), tp, { buildEndpoint: () => ep as never, log: () => {} });
  await tick();
  ep.emit("message", dm("alice", "[[file:/tmp/out.pdf|the report]]"), { ack: () => {}, nak: () => {}, durable: true }, { historical: false, kind: "dm" });
  await tick();
  await bridge.stop();
  assert.deepEqual(tp.fileSends, [{ chatId: 42, path: "/tmp/out.pdf", caption: "alice: the report" }]);
});

test("outbound file with leading text → the leftover text becomes the caption", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fout-"));
  const ep = new FakeEndpoint();
  const tp = new FakeTransport();
  const bridge = await runBridge(cfgIn(dir, { seedChats: [42] }), tp, { buildEndpoint: () => ep as never, log: () => {} });
  await tick();
  ep.emit("message", dm("alice", "here you go [[file:/tmp/out.pdf]]"), { ack: () => {}, nak: () => {}, durable: true }, { historical: false, kind: "dm" });
  await tick();
  await bridge.stop();
  assert.deepEqual(tp.fileSends, [{ chatId: 42, path: "/tmp/out.pdf", caption: "alice: here you go" }]);
});

test("outbound [[file:…]] with NO transport.sendFile → falls back to sending the text as-is", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fout-"));
  const ep = new FakeEndpoint();
  const tp = new FakeTransport();
  tp.sendFile = undefined; // a channel with no file-upload support
  const bridge = await runBridge(cfgIn(dir, { seedChats: [42] }), tp, { buildEndpoint: () => ep as never, log: () => {} });
  await tick();
  ep.emit("message", dm("alice", "grab it [[file:/tmp/out.pdf]]"), { ack: () => {}, nak: () => {}, durable: true }, { historical: false, kind: "dm" });
  await tick();
  await bridge.stop();
  assert.equal(tp.fileSends.length, 0, "nothing uploaded (no sendFile)");
  const sent = tp.sends.find((s) => s.chatId === 42);
  assert.ok(sent, "the text was sent as a fallback");
  assert.equal(sent!.text, "alice: grab it [[file:/tmp/out.pdf]]", "the raw text (directive included) is sent as-is");
});
