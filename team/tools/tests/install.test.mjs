import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { TRIGGER_RE, check, install, resolveProfiles, stripAutoTriggers } from '../lib/install.mjs';
import { TeamError, readJson } from '../lib/util.mjs';
import { commitAll, fakeProject, fakeTeam, tmp, write } from './helpers.mjs';

const setup = (opts) => {
  const team = fakeTeam(opts);
  const project = fakeProject();
  const state = tmp('core-state-');
  return { team, project, state, run: (extra = {}) => install({ project, profiles: ['base'], teamRoot: team.root, state, ...extra }) };
};

test('profiles compose through extends without duplicates', () => {
  const { team } = setup();
  const sel = resolveProfiles(['extra', 'base'], team.root);
  assert.deepEqual(sel.profiles, ['base', 'extra']);
  assert.deepEqual(sel.ecc.skills, ['alpha']);
});

test('unknown profile and cycles are refused', () => {
  const { team } = setup();
  assert.throws(() => resolveProfiles(['nope'], team.root), /unknown profile/);
  write(team.root, 'profiles/a.json', JSON.stringify({ extends: ['b'] }));
  write(team.root, 'profiles/b.json', JSON.stringify({ extends: ['a'] }));
  assert.throws(() => resolveProfiles(['a'], team.root), /cycle/);
});

test('install copies a prefixed, licensed, patched subset and writes the lock', () => {
  const { project, run } = setup();
  const r = run();
  assert.equal(r.dryRun, false);
  const has = (rel) => fs.existsSync(path.join(project, rel));
  assert.ok(has('.claude/skills/ecc-alpha/SKILL.md'));
  assert.ok(has('.claude/skills/ecc-alpha/LICENSE'));
  assert.ok(has('.claude/skills/ecc-alpha/references/notes.md'));
  assert.ok(!has('.claude/skills/ecc-alpha/scripts/helper.py'), 'executable files are skipped');
  assert.ok(has('.claude/agents/LICENSE-ECC'));
  assert.ok(has('.claude/rules/ecc/typescript/style.md'));
  assert.ok(has('.claude/rules/core-team.md'));
  assert.ok(has('.claude/skills/core-dev/SKILL.md'));
  const agent = fs.readFileSync(path.join(project, '.claude/agents/reviewer-x.md'), 'utf8');
  assert.ok(!TRIGGER_RE.test(agent.split('\n').find((l) => l.startsWith('description:'))), 'no trigger phrase survives');
  assert.match(agent, /description: Expert reviewer\. Use when code changes\./);
  assert.match(agent, /use the lint command/);
  assert.match(agent, /^origin: ECC v9\.9\.9/m);
  const lock = readJson(path.join(project, '.claude/team/lock.json'));
  assert.equal(lock.files['.claude/agents/reviewer-x.md'].transforms.join(','), 'strip-auto-triggers,patch:no-rm,origin-line');
  assert.equal(lock.skipped[0].reason, 'skipped-executable');
  assert.ok(lock.unresolved.some((u) => u.refs.includes('/gamma-cmd')), 'missing command reported');
  assert.ok(lock.unresolved.some((u) => u.refs.includes('agent:beta-agent')), 'missing agent reported');
  assert.ok(!JSON.stringify(lock).includes(project), 'lock carries no machine path');
});

test('project-owned files are created once and never overwritten', () => {
  const { project, run } = setup();
  run();
  const settings = path.join(project, '.claude/settings.json');
  assert.match(fs.readFileSync(settings, 'utf8'), /UserPromptSubmit/);
  fs.writeFileSync(settings, '{"project":"owned"}\n');
  fs.writeFileSync(path.join(project, '.claude/rules/core-project.md'), 'mine\n');
  commitAll(project);
  run();
  assert.equal(fs.readFileSync(settings, 'utf8'), '{"project":"owned"}\n');
  assert.equal(fs.readFileSync(path.join(project, '.claude/rules/core-project.md'), 'utf8'), 'mine\n');
});

test('the settings hook prints valid JSON with additionalContext', async () => {
  const { project, run } = setup();
  run();
  const cmd = readJson(path.join(project, '.claude/settings.json')).hooks.UserPromptSubmit[0].hooks[0].command;
  const { execFileSync } = await import('node:child_process');
  const outJson = JSON.parse(execFileSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' }));
  assert.match(outJson.hookSpecificOutput.additionalContext, /core-dev/);
});

test('a foreign file at an install path is not overwritten', () => {
  const { project, run } = setup();
  write(project, '.claude/agents/reviewer-x.md', 'project agent\n');
  assert.throws(() => run(), /not installed by the core/);
  assert.equal(fs.readFileSync(path.join(project, '.claude/agents/reviewer-x.md'), 'utf8'), 'project agent\n');
});

test('a patch that matches nothing fails the install', () => {
  const { run, team } = setup();
  const p = readJson(path.join(team.root, 'profiles/base.json'));
  p.patches[0].search = 'text that is not there';
  write(team.root, 'profiles/base.json', JSON.stringify(p));
  assert.throws(() => run(), /matched nothing/);
});

test('a skill that depends on its script is refused', () => {
  const { run, team } = setup();
  const p = readJson(path.join(team.root, 'profiles/base.json'));
  p.ecc.skills.push('scripted');
  write(team.root, 'profiles/base.json', JSON.stringify(p));
  assert.throws(() => run(), /depends on executable/);
});

test('an unscoped rule is refused', () => {
  const { run, team } = setup();
  const p = readJson(path.join(team.root, 'profiles/base.json'));
  p.ecc.rules.push('common/always.md');
  write(team.root, 'profiles/base.json', JSON.stringify(p));
  assert.throws(() => run(), /no paths: scope/);
});

test('a symlink in the source is refused', () => {
  const { run, team } = setup();
  fs.symlinkSync('/etc/hosts', path.join(team.ecc, 'skills/alpha/linked.md'));
  assert.throws(() => run(), /symlink/);
});

test('a symlinked .claude directory in the project is refused', () => {
  const { project, run } = setup();
  const elsewhere = tmp('core-elsewhere-');
  fs.symlinkSync(elsewhere, path.join(project, '.claude'));
  assert.throws(() => run(), /symlink/);
  assert.equal(fs.readdirSync(elsewhere).length, 0);
});

test('check is clean after install and goes red on each kind of drift (sabotage)', () => {
  const { project, team, state, run } = setup();
  run();
  const c = () => check({ project, teamRoot: team.root, state });
  assert.equal(c().status, 'clean');
  const skill = path.join(project, '.claude/skills/ecc-alpha/SKILL.md');
  const orig = fs.readFileSync(skill);
  fs.appendFileSync(skill, 'x');
  assert.equal(c().status, 'drift', 'one changed byte');
  fs.writeFileSync(skill, orig);
  write(project, '.claude/skills/ecc-alpha/extra.md', 'smuggled\n');
  assert.match(c().problems.join('\n'), /unknown file/, 'extra file');
  fs.rmSync(path.join(project, '.claude/skills/ecc-alpha/extra.md'));
  fs.rmSync(path.join(project, '.claude/agents/LICENSE-ECC'));
  assert.match(c().problems.join('\n'), /missing/, 'missing file');
});

test('check reports outdated when the core source changes, without calling it drift', () => {
  const { project, team, state, run } = setup();
  run();
  fs.appendFileSync(path.join(team.root, 'core/skills/core-dev/SKILL.md'), '\nnew line\n');
  const r = check({ project, teamRoot: team.root, state });
  assert.equal(r.status, 'clean');
  assert.ok(r.outdated.some((o) => o.includes('core-dev')));
});

test('check without the pinned checkout cannot run (exit code 2)', () => {
  const { project, team, state, run } = setup();
  run();
  fs.rmSync(team.ecc, { recursive: true, force: true });
  assert.throws(
    () => check({ project, teamRoot: team.root, state }),
    (err) => err instanceof TeamError && err.code === 2,
  );
});

test('a moved pin is refused', () => {
  const { team, run } = setup();
  const lock = readJson(path.join(team.root, 'ecc.lock.json'));
  lock.commit = 'f'.repeat(40);
  write(team.root, 'ecc.lock.json', JSON.stringify(lock));
  assert.throws(() => run(), /the pin says/);
});

test('reinstall removes files a profile dropped, and refuses when they were edited', () => {
  const { project, team, run } = setup();
  run();
  commitAll(project);
  const p = readJson(path.join(team.root, 'profiles/base.json'));
  p.ecc.rules = [];
  write(team.root, 'profiles/base.json', JSON.stringify(p));
  const r = run();
  assert.ok(r.removed.includes('.claude/rules/ecc/typescript/style.md'));
  assert.ok(!fs.existsSync(path.join(project, '.claude/rules/ecc')));
});

test('dry run writes nothing', () => {
  const { project, run } = setup();
  const r = run({ dryRun: true });
  assert.ok(r.plan.length > 5);
  assert.ok(!fs.existsSync(path.join(project, '.claude')));
});

test('install registers the project in the state directory', () => {
  const { project, state, run } = setup();
  run();
  const reg = readJson(path.join(state, 'registry.json'));
  assert.equal(reg.projects[path.basename(project)].path, project);
  assert.deepEqual(reg.projects[path.basename(project)].profiles, ['base']);
});

test('stripAutoTriggers keeps the when-clause and drops mandates', () => {
  const t = '---\nname: a\ndescription: Reviews code. Use PROACTIVELY when editing. MUST BE USED for all code changes.\n---\nbody\n';
  const r = stripAutoTriggers(t);
  assert.equal(r.changed, true);
  assert.match(r.text, /description: Reviews code\. Use when editing\.\n/);
  assert.equal(stripAutoTriggers('---\nname: a\ndescription: Plain. Use when asked.\n---\n').changed, false);
});

test('regression: "Use for all"/"immediately after" descriptions keep their scope', () => {
  const t = '---\nname: r\ndescription: Expert reviewer. Use for all TypeScript and JavaScript code changes. Use immediately after writing code. MUST BE USED for all code changes.\n---\n';
  const r = stripAutoTriggers(t).text;
  assert.match(r, /description: Expert reviewer\. Use for TypeScript and JavaScript code changes\. Use after writing code\.\n/);
  assert.ok(!TRIGGER_RE.test(r));
});

test('regression: two projects with the same folder name keep separate registry entries', async () => {
  const { registerProject } = await import('../lib/install.mjs');
  const state = tmp('core-state-');
  const lock = { requested: ['base'], coreVersion: '0', ecc: { commit: 'x' }, installedAt: 't' };
  registerProject({ state, project: '/a/app', lock });
  registerProject({ state, project: '/b/app', lock });
  const reg = readJson(path.join(state, 'registry.json'));
  assert.equal(Object.keys(reg.projects).length, 2);
  assert.deepEqual(Object.values(reg.projects).map((p) => p.path).sort(), ['/a/app', '/b/app']);
});

test('sabotage: a tampered lock cannot make install delete files outside .claude', () => {
  const { project, run } = setup();
  run();
  commitAll(project);
  const victim = write(path.dirname(project), `victim-${path.basename(project)}.txt`, 'keep me\n');
  const lockFile = path.join(project, '.claude/team/lock.json');
  const lock = readJson(lockFile);
  lock.files[`../${path.basename(victim)}`] = { source: 'core', sha256: 'x' };
  fs.writeFileSync(lockFile, JSON.stringify(lock));
  assert.throws(() => run({ force: true }), /outside \.claude/);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep me\n');
});

test('check without the pinned checkout names the missing pin', () => {
  const { project, team, state, run } = setup();
  run();
  fs.rmSync(team.ecc, { recursive: true, force: true });
  assert.throws(() => check({ project, teamRoot: team.root, state }), /pinned ECC checkout missing/);
});
