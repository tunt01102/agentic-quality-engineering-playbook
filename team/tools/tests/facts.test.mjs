import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ciFor, coverageFor, findingsTrend, githubSlug, refreshFacts, taskCommits } from '../lib/collect.mjs';
import { scoreTask } from '../lib/score.mjs';
import { readJsonl } from '../lib/util.mjs';
import { tmp, write } from './helpers.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test', ...args], { encoding: 'utf8' }).trim();

function repo() {
  const dir = tmp('core-facts-');
  git(dir, 'init', '-q');
  git(dir, 'remote', 'add', 'origin', 'ssh://github.com/someone/app.git');
  const commit = (name) => {
    write(dir, name, name);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', `add ${name}`);
    return git(dir, 'rev-parse', 'HEAD');
  };
  return { dir, commit };
}

const LENSES = ['failure-path', 'data-scope', 'contract-coverage', 'config-sequencing'];
const record = (over) => ({
  schema: 'core-task-record/1', id: 'app-1', ts: new Date().toISOString(), project: 'app', class: 'fix', outcome: 'done',
  startedAt: new Date().toISOString(), estimate_min: 10, actual_min: 10, requiredGates: ['test'],
  gates: { test: { status: 'pass', runs: 3, runsRequired: 3, tests: 5, kind: 'test' } }, rework_rounds: 0,
  review: { lenses: LENSES, findings: [] }, ...over,
});

test('githubSlug reads GitHub remotes and rejects others', () => {
  assert.equal(githubSlug('ssh://github.com/someone/app.git'), 'someone/app');
  assert.equal(githubSlug('github.com/someone/app'), 'someone/app');
  assert.equal(githubSlug('ssh://gitlab.example/someone/app.git'), null);
  assert.equal(githubSlug(''), null);
});

test('taskCommits returns the commits between start and done', () => {
  const { dir, commit } = repo();
  const start = commit('a');
  const c1 = commit('b');
  const c2 = commit('c');
  assert.deepEqual(taskCommits(dir, { startHead: start, head: c2 }).sort(), [c1, c2].sort());
  assert.deepEqual(taskCommits(dir, { startHead: c2, head: c2 }), [], 'closed before committing: nothing attributable');
  assert.deepEqual(taskCommits(dir, { head: c2 }), [], 'older record without a start: nothing attributable');
  assert.deepEqual(taskCommits(dir, { head: 'nope' }), []);
});

test('ciFor counts failed, pending and passing runs, and says unknown when GitHub cannot be asked', () => {
  const { dir, commit } = repo();
  const start = commit('a');
  const c1 = commit('b');
  const c2 = commit('c');
  const runsBySha = { [c1]: [{ s: 'completed', c: 'failure' }], [c2]: [{ s: 'completed', c: 'success' }] };
  const gh = (args) => JSON.stringify(runsBySha[/head_sha=([0-9a-f]+)/.exec(args[3])[1]] || []);
  const ci = ciFor(dir, { startHead: start, head: c2 }, { gh });
  assert.equal(ci.status, 'fail');
  assert.equal(ci.failed, 1);
  assert.equal(ci.runs, 2);
  assert.equal(ciFor(dir, { startHead: c1, head: c2 }, { gh }).status, 'pass');
  const one = { startHead: c1, head: c2 };
  assert.equal(ciFor(dir, one, { gh: () => JSON.stringify([{ s: 'in_progress', c: null, e: 'push' }]) }).status, 'pending');
  assert.equal(ciFor(dir, one, { gh: () => '[]' }).status, 'none');
  assert.equal(ciFor(dir, one, { gh: () => { throw new Error('404'); } }).status, 'unknown');
  assert.equal(ciFor(dir, one, { gh: () => JSON.stringify([{ s: 'completed', c: 'failure', e: 'schedule' }]) }).status, 'none', 'scheduled runs are not caused by the commit');
  assert.equal(ciFor(dir, { startHead: c2, head: c2 }, { gh }).status, 'none');
  assert.equal(ciFor(dir, { head: c2 }, { gh }).status, 'unknown');
});

test('sabotage: a red CI run lowers rework like a failed local verify; unknown CI does not', () => {
  const base = scoreTask(record({}));
  const red = scoreTask(record({ ci: { status: 'fail', failed: 1 } }));
  const unknown = scoreTask(record({ ci: { status: 'unknown' } }));
  assert.equal(base.breakdown.rework - red.breakdown.rework, 3);
  assert.equal(unknown.breakdown.rework, base.breakdown.rework);
  assert.ok(unknown.notes.includes('ci: not checked'));
});

test('refreshFacts rescores a task once its CI is known and writes coverage', () => {
  const { dir, commit } = repo();
  const start = commit('a');
  const head = commit('b');
  const stray = commit('c'); // a later commit made outside any task
  const state = tmp('core-state-');
  write(state, 'registry.json', JSON.stringify({ projects: { app: { path: dir } } }));
  const rec = record({ startHead: start, head });
  write(state, 'tasks.jsonl', JSON.stringify({ ...rec, ...scoreTask(rec) }) + '\n');
  write(dir, '.claude/team/ledger.jsonl', JSON.stringify(rec) + '\n');
  const gh = () => JSON.stringify([{ s: 'completed', c: 'failure' }]);
  const r = refreshFacts(state, { gh, tokenFor: () => ({}) });
  assert.equal(r.ciUpdated, 1);
  const [t] = readJsonl(path.join(state, 'tasks.jsonl')).records;
  assert.equal(t.ci.status, 'fail');
  assert.equal(t.breakdown.rework, 5);
  const cov = JSON.parse(fs.readFileSync(path.join(state, 'coverage.json'), 'utf8')).projects.app;
  assert.equal(cov.unrecorded, 2, 'the first commit and the stray one have no task');
  assert.ok(cov.sample.some((s) => s.startsWith(stray.slice(0, 7))));
  assert.equal(refreshFacts(state, { gh, tokenFor: () => ({}) }).ciUpdated, 0, 'final CI is not re-queried');
});

test('coverage ignores bot commits and says unknown outside git', () => {
  const { dir, commit } = repo();
  commit('a');
  write(dir, 'bot.txt', 'x');
  git(dir, 'add', '-A');
  execFileSync('git', ['-C', dir, '-c', 'user.name=bot', '-c', 'user.email=github-actions[bot]', 'commit', '-qm', 'bot'], { encoding: 'utf8' });
  assert.equal(coverageFor(dir, []).commits, 1);
  assert.equal(coverageFor(tmp('core-nogit-'), []).status, 'unknown');
});

test('findings trend needs five tasks', () => {
  const t = (n, i) => ({ score: 90, ts: `2026-10-0${i}`, review: { findings: Array(n).fill({}) } });
  assert.equal(findingsTrend([t(1, 1), t(2, 2)]).medianFindings, null);
  assert.equal(findingsTrend([t(1, 1), t(2, 2), t(3, 3), t(4, 4), t(5, 5)]).medianFindings, 3);
});
