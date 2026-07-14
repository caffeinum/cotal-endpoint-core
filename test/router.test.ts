/**
 * Hermetic checks for the PURE routing / sticky / chunking / allowlist core (src/router.ts). No network,
 * no mesh, no channel. `tsx --test test/router.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { CotalMessage } from "@cotal-ai/core";
import {
  chunkMessage,
  classifyChat,
  formatOutbound,
  parseStickyTarget,
  ReplyMap,
  routeInbound,
  stickyLabel,
  textOf,
  type Inbound,
  type RouteCtx,
  type StickyTarget,
} from "../src/index.js";

const ctx = (over: Partial<RouteCtx> = {}): RouteCtx => ({
  replyMap: new ReplyMap(),
  sticky: new Map<number, StickyTarget>(),
  ...over,
});

/** Build an inbound message (channel-agnostic). */
const inb = (over: Partial<Inbound> & { text: string }, chatId = 42, id = 1): Inbound => ({
  chatId,
  messageId: id,
  userId: 7,
  ...over,
});

const dm = (from: string, text: string): CotalMessage =>
  ({ id: "m1", ts: Date.now(), space: "s", from: { id: "id-" + from, name: from }, parts: [{ kind: "text", text }], to: "me" }) as CotalMessage;

// ── routeInbound precedence ──────────────────────────────────────────────────────────────────────
test("reply-threading wins and latches sticky", () => {
  const c = ctx();
  c.replyMap.set(42, 99, { name: "alice", id: "id-alice" });
  const a = routeInbound(inb({ text: "sounds good", replyToId: 99 }), c);
  assert.deepEqual(a, { kind: "dm", target: "alice", text: "sounds good", chatId: 42 });
  assert.deepEqual(c.sticky.get(42), { kind: "dm", name: "alice" });
});

test("leading @name → dm + latches sticky", () => {
  const c = ctx();
  const a = routeInbound(inb({ text: "@bob ship it" }), c);
  assert.deepEqual(a, { kind: "dm", target: "bob", text: "ship it", chatId: 42 });
  assert.deepEqual(c.sticky.get(42), { kind: "dm", name: "bob" });
});

test("leading @all → broadcast-all + latches sticky {all}", () => {
  const c = ctx();
  const a = routeInbound(inb({ text: "@all standup in 5" }), c);
  assert.deepEqual(a, { kind: "all", text: "standup in 5", chatId: 42 });
  assert.deepEqual(c.sticky.get(42), { kind: "all" });
  // case-insensitive keyword
  assert.equal(routeInbound(inb({ text: "@ALL hi" }), ctx()).kind, "all");
});

test("leading #channel → channel + latches sticky {channel}", () => {
  const c = ctx();
  const a = routeInbound(inb({ text: "#eng deploying" }), c);
  assert.deepEqual(a, { kind: "channel", channel: "eng", text: "deploying", chatId: 42 });
  assert.deepEqual(c.sticky.get(42), { kind: "channel", channel: "eng" });
});

test("leading ?role → anycast + latches sticky {anycast}", () => {
  const c = ctx();
  const a = routeInbound(inb({ text: "?reviewer take a look" }), c);
  assert.deepEqual(a, { kind: "anycast", role: "reviewer", text: "take a look", chatId: 42 });
  assert.deepEqual(c.sticky.get(42), { kind: "anycast", role: "reviewer" });
});

test("sticky target routes a plain line after a prior @name", () => {
  const c = ctx();
  routeInbound(inb({ text: "@carol hi" }), c); // latches carol
  const a = routeInbound(inb({ text: "any update?" }), c);
  assert.deepEqual(a, { kind: "dm", target: "carol", text: "any update?", chatId: 42 });
});

test("a plain line repeats the LAST sticky kind (channel / all / anycast), not just dm", () => {
  const chan = ctx();
  routeInbound(inb({ text: "#eng go" }), chan);
  assert.deepEqual(routeInbound(inb({ text: "status?" }), chan), { kind: "channel", channel: "eng", text: "status?", chatId: 42 });

  const all = ctx();
  routeInbound(inb({ text: "@all go" }), all);
  assert.deepEqual(routeInbound(inb({ text: "status?" }), all), { kind: "all", text: "status?", chatId: 42 });

  const any = ctx();
  routeInbound(inb({ text: "?planner go" }), any);
  assert.deepEqual(routeInbound(inb({ text: "status?" }), any), { kind: "anycast", role: "planner", text: "status?", chatId: 42 });
});

test("first message / no sticky and no sigil → default to @all (a fresh chat just works)", () => {
  const a = routeInbound(inb({ text: "hello world" }), ctx());
  assert.deepEqual(a, { kind: "all", text: "hello world", chatId: 42 });
});

test("unknown @name still produces a dm action (bridge resolves/fails at send)", () => {
  const a = routeInbound(inb({ text: "@ghost yo" }), ctx());
  assert.deepEqual(a, { kind: "dm", target: "ghost", text: "yo", chatId: 42 });
});

test("text-less / empty inbounds are ignored", () => {
  assert.equal(routeInbound(inb({ text: "" }), ctx()).kind, "ignore");
  assert.equal(routeInbound(inb({ text: "   " }), ctx()).kind, "ignore");
});

// ── precedence CONFLICTS (the ordering that actually matters) ──────────────────────────────────────
test("reply-threading beats a message that ALSO leads with @name", () => {
  const c = ctx();
  c.replyMap.set(42, 99, { name: "alice", id: "id-alice" });
  // Replies to alice's bot message but the body also starts with @bob — the reply wins, @bob is literal.
  const a = routeInbound(inb({ text: "@bob nvm", replyToId: 99 }), c);
  assert.deepEqual(a, { kind: "dm", target: "alice", text: "@bob nvm", chatId: 42 });
  assert.deepEqual(c.sticky.get(42), { kind: "dm", name: "alice" });
});

test("leading @name overrides an existing sticky target (and re-latches)", () => {
  const c = ctx({ sticky: new Map<number, StickyTarget>([[42, { kind: "dm", name: "carol" }]]) });
  const a = routeInbound(inb({ text: "@dave ping" }), c);
  assert.deepEqual(a, { kind: "dm", target: "dave", text: "ping", chatId: 42 });
  assert.deepEqual(c.sticky.get(42), { kind: "dm", name: "dave" });
});

// ── stickyLabel + parseStickyTarget (persistence primitives) ──────────────────────────────────────
test("stickyLabel renders each target KIND (for /here)", () => {
  assert.equal(stickyLabel({ kind: "dm", name: "alice" }), "@alice");
  assert.equal(stickyLabel({ kind: "channel", channel: "eng" }), "#eng");
  assert.equal(stickyLabel({ kind: "all" }), "📢 all");
  assert.equal(stickyLabel({ kind: "anycast", role: "reviewer" }), "?reviewer");
});

test("parseStickyTarget accepts valid shapes and rejects malformed ones", () => {
  assert.deepEqual(parseStickyTarget({ kind: "dm", name: "a" }), { kind: "dm", name: "a" });
  assert.deepEqual(parseStickyTarget({ kind: "channel", channel: "eng" }), { kind: "channel", channel: "eng" });
  assert.deepEqual(parseStickyTarget({ kind: "all" }), { kind: "all" });
  assert.deepEqual(parseStickyTarget({ kind: "anycast", role: "r" }), { kind: "anycast", role: "r" });
  // malformed → undefined (corrupt file degrades to the @all default, never injects a bad target)
  assert.equal(parseStickyTarget({ kind: "dm" }), undefined); // missing name
  assert.equal(parseStickyTarget({ kind: "bogus" }), undefined);
  assert.equal(parseStickyTarget("nope"), undefined);
  assert.equal(parseStickyTarget(null), undefined);
});

// ── formatOutbound ────────────────────────────────────────────────────────────────────────────────
test("formatOutbound renders '<from>: text' and prefixes channels", () => {
  assert.equal(formatOutbound(dm("alice", "done"), "dm"), "alice: done");
  const chan = { id: "m", ts: 1, space: "s", from: { id: "x", name: "alice" }, parts: [{ kind: "text", text: "hey" }], channel: "eng" } as CotalMessage;
  assert.equal(formatOutbound(chan, "channel"), "[#eng] alice: hey");
});

test("textOf labels an unknown extension part instead of literal 'undefined'", () => {
  const msg = {
    id: "m", ts: 1, space: "s", from: { id: "x", name: "a" },
    parts: [{ kind: "text", text: "hi" }, { kind: "image.png", url: "x" }], to: "me",
  } as unknown as CotalMessage;
  assert.equal(textOf(msg), "hi [image.png]");
  assert.ok(!textOf(msg).includes("undefined"));
});

// ── ReplyMap bounded ────────────────────────────────────────────────────────────────────────────
test("ReplyMap evicts oldest past cap", () => {
  const rm = new ReplyMap(2);
  rm.set(42, 1, { name: "a", id: "1" });
  rm.set(42, 2, { name: "b", id: "2" });
  rm.set(42, 3, { name: "c", id: "3" });
  assert.equal(rm.get(42, 1), undefined);
  assert.equal(rm.get(42, 3)?.name, "c");
  assert.equal(rm.size, 2);
});

test("ReplyMap is keyed by (chatId, message_id): a reply in chat B does NOT resolve chat A's ref", () => {
  const rm = new ReplyMap();
  // Same message_id 5 recorded in two different chats → two distinct refs, no cross-talk.
  rm.set(42, 5, { name: "alice", id: "id-alice" });
  rm.set(77, 5, { name: "bob", id: "id-bob" });
  assert.equal(rm.get(42, 5)?.name, "alice");
  assert.equal(rm.get(77, 5)?.name, "bob");
  // A chat that never recorded message_id 5 gets nothing (not a neighbour's ref).
  assert.equal(rm.get(99, 5), undefined);
});

test("routeInbound reply-threading is chat-scoped: chat B's reply to id 5 ignores chat A's ref", () => {
  const c = ctx();
  c.replyMap.set(42, 5, { name: "alice", id: "id-alice" }); // recorded only in chat 42
  // A swipe-reply to message_id 5 arriving in chat 77 must NOT thread to alice — it falls through to
  // the @all default (no ref for (77,5), no sticky yet).
  const a = routeInbound(inb({ text: "thanks", replyToId: 5 }, 77), c);
  assert.deepEqual(a, { kind: "all", text: "thanks", chatId: 77 });
});

// ── chunkMessage ──────────────────────────────────────────────────────────────────────────────────
test("chunkMessage: short text is one chunk; a >limit body splits into multiple ≤limit chunks", () => {
  assert.deepEqual(chunkMessage("hi", 4096), ["hi"]);
  const long = "x".repeat(5000);
  const parts = chunkMessage(long, 4096);
  assert.equal(parts.length, 2);
  assert.ok(parts.every((p) => p.length <= 4096));
  assert.equal(parts.join(""), long, "hard-split loses no characters");
});

test("chunkMessage: prefers newline/space boundaries and consumes the split whitespace", () => {
  // 10 words of 5 chars + spaces; limit 12 forces a split on a space boundary.
  const text = "aaaaa bbbbb ccccc ddddd";
  const parts = chunkMessage(text, 12);
  assert.ok(parts.every((p) => p.length <= 12));
  assert.ok(!parts.some((p) => p.startsWith(" ")), "the boundary space is consumed, not duplicated");
  // Rejoining with a single space reconstructs the original (the only split points were spaces).
  assert.equal(parts.join(" "), text);
});

// ── classifyChat ────────────────────────────────────────────────────────────────────────────────
test("classifyChat: allowlisted → allow; unknown → ignore by DEFAULT (no auto-trust)", () => {
  assert.equal(classifyChat(1, new Set([1])), "allow");
  assert.equal(classifyChat(9, new Set()), "ignore"); // empty list, no opt-in → NOT learned
  assert.equal(classifyChat(9, new Set([1])), "ignore");
});

test("classifyChat: --learn-first-chat learns ONLY while the list is empty", () => {
  assert.equal(classifyChat(9, new Set(), true), "learn"); // opt-in + empty → learn
  assert.equal(classifyChat(9, new Set([1]), true), "ignore"); // opt-in but non-empty → never learn
  assert.equal(classifyChat(1, new Set([1]), true), "allow");
});
