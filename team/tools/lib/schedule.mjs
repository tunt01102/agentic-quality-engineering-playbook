// Schedules for the background jobs (SDD section 8.1): due logic, freshness, tick, run-now and a
// macOS background job (property list).
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  TEAM_ROOT,
  TeamError,
  acquireLock,
  appendJsonl,
  clip,
  nowIso,
  readJson,
  redact,
  writeAtomic,
  writeJson,
} from './util.mjs';

export const JOBS = ['collect', 'evaluate', 'scout'];
const EVERY = ['hourly', 'daily', 'weekly'];
const FIELDS = ['enabled', 'every', 'hour', 'weekday', 'lastRun'];
const JOB_TIMEOUT_MS = 20 * 60 * 1000;
// Three jobs of up to 20 minutes each, plus margin, before a lock counts as stale.
const TICK_LOCK_TTL_MS = 65 * 60 * 1000;

export const DEFAULT_SCHEDULES = Object.freeze({
  collect: { enabled: true, every: 'hourly', hour: 0, weekday: 1, lastRun: null },
  evaluate: { enabled: true, every: 'daily', hour: 7, weekday: 1, lastRun: null },
  scout: { enabled: false, every: 'weekly', hour: 8, weekday: 1, lastRun: null },
});

// Jobs running in this process, shared by tick and runNow so the two never overlap.
const inFlight = new Set();

export function isRunning(job) {
  return inFlight.has(job);
}

export function runningJobs() {
  return [...inFlight];
}

function schedulesFile(state) {
  return path.join(state, 'schedules.json');
}

function defaults() {
  return { jobs: Object.fromEntries(JOBS.map((j) => [j, { ...DEFAULT_SCHEDULES[j] }])) };
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Validate a schedules object; fill missing fields from the defaults; return a normalised copy. */
export function validateSchedules(obj) {
  if (!isObject(obj) || !isObject(obj.jobs)) throw new TeamError('schedules must be an object with "jobs"');
  for (const k of Object.keys(obj)) {
    if (k !== 'jobs') throw new TeamError(`unknown schedules field: ${JSON.stringify(k)}`);
  }
  const out = defaults();
  for (const [job, cfg] of Object.entries(obj.jobs)) {
    if (!JOBS.includes(job)) throw new TeamError(`unknown job: ${JSON.stringify(job)}`);
    if (!isObject(cfg)) throw new TeamError(`schedule for ${job} must be an object`);
    for (const k of Object.keys(cfg)) {
      if (!FIELDS.includes(k)) throw new TeamError(`unknown field for ${job}: ${JSON.stringify(k)}`);
    }
    const merged = { ...out.jobs[job], ...cfg };
    if (typeof merged.enabled !== 'boolean') throw new TeamError(`${job}.enabled must be true or false`);
    if (!EVERY.includes(merged.every)) throw new TeamError(`${job}.every must be one of ${EVERY.join(', ')}`);
    if (!Number.isInteger(merged.hour) || merged.hour < 0 || merged.hour > 23) {
      throw new TeamError(`${job}.hour must be an integer from 0 to 23`);
    }
    if (!Number.isInteger(merged.weekday) || merged.weekday < 0 || merged.weekday > 6) {
      throw new TeamError(`${job}.weekday must be an integer from 0 (Sunday) to 6`);
    }
    if (merged.lastRun !== null) {
      if (typeof merged.lastRun !== 'string' || Number.isNaN(Date.parse(merged.lastRun))) {
        throw new TeamError(`${job}.lastRun must be null or a timestamp`);
      }
    }
    out.jobs[job] = merged;
  }
  return out;
}

export function loadSchedules(state) {
  const raw = readJson(schedulesFile(state), null);
  if (raw === null) return defaults();
  return validateSchedules(raw);
}

export function saveSchedules(state, obj) {
  const valid = validateSchedules(obj);
  writeJson(schedulesFile(state), valid);
  return valid;
}

function lastRunMs(cfg) {
  if (!cfg.lastRun) return null;
  const t = Date.parse(cfg.lastRun);
  return Number.isNaN(t) ? null : t;
}

/** Due logic in local time. Daily and weekly run once per slot, at or after the slot hour of the day. */
export function isDue(job, cfg, now = new Date()) {
  if (!JOBS.includes(job) || !cfg) return false;
  const last = lastRunMs(cfg);
  if (cfg.every === 'hourly') return last === null || now.getTime() - last >= 60 * 60 * 1000;
  if (cfg.every === 'weekly' && now.getDay() !== cfg.weekday) return false;
  if (cfg.every !== 'daily' && cfg.every !== 'weekly') return false;
  const slot = new Date(now.getFullYear(), now.getMonth(), now.getDate(), cfg.hour, 0, 0, 0).getTime();
  if (now.getTime() < slot) return false;
  return last === null || last < slot;
}

function slotAt(day, hour) {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, 0, 0, 0);
}

/** Slots that came due after lastRun and up to now, counted up to `cap`. */
function missedSlots(cfg, now, cap = 3) {
  const last = lastRunMs(cfg);
  if (cfg.every === 'hourly') {
    if (last === null) return cap;
    return Math.min(cap, Math.max(0, Math.floor((now.getTime() - last) / (60 * 60 * 1000))));
  }
  const step = cfg.every === 'weekly' ? 7 : 1;
  // The most recent slot at or before now.
  let slot = slotAt(now, cfg.hour);
  if (cfg.every === 'weekly') slot.setDate(slot.getDate() - ((now.getDay() - cfg.weekday + 7) % 7));
  if (slot.getTime() > now.getTime()) slot.setDate(slot.getDate() - step);
  let n = 0;
  while (n < cap && (last === null || slot.getTime() > last)) {
    n++;
    slot = slotAt(new Date(slot.getFullYear(), slot.getMonth(), slot.getDate() - step), cfg.hour);
  }
  return n;
}

/**
 * Freshness, separate from ok/failed: fresh (nothing missed), stale (one or two slots missed),
 * missed (more than two slots, or never ran while enabled), disabled.
 */
export function freshness(cfg, now = new Date()) {
  if (!cfg || !cfg.enabled) return 'disabled';
  if (lastRunMs(cfg) === null) return 'missed';
  const n = missedSlots(cfg, now);
  if (n === 0) return 'fresh';
  return n <= 2 ? 'stale' : 'missed';
}

export function newRunId(job, now = new Date()) {
  const ts = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '').toLowerCase();
  return `run-${job}-${ts}-${randomBytes(3).toString('hex')}`;
}

/** Default runner: the CLI itself through execFile, no shell, with a time limit. */
export function defaultRunJob(job) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(TEAM_ROOT, 'tools', 'team.mjs'), job],
      { timeout: JOB_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const output = `${stdout || ''}${stderr ? `\n${stderr}` : ''}`;
        if (!err) return resolve({ exitCode: 0, output });
        const exitCode = typeof err.code === 'number' ? err.code : err.killed ? 124 : 2;
        resolve({ exitCode, output: `${output}\n${err.killed ? 'killed: time limit reached' : ''}` });
      },
    );
  });
}

function lastLine(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

async function execute(job, { state, runJob = defaultRunJob, clock = Date.now, id }) {
  // Callers mark the job in flight before the first await.
  const startedAt = nowIso(clock);
  const runId = id || newRunId(job, new Date(clock()));
  // Cross-process: a job never runs twice at once, whether started by tick, the dashboard or another tick.
  const release = acquireLock(path.join(state, 'locks', `job-${job}.lock`), { ttlMs: 25 * 60 * 1000, clock });
  if (!release) {
    const entry = { id: runId, job, startedAt, finishedAt: startedAt, status: 'skipped', exitCode: null, summary: 'already running in another process' };
    appendJsonl(path.join(state, 'runs', 'index.jsonl'), entry);
    return entry;
  }
  try {
    let exitCode;
    let output;
    try {
      const res = await runJob(job);
      exitCode = Number.isInteger(res?.exitCode) ? res.exitCode : 2;
      output = String(res?.output ?? '');
    } catch (err) {
      exitCode = Number.isInteger(err?.exitCode) ? err.exitCode : Number.isInteger(err?.code) ? err.code : 2;
      output = String(err?.message ?? err);
    }
    const finishedAt = nowIso(clock);
    const entry = {
      id: runId,
      job,
      startedAt,
      finishedAt,
      status: exitCode === 0 ? 'ok' : 'failed',
      exitCode,
      summary: clip(lastLine(output), 200),
    };
    const runsDir = path.join(state, 'runs');
    writeAtomic(path.join(runsDir, `${runId}.log`), redact(output));
    appendJsonl(path.join(runsDir, 'index.jsonl'), entry);
    // Re-read so a schedule saved during the run is kept; only this job's lastRun changes.
    const current = loadSchedules(state);
    current.jobs[job].lastRun = startedAt;
    saveSchedules(state, current);
    return entry;
  } finally {
    release();
  }
}

/** Run every enabled, due job once, sequentially, under the tick lock. */
export async function tick({ state, now, runJob, clock } = {}) {
  const at = now instanceof Date ? now : new Date((clock || Date.now)());
  const clk = clock || (now instanceof Date ? () => now.getTime() : Date.now);
  const release = acquireLock(path.join(state, 'locks', 'tick.lock'), { ttlMs: TICK_LOCK_TTL_MS, clock: clk });
  if (!release) return { skipped: 'locked' };
  const ran = [];
  try {
    const sched = loadSchedules(state);
    for (const job of JOBS) {
      const cfg = sched.jobs[job];
      if (!cfg.enabled || !isDue(job, cfg, at) || inFlight.has(job)) continue;
      inFlight.add(job);
      try {
        ran.push(await execute(job, { state, runJob, clock: clk }));
      } finally {
        inFlight.delete(job);
      }
    }
  } finally {
    release();
  }
  return { ran };
}

/** Run one job now, recorded the same way as a scheduled run. Refuses a job already in flight. */
export async function runNow(job, { state, runJob, clock, id } = {}) {
  if (!JOBS.includes(job)) throw new TeamError(`unknown job: ${JSON.stringify(job)}`);
  if (inFlight.has(job)) throw new TeamError(`${job} is already running`);
  inFlight.add(job);
  try {
    return await execute(job, { state, runJob, clock, id });
  } finally {
    inFlight.delete(job);
  }
}

function xml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** A macOS background job (property list) running `tick` every intervalSec. No DOCTYPE line (it would carry a URL). */
export function printMacosAgent({ nodePath, teamPath, state, ghPath, intervalSec = 900 } = {}) {
  for (const [name, p] of [['node', nodePath], ['team.mjs', teamPath], ['state', state]]) {
    if (typeof p !== 'string' || !path.isAbsolute(p)) throw new TeamError(`${name} path must be absolute`);
  }
  if (ghPath !== undefined && (typeof ghPath !== 'string' || !path.isAbsolute(ghPath))) {
    throw new TeamError('gh path must be absolute');
  }
  if (!Number.isInteger(intervalSec) || intervalSec < 60) throw new TeamError('interval must be at least 60 seconds');
  const binDirs = [path.dirname(nodePath), ghPath ? path.dirname(ghPath) : null, '/usr/bin', '/bin'];
  const envPath = [...new Set(binDirs.filter(Boolean))].join(':');
  const runs = path.join(state, 'runs');
  const str = (v) => `<string>${xml(v)}</string>`;
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  ${str('team.agentic.tick')}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    ${str(nodePath)}`,
    `    ${str(teamPath)}`,
    `    ${str('tick')}`,
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>AGENTIC_TEAM_HOME</key>',
    `    ${str(state)}`,
    '    <key>PATH</key>',
    `    ${str(envPath)}`,
    '  </dict>',
    '  <key>StartInterval</key>',
    `  <integer>${intervalSec}</integer>`,
    '  <key>RunAtLoad</key>',
    '  <false/>',
    '  <key>StandardOutPath</key>',
    `  ${str(path.join(runs, 'agent.out.log'))}`,
    '  <key>StandardErrorPath</key>',
    `  ${str(path.join(runs, 'agent.err.log'))}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}
