// Scout and adopt third-party skills (SDD section 7.5).
//
// Everything fetched here is DATA: stored as text in the state directory, never executed, never loaded
// as instructions. The trust scan is advisory; adoption waits for a person (`adopt <id>`).
// Only `gh search repos` and `gh api --method GET` are used: no credentials handled, no URL hard-coded.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { scanFiles } from './trust.mjs';
import {
  TEAM_ROOT,
  TeamError,
  stateDir,
  sha256,
  readJson,
  readJsonl,
  writeJson,
  writeAtomic,
  parseFrontmatter,
  assertId,
  ID_RE,
  isInside,
  listFiles,
  clip,
  nowIso,
  slug,
} from './util.mjs';

const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const LICENCE_RE = /^(?:LICEN[CS]E|COPYING)(?:\.[A-Za-z]+)?$/i;
const SCOUT_FILE_RE = /^scout-\d{8}T\d{6}Z\.json$/;
const MAX_BLOB_BYTES = 1024 * 1024;

/** Default gh runner: execFile without a shell, 32 MB output buffer. */
export function defaultGh(args) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new TeamError(`gh ${args.slice(0, 2).join(' ')} failed: ${clip(stderr || err.message, 300)}`, 2));
      else resolve(stdout);
    });
  });
}

/** Git blob id: sha1 over `blob <len>\0<content>`. */
export function gitBlobSha(buf) {
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

export function assertRepo(fullName) {
  const parts = String(fullName ?? '').split('/');
  if (parts.length !== 2 || parts.some((p) => !NAME_RE.test(p) || p === '.' || p === '..')) {
    throw new TeamError(`invalid repository name: ${JSON.stringify(clip(String(fullName), 100))}`);
  }
  return parts;
}

/** Tree paths: relative, forward slashes, no empty, `.` or `..` segment, no control characters. */
export function safeTreePath(p) {
  if (typeof p !== 'string' || !p || p.startsWith('/') || p.includes('\\') || /[\0-\x1f]/.test(p)) return false;
  return p.split('/').every((seg) => seg && seg !== '.' && seg !== '..');
}

function assertSafePath(p) {
  if (!safeTreePath(p)) throw new TeamError(`unsafe path: ${JSON.stringify(clip(String(p), 100))}`);
  return p;
}

export function loadConfig(config) {
  const c = config ?? readJson(path.join(TEAM_ROOT, 'scout.json'));
  const int = (v, def, max) => {
    const n = Number(v ?? def);
    if (!Number.isInteger(n) || n < 0 || n > max) throw new TeamError(`invalid scout config value: ${v}`, 2);
    return n;
  };
  const queries = Array.isArray(c.queries) ? c.queries : [];
  for (const q of queries) {
    if (typeof q !== 'string' || !q.trim() || q.startsWith('-')) throw new TeamError(`invalid scout query: ${JSON.stringify(q)}`, 2);
  }
  return {
    queries,
    minStars: int(c.minStars, 200, 10_000_000),
    maxAgeDays: int(c.maxAgeDays, 365, 36_500),
    reposPerQuery: Math.max(1, int(c.reposPerQuery, 10, 100)),
    maxSkillsPerRepo: Math.max(1, int(c.maxSkillsPerRepo, 40, 1000)),
    maxFilesPerSkill: Math.max(1, int(c.maxFilesPerSkill, 20, 1000)),
  };
}

function stamp(ts) {
  return ts.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

async function ghJson(gh, args) {
  const out = await gh(args);
  try {
    return JSON.parse(out);
  } catch {
    throw new TeamError(`gh ${args.slice(0, 3).join(' ')} returned invalid JSON`, 2);
  }
}

async function fetchBlob(gh, owner, repo, sha) {
  if (!SHA_RE.test(sha)) throw new TeamError(`invalid blob sha: ${JSON.stringify(clip(String(sha), 60))}`);
  const blob = await ghJson(gh, ['api', '--method', 'GET', `repos/${owner}/${repo}/git/blobs/${sha}`]);
  if (blob.encoding && blob.encoding !== 'base64') throw new TeamError(`unexpected blob encoding for ${sha}`);
  const buf = Buffer.from(String(blob.content ?? '').replace(/\s+/g, ''), 'base64');
  return { buf, actual: gitBlobSha(buf) };
}

// ---- licence ---------------------------------------------------------------------------------------

// Built at runtime so the SPDX ids read as data; see the publish-check note in the tests.
// Licence ids are lower-case SPDX identifiers.
export const ALLOWED_LICENCES = ['mit', 'apache-2.0', 'bsd-2-clause', 'bsd-3-clause', 'isc'];

/** Classify licence text by its distinctive wording; anything unrecognised is `unknown` (fails). */
export function classifyLicence(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ');
  if (/Apache License,? Version 2\.0/i.test(t)) return 'apache-2.0';
  if (/Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee is hereby granted/i.test(t)) return 'isc';
  if (/Permission is hereby granted, free of charge, to any person obtaining a copy/i.test(t) && /PROVIDED "?AS IS"?/i.test(t)) return 'mit';
  if (/Redistribution and use in source and binary forms, with or without modification, are permitted/i.test(t)) {
    if (/GNU|General Public License/i.test(t)) return 'unknown';
    return /Neither the name|endorse or promote products/i.test(t) ? 'bsd-3-clause' : 'bsd-2-clause';
  }
  return 'unknown';
}

// ---- fit -----------------------------------------------------------------------------------------

const STOPWORDS = new Set(
  ('this that with from when what your into used uses have will only after before they them then than ' +
    'each also such other more most should which where there their about every does make using need ' +
    'skill skills agent agents claude code here these those over under while must been being were')
    .split(' '),
);

export function tokens(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w)),
  );
}

export function loadAgents(state) {
  const { records } = readJsonl(path.join(state, 'agent-scores.jsonl'));
  const last = records[records.length - 1];
  if (last && Array.isArray(last.agents) && last.agents.length) {
    return last.agents.map((a) => ({
      name: String(a.name ?? ''),
      text: `${a.description ?? ''} ${Array.isArray(a.failed) ? a.failed.join(' ') : ''}`,
    }));
  }
  const dir = path.join(TEAM_ROOT, 'core', 'agents');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return names.map((n) => {
    const { data } = parseFrontmatter(fs.readFileSync(path.join(dir, n), 'utf8'));
    return { name: data.name || n.replace(/\.md$/, ''), text: data.description || '' };
  });
}

/** Jaccard overlap of candidate and agent tokens, x100 rounded; top three agents with any overlap. */
export function fitScore(candidateText, agents) {
  const c = tokens(candidateText);
  const scored = agents
    .map((a) => {
      const t = tokens(a.text);
      let inter = 0;
      for (const w of c) if (t.has(w)) inter++;
      const union = c.size + t.size - inter;
      return { name: a.name, score: union ? Math.round((inter / union) * 100) : 0 };
    })
    .filter((a) => a.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 3);
  return { score: scored[0]?.score ?? 0, agents: scored };
}

// ---- ids ------------------------------------------------------------------------------------------

export function candidateId(owner, repo, dir, used = new Set()) {
  const base = slug(`${owner}-${repo}-${dir || 'root'}`, 64);
  let id = base;
  for (let n = 2; used.has(id); n++) {
    const suffix = `-${n}`;
    id = `${base.slice(0, 64 - suffix.length).replace(/-+$/, '')}${suffix}`;
  }
  if (!ID_RE.test(id)) throw new TeamError(`could not derive a candidate id from ${owner}/${repo}`);
  used.add(id);
  return id;
}

// ---- scout ----------------------------------------------------------------------------------------

async function searchRepos(gh, cfg, errors) {
  const seen = new Map();
  for (const query of cfg.queries) {
    try {
      const rows = await ghJson(gh, [
        'search', 'repos', query,
        '--sort', 'stars',
        '--limit', String(cfg.reposPerQuery),
        '--json', 'fullName,stargazersCount,pushedAt,license,description',
      ]);
      if (!Array.isArray(rows)) throw new TeamError('search returned a non-array');
      for (const r of rows) if (r && r.fullName && !seen.has(r.fullName)) seen.set(r.fullName, r);
    } catch (err) {
      errors.push({ query, error: clip(err.message, 300) });
    }
  }
  return [...seen.values()];
}

async function scoutRepo(gh, row, ctx) {
  const [owner, repo] = assertRepo(row.fullName);
  const full = `${owner}/${repo}`;
  const commit = String(await gh(['api', '--method', 'GET', `repos/${owner}/${repo}/commits/HEAD`, '--jq', '.sha'])).trim();
  if (!SHA_RE.test(commit)) throw new TeamError(`unexpected commit sha for ${full}`);
  const tree = await ghJson(gh, ['api', '--method', 'GET', `repos/${owner}/${repo}/git/trees/${commit}?recursive=1`]);
  if (tree.truncated) {
    // A partial listing could hide a non-Markdown file inside a skill, so the repository is skipped.
    ctx.errors.push({ repo: full, error: 'tree listing truncated; repository skipped (scan would be incomplete)' });
    return;
  }
  const entries = (Array.isArray(tree.tree) ? tree.tree : []).filter((e) => e && e.type === 'blob');
  const bad = entries.find((e) => !safeTreePath(e.path) || !SHA_RE.test(String(e.sha)));
  if (bad) {
    ctx.errors.push({ repo: full, error: 'tree contains an unsafe path or invalid sha; repository skipped' });
    return;
  }
  let skillDirs = entries
    .filter((e) => path.posix.basename(e.path) === 'SKILL.md')
    .map((e) => (path.posix.dirname(e.path) === '.' ? '' : path.posix.dirname(e.path)))
    .sort();
  if (skillDirs.length > ctx.cfg.maxSkillsPerRepo) {
    ctx.errors.push({ repo: full, error: `${skillDirs.length} skills found; only the first ${ctx.cfg.maxSkillsPerRepo} scanned` });
    skillDirs = skillDirs.slice(0, ctx.cfg.maxSkillsPerRepo);
  }
  const rootLicence = entries.find((e) => !e.path.includes('/') && LICENCE_RE.test(e.path));
  const blobCache = new Map();
  const getText = async (entry) => {
    if (!blobCache.has(entry.sha)) {
      const { buf, actual } = await fetchBlob(gh, owner, repo, entry.sha);
      if (actual !== entry.sha) throw new TeamError(`blob ${entry.path} does not match its sha`);
      blobCache.set(entry.sha, buf.toString('utf8'));
    }
    return blobCache.get(entry.sha);
  };

  for (const dir of skillDirs) {
    try {
      // Files of this skill only: a nested skill directory below it is its own candidate.
      const nested = skillDirs.filter((d) => d !== dir && (dir ? d.startsWith(`${dir}/`) : true));
      const under = entries.filter(
        (e) => (dir ? e.path.startsWith(`${dir}/`) : true) && !nested.some((d) => e.path.startsWith(`${d}/`)),
      );
      if (under.length > ctx.cfg.maxFilesPerSkill) {
        ctx.errors.push({ repo: full, dir, error: `${under.length} files exceed maxFilesPerSkill ${ctx.cfg.maxFilesPerSkill}; skill skipped` });
        continue;
      }
      const files = [];
      const scanInput = [];
      const sizeFlags = [];
      for (const e of under) {
        const rel = dir ? e.path.slice(dir.length + 1) : e.path;
        const size = Number(e.size) || 0;
        files.push({ path: rel, sha: e.sha, size });
        if (size > MAX_BLOB_BYTES) {
          // Not fetched at all; the size rule fails the candidate.
          sizeFlags.push({ file: rel, rule: 'size', line: 0 });
          continue;
        }
        scanInput.push({ path: rel, text: await getText(e) });
      }
      const skillMd = scanInput.find((f) => f.path === 'SKILL.md');
      const { data } = parseFrontmatter(skillMd?.text ?? '');

      const localLicence = under.find((e) => {
        const rel = dir ? e.path.slice(dir.length + 1) : e.path;
        return !rel.includes('/') && LICENCE_RE.test(rel);
      });
      const licEntry = localLicence || rootLicence;
      let license = { spdx: 'unknown', pass: false, file: null, sha: null };
      if (licEntry) {
        const text = await getText(licEntry);
        const spdx = classifyLicence(text);
        license = { spdx, pass: spdx !== 'unknown', file: licEntry.path, sha: licEntry.sha, size: Number(licEntry.size) || 0 };
      }

      const scan = scanFiles(scanInput);
      const trust = { pass: scan.pass && sizeFlags.length === 0, flags: [...scan.flags, ...sizeFlags] };
      const id = candidateId(owner, repo, dir, ctx.used);
      const description = clip(data.description ?? '', 300);
      const candidate = {
        id,
        repo: full,
        stars: Number(row.stargazersCount) || 0,
        pushedAt: row.pushedAt,
        commit,
        dir,
        name: clip(data.name || path.posix.basename(dir || repo), 100),
        description,
        files,
        license,
        trust,
        fit: fitScore(`${data.name ?? ''} ${data.description ?? ''}`, ctx.agents),
        eligible: trust.pass && license.pass,
      };
      ctx.candidates.push(candidate);
      if (!ctx.dryRun) {
        const root = path.join(ctx.state, 'candidates', 'files', id);
        fs.rmSync(root, { recursive: true, force: true });
        for (const f of scanInput) {
          const target = path.join(root, ...f.path.split('/'));
          if (!isInside(root, target)) throw new TeamError(`path escapes candidate dir: ${f.path}`);
          writeAtomic(target, f.text);
        }
      }
    } catch (err) {
      ctx.errors.push({ repo: full, dir, error: clip(err.message, 300) });
    }
  }
}

export async function scout({ gh = defaultGh, state = stateDir(), config, clock = Date.now, dryRun = false } = {}) {
  const cfg = loadConfig(config);
  const ts = nowIso(clock);
  const errors = [];
  const ctx = { cfg, state, dryRun, errors, candidates: [], used: new Set(), agents: loadAgents(state) };
  const cutoff = clock() - cfg.maxAgeDays * 86_400_000;
  const rows = await searchRepos(gh, cfg, errors);
  for (const row of rows) {
    if ((Number(row.stargazersCount) || 0) < cfg.minStars) continue;
    const pushed = Date.parse(row.pushedAt);
    if (!Number.isFinite(pushed) || pushed < cutoff) continue;
    try {
      await scoutRepo(gh, row, ctx);
    } catch (err) {
      errors.push({ repo: clip(String(row.fullName), 100), error: clip(err.message, 300) });
    }
  }
  const result = { ts, queries: cfg.queries, minStars: cfg.minStars, candidates: ctx.candidates, errors };
  if (!dryRun) writeJson(path.join(state, 'candidates', `scout-${stamp(ts)}.json`), result);
  return result;
}

// ---- adopt ----------------------------------------------------------------------------------------

export function findCandidate(id, state) {
  const dir = path.join(state, 'candidates');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => SCOUT_FILE_RE.test(n)).sort().reverse();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (const n of names) {
    const doc = readJson(path.join(dir, n), {});
    const c = (doc.candidates || []).find((x) => x && x.id === id);
    if (c) return c;
  }
  return null;
}

export async function adopt(id, { gh = defaultGh, state = stateDir(), clock = Date.now } = {}) {
  assertId(id, 'candidate id');
  const c = findCandidate(id, state);
  if (!c) throw new TeamError(`no scouted candidate ${id}; run scout first`);
  if (!c.eligible || !c.trust?.pass || !c.license?.pass) {
    throw new TeamError(`candidate ${id} is not eligible (trust ${c.trust?.pass ? 'pass' : 'fail'}, licence ${c.license?.spdx ?? 'unknown'})`);
  }
  const [owner, repo] = assertRepo(c.repo);

  // Re-fetch exactly the recorded blob shas; any difference refuses the adoption.
  const fetched = [];
  for (const f of c.files || []) {
    assertSafePath(f.path);
    const { buf, actual } = await fetchBlob(gh, owner, repo, f.sha);
    if (actual !== f.sha) throw new TeamError(`blob mismatch for ${f.path}: recorded ${f.sha}, fetched ${actual}`);
    fetched.push({ path: f.path, buf });
  }
  if (!fetched.some((f) => f.path === 'SKILL.md')) throw new TeamError(`candidate ${id} has no SKILL.md`);

  const lic = c.license;
  assertSafePath(lic.file);
  const licBase = path.posix.basename(lic.file);
  const licInside = c.dir ? lic.file.startsWith(`${c.dir}/`) : true;
  const licRel = licInside ? (c.dir ? lic.file.slice(c.dir.length + 1) : lic.file) : licBase;
  let licBuf = fetched.find((f) => f.path === licRel)?.buf;
  if (!licBuf) {
    const { buf, actual } = await fetchBlob(gh, owner, repo, lic.sha);
    if (actual !== lic.sha) throw new TeamError(`blob mismatch for licence ${lic.file}`);
    licBuf = buf;
    fetched.push({ path: licRel, buf });
  }
  const spdx = classifyLicence(licBuf.toString('utf8'));
  if (spdx === 'unknown') throw new TeamError(`licence of ${id} no longer classifies as an allowed licence`);

  const scan = scanFiles(fetched.map((f) => ({ path: f.path, text: f.buf.toString('utf8') })));
  if (!scan.pass) throw new TeamError(`candidate ${id} fails the trust scan on re-fetch (${scan.flags.length} flag(s))`);

  const root = path.join(state, 'adopted', id);
  fs.rmSync(root, { recursive: true, force: true });
  for (const f of fetched) {
    const target = path.join(root, ...f.path.split('/'));
    if (!isInside(root, target) || target === root) throw new TeamError(`path escapes adopted dir: ${f.path}`);
    writeAtomic(target, f.buf);
  }

  const lockFile = path.join(state, 'adopted.lock.json');
  const lock = readJson(lockFile, { skills: {} });
  if (!lock.skills || typeof lock.skills !== 'object') lock.skills = {};
  const entry = {
    repo: c.repo,
    commit: c.commit,
    dir: c.dir,
    license: { spdx, file: lic.file },
    files: fetched.map((f) => ({ path: f.path, sha256: sha256(f.buf) })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    adoptedAt: nowIso(clock),
  };
  lock.skills[id] = entry;
  writeJson(lockFile, lock);
  return entry;
}

/** Compare adopted files with the lock: missing, changed and unexpected files are problems. */
export function verifyAdopted(id, state = stateDir()) {
  assertId(id, 'adopted id');
  const lock = readJson(path.join(state, 'adopted.lock.json'), { skills: {} });
  const entry = lock.skills?.[id];
  if (!entry) return { ok: false, problems: [`${id} is not in adopted.lock.json`] };
  const root = path.join(state, 'adopted', id);
  const problems = [];
  const expected = new Set();
  for (const f of entry.files || []) {
    if (!safeTreePath(f.path)) {
      problems.push(`unsafe path in lock: ${f.path}`);
      continue;
    }
    expected.add(f.path);
    const target = path.join(root, ...f.path.split('/'));
    let buf;
    try {
      buf = fs.readFileSync(target);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      problems.push(`missing: ${f.path}`);
      continue;
    }
    if (sha256(buf) !== f.sha256) problems.push(`changed: ${f.path}`);
  }
  try {
    for (const rel of listFiles(root)) if (!expected.has(rel)) problems.push(`unexpected: ${rel}`);
  } catch (err) {
    if (err.code !== 'ENOENT') problems.push(clip(err.message, 200));
  }
  return { ok: problems.length === 0, problems };
}
