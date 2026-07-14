/**
 * Channel-agnostic config skeleton + local state for a cotal endpoint. Only node stdlib + (elsewhere)
 * @cotal-ai/core — no channel SDK. A concrete channel EXTENDS {@link EndpointConfig} with its own fields
 * (token, api keys, formatting flags) and reuses these state helpers.
 *
 * State lives under `<stateRoot>/<space>/`:
 *   <name>.id           — the pinned open-mesh peer id (same id across restarts so an agent's reply
 *                         redelivers to the SAME durable consumer after a bounce)
 *   <name>.offset       — a transport's poll cursor, so a restart doesn't reprocess buffered updates
 *   chats.json          — the learned chat allowlist (a stranger can't inject onto the mesh)
 *   <name>.sticky.json  — per-chat sticky destinations
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseStickyTarget, type StickyTarget } from "./router.js";

/** Crash-safe write: write a sibling temp file then atomically rename over the target, so a crash
 *  mid-write never leaves a half-written (corrupt) file — the reader sees either the old or the new. */
export function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/** The channel-agnostic config fields every endpoint needs. A channel extends this. */
export interface EndpointConfig {
  space: string;
  server: string;
  /** The mesh peer name the bridge joins under. */
  name: string;
  /** The default broadcast channel (subscribed for reply-forwarding). */
  channel: string;
  /** Optional JWT creds file contents (authed mesh). Absent → open localhost mesh. */
  creds?: string;
  /** Root dir for local state (`<stateRoot>/<space>/…`). */
  stateRoot: string;
  /** Chat ids seeded onto the allowlist via config (e.g. --chat) — the deterministic "I know my chat id"
   *  path. Keeps working alongside `/bind`. */
  seedChats: number[];
  /** DEV/TEST-ONLY (deprecated, default false): trust the FIRST sender's chat when the allowlist is empty
   *  — "first stranger to text the enumerable bot wins", so INSECURE on any real network. Kept as a
   *  hermetic-test / trusted-loopback convenience. The secure bootstrap for a NEW chat is `/bind <code>`
   *  (a mesh-minted, TTL'd, one-time code — see {@link import("./bind.js").BindMinter}); `--chat` seeds
   *  remain the deterministic path. Do NOT enable this in production. */
  learnFirstChat: boolean;
  /** Override for where INBOUND attachments (documents/photos) are saved. Absent → `<stateRoot>/<space>/files/`. */
  filesDir?: string;
  /** Override for the channel a received-file announcement is multicast to. Absent → {@link FILES_CHANNEL_DEFAULT}. */
  filesChannel?: string;
}

/** The default channel a received-file announcement is published to — a DEDICATED #files channel,
 *  distinct from the endpoint's broadcast `channel` (#general), so file-feed subscribers don't have to
 *  wade through chatter. */
export const FILES_CHANNEL_DEFAULT = "files";

/** The channel a received-file announcement is multicast to: the configured `filesChannel` override,
 *  else {@link FILES_CHANNEL_DEFAULT}. Mirrors {@link resolveFilesDir}. */
export function resolveFilesChannel(cfg: EndpointConfig): string {
  return cfg.filesChannel ?? FILES_CHANNEL_DEFAULT;
}

/** `<stateRoot>/<space>/`, created on demand. */
export function stateDir(cfg: EndpointConfig): string {
  const dir = join(cfg.stateRoot, cfg.space);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Where INBOUND attachments land: the configured `filesDir` override, else `<stateRoot>/<space>/files/`.
 *  NOT created here — {@link import("./files.js").saveInboundFile} mkdirs on demand at write time. */
export function resolveFilesDir(cfg: EndpointConfig): string {
  return cfg.filesDir ?? join(stateDir(cfg), "files");
}

/** The pinned open-mesh peer id: read `<name>.id`, else mint one and persist it. cotal 0.11's
 *  owner/actor principal grammar forbids '-' in a token, so the id must be a NATS-safe `[A-Za-z0-9_]`
 *  token — a dashed UUID is rejected on connect ("invalid owner/actor token"). Strip dashes on mint AND
 *  migrate a legacy dashed `.id` file in place so the endpoint keeps the SAME inbox across the upgrade. */
export function peerId(cfg: EndpointConfig): string {
  const file = join(stateDir(cfg), `${cfg.name}.id`);
  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8").trim();
    if (raw) {
      const safe = raw.replace(/-/g, "");
      if (safe !== raw) writeFileAtomic(file, safe);
      return safe;
    }
  }
  const id = randomUUID().replace(/-/g, "");
  // Atomic write: the `.id` file IS the durability guarantee — a half-written/blanked id would mint a
  // NEW id next start, so an agent's replies redeliver to the OLD (dead) consumer and are lost.
  writeFileAtomic(file, id);
  return id;
}

const OFFSET_FILE = (cfg: EndpointConfig) => join(stateDir(cfg), `${cfg.name}.offset`);

export function readOffset(cfg: EndpointConfig): number {
  const f = OFFSET_FILE(cfg);
  if (!existsSync(f)) return 0;
  const n = Number(readFileSync(f, "utf8").trim());
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export function writeOffset(cfg: EndpointConfig, offset: number): void {
  writeFileAtomic(OFFSET_FILE(cfg), String(offset));
}

const CHATS_FILE = (cfg: EndpointConfig) => join(stateDir(cfg), "chats.json");

/** Load the learned chat allowlist (seed chats unioned in). A corrupt/unparseable file must NOT
 *  brick startup — it's logged and treated as empty (the seed chats still apply), so a bad write
 *  degrades to "no learned chats" rather than a fatal JSON.parse throw. */
export function readAllowlist(cfg: EndpointConfig, log?: (m: string) => void): Set<number> {
  const f = CHATS_FILE(cfg);
  const set = new Set<number>(cfg.seedChats);
  if (existsSync(f)) {
    try {
      const arr = JSON.parse(readFileSync(f, "utf8")) as unknown;
      if (Array.isArray(arr)) for (const x of arr) if (Number.isInteger(x)) set.add(x as number);
    } catch (e) {
      (log ?? ((m: string) => console.error(`[cotal-endpoint] ${m}`)))(
        `chats.json is corrupt (${(e as Error).message}) — treating as empty`,
      );
    }
  }
  return set;
}

export function writeAllowlist(cfg: EndpointConfig, chats: Set<number>): void {
  writeFileAtomic(CHATS_FILE(cfg), JSON.stringify([...chats]));
}

const STICKY_FILE = (cfg: EndpointConfig) => join(stateDir(cfg), `${cfg.name}.sticky.json`);

/** Load the per-chat sticky targets (chatId → StickyTarget). Like the allowlist, a corrupt/unparseable
 *  file must NOT brick startup — it's logged and treated as empty (every chat falls back to the @all
 *  default), and any malformed per-chat entry is skipped (parseStickyTarget → undefined). */
export function readSticky(cfg: EndpointConfig, log?: (m: string) => void): Map<number, StickyTarget> {
  const f = STICKY_FILE(cfg);
  const map = new Map<number, StickyTarget>();
  if (existsSync(f)) {
    try {
      const obj = JSON.parse(readFileSync(f, "utf8")) as unknown;
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
          const id = Number(k);
          const t = parseStickyTarget(v);
          if (Number.isInteger(id) && t) map.set(id, t);
        }
      }
    } catch (e) {
      (log ?? ((m: string) => console.error(`[cotal-endpoint] ${m}`)))(
        `sticky file is corrupt (${(e as Error).message}) — treating as empty`,
      );
    }
  }
  return map;
}

export function writeSticky(cfg: EndpointConfig, sticky: Map<number, StickyTarget>): void {
  const obj: Record<string, StickyTarget> = {};
  for (const [k, v] of sticky) obj[k] = v;
  writeFileAtomic(STICKY_FILE(cfg), JSON.stringify(obj));
}
