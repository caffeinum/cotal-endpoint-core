/**
 * Chat-binding: a short-lived, one-time code that authorizes a NEW chat onto the mesh. PURE + testable
 * with an injected clock and RNG — no I/O, no mesh, no channel SDK. Only node stdlib.
 *
 * The code is minted on the TRUSTED side (over the mesh — a `paw bind` CLI or an agent's `cotal_dm`),
 * relayed to the human, and typed into the untrusted chat as `/bind <code>`. The bridge verifies it and
 * adds the chat to the allowlist. Security rests on "you can produce a code minted on the mesh", NOT on
 * "you can talk to the bot" (an enumerable bot username reachable by any stranger).
 *
 * Defenses: 6-char Crockford-base32 code (≈1.07e9 haystack), 120s TTL, one-time consume, ONE active code
 * at a time, and a GLOBAL (not per-chat — the attacker controls chat ids) token-bucket rate limit on
 * verify attempts (~10/min). A failed verify is ALWAYS a generic false — no oracle distinguishes
 * wrong/expired/none/rate-limited.
 */

/** The reserved data-part discriminator a peer sends the endpoint to REQUEST a fresh bind code. */
export const BIND_REQUEST_PROTO = "ai.cotal.bind-request";
/** The reserved data-part discriminator the endpoint replies with, carrying the minted `code` + `ttlSec`. */
export const BIND_CODE_PROTO = "ai.cotal.bind-code";

/**
 * Crockford base32 alphabet: 0-9 + A-Z minus I, L, O, U — unambiguous when read aloud or typed. 32 chars,
 * so a random byte maps to an index with `byte & 31` (no modulo bias, since 32 divides 256 evenly).
 */
export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Encode the first `len` bytes as Crockford-base32 chars (5 bits each, `byte & 31`). Pure. */
export function encodeCode(bytes: Uint8Array, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += CROCKFORD_ALPHABET[bytes[i] & 31];
  return s;
}

/**
 * Fold user input into the canonical code alphabet: uppercase, drop everything that isn't [0-9A-Z]
 * (spaces, dashes Crockford allows for readability), then map the ambiguous glyphs O→0 and I/L→1. So a
 * human who types `o1-il0` and the minted `0111 0` compare equal. Pure.
 */
export function normalizeCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

/**
 * True when a message's parts carry a bind-request data part. STRUCTURAL (no @cotal-ai/core import — kept
 * node-stdlib-only), so it works on any `{ kind, data }`-shaped part list. Pure.
 */
export function partsHaveBindRequest(parts: readonly { kind: string; data?: unknown }[]): boolean {
  return parts.some((p) => p.kind === "data" && hasProto(p.data, BIND_REQUEST_PROTO));
}

function hasProto(data: unknown, proto: string): boolean {
  return typeof data === "object" && data !== null && (data as { proto?: unknown }).proto === proto;
}

export interface BindMinterOpts {
  /** Injected clock (ms epoch) — every TTL/rate decision reads this, never Date.now directly. */
  now: () => number;
  /** Injected RNG — returns `n` random bytes. Real endpoint passes node:crypto randomBytes; tests a stub. */
  rand: (n: number) => Uint8Array;
  /** Code lifetime in ms (default 120000). */
  ttlMs?: number;
  /** Global verify rate limit: `max` attempts per `windowMs` (default 10 / 60000ms). */
  rateLimit?: { max: number; windowMs: number };
  /** Code length in chars (default 6). */
  codeLen?: number;
}

/**
 * The stateful minter: holds AT MOST ONE pending `{ code, expiresAt }` (a new mint supersedes the prior)
 * plus a global token bucket for verify attempts. All time flows through the injected clock, all
 * randomness through the injected RNG, so it's fully deterministic under test.
 */
export class BindMinter {
  private pending: { code: string; expiresAt: number } | null = null;
  private readonly now: () => number;
  private readonly rand: (n: number) => Uint8Array;
  private readonly ttlMs: number;
  private readonly rateMax: number;
  private readonly rateWindowMs: number;
  private readonly codeLen: number;
  // Token bucket: `tokens` refills toward `rateMax` at `rateMax / rateWindowMs` per ms.
  private tokens: number;
  private lastRefill: number;

  constructor(opts: BindMinterOpts) {
    this.now = opts.now;
    this.rand = opts.rand;
    this.ttlMs = opts.ttlMs ?? 120_000;
    this.rateMax = opts.rateLimit?.max ?? 10;
    this.rateWindowMs = opts.rateLimit?.windowMs ?? 60_000;
    this.codeLen = opts.codeLen ?? 6;
    this.tokens = this.rateMax;
    this.lastRefill = this.now();
  }

  /** Mint a fresh code, superseding any prior pending one. Returns the code + its TTL in whole seconds. */
  mint(): { code: string; ttlSec: number } {
    const code = encodeCode(this.rand(this.codeLen), this.codeLen);
    this.pending = { code, expiresAt: this.now() + this.ttlMs };
    return { code, ttlSec: Math.round(this.ttlMs / 1000) };
  }

  /**
   * Verify an untrusted code. Returns true EXACTLY ONCE for a live, matching code (then consumes it);
   * false for wrong / expired / none-pending / rate-limited — indistinguishable to the caller (no oracle).
   * Every attempt (even a legit one) spends a rate token, so a brute-forcer is globally capped.
   */
  verify(code: string): boolean {
    if (!this.spendToken()) return false; // rate-limited → generic false
    const p = this.pending;
    if (!p) return false;
    if (this.now() >= p.expiresAt) {
      this.pending = null; // expired — clear it
      return false;
    }
    if (normalizeCode(code) !== p.code) return false; // wrong — pending survives for a retry
    this.pending = null; // one-time: consume on success
    return true;
  }

  private spendToken(): boolean {
    const now = this.now();
    const elapsed = now - this.lastRefill;
    if (elapsed > 0) {
      this.tokens = Math.min(this.rateMax, this.tokens + (elapsed / this.rateWindowMs) * this.rateMax);
      this.lastRefill = now;
    }
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}
