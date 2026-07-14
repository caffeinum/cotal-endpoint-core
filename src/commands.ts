/**
 * The mesh-generic slash-command layer. An inbound message whose text starts with `/` is a COMMAND
 * (the chat-bot convention), handled HERE and NEVER routed onto the mesh as a peer message.
 *
 * Everything here is MESH-GENERIC — anything a bare {@link CotalEndpoint} peer can serve from the mesh
 * itself (roster/presence/dm/multicast). Deliberately NO `/ps`, `/status`, `/runtime`: those are paw
 * MANAGER ops, and an endpoint is manager-less by design (zero paw coupling — only @cotal-ai/core).
 *
 * The command SET is one table ({@link COMMANDS}) so it's the single source of truth for BOTH the
 * router (dispatch by name/alias) and the channel's command menu ({@link commandMenu}).
 *
 * A handler talks to the world only through {@link CommandEnv} (roster read, unicast/multicast, a
 * reply back to the SAME chat, sticky get/set, identity) — so the whole layer is unit-testable with a
 * fake env, no network and no real endpoint.
 */
import { stickyLabel, type StickyTarget } from "./router.js";

/** What a command handler is allowed to do — the seam the bridge fills with the live endpoint. */
export interface CommandEnv {
  /** Present (non-offline) peers, excluding the bridge itself. */
  roster(): { name: string; status: string }[];
  /** Resolve a name → a present peer (case-insensitive), or undefined if absent/offline. */
  resolveTarget(name: string): { id: string; name: string } | undefined;
  /** DM a resolved peer id on the mesh. */
  unicast(id: string, text: string): Promise<void>;
  /** Broadcast to a channel on the mesh. */
  multicast(text: string, channel: string): Promise<void>;
  /** Send a reply back to the originating chat. */
  reply(text: string): Promise<void>;
  /** This chat's current sticky destination (undefined = unset → plain text defaults to @all). */
  getSticky(): StickyTarget | undefined;
  /** Latch this chat's sticky destination (persisted by the bridge). */
  setSticky(target: StickyTarget): void;
  /** The bridge's own mesh identity + the default broadcast channel (for /here and /help). */
  identity: { name: string; space: string; server: string; defaultChannel: string };
}

export interface CommandSpec {
  /** The command word WITHOUT a leading slash — also the menu key (lowercase, [a-z0-9_]). */
  command: string;
  /** One-line description shown in the `/` autocomplete menu. */
  description: string;
  /** Extra invocation names (e.g. `whoami` → `here`). Not shown separately in the menu. */
  aliases?: string[];
  handler: (args: string, env: CommandEnv) => Promise<void>;
}

/** A parsed `/command …` — `name` is lowercased and slash-stripped; `args` is the trimmed remainder. */
export interface ParsedCommand {
  name: string;
  args: string;
}

/**
 * Detect + parse a bot command. Returns null when `text` is NOT a command (so the caller falls through
 * to the address router). Handles the `/cmd@botname` form (channels append the bot username in groups)
 * by dropping the `@botname` suffix. A lone `/` or `/123` (no letter) is not a command — null, so it
 * routes as a normal message.
 */
export function parseCommand(text: string): ParsedCommand | null {
  const t = text.trim();
  if (!t.startsWith("/")) return null;
  const m = t.match(/^\/([A-Za-z][A-Za-z0-9_]*)(?:@\S+)?(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: (m[2] ?? "").trim() };
}

const fmtRoster = (env: CommandEnv): string => {
  const peers = env.roster();
  if (peers.length === 0) return "no agents present on the mesh.";
  const lines = peers.map((p) => `• ${p.name} — ${p.status}`);
  return `present on the mesh (${peers.length}):\n${lines.join("\n")}`;
};

const HELP_ADDRESSING =
  "addressing (no slash):\n" +
  "• plain text → your sticky target, or 📢 all if none yet\n" +
  "• @name msg → DM that agent + make it sticky\n" +
  "• @all msg → broadcast to every present agent + make it sticky\n" +
  "• #channel msg → broadcast to that channel + make it sticky\n" +
  "• ?role msg → anycast to ONE agent of that role (a single answer)\n" +
  "• swipe-reply to an agent's message → thread back to it";

/**
 * The command table — the ONE source of truth for the router and the channel menu. Mesh-generic only.
 */
export const COMMANDS: CommandSpec[] = [
  {
    command: "who",
    description: "Who's present on the mesh (roster + status)",
    handler: async (_args, env) => {
      await env.reply(fmtRoster(env));
    },
  },
  {
    command: "help",
    description: "List commands and how addressing works",
    handler: async (_args, env) => {
      const cmds = COMMANDS.map((c) => `/${c.command} — ${c.description}`).join("\n");
      await env.reply(`commands:\n${cmds}\n\n${HELP_ADDRESSING}`);
    },
  },
  {
    command: "to",
    description: "Set your sticky DM target: /to <name>",
    handler: async (args, env) => {
      const name = args.split(/\s+/)[0] ?? "";
      if (!name) {
        await env.reply("usage: /to <name>");
        return;
      }
      const tgt = env.resolveTarget(name);
      if (!tgt) {
        const present = env.roster().map((p) => p.name).join(", ") || "(none)";
        await env.reply(`not present: "${name}" — present: ${present}`);
        return;
      }
      env.setSticky({ kind: "dm", name: tgt.name });
      await env.reply(`sticky target → @${tgt.name}. plain messages now DM ${tgt.name}.`);
    },
  },
  {
    command: "dm",
    description: "One-off DM (no sticky change): /dm <name> <msg>",
    handler: async (args, env) => {
      const m = args.match(/^(\S+)\s+([\s\S]+)$/);
      if (!m) {
        await env.reply("usage: /dm <name> <msg>");
        return;
      }
      const [, name, text] = m;
      const tgt = env.resolveTarget(name);
      if (!tgt) {
        const present = env.roster().map((p) => p.name).join(", ") || "(none)";
        await env.reply(`no peer "${name}" on the mesh — present: ${present}`);
        return;
      }
      await env.unicast(tgt.id, text);
      await env.reply(`→ @${tgt.name} (one-off): ${text}`);
    },
  },
  {
    command: "here",
    description: "This bridge's identity + your current target",
    aliases: ["whoami"],
    handler: async (_args, env) => {
      const sticky = env.getSticky();
      const target = sticky
        ? `${stickyLabel(sticky)} (sticky)`
        : "none yet — plain text goes to 📢 all";
      await env.reply(
        `bridge peer: ${env.identity.name}\n` +
          `space: ${env.identity.space}\n` +
          `server: ${env.identity.server}\n` +
          `target: ${target}`,
      );
    },
  },
];

const BY_NAME: Map<string, CommandSpec> = (() => {
  const map = new Map<string, CommandSpec>();
  for (const c of COMMANDS) {
    map.set(c.command, c);
    for (const a of c.aliases ?? []) map.set(a, c);
  }
  return map;
})();

/**
 * Run a parsed command through {@link COMMANDS}. An unknown `/command` replies a short, friendly
 * pointer to /help (never silent). Returns nothing — all effects go through `env`.
 */
export async function runCommand(parsed: ParsedCommand, env: CommandEnv): Promise<void> {
  const spec = BY_NAME.get(parsed.name);
  if (!spec) {
    await env.reply(`unknown command "/${parsed.name}" — try /help`);
    return;
  }
  await spec.handler(parsed.args, env);
}

/** The `{command, description}` list for the channel's command menu — primary commands only (no aliases). */
export function commandMenu(): { command: string; description: string }[] {
  return COMMANDS.map((c) => ({ command: c.command, description: c.description }));
}
