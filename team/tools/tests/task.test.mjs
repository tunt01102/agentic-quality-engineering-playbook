import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { install } from '../lib/install.mjs';
import { ledgerFile, parseTestCount, reviewAdd, reviewResolve, taskDone, taskStart, verify } from '../lib/task.mjs';
import { readJsonl } from '../lib/util.mjs';
import { commitAll, fakeProject, fakeTeam, tmp, write } from './helpers.mjs';

function setup(scripts) {
  const team = fakeTeam();
  const project = fakeProject(scripts);
  const state = tmp('core-state-');
  install({ project, profiles: ['base'], teamRoot: team.root, state });
  commitAll(project, 'install');
  let t = Date.parse('2026-10-02T00:00:00Z');
  const clock = () => t;
  const advance = (min) => (t += min * 60000);
  return { project, clock, advance };
}

const allLenses = (project, task) => {
  for (const lens of ['failure-path', 'data-scope', 'contract-coverage', 'config-sequencing']) reviewAdd({ project, task, lens, findings: 0 });
};

test('a full task records receipt-backed gates and derived timings', () => {
  const { project, clock, advance } = setup();
  const t = taskStart({ project, title: 'Fix rounding', cls: 'fix', estimate: 30, premise: 'confirmed', clock });
  write(project, 'src/a.ts', 'export const a = 1;\n');
  const { receipt } = verify({ project, task: t.id, clock });
  assert.equal(receipt.pass, true);
  assert.equal(receipt.gates.find((g) => g.id === 'test').runs.length, 3);
  allLenses(project, t.id);
  advance(40);
  const rec = taskDone({ project, task: t.id, outcome: 'done', evidence: ['rounding: unit test passes'], clock });
  assert.equal(rec.actual_min, 40);
  assert.equal(rec.estimate_min, 30);
  assert.deepEqual(rec.requiredGates, ['lint', 'test', 'build']);
  assert.equal(rec.gates.test.status, 'pass');
  assert.equal(rec.gates.test.tests, 4);
  assert.equal(readJsonl(ledgerFile(project)).records.length, 1);
  assert.ok(!fs.existsSync(path.join(project, '.claude/team/open', `${t.id}.json`)));
});

test('done without a receipt is refused; partial records the gates as claimed (sabotage: fabricated pass)', () => {
  const { project, clock } = setup();
  const t = taskStart({ project, title: 'No verify', cls: 'fix', estimate: 10, premise: 'confirmed', clock });
  allLenses(project, t.id);
  assert.throws(() => taskDone({ project, task: t.id, outcome: 'done', evidence: ['says it passed'], clock }), /no verify receipt/);
  const rec = taskDone({ project, task: t.id, outcome: 'partial', evidence: ['x'], clock });
  assert.equal(rec.gates.test.status, 'claimed');
});

test('editing code after verify voids the receipt; committing it does not', () => {
  const { project, clock } = setup();
  const t = taskStart({ project, title: 'Edit after', cls: 'fix', estimate: 10, premise: 'confirmed', clock });
  write(project, 'src/a.ts', 'a\n');
  verify({ project, task: t.id, clock });
  allLenses(project, t.id);
  commitAll(project, 'commit the verified tree');
  const ok = taskDone({ project, task: `${t.id}`, outcome: 'partial', evidence: ['x'], clock });
  assert.equal(ok.gates.lint.status, 'pass', 'commit after verify keeps the receipt');

  const t2 = taskStart({ project, title: 'Edit after two', cls: 'fix', estimate: 10, premise: 'confirmed', clock });
  verify({ project, task: t2.id, clock });
  allLenses(project, t2.id);
  write(project, 'src/a.ts', 'changed after verify\n');
  assert.throws(() => taskDone({ project, task: t2.id, outcome: 'done', evidence: ['x'], clock }), /changed after the last verify/);
});

test('a test gate that counts zero tests fails', () => {
  const { project, clock } = setup({ lint: 'true', test: 'echo "no tests found"', build: 'true' });
  const { receipt } = verify({ project, clock });
  assert.equal(receipt.pass, false);
  assert.equal(receipt.gates.find((g) => g.id === 'test').reason, 'no tests counted');
});

test('a failing gate stops its runs and fails the receipt; rework is derived', () => {
  const { project, clock } = setup({ lint: 'exit 3', test: 'echo "Tests  1 passed"', build: 'true' });
  const t = taskStart({ project, title: 'Lint red', cls: 'fix', estimate: 10, premise: 'confirmed', clock });
  const { receipt } = verify({ project, task: t.id, clock });
  assert.equal(receipt.pass, false);
  assert.equal(receipt.gates[0].runs[0].exit, 3);
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ scripts: { lint: 'true', test: 'echo "Tests  1 passed"', build: 'true' } }));
  // project.json is project-owned and already holds the old commands; edit it as the project would
  const cfgFile = path.join(project, '.claude/team/project.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.gates[0].cmd = 'true';
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  verify({ project, task: t.id, clock });
  allLenses(project, t.id);
  const rec = taskDone({ project, task: t.id, outcome: 'done', evidence: ['fixed'], clock });
  assert.equal(rec.rework_rounds, 1);
  assert.equal(rec.verifyRounds, 2);
});

test('review rules: location required, waiver needs a reason, open high blocks done', () => {
  const { project, clock } = setup();
  const t = taskStart({ project, title: 'Review rules', cls: 'feature', estimate: 10, premise: 'confirmed', clock });
  assert.throws(() => reviewAdd({ project, task: t.id, lens: 'data-scope', severity: 'high', where: 'src/a.ts', disposition: 'open' }), /file:line/);
  assert.throws(() => reviewAdd({ project, task: t.id, lens: 'data-scope', severity: 'low', where: 'a.ts:1', disposition: 'waived' }), /reason/);
  assert.throws(() => reviewAdd({ project, task: t.id, lens: 'data-scope', findings: 3 }), /--findings 0/);
  verify({ project, task: t.id, clock });
  allLenses(project, t.id);
  reviewAdd({ project, task: t.id, lens: 'data-scope', severity: 'high', where: 'src/a.ts:9', disposition: 'open' });
  assert.throws(() => taskDone({ project, task: t.id, outcome: 'done', evidence: ['x'], clock }), /still open/);
  reviewResolve({ project, task: t.id, where: 'src/a.ts:9', disposition: 'fixed' });
  const rec = taskDone({ project, task: t.id, outcome: 'done', evidence: ['x'], clock });
  assert.equal(rec.review.findings[0].disposition, 'fixed');
});

test('missing lenses block done for reviewed classes but not for investigate', () => {
  const { project, clock } = setup();
  const t = taskStart({ project, title: 'Lens gap', cls: 'change', estimate: 10, premise: 'confirmed', clock });
  verify({ project, task: t.id, clock });
  reviewAdd({ project, task: t.id, lens: 'failure-path', findings: 0 });
  assert.throws(() => taskDone({ project, task: t.id, outcome: 'done', evidence: ['x'], clock }), /lenses not recorded: data-scope/);
  const i = taskStart({ project, title: 'Look', cls: 'investigate', estimate: 10, premise: 'plausible', clock });
  verify({ project, task: i.id, clock });
  assert.equal(taskDone({ project, task: i.id, outcome: 'done', evidence: ['found it'], clock }).outcome, 'done');
});

test('inputs are validated and free text is redacted', () => {
  const { project, clock } = setup();
  assert.throws(() => taskStart({ project, title: 'x', cls: 'nope', estimate: 1, premise: 'confirmed', clock }), /--class/);
  assert.throws(() => taskStart({ project, title: 'x', cls: 'fix', estimate: -1, premise: 'confirmed', clock }), /--estimate/);
  assert.throws(() => taskDone({ project, task: '../../etc', outcome: 'done', clock }), /invalid task id/);
  const t = taskStart({ project, title: 'Redact', cls: 'investigate', estimate: 5, premise: 'confirmed', clock });
  verify({ project, task: t.id, clock });
  const fakeKey = ['sk', 'abcdefghijklmnopqrstuvwxyz0123'].join('-');
  const rec = taskDone({ project, task: t.id, outcome: 'done', evidence: [`leaked ${fakeKey} in output`], clock });
  assert.ok(!rec.evidence[0].includes(fakeKey));
  assert.match(rec.evidence[0], /\[redacted\]/);
});

test('parseTestCount understands common runners and returns null otherwise', () => {
  assert.equal(parseTestCount(' Test Files  39 passed (39)\n      Tests  662 passed (662)'), 662);
  assert.equal(parseTestCount('Tests:       2 failed, 10 passed, 12 total'), 10);
  assert.equal(parseTestCount('# tests 5\n# pass 5\n# fail 0'), 5);
  assert.equal(parseTestCount('  7 passing (20ms)'), 7);
  assert.equal(parseTestCount('nothing ran'), null);
});

test('merge stage runs test gates five times', () => {
  const { project, clock } = setup();
  const { receipt } = verify({ project, stage: 'merge', clock });
  assert.equal(receipt.gates.find((g) => g.id === 'test').runs.length, 5);
});

test('sabotage: evidence that admits an omission cannot be recorded as done', async () => {
  const { project, clock } = setup();
  const t = taskStart({ project, title: 'Omission', cls: 'investigate', estimate: 5, premise: 'confirmed', clock });
  verify({ project, task: t.id, clock });
  assert.throws(() => taskDone({ project, task: t.id, outcome: 'done', evidence: ['browser smoke not run'], clock }), /admits an omission/);
});

test('gate passes only for a tree with a passing receipt', async () => {
  const { gate } = await import('../lib/task.mjs');
  const { project, clock } = setup();
  assert.equal(gate({ project }).pass, false);
  verify({ project, clock });
  assert.equal(gate({ project }).pass, true);
  write(project, 'src/new.ts', 'x\n');
  assert.match(gate({ project }).reason, /no receipt for the current tree/);
});

test('regression: two tasks started in the same second get different ids', () => {
  const { project, clock } = setup();
  const a = taskStart({ project, title: 'Same', cls: 'fix', estimate: 5, premise: 'confirmed', clock });
  const b = taskStart({ project, title: 'Same', cls: 'change', estimate: 5, premise: 'confirmed', clock });
  assert.notEqual(a.id, b.id);
  assert.throws(() => taskStart({ project, title: true, cls: 'fix', estimate: 5, premise: 'confirmed', clock }), /--title/);
});

test('regression: deleting a receipt never makes the next verify overwrite another', () => {
  const { project, clock } = setup();
  const t = taskStart({ project, title: 'Receipts', cls: 'fix', estimate: 5, premise: 'confirmed', clock });
  const r1 = verify({ project, task: t.id, clock });
  const r2 = verify({ project, task: t.id, clock });
  fs.rmSync(r1.file);
  const r3 = verify({ project, task: t.id, clock });
  assert.notEqual(r3.file, r2.file);
  assert.equal(r3.receipt.n, 3);
});

test('regression: the omission check only fires on admissions, not on fixes of missing things', async () => {
  const { OMISSION_RE } = await import('../lib/task.mjs');
  assert.equal(OMISSION_RE.test('fixed the missing null check'), false);
  assert.equal(OMISSION_RE.test('0 skipped, 40 passed'), false);
  assert.equal(OMISSION_RE.test('browser smoke not run'), true);
  assert.equal(OMISSION_RE.test('missing: mobile screenshot'), true);
});

test('regression: editing project.json gates after verify voids the receipt', () => {
  const { project, clock } = setup();
  const t = taskStart({ project, title: 'Gate edit', cls: 'investigate', estimate: 5, premise: 'confirmed', clock });
  verify({ project, task: t.id, clock });
  const cfgFile = path.join(project, '.claude/team/project.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.gates = cfg.gates.filter((g) => g.id !== 'test');
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  assert.throws(() => taskDone({ project, task: t.id, outcome: 'done', evidence: ['x'], clock }), /changed after the last verify/);
});

test('sabotage: a hand-written receipt is ignored', async () => {
  const { gate, worktreeTree } = await import('../lib/task.mjs');
  const { project, clock } = setup();
  const tree = worktreeTree(project);
  write(project, '.claude/team/receipts/adhoc-001.json', JSON.stringify({ schema: 'core-receipt/1', tree, pass: true, ts: 'x', gates: [] }));
  assert.equal(gate({ project }).pass, false);
  const t = taskStart({ project, title: 'Forged', cls: 'investigate', estimate: 5, premise: 'confirmed', clock });
  write(project, `.claude/team/receipts/${t.id}-001.json`, JSON.stringify({ schema: 'core-receipt/1', task: t.id, tree, pass: true, ts: 'x', gates: [{ id: 'lint', status: 'pass', runs: [{}] }] }));
  assert.throws(() => taskDone({ project, task: t.id, outcome: 'done', evidence: ['x'], clock }), /no verify receipt/);
});

test('mutation: partial after an edit records gates as claimed', () => {
  const { project, clock } = setup();
  const t = taskStart({ project, title: 'Partial edit', cls: 'fix', estimate: 5, premise: 'confirmed', clock });
  verify({ project, task: t.id, clock });
  write(project, 'src/late.ts', 'x\n');
  const rec = taskDone({ project, task: t.id, outcome: 'partial', evidence: ['x'], clock });
  assert.equal(rec.gates.lint.status, 'claimed');
  assert.match(rec.gates.lint.reason, /changed after the last verify/);
});

test('mutation: a test gate reporting 0 passed fails, and skipped tests are not counted', () => {
  assert.equal(parseTestCount('# pass 0\n# skipped 5'), 0);
  const { project, clock } = setup({ lint: 'true', test: 'echo "# pass 0"', build: 'true' });
  const { receipt } = verify({ project, clock });
  assert.equal(receipt.pass, false);
  assert.equal(receipt.gates.find((g) => g.id === 'test').reason, 'no tests counted');
});

test('gate commands are redacted in receipts', () => {
  const fakeKey = ['ghp', 'abcdefghijklmnopqrstuvwx1234'].join('_');
  const { project, clock } = setup({ lint: `echo ${fakeKey} >/dev/null`, test: 'echo "Tests  1 passed"', build: 'true' });
  const { file } = verify({ project, clock });
  assert.ok(!fs.readFileSync(file, 'utf8').includes(fakeKey));
});
