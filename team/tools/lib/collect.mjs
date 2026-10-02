// Collect task records from registered projects, score them, evaluate agents, write the roadmap.
import fs from 'node:fs';
import path from 'node:path';
import { RUBRIC, compareTask, median, scoreAgent, scoreTask } from './score.mjs';
import { TEAM_ROOT, TeamError, VERSION, acquireLock, appendJsonl, clip, listFiles, nowIso, readJson, readJsonl, redact, writeAtomic, stateDir } from './util.mjs';

const MAX_TEXT = 300;

function sanitise(rec) {
  const out = { ...rec };
  for (const k of ['task', 'id', 'project']) if (typeof out[k] === 'string') out[k] = clip(out[k], k === 'task' ? 200 : 120);
  if (Array.isArray(out.evidence)) out.evidence = out.evidence.slice(0, 10).map((e) => clip(e, MAX_TEXT));
  return JSON.parse(redact(JSON.stringify(out)));
}

/**
 * Pull new records from every registered project's ledger into tasks.jsonl, scored and compared.
 * Returns per-project counts; a project whose ledger is unreadable is reported, never treated as empty.
 */
export function collect({ state = stateDir() } = {}) {
  const release = acquireLock(path.join(state, 'locks', 'collect.lock'), { ttlMs: 10 * 60 * 1000 });
  if (!release) throw new TeamError('another collect is running', 2);
  try {
    return collectLocked(state);
  } finally {
    release();
  }
}

function collectLocked(state) {
  const reg = readJson(path.join(state, 'registry.json'), { projects: {} });
  const tasksFile = path.join(state, 'tasks.jsonl');
  const existing = dedupeById(readJsonl(tasksFile).records);
  const seen = new Set(existing.map((t) => t.id));
  const all = [...existing];
  const report = { projects: {}, added: 0, invalid: 0 };
  const names = Object.keys(reg.projects || {});
  if (!names.length) return { ...report, note: 'no registered projects' };
  for (const name of names) {
    const p = reg.projects[name];
    const ledger = path.join(p.path, '.claude', 'team', 'ledger.jsonl');
    if (!fs.existsSync(p.path)) {
      report.projects[name] = { status: 'unreachable' };
      continue;
    }
    const { records, bad, missing } = readJsonl(ledger);
    const entry = { status: missing ? 'no ledger yet' : 'ok', added: 0, badLines: bad.length };
    for (const raw of records) {
      if (!raw || typeof raw.id !== 'string' || seen.has(raw.id)) continue;
      const rec = sanitise(raw);
      const s = scoreTaskSafe(rec);
      const scored = { ...rec, project: rec.project || name, score: s.score, ...(s.reason ? { scoreReason: s.reason } : {}), breakdown: s.breakdown, scoreNotes: s.notes, scoredAt: nowIso() };
      scored.comparison = compareTask(scored, all);
      appendJsonl(tasksFile, scored);
      all.push(scored);
      seen.add(rec.id);
      entry.added++;
      report.added++;
      if (s.score === null) report.invalid++;
    }
    report.projects[name] = entry;
  }
  return report;
}

function scoreTaskSafe(rec) {
  try {
    return scoreTask(rec);
  } catch (err) {
    return { score: null, reason: `invalid: ${err.message}`, breakdown: null, notes: [] };
  }
}

// ---------- evaluate ----------

function agentFilesOf(project) {
  const dir = path.join(project, '.claude', 'agents');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => path.join(dir, f));
}

function knownNames(teamRoot) {
  const all = new Set();
  const eccDirs = fs.existsSync(path.join(teamRoot, '.cache')) ? fs.readdirSync(path.join(teamRoot, '.cache')).filter((d) => d.startsWith('ecc-')) : [];
  for (const d of eccDirs) {
    const root = path.join(teamRoot, '.cache', d);
    for (const sub of ['agents', 'commands']) {
      if (fs.existsSync(path.join(root, sub))) for (const f of fs.readdirSync(path.join(root, sub))) all.add(f.replace(/\.md$/, ''));
    }
    if (fs.existsSync(path.join(root, 'skills'))) for (const s of fs.readdirSync(path.join(root, 'skills'))) all.add(s);
  }
  return all;
}

/** Score every agent the core ships or a registered project has installed; write scores and roadmap. */
export function evaluate({ state = stateDir(), teamRoot = TEAM_ROOT, clock = Date.now, write = true } = {}) {
  const reg = readJson(path.join(state, 'registry.json'), { projects: {} });
  const allKnown = knownNames(teamRoot);
  const agents = new Map();
  const consider = (file, origin, project) => {
    const text = fs.readFileSync(file, 'utf8');
    const name = path.basename(file, '.md');
    const projectRoot = project ? reg.projects[project].path : null;
    const known = new Set();
    if (projectRoot) {
      for (const f of agentFilesOf(projectRoot)) known.add(path.basename(f, '.md'));
      const sk = path.join(projectRoot, '.claude', 'skills');
      if (fs.existsSync(sk)) for (const d of fs.readdirSync(sk)) known.add(d.replace(/^ecc-/, ''));
    }
    const s = scoreAgent(text, { known, allKnown: projectRoot ? allKnown : new Set() });
    const prev = agents.get(name);
    if (!prev || s.score < prev.static) {
      agents.set(name, { name, origin, description: clip(s.description, 200), static: s.score, failed: s.failed, lines: s.lines, unresolvedRefs: s.unresolvedRefs, projects: [...(prev?.projects || [])] });
    }
    if (project && !agents.get(name).projects.includes(project)) agents.get(name).projects.push(project);
  };
  for (const f of listFiles(path.join(teamRoot, 'core', 'agents')).filter((f) => f.endsWith('.md'))) {
    consider(path.join(teamRoot, 'core', 'agents', f), 'core', null);
  }
  for (const [name, p] of Object.entries(reg.projects || {})) {
    if (!fs.existsSync(p.path)) continue;
    let lock = null;
    try {
      lock = readJson(path.join(p.path, '.claude', 'team', 'lock.json'));
    } catch {
      /* not installed */
    }
    for (const file of agentFilesOf(p.path)) {
      const dest = `.claude/agents/${path.basename(file)}`;
      const meta = lock?.files?.[dest];
      if (!meta) continue; // only agents the core installed
      consider(file, meta.source === 'core' ? 'core' : meta.source, name);
    }
  }

  const tasks = dedupeById(readJsonl(path.join(state, 'tasks.jsonl')).records);
  const since = clock() - 30 * 24 * 3600 * 1000;
  const recent = tasks.filter((t) => typeof t.score === 'number' && Date.parse(t.ts) >= since);
  for (const a of agents.values()) {
    const used = tasks.filter((t) => typeof t.score === 'number' && Array.isArray(t.agents) && t.agents.includes(a.name));
    a.outcome = { median: used.length >= 5 ? median(used.map((t) => t.score)) : null, n: used.length, note: used.length >= 5 ? '' : 'insufficient data (n<5)' };
    a.escapedFindings = 'unmeasured';
  }
  const list = [...agents.values()].sort((x, y) => x.static - y.static || x.name.localeCompare(y.name));
  const index = {
    staticMean: list.length ? Math.round((list.reduce((s, a) => s + a.static, 0) / list.length) * 10) / 10 : null,
    taskMedian30: recent.length ? median(recent.map((t) => t.score)) : null,
    taskN: recent.length,
  };
  const ts = nowIso(clock);
  const evaluation = { ts, coreVersion: VERSION, index, calibration: calibration(tasks), agents: list };

  const scout = latestScout(state);
  const roadmap = renderRoadmap(evaluation, scout);
  if (write) {
    appendJsonl(path.join(state, 'agent-scores.jsonl'), evaluation);
    const stamp = ts.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    writeAtomic(path.join(state, 'runs', `evaluate-${stamp}.json`), JSON.stringify(evaluation, null, 2) + '\n');
    writeAtomic(path.join(state, 'runs', `evaluate-${stamp}.md`), roadmap);
  }
  return { evaluation, roadmap };
}

function latestScout(state) {
  const dir = path.join(state, 'candidates');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => /^scout-.*\.json$/.test(f)).sort();
  if (!files.length) return null;
  try {
    return readJson(path.join(dir, files.at(-1)));
  } catch {
    return null;
  }
}

/** Roadmap: rubric fixes per agent, ordered by points to gain; scout matches by id and score only. */
export function renderRoadmap(evaluation, scout) {
  const points = Object.fromEntries(RUBRIC.map((r) => [r.id, r]));
  const lines = [`# Core agent roadmap (${evaluation.ts})`, ''];
  lines.push(`Static mean ${evaluation.index.staticMean ?? 'n/a'}; task median (30 days) ${evaluation.index.taskMedian30 ?? 'no data'} (n=${evaluation.index.taskN}).`, '');
  const cal = Object.entries(evaluation.calibration || {});
  if (cal.length) {
    lines.push('Estimate calibration (median actual / estimate; apply it in the next plan):');
    for (const [cls, c] of cal) lines.push(`- ${cls}: ${c.ratio ?? 'insufficient data'} (n=${c.n})`);
    lines.push('');
  }
  const items = [];
  for (const a of evaluation.agents) {
    const gain = a.failed.reduce((s, f) => s + (points[f]?.points || 0), 0);
    if (gain) items.push({ a, gain });
  }
  items.sort((x, y) => y.gain - x.gain || x.a.name.localeCompare(y.a.name));
  if (!items.length) lines.push('Every agent passes the static rubric.');
  for (const { a, gain } of items) {
    lines.push(`## ${a.name} (${a.origin}, static ${a.static}, +${gain} available)`);
    for (const f of a.failed) {
      const where = a.origin === 'core' ? 'edit team/core/agents' : 'add a profile patch or drop it from the profile';
      lines.push(`- ${f} (+${points[f].points}): ${points[f].fix}. Where: ${where}.`);
    }
    if (a.unresolvedRefs?.length) lines.push(`- unresolved references: ${a.unresolvedRefs.join(', ')}`);
    lines.push(`- outcome: ${a.outcome.median ?? a.outcome.note} (n=${a.outcome.n})`);
    const matches = (scout?.candidates || [])
      .filter((c) => c.eligible && (c.fit?.agents || []).some((m) => m.name === a.name))
      .slice(0, 3)
      .map((c) => `${c.id} (fit ${c.fit.score})`);
    if (matches.length) lines.push(`- scouted candidates to review: ${matches.join(', ')}`);
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

/** Median actual/estimate per task class, from done or partial tasks; null below five samples. */
export function calibration(tasks) {
  const by = {};
  for (const t of tasks) {
    if (!['done', 'partial'].includes(t.outcome) || !(t.estimate_min > 0) || !(t.actual_min >= 0)) continue;
    (by[t.class] ||= []).push(Math.max(t.actual_min, 1) / t.estimate_min);
  }
  return Object.fromEntries(
    Object.entries(by).map(([cls, r]) => [cls, { n: r.length, ratio: r.length >= 5 ? Math.round(median(r) * 100) / 100 : null }]),
  );
}

/** Keep the first record per id (tasks.jsonl is append-only; a duplicate line must not double-count). */
export function dedupeById(records) {
  const seen = new Set();
  return records.filter((r) => r && typeof r.id === 'string' && !seen.has(r.id) && seen.add(r.id));
}
