/**
 * Hermetic checks for the channel-agnostic config/state skeleton (src/config.ts): tolerant allowlist +
 * sticky reads, offset + peerId persistence. Temp dirs only, no network. `tsx --test test/config.test.ts`.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
  // cotal 0.11: a NATS-safe principal token — no dashes (a dashed UUID is rejected on connect).
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(peerId(cfg), a, "same id on the next read");
});

test("peerId migrates a legacy dashed UUID .id file in place (0.11 upgrade)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ep-"));
  const cfg = cfgIn(dir, { space: "pid" });
  const legacy = "6a3ec0fd-4bd0-45c2-a72b-9b29b4297ce7";
  mkdirSync(join(dir, "pid"), { recursive: true });
  writeFileSync(join(dir, "pid", "telegram.id"), legacy);
  const migrated = peerId({ ...cfg, name: "telegram" });
  assert.equal(migrated, "6a3ec0fd4bd045c2a72b9b29b4297ce7", "dashes stripped, same underlying id");
  assert.ok(!migrated.includes("-"), "no dashes");
});
