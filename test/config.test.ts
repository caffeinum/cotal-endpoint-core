/**
 * Hermetic checks for the channel-agnostic config/state skeleton (src/config.ts): tolerant allowlist +
 * sticky reads, offset + peerId persistence. Temp dirs only, no network. `tsx --test test/config.test.ts`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  peerId,
  readAllowlist,
  readOffset,
  readSticky,
  stateDir,
  writeOffset,
  writeSticky,
  type EndpointConfig,
  type StickyTarget,
} from "../src/index.js";

function cfgIn(dir: string, over: Partial<EndpointConfig> = {}): EndpointConfig {
  return { space: "t", server: "nats://127.0.0.1:4222", name: "telegram", channel: "general", stateRoot: dir, seedChats: [], learnFirstChat: false, ...over };
}

test("readAllowlist tolerates a corrupt chats.json (logs, keeps seeds, treats file as empty)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ep-"));
  const cfg = cfgIn(dir, { space: "corrupt", seedChats: [7] });
  writeFileSync(join(stateDir(cfg), "chats.json"), "{not valid json");
  let logged = "";
  const set = readAllowlist(cfg, (m) => { logged = m; });
  assert.deepEqual([...set], [7]); // seed survives; garbage doesn't brick startup
  assert.match(logged, /corrupt/);
});

test("readSticky tolerates a corrupt sticky file and skips malformed per-chat entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "ep-"));
  const cfg = cfgIn(dir, { space: "sticky" });
  writeFileSync(join(stateDir(cfg), "telegram.sticky.json"), "{not json");
  let logged = "";
  assert.equal(readSticky(cfg, (m) => { logged = m; }).size, 0);
  assert.match(logged, /corrupt/);
  // a valid file with one good + one malformed entry keeps only the good one
  writeFileSync(join(stateDir(cfg), "telegram.sticky.json"), JSON.stringify({ 42: { kind: "dm", name: "a" }, 77: { kind: "dm" } }));
  const map = readSticky(cfg);
  assert.deepEqual(map.get(42), { kind: "dm", name: "a" });
  assert.equal(map.get(77), undefined);
});

test("writeSticky/readSticky round-trip per-chat targets", () => {
  const dir = mkdtempSync(join(tmpdir(), "ep-"));
  const cfg = cfgIn(dir, { space: "rt" });
  const m = new Map<number, StickyTarget>([[42, { kind: "all" }], [7, { kind: "channel", channel: "eng" }]]);
  writeSticky(cfg, m);
  const back = readSticky(cfg);
  assert.deepEqual(back.get(42), { kind: "all" });
  assert.deepEqual(back.get(7), { kind: "channel", channel: "eng" });
});

test("readOffset defaults to 0; writeOffset persists a positive cursor", () => {
  const dir = mkdtempSync(join(tmpdir(), "ep-"));
  const cfg = cfgIn(dir, { space: "off" });
  assert.equal(readOffset(cfg), 0);
  writeOffset(cfg, 42);
  assert.equal(readOffset(cfg), 42);
});

test("peerId mints once and is stable across reads (durable open-mesh id)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ep-"));
  const cfg = cfgIn(dir, { space: "pid" });
  const a = peerId(cfg);
  assert.match(a, /[0-9a-f-]{36}/);
  assert.equal(peerId(cfg), a, "same id on the next read");
});
