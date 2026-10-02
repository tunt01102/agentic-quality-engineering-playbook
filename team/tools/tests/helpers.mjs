// Test fixtures: a throwaway team root with a fake pinned ECC checkout, and a throwaway project.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEAM_ROOT } from '../lib/util.mjs';

const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test', ...args], { encoding: 'utf8' }).trim();

export function tmp(prefix = 'core-test-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function write(root, rel, text) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return abs;
}

/** A team root that reuses the real core payload but a fake, tiny ECC pin. */
export function fakeTeam({ profiles, eccFiles } = {}) {
  const root = tmp('core-team-');
  fs.cpSync(path.join(TEAM_ROOT, 'core'), path.join(root, 'core'), { recursive: true });
  const ecc = path.join(root, '.cache', 'ecc-v9.9.9');
  const files = eccFiles || {
    LICENSE: 'MIT License\n\nCopyright (c) test\n',
    'skills/alpha/SKILL.md': '---\nname: alpha\ndescription: Alpha skill. Use when testing.\n---\nSee `beta-agent` and run /gamma-cmd first.\n',
    'skills/alpha/references/notes.md': 'notes\n',
    'skills/alpha/scripts/helper.py': 'print(1)\n',
    'skills/scripted/SKILL.md': '---\nname: scripted\ndescription: Needs a script.\n---\nRun scripts/run.js now.\n',
    'skills/scripted/scripts/run.js': 'console.log(1)\n',
    'agents/reviewer-x.md': '---\nname: reviewer-x\ndescription: Expert reviewer. Use PROACTIVELY when code changes. MUST BE USED for all code changes.\ntools: Read, Grep\nmodel: sonnet\n---\nBody\n# Reinstall\nrm -rf node_modules\n',
    'agents/beta-agent.md': '---\nname: beta-agent\ndescription: Beta.\ntools: Read\n---\n',
    'commands/gamma-cmd.md': '# gamma\n',
    'rules/typescript/style.md': ['---', 'paths:', '  - "**/*.ts"', '---', 'Style', ''].join('\n'),
    'rules/common/always.md': '# no scope\n',
  };
  for (const [rel, text] of Object.entries(files)) write(ecc, rel, text);
  git(ecc, 'init', '-q');
  git(ecc, 'add', '-A');
  git(ecc, 'commit', '-qm', 'pin');
  const commit = git(ecc, 'rev-parse', 'HEAD');
  write(root, 'ecc.lock.json', JSON.stringify({ name: 'ECC', repo: 'example/ECC', tag: 'v9.9.9', commit, license: 'MIT' }));
  const defaultProfiles = profiles || {
    base: {
      core: { rules: ['core-team.md'], skills: ['core-dev'], agents: ['core-verifier'] },
      ecc: { skills: ['alpha'], agents: ['reviewer-x'], rules: ['typescript/style.md'] },
      patches: [{ id: 'no-rm', file: 'agents/reviewer-x.md', search: 'rm -rf node_modules\n', replace: 'use the lint command\n', reason: 'test' }],
    },
    extra: { extends: ['base'], ecc: { skills: [] } },
  };
  for (const [name, p] of Object.entries(defaultProfiles)) write(root, `profiles/${name}.json`, JSON.stringify(p));
  return { root, ecc, commit };
}

export function fakeProject(scripts = { lint: 'echo lint', test: 'echo "Tests  4 passed (4)"', build: 'echo build' }) {
  const dir = tmp('core-proj-');
  write(dir, 'package.json', JSON.stringify({ name: 'p', scripts }));
  write(dir, '.gitignore', '.claude/team/ledger.jsonl\n.claude/team/receipts/\n.claude/team/open/\n');
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

export function commitAll(dir, msg = 'change') {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', msg, '--allow-empty');
}
