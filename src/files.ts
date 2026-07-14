/**
 * Channel-agnostic file plumbing: sanitize + save an INBOUND attachment to disk, and parse the OUTBOUND
 * `[[file:…]]` directive an agent embeds in its text. Only node stdlib — no channel SDK. The transport
 * owns the DOWNLOAD (an {@link import("./transport.js").FileRef}); this owns where the bytes land and how
 * an agent asks for a file to be sent back.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/**
 * Reduce an arbitrary claimed filename to a SAFE basename — no path separators, no traversal, no
 * absolute/nul tricks. Keeps the last path segment, strips control chars, and collapses to a fallback
 * when nothing usable is left (a name that was all separators / dots). Pure.
 */
export function sanitizeFilename(name: string, fallback = "file"): string {
  // Take the basename of BOTH separator styles (a Windows-style `a\b.png` from a foreign channel too).
  const base = basename(name.replace(/\\/g, "/"));
  // Drop path/control chars and leading dots (so `..`, `.`, hidden-file tricks can't survive).
  const cleaned = base
    .replace(/[/\\\0-\x1f\x7f]/g, "")
    .replace(/^\.+/, "")
    .trim();
  return cleaned.length ? cleaned : fallback;
}

/**
 * Write `bytes` into `dir` under a sanitized, COLLISION-FREE filename, creating `dir` on demand, and
 * return the ABSOLUTE path written. If the sanitized name already exists, a ` (1)`, ` (2)`… numeric
 * suffix is inserted before the extension until a free name is found — so two files named `photo.jpg`
 * never clobber each other. Fails loud on an I/O error (never a silent partial write).
 */
export function saveInboundFile(dir: string, filename: string, bytes: Uint8Array): string {
  mkdirSync(dir, { recursive: true });
  const safe = sanitizeFilename(filename);
  const target = uniquePath(dir, safe);
  writeFileSync(target, bytes);
  return resolve(target);
}

/** Resolve a free path in `dir` for `safe`, inserting a ` (n)` suffix before the extension on collision. */
function uniquePath(dir: string, safe: string): string {
  const first = join(dir, safe);
  if (!existsSync(first)) return first;
  const dot = safe.lastIndexOf(".");
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : "";
  for (let n = 1; ; n++) {
    const candidate = join(dir, `${stem} (${n})${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
}

/**
 * The wire record announced on the #files channel when the endpoint receives a file. It rides INSIDE
 * the mesh message as a `data` part (discriminated by {@link FILE_PART_PROTO}) and is appended to a
 * local `index.jsonl` manifest. No bytes ever cross the mesh — only this metadata + the ABSOLUTE,
 * already-sanitized `path` a local reader can open directly.
 */
export interface FileEntry {
  /** Schema version — 1 for this shape. */
  v: 1;
  /** When the file was received (ms epoch). */
  ts: number;
  /** The safe basename the bytes were saved under. */
  name: string;
  /** The ABSOLUTE, traversal-sanitized path the bytes landed at. */
  path: string;
  /** Byte size, when known. */
  size?: number;
  /** Declared MIME type, when the channel provided one. */
  mime?: string;
  /** Any caption the sender attached. */
  caption?: string;
  /** Provenance — the endpoint (`cfg.name`) that received it. */
  source: string;
  /** The originating chat id, when known. */
  chatId?: number;
}

/** The `data`-part discriminator for a {@link FileEntry} announcement on the #files channel. */
export const FILE_PART_PROTO = "ai.cotal.file";

/** The manifest file name inside the files dir — one JSON-encoded {@link FileEntry} per line. */
const MANIFEST_FILE = "index.jsonl";

/**
 * Append one {@link FileEntry} as a single JSON line to `<dir>/index.jsonl`, creating `dir` on demand.
 * Fails loud on any I/O error (never a silent partial write) — the announcement itself is best-effort,
 * but this helper reports the truth so the caller can decide. Pure aside from the append.
 */
export function appendFileManifest(dir: string, entry: FileEntry): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, MANIFEST_FILE), JSON.stringify(entry) + "\n");
}

/**
 * Read the `<dir>/index.jsonl` manifest, newest-last, returning the last `limit` entries (all when
 * omitted). Tolerant of a torn/blank FINAL line (a crash mid-append) — that last fragment is dropped.
 * But an EARLIER corrupt line throws (fail loud — a hole in the middle means real corruption, never a
 * fabricated fallback). Returns [] when the manifest doesn't exist yet.
 */
export function readFileManifest(dir: string, limit?: number): FileEntry[] {
  const file = join(dir, MANIFEST_FILE);
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf8");
  if (!raw) return [];
  const lines = raw.split("\n");
  // A trailing newline yields a final "" — and a crash mid-append can leave a torn final fragment; the
  // LAST element is thus allowed to be unparseable and is dropped. Any EARLIER bad line is fatal.
  const lastIdx = lines.length - 1;
  const entries: FileEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue; // blank line (incl. the trailing-newline "") — skip
    try {
      entries.push(JSON.parse(line) as FileEntry);
    } catch (e) {
      if (i === lastIdx) break; // torn final line — tolerate
      throw new Error(`corrupt manifest line ${i + 1} in ${file}: ${(e as Error).message}`);
    }
  }
  // slice(-limit) would be WRONG for limit 0 (`-0 === 0` → slice(0) → all); index from the end instead.
  return limit !== undefined ? entries.slice(Math.max(0, entries.length - limit)) : entries;
}

/** A human-readable one-line announcement for a received file, e.g.
 *  `📎 report.pdf (12.3 KB) saved to /abs/path`. Size omitted when unknown. Pure. */
export function formatFileAnnouncement(entry: FileEntry): string {
  const size = entry.size !== undefined ? ` (${formatBytes(entry.size)})` : "";
  return `📎 ${entry.name}${size} saved to ${entry.path}`;
}

/** Human byte size (B / KB / MB / GB), 1 decimal above bytes. Pure. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let val = n / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(1)} ${units[i]}`;
}

/** A parsed outbound file directive: the local `path`, an optional inline `caption`, and `rest` — the
 *  agent's text with the WHOLE `[[file:…]]` token removed (used as the caption when none is inline). */
export interface FileDirective {
  path: string;
  caption?: string;
  rest: string;
}

// `[[file:<path>]]` or `[[file:<path>|<caption>]]`. The path is everything up to a `|` or the closing
// `]]`; a trailing `|<caption>` is optional. Non-greedy so the FIRST directive wins.
const FILE_DIRECTIVE = /\[\[file:([^\]|]+?)(?:\|([^\]]*))?\]\]/;

/**
 * Parse the first `[[file:<abs-path>]]` (or `[[file:<path>|<caption>]]`) directive out of an agent's
 * outgoing text. Returns undefined when there's no directive (a plain message). `rest` is the text with
 * the directive stripped and trimmed — the bridge uses the inline caption if present, else `rest`. Pure.
 */
export function parseFileDirective(text: string): FileDirective | undefined {
  const m = FILE_DIRECTIVE.exec(text);
  if (!m) return undefined;
  const path = m[1].trim();
  if (!path) return undefined; // `[[file:]]` with no path is not a valid directive
  const inline = m[2]?.trim();
  const rest = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
  return { path, caption: inline || undefined, rest };
}
