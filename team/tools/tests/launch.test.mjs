import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { BIN, COMMAND, dashboardUrl, installCommand, startDashboard, openBrowser, probeDashboard } from '../lib/launch.mjs';
import { createServer } from '../lib/server.mjs';
import { TeamError } from '../lib/util.mjs';
import { tmp, write } from './helpers.mjs';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

test('dashboardUrl points at the loopback address', () => {
  assert.equal(new URL(dashboardUrl(4417)).host, '127.0.0.1:4417');
  assert.equal(new URL(dashboardUrl(4417)).protocol, 'http:');
});

test('launch starts the server once and opens the browser', async () => {
  const opened = [];
  let served = 0;
  const r = await startDashboard({
    port: 4999,
    state: tmp('core-state-'),
    serve: async () => (served++, { fake: true }),
    probe: async () => false,
    opener: (u) => (opened.push(u), true),
    log: () => {},
  });
  assert.equal(served, 1);
  assert.equal(r.reused, false);
  assert.deepEqual(opened, [dashboardUrl(4999)]);
});

test('--no-open starts the server without opening a browser', async () => {
  const opened = [];
  await startDashboard({ port: 4999, serve: async () => ({}), probe: async () => false, opener: (u) => opened.push(u), open: false, log: () => {} });
  assert.deepEqual(opened, []);
});

test('a dashboard already running is reused, not started twice', async () => {
  const opened = [];
  const r = await startDashboard({
    port: 4999,
    serve: async () => assert.fail('must not start a second server'),
    probe: async () => true,
    opener: (u) => opened.push(u),
    log: () => {},
  });
  assert.equal(r.reused, true);
  assert.equal(opened.length, 1);
});

test('a port held by another program is reported with exit code 2', async () => {
  await assert.rejects(
    startDashboard({
      port: 4999,
      serve: async () => {
        const e = new Error('in use');
        e.code = 'EADDRINUSE';
        throw e;
      },
      probe: async () => false,
      opener: () => true,
      log: () => {},
    }),
    (err) => err instanceof TeamError && err.code === 2 && /--port/.test(err.message),
  );
});

test('probe recognises the core dashboard and nothing else', async () => {
  const state = tmp('core-state-');
  const port0 = await (async () => {
    const s = http.createServer();
    const p = await listen(s);
    s.close();
    return p;
  })();
  const dash = createServer({ state, port: port0 });
  await new Promise((resolve) => dash.listen(port0, '127.0.0.1', resolve));
  const other = http.createServer((req, res) => res.end('<html>another app</html>'));
  const otherPort = await listen(other);
  try {
    assert.equal(await probeDashboard(port0), true);
    assert.equal(await probeDashboard(otherPort), false);
  } finally {
    dash.close();
    other.close();
  }
  assert.equal(await probeDashboard(otherPort), false, 'nothing listening');
});

test('openBrowser picks the platform opener and survives a missing one', () => {
  const calls = [];
  const fake = (cmd, args) => (calls.push([cmd, ...args]), { on() {}, unref() {} });
  openBrowser('X', { platform: 'darwin', run: fake });
  openBrowser('X', { platform: 'linux', run: fake });
  assert.deepEqual(calls.map((c) => c[0]), ['open', 'xdg-open']);
  assert.equal(openBrowser('X', { platform: 'linux', run: () => { throw new Error('ENOENT'); } }), false);
});

test('install-command links into a writable PATH directory, is idempotent and never overwrites', () => {
  const home = tmp('core-home-');
  const binDir = path.join(home, '.local', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const env = { PATH: [binDir, '/usr/bin'].join(path.delimiter) };
  const first = installCommand({ env, home });
  assert.equal(first.link, path.join(binDir, COMMAND));
  assert.equal(first.created, true);
  assert.equal(fs.readlinkSync(first.link), BIN);
  assert.equal(installCommand({ env, home }).created, false);
  fs.rmSync(first.link);
  write(binDir, COMMAND, 'someone else\n');
  assert.throws(() => installCommand({ env, home }), /already exists/);
  assert.equal(fs.readFileSync(first.link, 'utf8'), 'someone else\n');
  assert.throws(() => installCommand({ env: { PATH: '/nonexistent' }, home: tmp('core-home-') }), /no writable directory/);
});

test('the run-core-dev script works through a symlink', () => {
  const dir = tmp('core-bin-');
  fs.symlinkSync(BIN, path.join(dir, COMMAND));
  const out = execFileSync('/bin/sh', [path.join(dir, COMMAND), '--help'], { encoding: 'utf8' });
  assert.match(out, /dashboard \[--port 4417\]/);
  assert.ok(fs.statSync(BIN).mode & 0o111, 'the script is executable');
});

test('install-command prefers the home bin directory over other writable PATH entries', async () => {
  const { candidateBinDirs } = await import('../lib/launch.mjs');
  const home = tmp('core-home-');
  const other = tmp('core-other-');
  const local = path.join(home, '.local', 'bin');
  fs.mkdirSync(local, { recursive: true });
  assert.deepEqual(candidateBinDirs({ env: { PATH: [other, local].join(path.delimiter) }, home }), [local, other]);
});
