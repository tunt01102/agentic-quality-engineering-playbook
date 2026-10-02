#!/usr/bin/env node
// Core dev team CLI. See team/SDD.md section 9. Exit codes: 0 ok, 1 the check said no, 2 could not run.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { check, fetchEcc, install, listProfiles } from './lib/install.mjs';
import { gate, receiptTable, reviewAdd, reviewResolve, taskDone, taskStart, verify } from './lib/task.mjs';
import { collect, evaluate } from './lib/collect.mjs';
import { median } from './lib/score.mjs';
import { TEAM_ROOT, TeamError, VERSION, parseArgs, stateDir, writeJson } from './lib/util.mjs';

const HELP = `core dev team ${VERSION}

  fetch                                     clone the pinned ECC tag into team/.cache and verify it
  profiles                                  list profiles
  install <project> --profile a,b [--dry-run] [--force]
  check <project> [--strict]                drift (exit 1) and outdated report; --strict fails on outdated
  task start --project . --class <c> --title "<t>" --estimate <min> --premise <p>
  task done --project . --task <id> --outcome <o> --evidence "<e>" [--agent <name>]
  verify --project . [--task <id>] [--stage pr|merge] [--all]
  review --project . --task <id> --lens <l> (--findings 0 | --severity s --where f:l --disposition d [--note n])
  review resolve --project . --task <id> --where f:l --disposition d [--note n]
  gate [--project .]                        exit 1 unless the current tree has a passing receipt
  collect                                   pull task records, check CI for their commits, score, find unrecorded commits
  register <project> --gh-user <login>      which gh account collect uses to read that project's CI
  evaluate                                  score agents, write the roadmap
  scout [--dry-run]                         search public skills, trust-scan, rank
  adopt <candidate-id>                      vendor one passing candidate into the state directory
  tick                                      run due scheduled jobs
  serve [--port 4417]                       local dashboard on 127.0.0.1
  dashboard [--port 4417] [--no-open]       start (or reuse) the dashboard and open it in the browser
  install-command [--dir <dir>]             put run-core-dev on your PATH (symlink, never overwrites)
  schedule print-macos                      print a macOS background job that runs tick every 15 minutes
  measure <project> [--samples 3] [--prompt "..."]  context tokens of a fresh session
`;

const list = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

async function main(argv) {
  const args = parseArgs(argv, { multi: ['evidence', 'agent'], bool: ['dry-run', 'force', 'strict', 'all', 'json', 'help', 'version', 'no-open'] });
  const [cmd, sub] = args._;
  const out = (v) => console.log(args.json || typeof v !== 'string' ? JSON.stringify(v, null, 2) : v);
  if (args.version) return out(VERSION);
  if (!cmd || args.help || cmd === 'help') return out(HELP);
  const state = stateDir();
  const scoutMod = () => import('./lib/scout.mjs');

  switch (cmd) {
    case 'fetch':
      return out(fetchEcc());
    case 'profiles':
      return out(listProfiles().join('\n'));
    case 'install': {
      if (!sub) throw new TeamError('install needs a project path');
      if (!args.profile || args.profile === true) throw new TeamError('install needs --profile a,b');
      const { verifyAdopted } = await scoutMod().catch(() => ({}));
      const r = install({ project: sub, profiles: String(args.profile).split(',').map((s) => s.trim()).filter(Boolean), dryRun: args['dry-run'], force: args.force, state, verifyAdopted });
      return out(r);
    }
    case 'check': {
      if (!sub) throw new TeamError('check needs a project path');
      const { verifyAdopted } = await scoutMod().catch(() => ({}));
      const r = check({ project: sub, state, verifyAdopted });
      out(r);
      if (r.status !== 'clean' || (args.strict && r.outdated.length)) process.exitCode = 1;
      return;
    }
    case 'task': {
      const project = args.project && args.project !== true ? args.project : '.';
      if (sub === 'start') {
        const r = taskStart({ project, title: args.title, cls: args.class, estimate: args.estimate, premise: args.premise });
        return out(args.json ? r : `task started: ${r.id}`);
      }
      if (sub === 'done') {
        const r = taskDone({ project, task: args.task, outcome: args.outcome, evidence: list(args.evidence), agents: list(args.agent) });
        return out(args.json ? r : `task recorded: ${r.id} (${r.outcome}); gates ${Object.entries(r.gates).map(([k, v]) => `${k}=${v.status}`).join(' ')}`);
      }
      throw new TeamError('task needs start or done');
    }
    case 'verify': {
      const project = args.project && args.project !== true ? args.project : '.';
      const { receipt, file } = verify({ project, task: args.task, stage: args.stage || 'pr', all: args.all, log: (m) => console.error(m) });
      out(args.json ? receipt : `${receiptTable(receipt)}\nreceipt: ${path.relative(path.resolve(project), file)}`);
      if (!receipt.pass) process.exitCode = 1;
      return;
    }
    case 'review': {
      const project = args.project && args.project !== true ? args.project : '.';
      if (sub === 'resolve') return out(`updated ${reviewResolve({ project, task: args.task, where: args.where, disposition: args.disposition, note: args.note })} finding(s)`);
      return out(reviewAdd({ project, task: args.task, lens: args.lens, findings: args.findings, severity: args.severity, where: args.where, disposition: args.disposition, note: args.note }));
    }
    case 'gate': {
      const project = args.project && args.project !== true ? args.project : sub || '.';
      const r = gate({ project });
      out(args.json ? r : r.pass ? `gate: PASS (receipt ${r.receipt})` : `gate: FAIL (${r.reason})`);
      if (!r.pass) process.exitCode = 1;
      return;
    }
    case 'register': {
      if (!sub || typeof args['gh-user'] !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(args['gh-user'])) throw new TeamError('register needs a project path and --gh-user <login>', 2);
      const file = path.join(state, 'registry.json');
      const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
      const entry = Object.entries(reg.projects || {}).find(([, p]) => p.path === path.resolve(sub));
      if (!entry) throw new TeamError(`${path.resolve(sub)} is not a registered project (install the core first)`);
      entry[1].ghUser = args['gh-user'];
      writeJson(file, reg);
      return out(`registered ${entry[0]}: CI read with the ${args['gh-user']} account`);
    }
    case 'collect':
      return out(collect({ state }));
    case 'evaluate': {
      const { evaluation, roadmap } = evaluate({ state });
      return out(args.json ? evaluation : roadmap);
    }
    case 'scout': {
      const { scout } = await scoutMod();
      const r = await scout({ state, dryRun: args['dry-run'], log: (m) => console.error(m) });
      if (!r.candidates.length && r.errors.length) process.exitCode = 2; // every search failed: the run did not happen
      return out(args.json ? r : `scout: ${r.candidates.length} candidates, ${r.candidates.filter((c) => c.eligible).length} eligible, ${r.errors.length} errors`);
    }
    case 'adopt': {
      if (!sub) throw new TeamError('adopt needs a candidate id');
      const { adopt } = await scoutMod();
      return out(await adopt(sub, { state }));
    }
    case 'tick': {
      const { tick } = await import('./lib/schedule.mjs');
      return out(await tick({ state }));
    }
    case 'serve': {
      const { serve } = await import('./lib/server.mjs');
      return serve({ port: Number(args.port) || 4417, state });
    }
    case 'dashboard': {
      const { serve } = await import('./lib/server.mjs');
      const { startDashboard } = await import('./lib/launch.mjs');
      const port = args.port === undefined ? 4417 : Number(args.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TeamError('--port must be 1-65535', 2);
      const r = await startDashboard({ port, state, open: !args['no-open'] && !process.env.CORE_NO_OPEN, serve });
      return r.reused ? undefined : new Promise(() => {}); // keep serving until Ctrl+C
    }
    case 'install-command': {
      const { installCommand } = await import('./lib/launch.mjs');
      const r = installCommand({ dir: typeof args.dir === 'string' ? args.dir : undefined });
      return out(args.json ? r : `${r.created ? 'installed' : 'already installed'}: ${r.link} -> ${r.bin}${r.onPath ? '' : ' (that directory is not on your PATH)'}`);
    }
    case 'schedule': {
      if (sub !== 'print-macos') throw new TeamError('schedule needs print-macos');
      const { printMacosAgent } = await import('./lib/schedule.mjs');
      const which = (bin) => spawnSync('/bin/sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).stdout.trim();
      return out(printMacosAgent({ nodePath: process.execPath, teamPath: path.join(TEAM_ROOT, 'tools', 'team.mjs'), state, ghPath: which('gh') || undefined }));
    }
    case 'measure':
      return out(measure({ project: sub, samples: Number(args.samples) || 3, prompt: args.prompt, state }));
    default:
      throw new TeamError(`unknown command: ${cmd}\n\n${HELP}`, 2);
  }
}

/** Median context tokens (input + cache creation + cache read) of fresh headless sessions. */
export function measure({ project, samples = 3, prompt, state }) {
  if (!project) throw new TeamError('measure needs a project path');
  const cwd = path.resolve(project);
  const p = typeof prompt === 'string' ? prompt : 'Reply with the single word: ok';
  const runs = [];
  for (let i = 0; i < samples; i++) {
    const r = spawnSync('claude', ['-p', p, '--output-format', 'json'], { cwd, encoding: 'utf8', timeout: 300000, maxBuffer: 32 * 1024 * 1024 });
    if (r.status !== 0) throw new TeamError(`claude -p failed in ${cwd}: ${(r.stderr || '').slice(0, 300)}`, 2);
    const u = JSON.parse(r.stdout).usage || {};
    runs.push((u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0));
  }
  const v = spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout.trim();
  const result = { project: path.basename(cwd), prompt: p, samples: runs, median: median(runs), cli: v, ts: new Date().toISOString() };
  const file = path.join(state, 'measurements.json');
  let all = [];
  try {
    all = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* first measurement */
  }
  all.push(result);
  writeJson(file, all);
  return result;
}

main(process.argv.slice(2)).catch((err) => {
  if (err instanceof TeamError) {
    console.error(`error: ${err.message}`);
    process.exitCode = err.code;
  } else {
    console.error(err.stack || String(err));
    process.exitCode = 2;
  }
});
