// Install, check and fetch: the whitelist copier described in SDD sections 3 and 4.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  TEAM_ROOT, REPO_ROOT, VERSION, TeamError, assertNoSymlink, isInside, listFiles, nowIso,
  parseFrontmatter, readJson, redact, sha256, stateDir, writeAtomic, writeJson,
} from './util.mjs';

export const LOCK_PATH = '.claude/team/lock.json';
export const PROJECT_CONFIG = '.claude/team/project.json';
export const OVERLAY = '.claude/rules/core-project.md';
export const SETTINGS = '.claude/settings.json';
export const OWNED = [SETTINGS, OVERLAY, PROJECT_CONFIG];
export const LIBRARY = '.claude/team/library';
const EXECUTABLE = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|sh|bash|ps1|rb|go)$/i;
export const TRIGGER_RE = /PROACTIVELY|MUST BE USED|immediately after|Use for all\b|Use for any change|Automatically activat/i;

export function loadEccLock(teamRoot = TEAM_ROOT) {
  const lock = readJson(path.join(teamRoot, 'ecc.lock.json'));
  if (!/^[0-9a-f]{40}$/.test(lock.commit || '')) throw new TeamError('ecc.lock.json: commit must be 40 hex characters', 2);
  return lock;
}

export function eccCacheDir(lock, teamRoot = TEAM_ROOT) {
  return path.join(teamRoot, '.cache', `ecc-${lock.tag}`);
}

function gitHead(dir) {
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

/** The verified pinned checkout, or a code-2 error telling the user to fetch. */
export function eccDir({ teamRoot = TEAM_ROOT, lock = loadEccLock(teamRoot) } = {}) {
  const dir = eccCacheDir(lock, teamRoot);
  if (!fs.existsSync(path.join(dir, 'skills'))) {
    throw new TeamError(`pinned ECC checkout missing at ${path.relative(REPO_ROOT, dir)}: run "team.mjs fetch"`, 2);
  }
  const head = gitHead(dir);
  if (head !== lock.commit) throw new TeamError(`ECC cache is at ${head}, the pin says ${lock.commit}`, 1);
  return dir;
}

export function fetchEcc({ teamRoot = TEAM_ROOT, run = execFileSync } = {}) {
  const lock = loadEccLock(teamRoot);
  const dir = eccCacheDir(lock, teamRoot);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    run('gh', ['repo', 'clone', lock.repo, dir, '--', '-q', '--depth', '1', '--branch', lock.tag, '-c', 'advice.detachedHead=false'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  }
  const head = gitHead(dir);
  if (head !== lock.commit) {
    throw new TeamError(`tag ${lock.tag} now points at ${head}, the pin says ${lock.commit}: upstream moved the tag`, 1);
  }
  return { dir, commit: head, tag: lock.tag };
}

// ---------- profiles ----------

export function listProfiles(teamRoot = TEAM_ROOT) {
  return fs.readdirSync(path.join(teamRoot, 'profiles')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
}

export function resolveProfiles(names, teamRoot = TEAM_ROOT) {
  const order = [];
  const visit = (name, stack) => {
    if (!/^[a-z0-9-]+$/.test(name)) throw new TeamError(`invalid profile name: ${name}`);
    if (stack.includes(name)) throw new TeamError(`profile cycle: ${[...stack, name].join(' -> ')}`);
    if (order.includes(name)) return;
    const file = path.join(teamRoot, 'profiles', `${name}.json`);
    if (!fs.existsSync(file)) throw new TeamError(`unknown profile: ${name} (have: ${listProfiles(teamRoot).join(', ')})`);
    const p = readJson(file);
    for (const parent of p.extends || []) visit(parent, [...stack, name]);
    order.push(name);
  };
  for (const n of names) visit(n, []);
  const merged = {
    profiles: order,
    core: { rules: [], skills: [], agents: [] },
    ecc: { skills: [], activeSkills: [], agents: [], rules: [], activeRules: [] },
    patches: [],
    adopted: [],
  };
  const add = (list, items) => {
    for (const i of items || []) if (!list.includes(i)) list.push(i);
  };
  for (const name of order) {
    const p = readJson(path.join(teamRoot, 'profiles', `${name}.json`));
    for (const k of ['rules', 'skills', 'agents']) {
      add(merged.core[k], p.core?.[k]);
      add(merged.ecc[k], p.ecc?.[k]);
    }
    add(merged.ecc.activeSkills, p.ecc?.activeSkills);
    add(merged.ecc.activeRules, p.ecc?.activeRules);
    for (const patch of p.patches || []) {
      if (!merged.patches.some((x) => x.id === patch.id)) merged.patches.push(patch);
    }
    add(merged.adopted, p.adopted);
  }
  return merged;
}

// ---------- transforms ----------

/** Remove auto-invocation sentences from an agent's description line. */
export function stripAutoTriggers(text) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fm) return { text, changed: false };
  const lines = fm[1].split('\n');
  const i = lines.findIndex((l) => l.startsWith('description:'));
  if (i < 0) return { text, changed: false };
  const raw = lines[i].slice('description:'.length).trim();
  const quoted = /^(["'])(.*)\1$/.exec(raw);
  const body = quoted ? quoted[2] : raw;
  // Rewrite "Use PROACTIVELY when ..." to "Use when ..." (the when-clause is useful routing data), drop
  // "Proactively" as an adverb, and drop sentences that are pure mandates.
  const sentences = body
    .split(/(?<=[.!])\s+/)
    .map((s) =>
      s
        .replace(/\bUse PROACTIVELY\s+(when|for|after|before|to)\b/g, 'Use $1')
        .replace(/^Proactively\s+(\w)/, (m, c) => c.toUpperCase())
        .replace(/\bUse immediately after\b/g, 'Use after')
        .replace(/\bUse for all\s+/g, 'Use for ')
        .replace(/\bUse for any change\b/g, 'Use for changes'),
    );
  const kept = sentences.filter((s) => !TRIGGER_RE.test(s));
  let desc = kept.join(' ').trim();
  if (desc === body.trim()) return { text, changed: false };
  if (!desc) desc = sentences[0].replace(TRIGGER_RE, '').trim();
  lines[i] = `description: ${quoted ? quoted[1] + desc + quoted[1] : desc}`;
  const start = fm.index + 4;
  return { text: text.slice(0, start) + lines.join('\n') + text.slice(start + fm[1].length), changed: true };
}

export function addOriginLine(text, lock) {
  const line = `origin: ECC ${lock.tag} (${lock.commit.slice(0, 7)}), MIT, see LICENSE-ECC`;
  return text.replace(/^---\r?\n/, (m) => `${m}${line}\n`);
}

export function applyPatch(text, patch) {
  const count = text.split(patch.search).length - 1;
  if (count === 0) throw new TeamError(`patch ${patch.id} matched nothing in ${patch.file}: re-check it against the pin`);
  return text.split(patch.search).join(patch.replace);
}

// ---------- plan ----------

/**
 * Build the list of files to install. Each entry: dest (project-relative), content (string|Buffer),
 * source, upstream, upstreamSha256, transforms. Nothing is written here.
 */
export function planInstall({ profiles, teamRoot = TEAM_ROOT, ecc, lock, state = stateDir(), verifyAdopted, extra }) {
  const sel = resolveProfiles(profiles, teamRoot);
  // Project-owned additions (project.json extraEcc) on top of the public profiles: the project decides.
  for (const id of extra?.adopted || []) {
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new TeamError(`project.json extraEcc.adopted: invalid id ${JSON.stringify(id)}`);
    if (!sel.adopted.includes(id)) sel.adopted.push(id);
  }
  for (const k of ['skills', 'activeSkills', 'agents', 'rules', 'activeRules']) {
    for (const item of extra?.[k] || []) {
      if (typeof item !== 'string' || !/^[a-z0-9][a-z0-9/.-]{0,80}$/.test(item) || item.includes('..')) throw new TeamError(`project.json extraEcc.${k}: invalid entry ${JSON.stringify(item)}`);
      if (!sel.ecc[k].includes(item)) sel.ecc[k].push(item);
    }
  }
  for (const s of sel.ecc.activeSkills) if (!sel.ecc.skills.includes(s)) sel.ecc.skills.push(s);
  for (const r of sel.ecc.activeRules) if (!sel.ecc.rules.includes(r)) sel.ecc.rules.push(r);
  const files = [];
  const skipped = [];
  const library = [];
  const usedPatches = new Set();
  const seen = new Set();
  const push = (entry) => {
    if (seen.has(entry.dest)) throw new TeamError(`two sources install ${entry.dest}`);
    seen.add(entry.dest);
    files.push(entry);
  };
  const coreDir = path.join(teamRoot, 'core');
  const readSafe = (root, rel) => {
    const abs = path.join(root, rel);
    assertNoSymlink(root, abs);
    if (!fs.existsSync(abs)) throw new TeamError(`missing source file: ${path.relative(REPO_ROOT, abs) || abs}`);
    return fs.readFileSync(abs);
  };
  const patchesFor = (upstream) => sel.patches.filter((p) => p.file === upstream);
  const withPatches = (upstream, text, transforms) => {
    for (const p of patchesFor(upstream)) {
      text = applyPatch(text, p);
      usedPatches.add(p.id);
      transforms.push(`patch:${p.id}`);
    }
    return text;
  };

  for (const r of sel.core.rules) {
    push({ dest: `.claude/rules/${r}`, content: readSafe(coreDir, `rules/${r}`), source: 'core', upstream: `core/rules/${r}`, transforms: [] });
  }
  for (const s of sel.core.skills) {
    const dir = path.join(coreDir, 'skills', s);
    assertNoSymlink(coreDir, dir);
    if (!fs.existsSync(path.join(dir, 'SKILL.md'))) throw new TeamError(`core skill ${s} has no SKILL.md`);
    for (const rel of listFiles(dir)) {
      push({ dest: `.claude/skills/${s}/${rel}`, content: readSafe(dir, rel), source: 'core', upstream: `core/skills/${s}/${rel}`, transforms: [] });
    }
  }
  for (const a of sel.core.agents) {
    push({ dest: `.claude/agents/${a}.md`, content: readSafe(coreDir, `agents/${a}.md`), source: 'core', upstream: `core/agents/${a}.md`, transforms: [] });
  }

  const needsEcc = sel.ecc.skills.length || sel.ecc.agents.length || sel.ecc.rules.length;
  if (needsEcc) {
    if (!ecc || !lock) throw new TeamError('ECC selection needs the pinned checkout: run "team.mjs fetch"', 2);
    const license = readSafe(ecc, 'LICENSE');
    for (const s of sel.ecc.skills) {
      const dir = path.join(ecc, 'skills', s);
      assertNoSymlink(ecc, dir);
      if (!fs.existsSync(path.join(dir, 'SKILL.md'))) throw new TeamError(`ECC skill not found at the pin: ${s}`);
      const rels = listFiles(dir);
      const exec = rels.filter((r) => EXECUTABLE.test(r));
      const skillText = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
      for (const r of exec) {
        if (skillText.includes(path.basename(r))) {
          throw new TeamError(`ECC skill ${s} depends on executable file ${r}; exclude it from the profile`);
        }
        skipped.push({ path: `skills/${s}/${r}`, reason: 'skipped-executable' });
      }
      // Active skills are listed to the model every session; library skills cost nothing until read.
      const base = sel.ecc.activeSkills.includes(s) ? `.claude/skills/ecc-${s}` : `${LIBRARY}/${s}`;
      const fmText = parseFrontmatter(skillText).data;
      library.push({ name: s, description: fmText.description || '', path: `${base}/SKILL.md`, active: base.startsWith('.claude/skills/') });
      for (const rel of rels.filter((r) => !EXECUTABLE.test(r))) {
        const upstream = `skills/${s}/${rel}`;
        const raw = readSafe(dir, rel);
        const transforms = [];
        let content = raw;
        if (patchesFor(upstream).length) content = withPatches(upstream, raw.toString('utf8'), transforms);
        push({ dest: `${base}/${rel}`, content, source: 'ecc', upstream, upstreamSha256: sha256(raw), transforms });
      }
      if (!rels.includes('LICENSE')) {
        push({ dest: `${base}/LICENSE`, content: license, source: 'ecc', upstream: 'LICENSE', upstreamSha256: sha256(license), transforms: [] });
      }
    }
    const coreAgentNames = new Set(sel.core.agents);
    for (const a of sel.ecc.agents) {
      if (coreAgentNames.has(a)) throw new TeamError(`agent name collision between core and ECC: ${a}`);
      const upstream = `agents/${a}.md`;
      const raw = readSafe(ecc, upstream);
      const transforms = [];
      let text = raw.toString('utf8');
      const stripped = stripAutoTriggers(text);
      if (stripped.changed) {
        text = stripped.text;
        transforms.push('strip-auto-triggers');
      }
      text = withPatches(upstream, text, transforms);
      text = addOriginLine(text, lock);
      transforms.push('origin-line');
      push({ dest: `.claude/agents/${a}.md`, content: text, source: 'ecc', upstream, upstreamSha256: sha256(raw), transforms });
    }
    if (sel.ecc.agents.length) {
      push({ dest: '.claude/agents/LICENSE-ECC', content: license, source: 'ecc', upstream: 'LICENSE', upstreamSha256: sha256(license), transforms: [] });
    }
    for (const r of sel.ecc.rules) {
      if (!/^[a-z0-9-]+\/[a-z0-9-]+\.md$/.test(r)) throw new TeamError(`ECC rules are listed by file (pack/file.md): ${r}`);
      const upstream = `rules/${r}`;
      const raw = readSafe(ecc, upstream);
      const fm = parseFrontmatter(raw.toString('utf8'));
      if (!/^paths:/m.test(fm.raw)) throw new TeamError(`ECC rule ${r} has no paths: scope and would load every session`);
      const transforms = [];
      const content = patchesFor(upstream).length ? withPatches(upstream, raw.toString('utf8'), transforms) : raw;
      // Active rules load whenever a matching file is read (in a web project: nearly every session); library
      // rules are read on demand through the index.
      const active = sel.ecc.activeRules.includes(r);
      const dest = active ? `.claude/rules/ecc/${r}` : `${LIBRARY}/rules/${r}`;
      library.push({ name: `rules/${r.replace(/\.md$/, '')}`, description: `${r.split('/')[0]} rule: ${fm.data.description || r.split('/')[1].replace(/\.md$/, '').replace(/-/g, ' ')}`, path: dest, active });
      push({ dest, content, source: 'ecc', upstream, upstreamSha256: sha256(raw), transforms });
    }
    if (sel.ecc.activeRules.length) {
      push({ dest: '.claude/rules/ecc/LICENSE-ECC', content: license, source: 'ecc', upstream: 'LICENSE', upstreamSha256: sha256(license), transforms: [] });
    }
    if (library.length) {
      if (!library.every((e) => e.active)) push({ dest: `${LIBRARY}/LICENSE-ECC`, content: license, source: 'ecc', upstream: 'LICENSE', upstreamSha256: sha256(license), transforms: [] });
    }
  }

  for (const id of sel.adopted) {
    if (!verifyAdopted) throw new TeamError('adopted skills need the scout module', 2);
    const v = verifyAdopted(id, state);
    if (!v.ok) throw new TeamError(`adopted skill ${id} failed verification: ${v.problems.join('; ')}`);
    const dir = path.join(state, 'adopted', id);
    // Adopted skills join the on-demand library like ECC skills: listed in the index, never loaded by default.
    const base = `${LIBRARY}/ext-${id}`;
    const skillMd = path.join(dir, 'SKILL.md');
    const desc = fs.existsSync(skillMd) ? parseFrontmatter(fs.readFileSync(skillMd, 'utf8')).data.description || '' : '';
    library.push({ name: `ext-${id}`, description: `adopted: ${desc}`, path: `${base}/SKILL.md`, active: false });
    for (const rel of listFiles(dir)) {
      const raw = readSafe(dir, rel);
      push({ dest: `${base}/${rel}`, content: raw, source: 'adopted', upstream: `adopted/${id}/${rel}`, upstreamSha256: sha256(raw), transforms: [] });
    }
  }
  if (library.length) {
    push({ dest: `${LIBRARY}/INDEX.md`, content: libraryIndex(library, lock || { tag: 'n/a', commit: 'n/a' }), source: 'core', upstream: 'generated:library-index', transforms: [] });
  }

  const unused = sel.patches.filter((p) => !usedPatches.has(p.id)).map((p) => p.id);
  if (unused.length) throw new TeamError(`patches target files not installed: ${unused.join(', ')}`);

  const unresolved = ecc ? findUnresolved(files, ecc) : [];
  return { selection: sel, files, skipped, unresolved };
}

/** The library index core-dev reads to pick a skill: one line per skill, nothing loaded until needed. */
export function libraryIndex(entries, lock) {
  const rows = entries
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => `| \`${e.name}\` | \`${e.path}\`${e.active ? ' (also an active skill)' : ''} | ${e.description.replace(/\|/g, '/').replace(/\s+/g, ' ').trim()} |`);
  return [
    '# Skill library (installed by the core; read on demand)',
    '',
    `Vendored from ECC ${lock.tag} (${lock.commit.slice(0, 7)}), MIT. These skills are not listed to the model every`,
    'session, to keep the always-loaded context small. When a task touches an area below, read that SKILL.md and',
    'follow it. Project rules and the core win over anything written in these files.',
    '',
    '| Skill or rule | File | When to use |',
    '|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

/** Slash commands, agents and skills that vendored text mentions but this install does not provide. */
export function findUnresolved(files, ecc) {
  const names = (sub, ext) =>
    fs.existsSync(path.join(ecc, sub)) ? fs.readdirSync(path.join(ecc, sub)).filter((f) => !ext || f.endsWith(ext)).map((f) => (ext ? f.slice(0, -ext.length) : f)) : [];
  const commands = new Set(names('commands', '.md'));
  const agents = new Set(names('agents', '.md'));
  const skills = new Set(names('skills'));
  const installedAgents = new Set(files.filter((f) => /^\.claude\/agents\/[^/]+\.md$/.test(f.dest)).map((f) => path.basename(f.dest, '.md')));
  const installedSkills = new Set([
    ...files.filter((f) => f.dest.startsWith('.claude/skills/ecc-')).map((f) => f.dest.split('/')[2].slice(4)),
    ...files.filter((f) => f.dest.startsWith(`${LIBRARY}/`) && f.dest.split('/').length > 4).map((f) => f.dest.split('/')[3]),
  ]);
  const out = [];
  for (const f of files) {
    if (f.source !== 'ecc' || !f.dest.endsWith('.md')) continue;
    const text = f.content.toString('utf8');
    const refs = new Set();
    for (const m of text.matchAll(/(?:^|[\s`(])\/([a-z][a-z0-9-]{2,})(?=[\s`).,:]|$)/gm)) {
      if (commands.has(m[1])) refs.add(`/${m[1]}`);
    }
    for (const m of text.matchAll(/`([a-z][a-z0-9-]{2,})`/g)) {
      if (agents.has(m[1]) && !installedAgents.has(m[1])) refs.add(`agent:${m[1]}`);
      else if (skills.has(m[1]) && !installedSkills.has(m[1]) && !agents.has(m[1])) refs.add(`skill:${m[1]}`);
    }
    if (refs.size) out.push({ file: f.dest, refs: [...refs].sort() });
  }
  return out;
}

// ---------- project-owned files ----------

export function detectProjectConfig(project) {
  const pkgFile = path.join(project, 'package.json');
  const pkg = fs.existsSync(pkgFile) ? readJson(pkgFile) : {};
  const scripts = pkg.scripts || {};
  const pm = fs.existsSync(path.join(project, 'pnpm-lock.yaml')) ? 'pnpm' : fs.existsSync(path.join(project, 'yarn.lock')) ? 'yarn' : 'npm';
  const runCmd = (s) => (pm === 'npm' ? (s === 'test' ? 'npm test' : `npm run ${s}`) : `${pm} run ${s}`);
  const gates = [];
  if (scripts.lint) gates.push({ id: 'lint', kind: 'lint', cmd: runCmd('lint'), runs: 1, required: true });
  if (scripts.typecheck) gates.push({ id: 'typecheck', kind: 'check', cmd: runCmd('typecheck'), runs: 1, required: true });
  if (scripts.test) gates.push({ id: 'test', kind: 'test', cmd: runCmd('test'), runs: 3, required: true });
  if (scripts.build) gates.push({ id: 'build', kind: 'build', cmd: runCmd('build'), runs: 1, required: true });
  return {
    schema: 'core-project/1',
    name: path.basename(path.resolve(project)),
    packageManager: pm,
    gates,
    extraEcc: { skills: [], agents: [], rules: [] },
    notes: 'Project-owned. The core never overwrites this file. Edit the gates to match the project rules.',
  };
}

export const HOOK_TEXT =
  'Core dev team: for any development task (feature, change, fix, refactor, shipped content, review, deploy) ' +
  'load the core-dev skill first and follow it. This project\'s own rules (AGENTS.md, CLAUDE.md, .claude/rules) win over the core.';

export function settingsTemplate() {
  const payload = JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: HOOK_TEXT } });
  return {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: `printf '%s\\n' '${payload.replace(/'/g, "'\\''")}'` }] }],
    },
  };
}

export function overlayTemplate(cfg, teamRoot = TEAM_ROOT) {
  const tpl = fs.readFileSync(path.join(teamRoot, 'core', 'templates', 'core-project.md'), 'utf8');
  const gates = cfg.gates.map((g) => `- \`${g.id}\`: \`${redact(g.cmd)}\` (${g.runs} run${g.runs > 1 ? 's' : ''})`).join('\n') || '- (none detected: add them to project.json)';
  return tpl.replaceAll('{{name}}', cfg.name).replaceAll('{{gates}}', gates);
}

// ---------- install ----------

function gitDirtyUnder(project, rel) {
  try {
    // trimEnd only: porcelain lines start with a status column that may be a space (" M path").
    return execFileSync('git', ['-C', project, 'status', '--porcelain', '--untracked-files=all', '--', rel], { encoding: 'utf8' }).trimEnd();
  } catch {
    return '';
  }
}

function projectExtra(project) {
  const file = path.join(project, PROJECT_CONFIG);
  if (!fs.existsSync(file)) return null;
  const extra = readJson(file).extraEcc;
  if (extra !== undefined && (typeof extra !== 'object' || Array.isArray(extra) || extra === null)) throw new TeamError(`${PROJECT_CONFIG}: extraEcc must be an object`, 2);
  return extra || null;
}

export function readLock(project) {
  const file = path.join(project, LOCK_PATH);
  return fs.existsSync(file) ? readJson(file) : null;
}

export function install({ project, profiles, dryRun = false, force = false, teamRoot = TEAM_ROOT, state = stateDir(), verifyAdopted, clock = Date.now }) {
  project = path.resolve(project);
  if (!fs.existsSync(project) || !fs.statSync(project).isDirectory()) throw new TeamError(`not a directory: ${project}`, 2);
  assertNoSymlink(project, path.join(project, '.claude', 'team'));
  const eccLock = loadEccLock(teamRoot);
  const sel = resolveProfiles(profiles, teamRoot);
  const extra = projectExtra(project);
  const needsEcc = sel.ecc.skills.length || sel.ecc.agents.length || sel.ecc.rules.length || ['skills', 'activeSkills', 'agents', 'rules', 'activeRules'].some((k) => extra?.[k]?.length);
  const ecc = needsEcc ? eccDir({ teamRoot, lock: eccLock }) : null;
  const planned = planInstall({ profiles, teamRoot, ecc, lock: eccLock, state, verifyAdopted, extra });

  if (!force && !dryRun && readLock(project)) {
    // Uncommitted files the core wrote itself (still matching its lock), project-owned files and run output
    // are not a human's unsaved work; anything else under .claude/ is, and blocks a reinstall.
    const prevLock = readLock(project);
    const human = gitDirtyUnder(project, '.claude')
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(3).replace(/^"|"$/g, ''))
      .filter((rel) => {
        if (OWNED.includes(rel) || rel.startsWith('.claude/team/')) return false;
        const meta = prevLock.files?.[rel];
        const abs = path.join(project, rel);
        return !(meta && fs.existsSync(abs) && sha256(fs.readFileSync(abs)) === meta.sha256);
      });
    if (human.length) throw new TeamError(['uncommitted changes under .claude/ (commit them or pass --force)', ...human].join('\n  '));
  }

  const old = readLock(project);
  const oldFiles = old?.files || {};
  const conflicts = [];
  const writes = [];
  for (const f of planned.files) {
    const abs = path.join(project, f.dest);
    assertNoSymlink(project, abs);
    const sha = sha256(f.content);
    if (fs.existsSync(abs)) {
      const cur = sha256(fs.readFileSync(abs));
      if (!oldFiles[f.dest] && cur !== sha) conflicts.push(`${f.dest}: exists and was not installed by the core`);
      else if (oldFiles[f.dest] && cur !== oldFiles[f.dest].sha256 && cur !== sha && !force) conflicts.push(`${f.dest}: edited since the last install`);
      if (cur === sha) {
        writes.push({ ...f, sha, unchanged: true });
        continue;
      }
    }
    writes.push({ ...f, sha });
  }
  const plannedSet = new Set(planned.files.map((f) => f.dest));
  const removals = [];
  for (const [dest, meta] of Object.entries(oldFiles)) {
    if (plannedSet.has(dest)) continue;
    const abs = path.join(project, dest);
    assertLockPath(project, dest);
    if (!fs.existsSync(abs)) continue;
    if (sha256(fs.readFileSync(abs)) !== meta.sha256 && !force) conflicts.push(`${dest}: no longer installed but edited locally`);
    else removals.push(dest);
  }
  if (conflicts.length && !force) throw new TeamError(['refusing to overwrite', ...conflicts].join('\n  '));

  const cfgExists = fs.existsSync(path.join(project, PROJECT_CONFIG));
  const cfg = cfgExists ? readJson(path.join(project, PROJECT_CONFIG)) : detectProjectConfig(project);
  const owned = [];
  const warnings = [];
  if (!fs.existsSync(path.join(project, SETTINGS))) owned.push({ dest: SETTINGS, content: JSON.stringify(settingsTemplate(), null, 2) + '\n' });
  else if (!fs.readFileSync(path.join(project, SETTINGS), 'utf8').includes('core-dev')) warnings.push(`${SETTINGS} exists without the core-dev reminder hook: add it by hand (see settingsTemplate in the core)`);
  if (!fs.existsSync(path.join(project, OVERLAY))) owned.push({ dest: OVERLAY, content: overlayTemplate(cfg, teamRoot) });
  if (!cfgExists) owned.push({ dest: PROJECT_CONFIG, content: JSON.stringify(cfg, null, 2) + '\n' });

  const lockOut = {
    schema: 'core-team-lock/1',
    coreVersion: VERSION,
    profiles: planned.selection.profiles,
    requested: profiles,
    ecc: { repo: eccLock.repo, tag: eccLock.tag, commit: eccLock.commit },
    installedAt: nowIso(clock),
    files: Object.fromEntries(
      writes
        .sort((a, b) => a.dest.localeCompare(b.dest))
        .map((w) => [w.dest, { source: w.source, upstream: w.upstream, ...(w.upstreamSha256 ? { upstreamSha256: w.upstreamSha256 } : {}), sha256: w.sha, ...(w.transforms.length ? { transforms: w.transforms } : {}) }]),
    ),
    skipped: planned.skipped,
    unresolved: planned.unresolved,
    owned: OWNED,
  };
  const summary = {
    project,
    profiles: planned.selection.profiles,
    files: writes.length,
    changed: writes.filter((w) => !w.unchanged).length,
    removed: removals,
    created: owned.map((o) => o.dest),
    skipped: planned.skipped.length,
    unresolved: planned.unresolved.reduce((n, u) => n + u.refs.length, 0),
    warnings,
    dryRun,
  };
  if (dryRun) return { ...summary, plan: writes.map((w) => w.dest) };

  for (const w of writes) if (!w.unchanged) writeAtomic(path.join(project, w.dest), w.content);
  for (const dest of removals) {
    fs.rmSync(path.join(project, dest), { force: true });
    pruneEmptyDirs(project, path.dirname(path.join(project, dest)));
  }
  for (const o of owned) writeAtomic(path.join(project, o.dest), o.content);
  writeJson(path.join(project, LOCK_PATH), lockOut);
  registerProject({ state, project, lock: lockOut, clock });
  return summary;
}

/** A lock entry must name a file under .claude/ with no escape; a tampered lock cannot reach elsewhere. */
function assertLockPath(project, dest) {
  if (typeof dest !== 'string' || !dest.startsWith('.claude/') || dest.split('/').includes('..') || path.isAbsolute(dest)) {
    throw new TeamError(`lock entry outside .claude/: ${JSON.stringify(dest)}`);
  }
  assertNoSymlink(project, path.join(project, dest));
}

function pruneEmptyDirs(project, dir) {
  const stop = path.join(project, '.claude');
  while (isInside(stop, dir) && dir !== stop && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir);
    dir = path.dirname(dir);
  }
}

export function registerProject({ state, project, lock, check, clock = Date.now }) {
  const file = path.join(state, 'registry.json');
  const reg = readJson(file, { projects: {} });
  reg.coreRoot = REPO_ROOT;
  reg.projects ||= {};
  let name = path.basename(project);
  if (reg.projects[name] && reg.projects[name].path !== project) name = `${name}-${sha256(project).slice(0, 6)}`;
  const prev = reg.projects[name] || {};
  reg.projects[name] = {
    ...prev,
    path: project,
    ...(lock ? { profiles: lock.requested || lock.profiles, coreVersion: lock.coreVersion, eccCommit: lock.ecc.commit, installedAt: lock.installedAt } : {}),
    ...(check ? { lastCheck: { ts: nowIso(clock), status: check.status, problems: check.problems.length } } : {}),
  };
  writeJson(file, reg);
  return reg.projects[name];
}

// ---------- check ----------

/** Compare disk with the lock (drift) and the lock with the current source (outdated). */
export function check({ project, teamRoot = TEAM_ROOT, state = stateDir(), verifyAdopted, register = true, clock = Date.now }) {
  project = path.resolve(project);
  const lock = readLock(project);
  if (!lock) throw new TeamError(`no core install found in ${project} (missing ${LOCK_PATH})`, 2);
  const problems = [];
  const outdated = [];
  for (const [dest, meta] of Object.entries(lock.files)) {
    const abs = path.join(project, dest);
    try {
      assertLockPath(project, dest);
    } catch (e) {
      problems.push(`${dest}: ${e.message}`);
      continue;
    }
    if (!fs.existsSync(abs)) problems.push(`${dest}: missing`);
    else if (sha256(fs.readFileSync(abs)) !== meta.sha256) problems.push(`${dest}: changed since install`);
  }
  // Unknown files inside directories the core owns completely.
  const ownedDirs = new Set();
  for (const dest of Object.keys(lock.files)) {
    const m = /^(\.claude\/skills\/[^/]+)\//.exec(dest) || /^(\.claude\/rules\/ecc)\//.exec(dest) || /^(\.claude\/team\/library)\//.exec(dest);
    if (m) ownedDirs.add(m[1]);
  }
  for (const d of ownedDirs) {
    const abs = path.join(project, d);
    if (!fs.existsSync(abs)) continue;
    for (const rel of listFiles(abs)) {
      const dest = `${d}/${rel}`;
      if (!lock.files[dest]) problems.push(`${dest}: unknown file in a core-owned directory`);
    }
  }
  const lockEcc = lock.ecc || {};
  const eccLock = loadEccLock(teamRoot);
  const ecc = eccDir({ teamRoot, lock: eccLock }); // code 2 when the cache is missing
  const planned = planInstall({ profiles: lock.requested || lock.profiles, teamRoot, ecc, lock: eccLock, state, verifyAdopted, extra: projectExtra(project) });
  for (const f of planned.files) {
    const meta = lock.files[f.dest];
    if (!meta) outdated.push(`${f.dest}: would be added`);
    else if (meta.sha256 !== sha256(f.content)) outdated.push(`${f.dest}: source changed`);
  }
  const plannedSet = new Set(planned.files.map((f) => f.dest));
  for (const dest of Object.keys(lock.files)) if (!plannedSet.has(dest)) outdated.push(`${dest}: would be removed`);
  if (lockEcc.commit !== eccLock.commit) outdated.push(`ECC pin changed: ${lockEcc.commit} -> ${eccLock.commit}`);
  const result = { project, status: problems.length ? 'drift' : 'clean', problems, outdated, coreVersion: lock.coreVersion, current: VERSION };
  if (register) registerProject({ state, project, check: result, clock });
  return result;
}
