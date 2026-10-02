// Task records, verify receipts and review entries: the facts the collector scores (SDD section 7.1).
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROJECT_CONFIG } from './install.mjs';
import { VERSION, TeamError, appendJsonl, assertId, clip, hmac, newKey, nowIso, readJson, redact, sha256, slug, stateDir, stateKey, writeJson } from './util.mjs';

export const CLASSES = ['feature', 'change', 'fix', 'refactor', 'content', 'investigate', 'review', 'deploy', 'hotfix'];
export const REVIEWED_CLASSES = ['feature', 'change', 'fix', 'refactor', 'content', 'hotfix'];
export const PREMISES = ['confirmed', 'plausible', 'refuted'];
export const OUTCOMES = ['done', 'partial', 'blocked', 'refuted', 'not-started'];
export const LENSES = ['failure-path', 'data-scope', 'contract-coverage', 'config-sequencing'];
export const SEVERITIES = ['critical', 'high', 'medium', 'low'];
export const DISPOSITIONS = ['fixed', 'waived', 'open'];
// A done report that lists something as missing or not run is partial, never done.
export const OMISSION_RE = /\b(not run|not done|not tested|not checked|could not run|did not run|was skipped|were skipped|untested)\b|\b(missing|skipped|todo)\s*:/i;

const teamDir = (project) => path.join(project, '.claude', 'team');
const RUN_OUTPUT = ['.claude/team/receipts', '.claude/team/open', '.claude/team/ledger.jsonl'];
const openFile = (project, id) => path.join(teamDir(project), 'open', `${assertId(id, 'task id')}.json`);
const receiptsDir = (project) => path.join(teamDir(project), 'receipts');
export const ledgerFile = (project) => path.join(teamDir(project), 'ledger.jsonl');

function git(project, args, extraEnv) {
  try {
    return execFileSync('git', ['-C', project, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, ...extraEnv },
    }).trim();
  } catch {
    return null;
  }
}

/** Tree hash of the whole working tree (tracked + untracked, honouring .gitignore), or null outside git. */
export function worktreeTree(project) {
  if (git(project, ['rev-parse', '--is-inside-work-tree']) !== 'true') return null;
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'core-idx-')), 'index');
  try {
    const env = { GIT_INDEX_FILE: tmp };
    if (git(project, ['rev-parse', '--verify', '-q', 'HEAD'])) git(project, ['read-tree', 'HEAD'], env);
    if (git(project, ['add', '-A', '--', '.'], env) === null) return null;
    // The core's own run output never counts as code, whether or not the project ignores it.
    git(project, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...RUN_OUTPUT], env);
    return git(project, ['write-tree'], env);
  } finally {
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
}

export function loadProjectConfig(project) {
  const file = path.join(project, PROJECT_CONFIG);
  if (!fs.existsSync(file)) throw new TeamError(`missing ${PROJECT_CONFIG}: install the core first`, 2);
  const cfg = readJson(file);
  if (!Array.isArray(cfg.gates)) throw new TeamError(`${PROJECT_CONFIG}: gates must be an array`, 2);
  for (const g of cfg.gates) {
    if (!/^[a-z0-9-]{1,32}$/.test(g.id || '') || typeof g.cmd !== 'string' || !g.cmd.trim()) {
      throw new TeamError(`${PROJECT_CONFIG}: every gate needs an id and a cmd`, 2);
    }
  }
  return cfg;
}

function readOpen(project, id) {
  const file = openFile(project, id);
  if (!fs.existsSync(file)) throw new TeamError(`no open task ${id} in this project (run "task start" first)`);
  return readJson(file);
}

// ---------- task start ----------

export function taskStart({ project, title, cls, estimate, premise, clock = Date.now }) {
  project = path.resolve(project);
  if (typeof title !== 'string' || !title.trim()) throw new TeamError('task start needs --title "<text>"');
  if (!CLASSES.includes(cls)) throw new TeamError(`--class must be one of ${CLASSES.join(', ')}`);
  if (!PREMISES.includes(premise)) throw new TeamError(`--premise must be one of ${PREMISES.join(', ')}`);
  const est = estimate === undefined || estimate === true ? null : Number(estimate);
  if (est !== null && !(Number.isFinite(est) && est > 0 && est < 10000)) throw new TeamError('--estimate must be minutes (a positive number)');
  const ts = nowIso(clock);
  const compact = ts.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'z').toLowerCase();
  const id = assertId(`${slug(title, 30)}-${compact}-${newKey(2)}`, 'task id');
  const rec = {
    schema: 'core-task-open/1',
    id,
    project: path.basename(project),
    title: clip(title, 200),
    class: cls,
    premise,
    estimate_min: est,
    startedAt: ts,
    startHead: git(project, ['rev-parse', 'HEAD']),
    reviews: [],
    agents: [],
  };
  const file = openFile(project, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rec, null, 2) + '\n', { flag: 'wx' }); // never replace an open task
  return rec;
}

// ---------- review ----------

export function reviewAdd({ project, task, lens, findings, severity, where, disposition, note, clock = Date.now }) {
  project = path.resolve(project);
  const rec = readOpen(project, task);
  if (!/^[a-z0-9-]{2,48}$/.test(lens || '')) throw new TeamError('--lens must be a lens or reviewer agent name');
  let entry;
  if (severity === undefined) {
    const n = Number(findings);
    if (findings === undefined || !Number.isInteger(n) || n !== 0) {
      throw new TeamError('record a lens with no findings as --findings 0, or one finding with --severity --where --disposition');
    }
    entry = { lens, findings: 0, ts: nowIso(clock) };
  } else {
    if (!SEVERITIES.includes(severity)) throw new TeamError(`--severity must be one of ${SEVERITIES.join(', ')}`);
    if (!DISPOSITIONS.includes(disposition)) throw new TeamError(`--disposition must be one of ${DISPOSITIONS.join(', ')}`);
    if (!where || !/:\d+/.test(String(where))) throw new TeamError('--where must be file:line (a finding without a location is an opinion)');
    if (disposition === 'waived' && !(note && String(note).trim())) throw new TeamError('a waived finding needs --note with the reason');
    entry = { lens, severity, where: clip(where, 200), disposition, note: note ? clip(note, 300) : '', ts: nowIso(clock) };
  }
  rec.reviews.push(entry);
  writeJson(openFile(project, task), rec);
  return entry;
}

/** Update the disposition of earlier findings at a location (e.g. open -> fixed after the fix). */
export function reviewResolve({ project, task, where, disposition, note, clock = Date.now }) {
  project = path.resolve(project);
  const rec = readOpen(project, task);
  if (!DISPOSITIONS.includes(disposition)) throw new TeamError(`--disposition must be one of ${DISPOSITIONS.join(', ')}`);
  if (disposition === 'waived' && !(note && String(note).trim())) throw new TeamError('a waived finding needs --note with the reason');
  const hits = rec.reviews.filter((r) => r.severity && r.where === where);
  if (!hits.length) throw new TeamError(`no finding recorded at ${where}`);
  for (const h of hits) {
    h.disposition = disposition;
    if (note) h.note = clip(note, 300);
    h.resolvedAt = nowIso(clock);
  }
  writeJson(openFile(project, task), rec);
  return hits.length;
}

// ---------- verify ----------

const TEST_COUNT_PATTERNS = [
  /Tests\s+(\d+)\s+passed/i, // vitest
  /Tests:[ \t]+(?:\d+\s+\w+,\s+)*(\d+)\s+passed/i, // jest
  /^[#ℹ]\s*pass\s+(\d+)/m, // node:test
  /(\d+)\s+passing\b/i, // mocha
  /(\d+)\s+passed\b/i, // pytest and generic
];

export function parseTestCount(output, custom) {
  const patterns = custom ? [new RegExp(custom, 'm'), ...TEST_COUNT_PATTERNS] : TEST_COUNT_PATTERNS;
  for (const re of patterns) {
    const m = re.exec(output);
    if (m) return Number(m[1]);
  }
  return null;
}

function defaultRunner(cmd, { cwd, timeoutMs }) {
  const t0 = Date.now();
  const r = spawnSync('/bin/sh', ['-c', cmd], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    timeout: timeoutMs,
    env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  const exit = r.error ? (r.error.code === 'ETIMEDOUT' ? 124 : 127) : r.status ?? 1;
  return { exit, output, ms: Date.now() - t0 };
}

export function verify({ project, task, stage = 'pr', all = false, run = defaultRunner, clock = Date.now, log = () => {}, state = stateDir() }) {
  project = path.resolve(project);
  if (!['pr', 'merge'].includes(stage)) throw new TeamError('--stage must be pr or merge');
  const cfg = loadProjectConfig(project);
  if (task) readOpen(project, task);
  const gates = cfg.gates.filter((g) => g.required !== false || all);
  if (!gates.length) throw new TeamError(`${PROJECT_CONFIG} has no gates to run`, 2);
  const results = [];
  for (const g of gates) {
    const runs = Math.max(1, Number(g.runs) || 1, g.kind === 'test' && stage === 'merge' ? 5 : 0);
    const out = [];
    let lastOutput = '';
    for (let i = 0; i < runs; i++) {
      log(`verify: ${g.id} run ${i + 1}/${runs}: ${redact(g.cmd)}`);
      const r = run(g.cmd, { cwd: project, timeoutMs: (Number(g.timeoutSec) || 1200) * 1000 });
      const tests = g.kind === 'test' ? parseTestCount(r.output, g.testPattern) : null;
      out.push({ exit: r.exit, ms: r.ms, tests, outSha256: sha256(r.output) });
      lastOutput = r.output;
      if (r.exit !== 0) break; // a failed run ends the gate; the rest would only repeat the failure
    }
    const ranAll = out.length === runs;
    const allZero = out.every((o) => o.exit === 0);
    const testsOk = g.kind !== 'test' || out.every((o) => Number.isInteger(o.tests) && o.tests > 0);
    const status = ranAll && allZero && testsOk ? 'pass' : 'fail';
    const tail = lastOutput.split('\n').filter((l) => l.trim()).slice(-15).join('\n');
    results.push({
      id: g.id,
      kind: g.kind || 'check',
      cmd: redact(g.cmd),
      required: g.required !== false,
      runsRequired: runs,
      runs: out,
      tests: g.kind === 'test' ? Math.min(...out.map((o) => (Number.isInteger(o.tests) ? o.tests : 0))) : null,
      status,
      reason: status === 'pass' ? '' : !allZero ? 'non-zero exit' : !testsOk ? 'no tests counted' : 'incomplete',
      tail: clip(tail, 1500),
    });
  }
  const receipt = {
    schema: 'core-receipt/1',
    task: task || null,
    ts: nowIso(clock),
    stage,
    head: git(project, ['rev-parse', 'HEAD']),
    tree: worktreeTree(project),
    dirty: Boolean(git(project, ['status', '--porcelain', '--', '.', ...RUN_OUTPUT.map((p) => `:(exclude)${p}`)])),
    coreVersion: VERSION,
    gates: results,
    pass: results.filter((r) => r.required).every((r) => r.status === 'pass'),
  };
  const dir = receiptsDir(project);
  fs.mkdirSync(dir, { recursive: true });
  const prefix = task || 'adhoc';
  const taken = fs
    .readdirSync(dir)
    .map((f) => new RegExp(`^${prefix}-(\\d+)\\.json$`).exec(f))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  const n = (taken.length ? Math.max(...taken) : 0) + 1;
  receipt.n = n;
  receipt.sig = signReceipt(receipt, state);
  const file = path.join(dir, `${prefix}-${String(n).padStart(3, '0')}.json`);
  fs.writeFileSync(file, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' }); // a receipt is never overwritten
  return { receipt, file };
}

export function receiptTable(receipt) {
  const rows = receipt.gates.map((g) => {
    const secs = (g.runs.reduce((s, r) => s + r.ms, 0) / 1000).toFixed(1);
    const detail = g.status === 'pass' ? '' : g.reason;
    return `| ${g.id} | ${g.status.toUpperCase()} | ${g.runs.length}/${g.runsRequired} | ${g.tests ?? ''} | ${secs} | ${detail} |`;
  });
  return ['| gate | result | runs | tests | s | detail |', '|---|---|---|---|---|---|', ...rows, '', `**verify: ${receipt.pass ? 'PASS' : 'FAIL'}** (receipt ${receipt.n})`].join('\n');
}

function canonical(receipt) {
  const { sig, ...rest } = receipt;
  return JSON.stringify(rest);
}

export function signReceipt(receipt, state = stateDir()) {
  return hmac(stateKey(state), canonical(receipt));
}

/** A receipt counts only if the CLI on this machine signed it. Hand-written receipts are ignored. */
export function receiptValid(receipt, state = stateDir()) {
  return Boolean(receipt && typeof receipt.sig === 'string' && receipt.sig === signReceipt(receipt, state));
}

function listReceipts(project, task, state) {
  const dir = receiptsDir(project);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${task}-`) && f.endsWith('.json'))
    .sort()
    .map((f) => readJson(path.join(dir, f)))
    .filter((r) => receiptValid(r, state));
}

// ---------- task done ----------

export function taskDone({ project, task, outcome, evidence = [], agents = [], clock = Date.now, state = stateDir() }) {
  project = path.resolve(project);
  if (!OUTCOMES.includes(outcome)) throw new TeamError(`--outcome must be one of ${OUTCOMES.join(', ')}`);
  const rec = readOpen(project, task);
  const cfg = loadProjectConfig(project);
  const required = cfg.gates.filter((g) => g.required !== false).map((g) => g.id);
  const receipts = listReceipts(project, task, state);
  const final = receipts[receipts.length - 1] || null;
  const tree = worktreeTree(project);
  const finalValid = Boolean(final && (tree === null ? true : final.tree === tree));

  const gates = {};
  for (const id of required) {
    const g = final?.gates.find((x) => x.id === id);
    if (!g) gates[id] = { status: 'claimed', runs: 0, reason: 'no receipt' };
    else if (!finalValid) gates[id] = { status: 'claimed', runs: g.runs.length, reason: 'code changed after the last verify' };
    else gates[id] = { status: g.status, runs: g.runs.length, runsRequired: g.runsRequired, tests: g.tests, kind: g.kind };
  }

  const findings = rec.reviews.filter((r) => r.severity);
  const lenses = [...new Set(rec.reviews.map((r) => r.lens))];
  const openBlocking = findings.filter((f) => f.disposition === 'open' && (f.severity === 'critical' || f.severity === 'high'));
  if (outcome === 'done') {
    const why = [];
    if (!final) why.push('no verify receipt');
    else if (!finalValid) why.push('code changed after the last verify: run verify again');
    else if (!final.pass) why.push('the last verify failed');
    if (REVIEWED_CLASSES.includes(rec.class)) {
      const missing = LENSES.filter((l) => !lenses.includes(l));
      if (missing.length) why.push(`review lenses not recorded: ${missing.join(', ')}`);
    }
    if (openBlocking.length) why.push(`${openBlocking.length} critical or high finding(s) still open`);
    const ev = evidence.filter((e) => String(e).trim());
    if (!ev.length) why.push('no --evidence given');
    const omission = ev.find((e) => OMISSION_RE.test(e));
    if (omission) why.push(`evidence admits an omission ("${clip(omission, 80)}")`);
    if (why.length) throw new TeamError(`not done: ${why.join('; ')}. Record --outcome partial or fix these first.`);
  }

  const doneAt = nowIso(clock);
  const record = {
    schema: 'core-task-record/1',
    id: rec.id,
    ts: doneAt,
    project: rec.project,
    task: rec.title,
    class: rec.class,
    premise: rec.premise,
    startedAt: rec.startedAt,
    estimate_min: rec.estimate_min,
    actual_min: Math.max(0, Math.round((Date.parse(doneAt) - Date.parse(rec.startedAt)) / 60000)),
    requiredGates: required,
    gates,
    verifyRounds: receipts.length,
    rework_rounds: receipts.filter((r) => !r.pass).length,
    review: {
      lenses,
      findings: findings.map((f) => ({ lens: f.lens, severity: f.severity, disposition: f.disposition, waivedWithReason: f.disposition !== 'waived' || Boolean(f.note) })),
      selfReported: true,
    },
    agents: [...new Set([...(rec.agents || []), ...agents.map((a) => String(a)).filter((a) => /^[a-z0-9-]{2,48}$/.test(a)), ...lenses.filter((l) => !LENSES.includes(l))])],
    outcome,
    evidence: evidence.slice(0, 10).map((e) => clip(e, 300)),
    startHead: rec.startHead || null,
    // Tracked files still differing from HEAD when the record closed: the work was not committed first.
    uncommittedFiles: (git(project, ['diff', '--name-only', 'HEAD', '--', '.', ...RUN_OUTPUT.map((p) => `:(exclude)${p}`)]) || '').split('\n').filter(Boolean).length,
    head: git(project, ['rev-parse', 'HEAD']),
    core_version: VERSION,
  };
  appendJsonl(ledgerFile(project), record);
  fs.rmSync(openFile(project, task), { force: true });
  return record;
}

/** Exit-1 predicate for hooks and humans: is there a passing receipt for exactly the current tree? */
export function gate({ project, state = stateDir() }) {
  project = path.resolve(project);
  const dir = receiptsDir(project);
  const tree = worktreeTree(project);
  if (tree === null) return { pass: false, reason: 'not a git work tree' };
  if (!fs.existsSync(dir)) return { pass: false, reason: 'no receipts' };
  const receipts = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(dir, f)))
    .filter((r) => r.tree === tree && receiptValid(r, state))
    .sort((a, b) => a.ts.localeCompare(b.ts));
  const last = receipts.at(-1);
  if (!last) return { pass: false, reason: 'no receipt for the current tree: run verify' };
  return last.pass ? { pass: true, receipt: last.ts, task: last.task } : { pass: false, reason: 'the last verify of this tree failed' };
}
