// Shared helpers for the core dev team CLI. Node >= 20, no dependencies.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '0.1.0';
export const TEAM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPO_ROOT = path.dirname(TEAM_ROOT);

/** A failure the CLI maps to an exit code: 1 = the check said no, 2 = could not run. */
export class TeamError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

export function stateDir(env = process.env) {
  return path.resolve(env.AGENTIC_TEAM_HOME || path.join(os.homedir(), '.agentic-team'));
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function newKey(bytes = 24) {
  return randomBytes(bytes).toString('hex');
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (fallback !== undefined && err.code === 'ENOENT') return fallback;
    if (fallback !== undefined && err instanceof SyntaxError) {
      throw new TeamError(`invalid JSON in ${file}: ${err.message}`, 2);
    }
    throw err;
  }
}

/** Write through a temp file and rename, so a reader never sees half a file. */
export function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function writeJson(file, value) {
  writeAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

export function appendJsonl(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + '\n');
}

/** Parse a JSONL file; bad lines are returned separately, never silently dropped. */
export function readJsonl(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { records: [], bad: [], missing: true };
    throw err;
  }
  const records = [];
  const bad = [];
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      records.push(JSON.parse(line));
    } catch {
      bad.push(i + 1);
    }
  });
  return { records, bad, missing: false };
}

/** True when `child` resolves inside `parent` (or equals it). */
export function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Throw if any existing component of `target` below `root` is a symlink. */
export function assertNoSymlink(root, target) {
  if (!isInside(root, target)) throw new TeamError(`path escapes its root: ${target}`);
  const rel = path.relative(root, target);
  let cur = path.resolve(root);
  if (fs.existsSync(cur) && fs.lstatSync(cur).isSymbolicLink()) {
    throw new TeamError(`refusing symlink: ${cur}`);
  }
  for (const part of rel ? rel.split(path.sep) : []) {
    cur = path.join(cur, part);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    if (st.isSymbolicLink()) throw new TeamError(`refusing symlink: ${cur}`);
  }
}

/** List files under dir (relative paths, sorted). Symlinks are refused. */
export function listFiles(dir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const a = path.join(abs, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) throw new TeamError(`refusing symlink: ${a}`);
      if (ent.isDirectory()) walk(a, r);
      else if (ent.isFile()) out.push(r);
    }
  };
  walk(dir, '');
  return out;
}

/** Minimal YAML-ish frontmatter parser: top-level `key: value` lines only. */
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text, raw: '' };
  const data = {};
  let lastKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) {
      lastKey = kv[1];
      data[lastKey] = kv[2].replace(/^["']|["']$/g, '');
    } else if (lastKey && /^\s+/.test(line)) {
      data[lastKey] = `${data[lastKey]} ${line.trim()}`.trim();
    }
  }
  return { data, body: text.slice(m[0].length), raw: m[1] };
}

// Same families as tools/publish_check.py, used to keep secrets out of records and output.
const SECRET_PATTERNS = [
  /ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /(?:AKIA|ASIA)[0-9A-Z]{16}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+)?/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b((?:api[_-]?key|secret|passw(?:or)?d|token|authorization)["']?\s*[:=]\s*["']?)[^\s"',;]{8,}/gi,
  /\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/g,
];

export function redact(text) {
  let s = String(text ?? '');
  for (const re of SECRET_PATTERNS) {
    s = s.replace(re, (match, prefix) => (typeof prefix === 'string' && match.startsWith(prefix) ? `${prefix}[redacted]` : '[redacted]'));
  }
  return s;
}

export function clip(text, max = 500) {
  const s = redact(text).replace(/\s+$/g, '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function nowIso(clock = Date.now) {
  return new Date(clock()).toISOString();
}

export function slug(text, max = 40) {
  return (
    String(text)
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/g, '') || 'task'
  );
}

export const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function assertId(id, what = 'id') {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new TeamError(`invalid ${what}: ${JSON.stringify(id)}`);
  return id;
}

/**
 * Exclusive lock file holding pid and start time. Created atomically with its content (link from a temp
 * file), so no reader ever sees an empty lock. A lock older than ttlMs (by mtime) is moved aside with a
 * rename, which only one contender can win, before the next attempt.
 */
export function acquireLock(file, { ttlMs = 30 * 60 * 1000, clock = Date.now } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${newKey(4)}`;
  fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, started: clock() }));
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.linkSync(tmp, file);
        const ino = fs.statSync(file).ino;
        return () => {
          try {
            if (fs.statSync(file).ino === ino) fs.unlinkSync(file);
          } catch {
            /* already gone */
          }
        };
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        let age;
        try {
          let started;
          try {
            started = Number(JSON.parse(fs.readFileSync(file, 'utf8')).started);
          } catch {
            started = NaN;
          }
          age = clock() - (Number.isFinite(started) ? started : fs.statSync(file).mtimeMs);
        } catch {
          continue; // released meanwhile: try again
        }
        if (age < ttlMs) return null;
        const aside = `${file}.stale.${process.pid}.${newKey(4)}`;
        try {
          fs.renameSync(file, aside); // only one process can move this exact file
          fs.rmSync(aside, { force: true });
        } catch {
          return null; // someone else took it over
        }
      }
    }
    return null;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Per-state HMAC key (created on first use, mode 0600) used to sign receipts. */
export function stateKey(state = stateDir()) {
  const file = path.join(state, 'receipt.key');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  fs.mkdirSync(state, { recursive: true });
  const key = newKey(32);
  try {
    fs.writeFileSync(file, key, { flag: 'wx', mode: 0o600 });
    return key;
  } catch (err) {
    if (err.code === 'EEXIST') return fs.readFileSync(file, 'utf8').trim();
    throw err;
  }
}

export function hmac(key, text) {
  return createHmac('sha256', key).update(text).digest('hex');
}

/** Tiny argv parser: --flag value, --flag=value, repeated flags become arrays, bare --flag is true. */
export function parseArgs(argv, { multi = [], bool = [] } = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    let key = a.slice(2);
    let val;
    const eq = key.indexOf('=');
    if (eq >= 0) {
      val = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else if (bool.includes(key) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
      val = true;
    } else {
      val = argv[++i];
    }
    if (multi.includes(key)) (out[key] ||= []).push(val);
    else out[key] = val;
  }
  return out;
}
