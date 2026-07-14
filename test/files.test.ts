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
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { CotalMessage } from "@cotal-ai/core";
import {
  appendFileManifest,
  FILE_PART_PROTO,
  FILES_CHANNEL_DEFAULT,
  formatFileAnnouncement,
  parseFileDirective,
  readFileManifest,
  resolveFilesChannel,
  resolveFilesDir,
  runBridge,
  sanitizeFilename,
  saveInboundFile,
  type EndpointConfig,
  type FileEntry,
} from "../src/index.js";
import { agent, fileInbound, FakeEndpoint, FakeTransport, tick } from "./fakes.js";

const entry = (over: Partial<FileEntry> = {}): FileEntry => ({
  v: 1,
  ts: 1_700_000_000_000,
  name: "report.pdf",
  path: "/abs/files/report.pdf",
  size: 2048,
  source: "telegram",
  ...over,
});

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
  const written = readdirSync(filesDir).filter((f) => f !== "index.jsonl"); // exclude the #files manifest
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

// ── #files feed: FileEntry / manifest / announcement pure helpers ────────────────────────────────────
test("resolveFilesChannel: default is #files; override honored", () => {
  assert.equal(FILES_CHANNEL_DEFAULT, "files");
  assert.equal(resolveFilesChannel(cfgIn("/x")), "files", "default channel is #files");
  assert.equal(resolveFilesChannel(cfgIn("/x", { filesChannel: "drops" })), "drops", "override honored");
});

test("formatFileAnnouncement: human-readable line with size; size omitted when unknown", () => {
  assert.equal(formatFileAnnouncement(entry({ size: 2048 })), "📎 report.pdf (2.0 KB) saved to /abs/files/report.pdf");
  assert.equal(formatFileAnnouncement(entry({ size: 500 })), "📎 report.pdf (500 B) saved to /abs/files/report.pdf");
  assert.equal(formatFileAnnouncement(entry({ size: 3 * 1024 * 1024 })), "📎 report.pdf (3.0 MB) saved to /abs/files/report.pdf");
  assert.equal(formatFileAnnouncement(entry({ size: undefined })), "📎 report.pdf saved to /abs/files/report.pdf", "no size → no parens");
});

test("appendFileManifest / readFileManifest: round-trip + newest-N tail", () => {
  const dir = mkdtempSync(join(tmpdir(), "fman-"));
  assert.deepEqual(readFileManifest(dir), [], "no manifest yet → empty");
  const a = entry({ name: "a.pdf", ts: 1 });
  const b = entry({ name: "b.pdf", ts: 2 });
  const c = entry({ name: "c.pdf", ts: 3 });
  appendFileManifest(dir, a);
  appendFileManifest(dir, b);
  appendFileManifest(dir, c);
  assert.deepEqual(readFileManifest(dir), [a, b, c], "round-trips all entries oldest→newest");
  assert.deepEqual(readFileManifest(dir, 2), [b, c], "limit returns the newest N (tail)");
  assert.deepEqual(readFileManifest(dir, 0), [], "limit 0 → none");
});

test("readFileManifest: tolerates a torn/blank FINAL line (crash mid-append)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fman-"));
  const a = entry({ name: "a.pdf", ts: 1 });
  appendFileManifest(dir, a);
  // Simulate a crash mid-append: a partial JSON fragment with no trailing newline.
  appendFileSync(join(dir, "index.jsonl"), '{"v":1,"ts":2,"name":"b.pd');
  assert.deepEqual(readFileManifest(dir), [a], "the torn final line is dropped, the good entry survives");
});

test("readFileManifest: throws on an EARLIER corrupt line (fail loud, no fabricated fallback)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fman-"));
  const good = entry({ name: "z.pdf", ts: 9 });
  // A corrupt line in the MIDDLE (a complete final line follows it) is real corruption → throw.
  appendFileSync(join(dir, "index.jsonl"), "not json at all\n" + JSON.stringify(good) + "\n");
  assert.throws(() => readFileManifest(dir), /corrupt manifest line 1/);
});

// ── #files feed: bridge announces a saved inbound file (manifest + data-part multicast) ───────────────
test("inbound file announces to #files (manifest + ai.cotal.file data part) even with an OFFLINE target", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fann-"));
  const ep = new FakeEndpoint(); // empty roster → the @name route resolves to nothing (offline target)
  const tp = new FakeTransport();
  tp.inbounds.push(fileInbound("data.csv", { text: "@nobody here", messageId: 11 }, new Uint8Array([1, 2, 3, 4, 5])));
  // The chat is seeded (default cfgIn) so the file is processed, but there is NO agent to route to —
  // the announce must fire regardless of the route landing anywhere.
  await drive(dir, ep, tp);
  assert.equal(ep.unicasts.length, 0, "nothing routed — no agent present");

  // (A) manifest: exactly one FileEntry appended.
  const manifest = readFileManifest(resolveFilesDir(cfgIn(dir)));
  assert.equal(manifest.length, 1, "one entry appended to the manifest");
  const savedPath = join(resolveFilesDir(cfgIn(dir)), "data.csv");
  assert.equal(manifest[0].name, "data.csv");
  assert.equal(manifest[0].path, savedPath);
  assert.equal(manifest[0].size, 5, "byte length recorded");
  assert.equal(manifest[0].source, "telegram", "provenance = cfg.name");
  assert.equal(manifest[0].caption, "@nobody here", "caption captured");
  assert.equal(manifest[0].chatId, 42);
  assert.equal(manifest[0].v, 1);

  // (B) multicast on #files: BOTH a text part (the readable line) AND the ai.cotal.file data part.
  // core's multicast DISCARDS the `text` arg when `parts` is supplied, so the readable line MUST ride as
  // an explicit text part — asserting on `parts` (not the fake's convenience `text` field) is what
  // catches that regression and keeps the `cotal_join("files")` live feed non-empty.
  const ann = ep.multicasts.find((m) => m.channel === FILES_CHANNEL_DEFAULT);
  assert.ok(ann, "multicast to #files");
  assert.ok(ann!.parts && ann!.parts.length === 2, "a text part + a data part on the wire");
  const textPart = ann!.parts!.find((p) => p.kind === "text") as { kind: string; text: string } | undefined;
  assert.ok(textPart, "the readable line rides as an explicit text PART (not the discarded text arg)");
  assert.equal(textPart!.text, `📎 data.csv (5 B) saved to ${savedPath}`, "human-readable announcement line");
  const part = ann!.parts!.find((p) => p.kind === "data") as { kind: string; data: { proto: string; name: string; path: string } } | undefined;
  assert.ok(part, "an ai.cotal.file data part");
  assert.equal(part!.data.proto, FILE_PART_PROTO, "discriminated by ai.cotal.file");
  assert.equal(part!.data.name, "data.csv");
  assert.equal(part!.data.path, savedPath, "the absolute path rides inside the message");
});

test("a normal text DM does NOT announce to #files (announce is file-only)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fann-"));
  const ep = new FakeEndpoint();
  ep.roster = [agent("bob")];
  const tp = new FakeTransport();
  tp.inbounds.push({ chatId: 42, userId: 42, messageId: 1, text: "@bob just a message" });
  await drive(dir, ep, tp);

  assert.equal(ep.unicasts.length, 1, "the text DM still routes");
  assert.ok(!ep.multicasts.some((m) => m.channel === FILES_CHANNEL_DEFAULT), "no #files announce for a plain text DM");
  assert.deepEqual(readFileManifest(resolveFilesDir(cfgIn(dir))), [], "no manifest entry for a plain text DM");
});
