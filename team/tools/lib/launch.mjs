// One-command dashboard: start the server (or reuse a running one) and open it in the default browser,
// plus the installer that puts `run-core-dev` on the PATH.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { TEAM_ROOT, TeamError } from './util.mjs';

export const COMMAND = 'run-core-dev';
export const BIN = path.join(TEAM_ROOT, 'bin', COMMAND);

export function dashboardUrl(port) {
  return url.format({ protocol: 'http', slashes: true, hostname: '127.0.0.1', port, pathname: '/' });
}

/** True when our dashboard already answers on this port (its page carries the core-key meta tag). */
export function probeDashboard(port, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', headers: { host: `127.0.0.1:${port}` }, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        if (body.length < 65536) body += c;
      });
      res.on('end', () => resolve(res.statusCode === 200 && body.includes('name="core-key"')));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

/** Open a URL in the default browser without waiting for it. Returns false when no opener could start. */
export function openBrowser(target, { platform = process.platform, run = spawn } = {}) {
  const [cmd, args] =
    platform === 'darwin' ? ['open', [target]] : platform === 'win32' ? ['cmd', ['/c', 'start', '""', target]] : ['xdg-open', [target]];
  try {
    const child = run(cmd, args, { stdio: 'ignore', detached: true });
    child.on?.('error', () => {});
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

/**
 * Start the dashboard and open it. Reuses a dashboard that is already running on the port; refuses (code 2)
 * when another program holds the port.
 */
export async function startDashboard({ port = 4417, state, open = true, serve, opener = openBrowser, probe = probeDashboard, log = (m) => process.stdout.write(`${m}\n`) }) {
  const target = dashboardUrl(port);
  if (await probe(port)) {
    log(`dashboard already running: ${target}`);
    if (open) opener(target);
    return { reused: true, url: target, server: null };
  }
  let server;
  try {
    server = await serve({ port, state });
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      throw new TeamError(`port ${port} is used by another program; try ${COMMAND} --port <number>`, 2);
    }
    throw err;
  }
  log(`open ${target}  (Ctrl+C to stop)`);
  if (open && !opener(target)) log('could not open a browser; open the address above');
  return { reused: false, url: target, server };
}

/** Directories on PATH the user can write to, in preference order. */
export function candidateBinDirs({ env = process.env, home = os.homedir() } = {}) {
  const onPath = [...new Set((env.PATH || '').split(path.delimiter).filter(Boolean).map((d) => path.resolve(d)))];
  const preferred = [path.join(home, '.local', 'bin'), path.join(home, 'bin')];
  // The user's own bin directories first, then any other writable directory already on PATH, in PATH order.
  const ordered = [...preferred.filter((d) => onPath.includes(d)), ...onPath.filter((d) => !preferred.includes(d))];
  return ordered.filter((d) => isWritableDir(d));
}

function isWritableDir(d) {
  try {
    fs.accessSync(d, fs.constants.W_OK);
    return fs.statSync(d).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Put `run-core-dev` on the PATH as a symlink to team/bin/run-core-dev. Never replaces a file that is not
 * already our own symlink.
 */
export function installCommand({ dir, env = process.env, home = os.homedir(), bin = BIN } = {}) {
  const target = dir ? path.resolve(dir) : candidateBinDirs({ env, home })[0];
  if (!target) throw new TeamError(`no writable directory on PATH; pass --dir <a directory on your PATH>`, 2);
  if (!isWritableDir(target)) throw new TeamError(`not a writable directory: ${target}`, 2);
  const link = path.join(target, COMMAND);
  let existing = null;
  try {
    existing = fs.lstatSync(link);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (existing) {
    if (existing.isSymbolicLink() && path.resolve(target, fs.readlinkSync(link)) === bin) {
      return { link, bin, created: false, onPath: isOnPath(target, env) };
    }
    throw new TeamError(`${link} already exists and is not the core's command; remove it or pass --dir`);
  }
  fs.symlinkSync(bin, link);
  return { link, bin, created: true, onPath: isOnPath(target, env) };
}

function isOnPath(dir, env) {
  return (env.PATH || '').split(path.delimiter).map((d) => path.resolve(d)).includes(path.resolve(dir));
}
