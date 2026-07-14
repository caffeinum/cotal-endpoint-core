/**
 * Hermetic checks for the mesh-generic slash-command layer: the parser, each command's routing/response
 * against a fake CommandEnv, the menu table, the command-scope self-management (default + private), and —
 * through the bridge with fakes — that a leading-`/` message is handled as a COMMAND and is NOT sent to a
 * peer/channel. `tsx --test test/commands.test.ts`.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  commandMenu,
  COMMANDS,
  parseCommand,
  runBridge,
  runCommand,
  type CommandEnv,
  type EndpointConfig,
  type StickyTarget,
} from "../src/index.js";
import { FakeEndpoint, FakeTransport, inbound, tick } from "./fakes.js";

// ── a recording fake CommandEnv ──────────────────────────────────────────────────────────────────
interface Rec {
  replies: string[];
  unicasts: { id: string; text: string }[];
  multicasts: { text: string; channel: string }[];
  sticky: StickyTarget | undefined;
  bound: string[];
}

function fakeEnv(
  roster: { name: string; status: string }[] = [],
  over: Partial<CommandEnv> = {},
): { env: CommandEnv; rec: Rec } {
  const rec: Rec = { replies: [], unicasts: [], multicasts: [], sticky: undefined, bound: [] };
  const env: CommandEnv = {
    roster: () => roster,
    resolveTarget: (name) => {
      const hit = roster.find((p) => p.name.toLowerCase() === name.toLowerCase());
      return hit ? { id: "id-" + hit.name, name: hit.name } : undefined;
    },
    unicast: async (id, text) => { rec.unicasts.push({ id, text }); },
    multicast: async (text, channel) => { rec.multicasts.push({ text, channel }); },
    reply: async (text) => { rec.replies.push(text); },
    getSticky: () => rec.sticky,
    setSticky: (target) => { rec.sticky = target; },
    tryBind: (code) => { rec.bound.push(code); return code === "GOOD42"; },
    identity: { name: "telegram", space: "paw", server: "nats://127.0.0.1:4222", defaultChannel: "general" },
    ...over,
  };
  return { env, rec };
}

// ── parseCommand ─────────────────────────────────────────────────────────────────────────────────
test("parseCommand: plain command, args, and lowercasing", () => {
  assert.deepEqual(parseCommand("/who"), { name: "who", args: "" });
  assert.deepEqual(parseCommand("/TO alice"), { name: "to", args: "alice" });
  assert.deepEqual(parseCommand("  /dm bob hey there  "), { name: "dm", args: "bob hey there" });
});

test("parseCommand: strips a /cmd@botname suffix (group form)", () => {
  assert.deepEqual(parseCommand("/who@candlestick_dev_bot"), { name: "who", args: "" });
  assert.deepEqual(parseCommand("/dm@some_bot bob hi"), { name: "dm", args: "bob hi" });
});

test("parseCommand: non-commands return null (so they route as messages)", () => {
  assert.equal(parseCommand("hello"), null);
  assert.equal(parseCommand("@alice hi"), null);
  assert.equal(parseCommand("#eng deploy"), null);
  assert.equal(parseCommand("/"), null); // lone slash — not a command word
  assert.equal(parseCommand("/123"), null); // must start with a letter
});

// ── /who ─────────────────────────────────────────────────────────────────────────────────────────
test("/who renders the roster with status; none → clear message", async () => {
  const { env, rec } = fakeEnv([{ name: "alice", status: "working" }, { name: "bob", status: "idle" }]);
  await runCommand(parseCommand("/who")!, env);
  assert.match(rec.replies[0], /present on the mesh \(2\)/);
  assert.match(rec.replies[0], /• alice — working/);
  assert.match(rec.replies[0], /• bob — idle/);

  const empty = fakeEnv([]);
  await runCommand(parseCommand("/who")!, empty.env);
  assert.match(empty.rec.replies[0], /no agents present/);
});

// ── /to ──────────────────────────────────────────────────────────────────────────────────────────
test("/to sets sticky when present; rejects an absent name with the roster", async () => {
  const { env, rec } = fakeEnv([{ name: "alice", status: "idle" }]);
  await runCommand(parseCommand("/to alice")!, env);
  assert.deepEqual(rec.sticky, { kind: "dm", name: "alice" });
  assert.match(rec.replies[0], /sticky target → @alice/);

  const { env: e2, rec: r2 } = fakeEnv([{ name: "alice", status: "idle" }]);
  await runCommand(parseCommand("/to ghost")!, e2);
  assert.equal(r2.sticky, undefined);
  assert.match(r2.replies[0], /not present: "ghost"/);
  assert.match(r2.replies[0], /present: alice/);
});

test("/to with no name → usage", async () => {
  const { env, rec } = fakeEnv([]);
  await runCommand(parseCommand("/to")!, env);
  assert.match(rec.replies[0], /usage: \/to <name>/);
});

// ── /switch (buttons; SEPARATE from /who) ──────────────────────────────────────────────────────────
test("/switch renders one button per present agent + 📢 all + #<defaultChannel> via sendButtons", async () => {
  const sent: { prompt: string; choices: { label: string; data: string }[] }[] = [];
  const { env } = fakeEnv(
    [{ name: "alice", status: "idle" }, { name: "bob", status: "working" }],
    { sendButtons: async (prompt, choices) => { sent.push({ prompt, choices }); } },
  );
  await runCommand(parseCommand("/switch")!, env);
  assert.equal(sent.length, 1, "one button prompt sent");
  assert.equal(sent[0].prompt, "Switch this chat to:");
  assert.deepEqual(sent[0].choices, [
    { label: "@alice", data: "sw|dm|alice" },
    { label: "@bob", data: "sw|dm|bob" },
    { label: "📢 all", data: "sw|all" },
    { label: "#general", data: "sw|ch|general" }, // fakeEnv identity.defaultChannel = "general"
  ]);
});

test("/switch degrades to a /to text hint when the channel has no button seam", async () => {
  const { env, rec } = fakeEnv([{ name: "alice", status: "idle" }]); // no sendButtons on this env
  await runCommand(parseCommand("/switch")!, env);
  assert.match(rec.replies[0], /buttons unsupported here — use \/to <name>/);
});

// ── /dm ──────────────────────────────────────────────────────────────────────────────────────────
test("/dm unicasts to a present peer WITHOUT changing sticky", async () => {
  const { env, rec } = fakeEnv([{ name: "alice", status: "idle" }]);
  await runCommand(parseCommand("/dm alice ship it")!, env);
  assert.deepEqual(rec.unicasts, [{ id: "id-alice", text: "ship it" }]);
  assert.equal(rec.sticky, undefined, "one-off DM must not latch sticky");
  assert.match(rec.replies[0], /→ @alice \(one-off\): ship it/);
});

test("/dm to an absent peer → no-peer error, no unicast", async () => {
  const { env, rec } = fakeEnv([{ name: "alice", status: "idle" }]);
  await runCommand(parseCommand("/dm ghost yo")!, env);
  assert.equal(rec.unicasts.length, 0);
  assert.match(rec.replies[0], /no peer "ghost"/);
});

test("/dm missing message → usage", async () => {
  const { env, rec } = fakeEnv([{ name: "alice", status: "idle" }]);
  await runCommand(parseCommand("/dm alice")!, env);
  assert.equal(rec.unicasts.length, 0);
  assert.match(rec.replies[0], /usage: \/dm <name> <msg>/);
});

// ── /say is REMOVED (redundant with #channel / @all routing) ──────────────────────────────────────
test("/say is no longer a command → unknown-command pointer (use #channel / @all instead)", async () => {
  const { env, rec } = fakeEnv([]);
  await runCommand(parseCommand("/say deploying now")!, env);
  assert.equal(rec.multicasts.length, 0, "/say must not broadcast — it's removed");
  assert.match(rec.replies[0], /unknown command "\/say" — try \/help/);
});

// ── /here + /whoami alias ────────────────────────────────────────────────────────────────────────
test("/here reports identity + target; /whoami is an alias", async () => {
  const { env, rec } = fakeEnv([{ name: "alice", status: "idle" }]);
  await runCommand(parseCommand("/here")!, env);
  assert.match(rec.replies[0], /bridge peer: telegram/);
  assert.match(rec.replies[0], /space: paw/);
  assert.match(rec.replies[0], /target: none yet — plain text goes to 📢 all/);

  rec.sticky = { kind: "dm", name: "alice" };
  await runCommand(parseCommand("/whoami")!, env);
  assert.match(rec.replies[1], /target: @alice \(sticky\)/);
});

// ── /help + unknown ──────────────────────────────────────────────────────────────────────────────
test("/help lists every command + explains addressing", async () => {
  const { env, rec } = fakeEnv([]);
  await runCommand(parseCommand("/help")!, env);
  for (const c of COMMANDS) assert.match(rec.replies[0], new RegExp(`/${c.command} `));
  assert.match(rec.replies[0], /@name msg → DM/);
  assert.match(rec.replies[0], /swipe-reply/);
});

test("unknown /command → friendly /help pointer (not silent)", async () => {
  const { env, rec } = fakeEnv([]);
  await runCommand(parseCommand("/frobnicate x")!, env);
  assert.match(rec.replies[0], /unknown command "\/frobnicate" — try \/help/);
});

// ── /bind ────────────────────────────────────────────────────────────────────────────────────────
test("/bind <valid> → tryBind called + authorized confirmation", async () => {
  const { env, rec } = fakeEnv();
  await runCommand(parseCommand("/bind GOOD42")!, env);
  assert.deepEqual(rec.bound, ["GOOD42"]);
  assert.match(rec.replies[0], /this chat is now authorized/);
});

test("/bind <wrong> → generic reject, no oracle", async () => {
  const { env, rec } = fakeEnv();
  await runCommand(parseCommand("/bind NOPE00")!, env);
  assert.deepEqual(rec.bound, ["NOPE00"]);
  assert.equal(rec.replies[0], "invalid or expired code");
});

test("/bind with no code → usage, tryBind not called (reveals no code state)", async () => {
  const { env, rec } = fakeEnv();
  await runCommand(parseCommand("/bind")!, env);
  assert.equal(rec.bound.length, 0);
  assert.match(rec.replies[0], /usage: \/bind <code>/);
});

// ── commandMenu ──────────────────────────────────────────────────────────────────────────────────
test("commandMenu is the table's primary commands, all valid keys", () => {
  const menu = commandMenu();
  assert.deepEqual(menu.map((c) => c.command), ["who", "help", "to", "switch", "dm", "here", "bind"]);
  for (const c of menu) {
    assert.match(c.command, /^[a-z][a-z0-9_]{0,31}$/, `bad command key: ${c.command}`);
    assert.ok(c.description.length > 0 && c.description.length <= 256);
  }
});

// ── through the bridge: a leading-`/` message is a COMMAND, never routed to a peer/channel ─────────
function cfgIn(dir: string, over: Partial<EndpointConfig> = {}): EndpointConfig {
  return { space: "t", server: "nats://127.0.0.1:4222", name: "telegram", channel: "general", stateRoot: dir, seedChats: [42], learnFirstChat: false, ...over };
}

test("bridge: command menu is registered on BOTH default and private scopes (stale-menu fix)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ep-"));
  const ep = new FakeEndpoint();
  const tp = new FakeTransport();
  const bridge = await runBridge(cfgIn(dir), tp, { buildEndpoint: () => ep as never, log: () => {} });
  await tick();
  await bridge.stop();
  // Registered twice: default scope (undefined) THEN the private scope (which overrides default in PMs,
  // so a stale scoped list from a prior bot can't hide our menu).
  assert.equal(tp.commandsSet.length, 2);
  assert.deepEqual(tp.commandsSet[0], { cmds: commandMenu(), scope: undefined });
  assert.deepEqual(tp.commandsSet[1], { cmds: commandMenu(), scope: "private" });
});

test("bridge: a /who message replies to the chat and is NOT sent to a peer/channel", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ep-"));
  const ep = new FakeEndpoint();
  ep.roster = [{ card: { id: "id-bob", name: "bob" }, status: "idle" }];
  const tp = new FakeTransport();
  tp.inbounds.push(inbound("/who"));
  const bridge = await runBridge(cfgIn(dir), tp, { buildEndpoint: () => ep as never, log: () => {} });
  await tick();
  await tick();
  await bridge.stop();
  assert.equal(ep.unicasts.length, 0, "/who must not DM a peer");
  assert.equal(ep.multicasts.length, 0, "/who must not broadcast");
  const reply = tp.sends.find((s) => s.chatId === 42 && /present on the mesh/.test(s.text));
  assert.ok(reply, "expected a /who roster reply to chat 42");
});

test("bridge: /dm <name> routes as a COMMAND (unicast + confirm), not the address router", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ep-"));
  const ep = new FakeEndpoint();
  ep.roster = [{ card: { id: "id-bob", name: "bob" }, status: "idle" }];
  const tp = new FakeTransport();
  tp.inbounds.push(inbound("/dm bob hello"));
  const bridge = await runBridge(cfgIn(dir), tp, { buildEndpoint: () => ep as never, log: () => {} });
  await tick();
  await tick();
  await bridge.stop();
  assert.deepEqual(ep.unicasts, [{ id: "id-bob", text: "hello" }]);
  assert.ok(tp.sends.some((s) => /→ @bob \(one-off\)/.test(s.text)), "expected a /dm confirmation reply");
});
