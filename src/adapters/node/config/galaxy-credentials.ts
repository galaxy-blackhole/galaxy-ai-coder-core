/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-09-29
 * @desc The Galaxy credential document — one secrets file for every Galaxy host.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Galaxy keeps every provider secret in one owner-only YAML document,
 * `~/.galaxy/credentials.yaml`, written in the shape the DeepSeek Harness
 * credential store reads (`version: 1`, `refs: <ref> -> <secret>`). Pointing DSH
 * at this file is a one-row profile patch, so the desktop app, the CLI, the VS
 * Code extension and the web GUI all read and write the same secrets.
 *
 * The editor works on lines instead of round-tripping YAML on purpose: the file
 * is shared with another writer that preserves comments and formatting, and a
 * full parse/render would silently reformat or drop entries this module does not
 * own (including DSH's `records` block).
 */

/** File name inside the Galaxy home. */
export const GALAXY_CREDENTIALS_FILENAME = "credentials.yaml";
/** Document version this module writes; DSH refuses an unversioned document. */
export const GALAXY_CREDENTIALS_VERSION = 1;

/** Absent or unreadable documents read as empty rather than throwing. */
export interface GalaxyCredentialsDocument {
  readonly refs: Readonly<Record<string, string>>;
  readonly version: number | undefined;
}

/** Absolute path of the shared credential document. */
export function galaxyCredentialsPath(home: string = homedir()): string {
  return join(home, ".galaxy", GALAXY_CREDENTIALS_FILENAME);
}

/**
 * Reference name for one provider id: `galaxy` → `GBH_GALAXY_API_KEY`,
 * `my-gateway` → `GBH_MY_GATEWAY_API_KEY`. DSH resolves a route's `apiKeyEnv`
 * against these names, so the mapping has to be derivable, never hand-kept.
 */
export function galaxyRefName(providerId: string): string {
  const normalized = providerId.trim().replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
  return `GBH_${normalized.length === 0 ? "PROVIDER" : normalized}_API_KEY`;
}

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  /* A plain scalar ends at an inline comment. */
  const comment = value.search(/\s#/);
  return (comment === -1 ? value : value.slice(0, comment)).trim();
}

/** Quote a scalar the way the shared document expects, only when it must. */
export function renderRefValue(value: string): string {
  return /^[A-Za-z0-9._@/+:-]+$/.test(value) ? value : `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

interface RefEntry {
  readonly indent: string;
  readonly key: string;
  readonly line: number;
}

/** Locate the top-level `refs:` block and the entries inside it. */
function findRefsBlock(lines: readonly string[]): { header: number; entries: readonly RefEntry[] } | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^refs:\s*(#.*)?$/.test(lines[index] ?? "")) continue;
    const entries: RefEntry[] = [];
    for (let scan = index + 1; scan < lines.length; scan += 1) {
      const line = lines[scan] ?? "";
      if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
      const match = /^(\s+)([^\s#][^:]*):\s*(.*)$/.exec(line);
      if (match === null) break;
      entries.push({ indent: match[1] ?? "  ", key: unquote(match[2] ?? ""), line: scan });
    }
    return { header: index, entries };
  }
  return undefined;
}

/** Parse the document's refs and version. A flat pre-version file still reads. */
export function parseGalaxyCredentials(text: string): GalaxyCredentialsDocument {
  const lines = text.split(/\r?\n/);
  const versionLine = lines.find(line => /^version:\s*\d+\s*$/.test(line));
  const version = versionLine === undefined ? undefined : Number(versionLine.split(":")[1]?.trim());
  const refs: Record<string, string> = {};
  const block = findRefsBlock(lines);
  if (block !== undefined) {
    for (const entry of block.entries) {
      const raw = lines[entry.line] ?? "";
      refs[entry.key] = unquote(raw.slice(raw.indexOf(":") + 1));
    }
    return Object.freeze({ refs: Object.freeze(refs), version });
  }
  /* Pre-release flat layout: every top-level scalar is a reference. */
  for (const line of lines) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*):\s*(\S.*)$/.exec(line);
    if (match === null || match[1] === "version") continue;
    refs[match[1] as string] = unquote(match[2] ?? "");
  }
  return Object.freeze({ refs: Object.freeze(refs), version });
}

/** Read the document; a missing file is an empty document, never an error. */
export function readGalaxyCredentials(path: string = galaxyCredentialsPath()): GalaxyCredentialsDocument {
  try {
    return parseGalaxyCredentials(readFileSync(path, "utf8"));
  } catch {
    return Object.freeze({ refs: Object.freeze({}), version: undefined });
  }
}

/** One reference value, or undefined when it is absent or empty. */
export function readGalaxyCredential(ref: string, path: string = galaxyCredentialsPath()): string | undefined {
  const value = readGalaxyCredentials(path).refs[ref];
  return value !== undefined && value.length > 0 ? value : undefined;
}

/** Owner-only mode and the refs present, for `config doctor`. */
export interface GalaxyCredentialsHealth {
  readonly exists: boolean;
  readonly mode: string | undefined;
  readonly ownerOnly: boolean;
  readonly refs: readonly string[];
  readonly version: number | undefined;
}

export function galaxyCredentialsHealth(path: string = galaxyCredentialsPath()): GalaxyCredentialsHealth {
  try {
    const info = statSync(path);
    const document = readGalaxyCredentials(path);
    return Object.freeze({
      exists: true,
      mode: (info.mode & 0o777).toString(8),
      ownerOnly: (info.mode & 0o077) === 0,
      refs: Object.freeze(Object.keys(document.refs).sort()),
      version: document.version,
    });
  } catch {
    return Object.freeze({ exists: false, mode: undefined, ownerOnly: true, refs: Object.freeze([]), version: undefined });
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Cross-process writer lock beside the document, so two hosts never interleave. */
function withLock<T>(path: string, run: () => T): T {
  const lock = path + ".lock";
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const handle = openSync(lock, "wx", 0o600);
      closeSync(handle);
      try {
        return run();
      } finally {
        try {
          unlinkSync(lock);
        } catch {
          /* a peer already released it */
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      /* Break a stale lock left by a crashed writer. */
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) unlinkSync(lock);
      } catch {
        /* the lock disappeared meanwhile */
      }
      sleepSync(50);
    }
  }
  throw new Error(`credentials: could not acquire ${lock}`);
}

/**
 * Insert, replace, or remove one reference while leaving every other byte of the
 * document — comments, formatting, and DSH's own `records` block — untouched.
 *
 * @param ref - reference name to write.
 * @param value - secret value; an empty string removes the reference.
 * @param path - document path, defaulting to the shared Galaxy home.
 */
export function upsertGalaxyCredential(ref: string, value: string, path: string = galaxyCredentialsPath()): void {
  withLock(path, () => {
    const exists = existsSync(path);
    const text = exists ? readFileSync(path, "utf8") : "";
    const trailingNewline = text.length === 0 || text.endsWith("\n");
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

    const block = findRefsBlock(lines);
    const encoded = value.length === 0 ? undefined : renderRefValue(value);

    if (block === undefined) {
      if (!lines.some(line => /^version:\s*\d+\s*$/.test(line))) lines.unshift(`version: ${GALAXY_CREDENTIALS_VERSION}`);
      lines.push("refs:");
      if (encoded !== undefined) lines.push(`  ${ref}: ${encoded}`);
    } else {
      const existing = block.entries.find(entry => entry.key === ref);
      if (existing !== undefined) {
        if (encoded === undefined) lines.splice(existing.line, 1);
        else lines[existing.line] = `${existing.indent}${ref}: ${encoded}`;
      } else if (encoded !== undefined) {
        const indent = block.entries[0]?.indent ?? "  ";
        const lastLine = block.entries.length === 0 ? block.header : (block.entries[block.entries.length - 1] as RefEntry).line;
        lines.splice(lastLine + 1, 0, `${indent}${ref}: ${encoded}`);
      }
    }

    const rendered = lines.join("\n") + (trailingNewline ? "\n" : "");
    const temporary = `${path}.${process.pid.toString(36)}.tmp`;
    writeFileSync(temporary, rendered, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  });
}

/** Write several references in one locked pass. */
export function upsertGalaxyCredentials(entries: Readonly<Record<string, string>>, path: string = galaxyCredentialsPath()): void {
  for (const [ref, value] of Object.entries(entries)) upsertGalaxyCredential(ref, value, path);
}
