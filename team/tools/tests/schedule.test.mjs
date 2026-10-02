import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  JOBS,
  freshness,
  isDue,
  loadSchedules,
  printMacosAgent,
  runNow,
  saveSchedules,
  tick,
  validateSchedules,
} from '../lib/schedule.mjs';
import { readJsonl } from '../lib/util.mjs';

function tmpState() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'team-schedule-'));
}

// Local-time dates: 2026-10-05 is a Monday.
const at = (d, h, m = 0) => new Date(2026, 9, d, h, m, 0, 0);
const iso = (date) => date.toISOString();

test('JOBS is the fixed list', () => {
  assert.deepEqual(JOBS, ['collect', 'evaluate', 'scout']);
});

test('defaults when schedules.json is absent', () => {
  const s = loadSchedules(tmpState());
  assert.equal(s.jobs.collect.every, 'hourly');
  assert.equal(s.jobs.collect.enabled, true);
  assert.equal(s.jobs.evaluate.every, 'daily');
  assert.equal(s.jobs.evaluate.hour, 7);
  assert.equal(s.jobs.scout.every, 'weekly');
  assert.equal(s.jobs.scout.weekday, 1);
  assert.equal(s.jobs.scout.hour, 8);
  assert.equal(s.jobs.scout.enabled, false);
});

test('hourly: due when never run, not at 59 min, due at exactly 60 min', () => {
  const now = at(5, 12, 0);
  const cfg = (lastRun) => ({ enabled: true, every: 'hourly', hour: 0, weekday: 0, lastRun });
  assert.equal(isDue('collect', cfg(null), now), true);
  assert.equal(isDue('collect', cfg(iso(new Date(now.getTime() - 59 * 60000))), now), false);
  assert.equal(isDue('collect', cfg(iso(new Date(now.getTime() - 60 * 60000))), now), true);
});

test('daily: not before the slot, due at exactly the slot, once per day', () => {
  const cfg = (lastRun) => ({ enabled: true, every: 'daily', hour: 7, weekday: 0, lastRun });
  assert.equal(isDue('evaluate', cfg(null), at(5, 6, 59)), false);
  assert.equal(isDue('evaluate', cfg(null), at(5, 7, 0)), true);
  assert.equal(isDue('evaluate', cfg(iso(at(4, 7, 0))), at(5, 7, 0)), true, 'yesterday ran, today is due');
  assert.equal(isDue('evaluate', cfg(iso(at(5, 7, 0))), at(5, 23, 0)), false, 'already ran in this slot');
  assert.equal(isDue('evaluate', cfg(iso(at(5, 6, 59))), at(5, 7, 1)), true, 'a run before the slot does not count');
});

test('weekly: only on the weekday, at or after the hour, once per week', () => {
  const cfg = (lastRun) => ({ enabled: true, every: 'weekly', hour: 8, weekday: 1, lastRun });
  assert.equal(isDue('scout', cfg(null), at(5, 7, 59)), false, 'Monday before 08:00');
  assert.equal(isDue('scout', cfg(null), at(5, 8, 0)), true, 'Monday at 08:00');
  assert.equal(isDue('scout', cfg(null), at(6, 9, 0)), false, 'Tuesday');
  assert.equal(isDue('scout', cfg(iso(at(5, 8, 0))), at(5, 20, 0)), false, 'already ran today');
  assert.equal(isDue('scout', cfg(iso(at(5, 8, 0))), at(12, 8, 0)), true, 'next Monday');
});

test('validateSchedules rejects bad values', () => {
  const ok = { jobs: { collect: { enabled: true, every: 'hourly', hour: 0, weekday: 0, lastRun: null } } };
  assert.equal(validateSchedules(ok).jobs.collect.every, 'hourly');
  const bad = [
    null,
    [],
    { jobs: [] },
    { jobs: {}, extra: 1 },
    { jobs: { deploy: { enabled: true } } },
    { jobs: { collect: { colour: 'red' } } },
    { jobs: { collect: { enabled: 'yes' } } },
    { jobs: { collect: { every: 'monthly' } } },
    { jobs: { collect: { hour: 24 } } },
    { jobs: { collect: { hour: -1 } } },
    { jobs: { collect: { hour: 1.5 } } },
    { jobs: { collect: { weekday: 7 } } },
    { jobs: { collect: { weekday: '1' } } },
    { jobs: { collect: { lastRun: 'not a date' } } },
  ];
  for (const b of bad) assert.throws(() => validateSchedules(b), { name: 'Error' }, JSON.stringify(b));
});

test('saveSchedules validates and round trips', () => {
  const state = tmpState();
  saveSchedules(state, { jobs: { scout: { enabled: true, every: 'daily', hour: 3 } } });
  const s = loadSchedules(state);
  assert.equal(s.jobs.scout.enabled, true);
  assert.equal(s.jobs.scout.hour, 3);
  assert.equal(s.jobs.collect.every, 'hourly');
  assert.throws(() => saveSchedules(state, { jobs: { scout: { hour: 99 } } }));
  assert.equal(loadSchedules(state).jobs.scout.hour, 3, 'a rejected save leaves the file unchanged');
});

test('tick runs due enabled jobs, records runs and updates lastRun', async () => {
  const state = tmpState();
  const now = at(5, 9, 0);
  const calls = [];
  const res = await tick({
    state,
    now,
    runJob: async (job) => {
      calls.push(job);
      return { exitCode: 0, output: `did ${job}\nfinished ${job}` };
    },
  });
  assert.deepEqual(calls, ['collect', 'evaluate'], 'scout is disabled by default');
  assert.equal(res.ran.length, 2);
  const { records } = readJsonl(path.join(state, 'runs', 'index.jsonl'));
  assert.equal(records.length, 2);
  assert.equal(records[0].status, 'ok');
  assert.equal(records[0].exitCode, 0);
  assert.equal(records[0].summary, 'finished collect');
  assert.match(fs.readFileSync(path.join(state, 'runs', `${records[0].id}.log`), 'utf8'), /did collect/);
  const s = loadSchedules(state);
  assert.equal(s.jobs.collect.lastRun, now.toISOString());
  assert.equal(s.jobs.scout.lastRun, null);
  const again = await tick({ state, now, runJob: async () => assert.fail('nothing should be due') });
  assert.deepEqual(again.ran, []);
});

test('tick records a failed run with its exit code and still releases the lock', async () => {
  const state = tmpState();
  const now = at(5, 9, 0);
  saveSchedules(state, { jobs: { evaluate: { enabled: false } } });
  const res = await tick({ state, now, runJob: async () => ({ exitCode: 3, output: 'boom' }) });
  assert.equal(res.ran[0].status, 'failed');
  assert.equal(res.ran[0].exitCode, 3);
  assert.equal(fs.existsSync(path.join(state, 'locks', 'tick.lock')), false);
  assert.equal(loadSchedules(state).jobs.collect.lastRun, now.toISOString(), 'a failed run still updates lastRun');
});

test('tick releases the lock when runJob throws', async () => {
  const state = tmpState();
  saveSchedules(state, { jobs: { evaluate: { enabled: false } } });
  const res = await tick({
    state,
    now: at(5, 9, 0),
    runJob: async () => {
      throw new Error('spawn failed');
    },
  });
  assert.equal(res.ran[0].status, 'failed');
  assert.equal(res.ran[0].exitCode, 2);
  assert.equal(fs.existsSync(path.join(state, 'locks', 'tick.lock')), false);
});

test('a held lock skips the tick; a stale lock is taken over', async () => {
  const state = tmpState();
  const now = at(5, 9, 0);
  const lock = path.join(state, 'locks', 'tick.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, started: now.getTime() - 60 * 1000 }));
  const held = await tick({ state, now, runJob: async () => assert.fail('must not run while locked') });
  assert.deepEqual(held, { skipped: 'locked' });
  assert.equal(fs.existsSync(lock), true, 'a held lock is left alone');

  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, started: now.getTime() - 3 * 60 * 60 * 1000 }));
  const ran = [];
  const res = await tick({ state, now, runJob: async (job) => (ran.push(job), { exitCode: 0, output: '' }) });
  assert.ok(res.ran.length > 0);
  assert.ok(ran.includes('collect'));
  assert.equal(fs.existsSync(lock), false);
});

test('runNow records without a due check and refuses a job in flight', async () => {
  const state = tmpState();
  let release;
  const gate = new Promise((r) => (release = r));
  const first = runNow('scout', { state, runJob: async () => (await gate, { exitCode: 0, output: 'ok' }) });
  await assert.rejects(runNow('scout', { state, runJob: async () => ({ exitCode: 0, output: '' }) }), /already running/);
  release();
  const entry = await first;
  assert.equal(entry.job, 'scout');
  assert.equal(entry.status, 'ok');
  assert.notEqual(loadSchedules(state).jobs.scout.lastRun, null);
  await assert.rejects(runNow('deploy', { state }), /unknown job/);
});

test('printMacosAgent has no DOCTYPE, escapes values and uses absolute paths', () => {
  const xml = printMacosAgent({
    nodePath: '/usr/local/bin/node',
    teamPath: '/usr/local/team & <co>/tools/team.mjs',
    state: '/usr/local/state',
  });
  assert.doesNotMatch(xml, /DOCTYPE/i);
  assert.match(xml, /team &amp; &lt;co&gt;/);
  assert.doesNotMatch(xml, /<co>/);
  assert.match(xml, /<string>tick<\/string>/);
  assert.match(xml, /<key>StandardOutPath<\/key>\s*<string>\/usr\/local\/state\/runs\//);
  assert.match(xml, /<key>StandardErrorPath<\/key>\s*<string>\/usr\/local\/state\/runs\//);
  assert.match(xml, /<integer>900<\/integer>/);
  assert.throws(() => printMacosAgent({ nodePath: 'node', teamPath: '/usr/t.mjs', state: '/usr/s' }), /absolute/);
});

test('freshness: fresh, stale, missed and disabled per cadence', () => {
  const hourly = (lastRun, enabled = true) => ({ enabled, every: 'hourly', hour: 0, weekday: 0, lastRun });
  const now = at(5, 12, 0);
  const ago = (min) => iso(new Date(now.getTime() - min * 60000));
  assert.equal(freshness(hourly(ago(59)), now), 'fresh');
  assert.equal(freshness(hourly(ago(60)), now), 'stale');
  assert.equal(freshness(hourly(ago(179)), now), 'stale');
  assert.equal(freshness(hourly(ago(180)), now), 'missed');
  assert.equal(freshness(hourly(null), now), 'missed', 'never ran while enabled');
  assert.equal(freshness(hourly(null, false), now), 'disabled');

  const daily = (lastRun) => ({ enabled: true, every: 'daily', hour: 7, weekday: 0, lastRun });
  assert.equal(freshness(daily(iso(at(5, 7, 0))), at(5, 12)), 'fresh');
  assert.equal(freshness(daily(iso(at(4, 7, 0))), at(5, 6, 59)), 'fresh', 'before today\'s slot');
  assert.equal(freshness(daily(iso(at(4, 7, 0))), at(5, 7, 0)), 'stale');
  assert.equal(freshness(daily(iso(at(3, 7, 0))), at(5, 12)), 'stale');
  assert.equal(freshness(daily(iso(at(2, 7, 0))), at(5, 12)), 'missed');

  const weekly = (lastRun) => ({ enabled: true, every: 'weekly', hour: 8, weekday: 1, lastRun });
  assert.equal(freshness(weekly(iso(at(5, 8, 0))), at(9, 12)), 'fresh');
  assert.equal(freshness(weekly(iso(at(5, 8, 0))), at(12, 8, 0)), 'stale', 'the next Monday slot passed');
  assert.equal(freshness(weekly(iso(at(5, 8, 0))), at(26, 9, 0)), 'missed', 'three Mondays passed');
});

test('mutation: a run log is redacted', async () => {
  const state = tmpState();
  const secret = ['sk', 'abcdefghijklmnopqrstuvwx1234'].join('-');
  const entry = await runNow('collect', { state, runJob: async () => ({ exitCode: 0, output: `leaked ${secret}` }) });
  const log = fs.readFileSync(path.join(state, 'runs', `${entry.id}.log`), 'utf8');
  assert.ok(!log.includes(secret));
  assert.match(log, /\[redacted\]/);
});

test('a job already running in another process is recorded as skipped', async () => {
  const { acquireLock } = await import('../lib/util.mjs');
  const state = tmpState();
  const release = acquireLock(path.join(state, 'locks', 'job-collect.lock'));
  const entry = await runNow('collect', { state, runJob: async () => assert.fail('must not run') });
  assert.equal(entry.status, 'skipped');
  release();
});
