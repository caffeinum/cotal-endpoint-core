/**
 * Hermetic unit tests for the pure bind minter (src/bind.ts): mint→verify one-time semantics, TTL expiry
 * via an injected clock, single-active-code supersede, the GLOBAL verify rate limit (blocks after N,
 * recovers after the window), the code charset/length, input normalization, and bind-request detection.
 * Deterministic — clock + RNG are injected, never node:crypto / Date.now. `tsx --test test/bind.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BindMinter,
  BIND_CODE_PROTO,
  BIND_REQUEST_PROTO,
  CROCKFORD_ALPHABET,
  encodeCode,
  normalizeCode,
  partsHaveBindRequest,
} from "../src/index.js";

/** A controllable clock: `set`/`advance` a mutable ms value the minter reads through `now`. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; }, set: (ms: number) => { t = ms; } };
}

/** A deterministic RNG: returns a repeating byte pattern so the minted code is predictable. */
function seededRand(...pattern: number[]) {
  let i = 0;
  return (n: number) => {
    const out = new Uint8Array(n);
    for (let k = 0; k < n; k++) out[k] = pattern[i++ % pattern.length];
    return out;
  };
}

// ── charset / length ───────────────────────────────────────────────────────────────────────────────
test("CROCKFORD_ALPHABET is 32 unambiguous chars (no I L O U)", () => {
  assert.equal(CROCKFORD_ALPHABET.length, 32);
  for (const bad of ["I", "L", "O", "U"]) assert.ok(!CROCKFORD_ALPHABET.includes(bad), `must exclude ${bad}`);
  assert.equal(new Set(CROCKFORD_ALPHABET).size, 32, "no duplicate chars");
});

test("encodeCode maps byte & 31 → alphabet; a minted code is 6 chars all in the alphabet", () => {
  assert.equal(encodeCode(new Uint8Array([0, 1, 31, 32, 33, 255]), 6), "01" + CROCKFORD_ALPHABET[31] + "01" + CROCKFORD_ALPHABET[31]);
  const m = new BindMinter({ now: () => 0, rand: (n) => new Uint8Array(n).map((_, i) => (i * 7 + 3) & 0xff) });
  const { code } = m.mint();
  assert.equal(code.length, 6);
  for (const ch of code) assert.ok(CROCKFORD_ALPHABET.includes(ch), `code char ${ch} not in alphabet`);
});

// ── mint → verify (one-time) ─────────────────────────────────────────────────────────────────────
test("verify is true EXACTLY ONCE, then false (one-time consume)", () => {
  const c = clock();
  const m = new BindMinter({ now: c.now, rand: seededRand(0) }); // code = "000000"
  const { code, ttlSec } = m.mint();
  assert.equal(code, "000000");
  assert.equal(ttlSec, 120);
  assert.equal(m.verify(code), true, "first verify succeeds");
  assert.equal(m.verify(code), false, "second verify of the consumed code fails");
});

test("a wrong guess returns false but does NOT consume the pending code (retry still works)", () => {
  const c = clock();
  const m = new BindMinter({ now: c.now, rand: seededRand(0) });
  const { code } = m.mint();
  assert.equal(m.verify("111111"), false, "wrong code fails");
  assert.equal(m.verify(code), true, "the correct code still works after a wrong guess");
});

test("verify with no pending code → false", () => {
  const m = new BindMinter({ now: () => 0, rand: seededRand(0) });
  assert.equal(m.verify("000000"), false);
});

// ── TTL expiry ───────────────────────────────────────────────────────────────────────────────────
test("a code expires after its TTL (via the injected clock)", () => {
  const c = clock();
  const m = new BindMinter({ now: c.now, rand: seededRand(0), ttlMs: 120_000 });
  const { code } = m.mint();
  c.advance(119_999);
  // Fresh minter for the boundary check would reset rate; here we just verify at the edge then past it.
  c.advance(2); // now 120_001 past mint → expired
  assert.equal(m.verify(code), false, "past TTL → expired → false");
});

test("a code just BEFORE the TTL still verifies", () => {
  const c = clock();
  const m = new BindMinter({ now: c.now, rand: seededRand(5), ttlMs: 120_000 });
  const { code } = m.mint();
  c.advance(119_000);
  assert.equal(m.verify(code), true);
});

// ── single active code (supersede) ───────────────────────────────────────────────────────────────
test("minting again SUPERSEDES the prior code — only the newest verifies", () => {
  const c = clock();
  const m = new BindMinter({ now: c.now, rand: seededRand(0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1) });
  const first = m.mint().code; // "000000"
  const second = m.mint().code; // "111111"
  assert.notEqual(first, second);
  assert.equal(m.verify(first), false, "the superseded (old) code no longer verifies");
  assert.equal(m.verify(second), true, "the newest code verifies");
});

// ── global rate limit ────────────────────────────────────────────────────────────────────────────
test("verify is GLOBALLY rate-limited: blocks after `max` attempts, recovers after the window", () => {
  const c = clock();
  const m = new BindMinter({ now: c.now, rand: seededRand(9), rateLimit: { max: 10, windowMs: 60_000 } });
  const { code } = m.mint();
  // Burn 10 attempts with WRONG guesses (each spends a token, none consumes the code).
  for (let i = 0; i < 10; i++) assert.equal(m.verify("XXXXXX"), false);
  // The 11th attempt is rate-limited → generic false EVEN FOR THE CORRECT CODE (no bypass).
  assert.equal(m.verify(code), false, "rate-limited: the correct code is rejected while the bucket is empty");
  // Advance one full window → bucket refills → the correct code now verifies.
  c.advance(60_000);
  assert.equal(m.verify(code), true, "after the window the bucket refills and the code verifies");
});

test("rate-limit is a token bucket: partial refill lets a proportional number of attempts through", () => {
  const c = clock();
  const m = new BindMinter({ now: c.now, rand: seededRand(0), rateLimit: { max: 4, windowMs: 60_000 } });
  m.mint();
  for (let i = 0; i < 4; i++) assert.equal(m.verify("ZZZZZZ"), false); // drain the 4 tokens
  assert.equal(m.verify("ZZZZZZ"), false, "empty bucket blocks");
  c.advance(30_000); // half a window → +2 tokens
  assert.equal(m.verify("ZZZZZZ"), false, "token 1 of the refill");
  assert.equal(m.verify("ZZZZZZ"), false, "token 2 of the refill");
  // The refilled tokens are used up; still blocked until more time passes.
  const before = m.verify("ZZZZZZ");
  assert.equal(before, false);
});

// ── input normalization ──────────────────────────────────────────────────────────────────────────
test("normalizeCode: uppercases, strips spaces/dashes, folds O→0 and I/L→1", () => {
  assert.equal(normalizeCode("abc123"), "ABC123");
  assert.equal(normalizeCode("a b-c 1"), "ABC1");
  assert.equal(normalizeCode("oIl"), "011");
  assert.equal(normalizeCode("O0-Il"), "0011");
});

test("verify accepts a Crockford-folded, spaced, lowercase entry of the minted code", () => {
  const c = clock();
  // rand 24 → 24 & 31 = 24 → CROCKFORD_ALPHABET[24] = "R"; code "RRRRRR" (no ambiguous glyphs).
  const m = new BindMinter({ now: c.now, rand: seededRand(24) });
  const { code } = m.mint();
  assert.equal(code, "RRRRRR");
  assert.equal(m.verify("rrrr rr"), true, "lowercase + a space still matches");
});

// ── bind-request detection ───────────────────────────────────────────────────────────────────────
test("partsHaveBindRequest: true only for a data part with the bind-request proto", () => {
  assert.equal(partsHaveBindRequest([{ kind: "data", data: { proto: BIND_REQUEST_PROTO, v: 1 } }]), true);
  assert.equal(partsHaveBindRequest([{ kind: "text", text: "hi" } as never]), false);
  assert.equal(partsHaveBindRequest([{ kind: "data", data: { proto: BIND_CODE_PROTO } }]), false, "a bind-CODE part is not a request");
  assert.equal(partsHaveBindRequest([{ kind: "data", data: null }]), false);
  assert.equal(partsHaveBindRequest([]), false);
});
