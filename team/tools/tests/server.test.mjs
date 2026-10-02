import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { format } from 'node:url';
import { createServer } from '../lib/server.mjs';
import { writeJson } from '../lib/util.mjs';

const coreKey = 'k'.repeat(48);
const servers = [];

function tmpState() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'team-server-'));
}

async function start(opts = {}) {
  const state = opts.state || tmpState();
  const server = createServer({ state, key: coreKey, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const port = server.address().port;
  const host = `127.0.0.1:${port}`;
  return { server, state, port, host, origin: format({ protocol: 'http', slashes: true, host }) };
}

function request(ctx, method, pathname, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port: ctx.port, method, path: pathname, headers: { Host: ctx.host, ...headers }, setHost: false },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

function post(ctx, pathname, body, headers = {}) {
  return request(ctx, 'POST', pathname, {
    body,
    headers: { Origin: ctx.origin, 'x-core-key': coreKey, 'Content-Type': 'application/json', ...headers },
  });
}

let ctx;
before(async () => {
  ctx = await start({ runJob: async () => ({ exitCode: 0, output: 'done' }) });
});

after(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});

test('wrong Host is rejected on static and API routes', async () => {
  for (const p of ['/', '/app.js', '/api/overview']) {
    const res = await request(ctx, 'GET', p, { headers: { Host: 'evil.test' } });
    assert.equal(res.status, 421, p);
    const res2 = await request(ctx, 'GET', p, { headers: { Host: `127.0.0.1:${ctx.port + 1}` } });
    assert.equal(res2.status, 421, `${p} other port`);
  }
  const ok = await request(ctx, 'GET', '/app.js');
  assert.equal(ok.status, 200);
  const alt = await request(ctx, 'GET', '/app.css', { headers: { Host: `localhost:${ctx.port}` } });
  assert.equal(alt.status, 200);
});

test('security headers present and no CORS headers', async () => {
  const res = await request(ctx, 'GET', '/api/overview');
  assert.match(res.headers['content-security-policy'], /default-src 'self'; script-src 'self'/);
  assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('empty state: overview has no projects and no crash; other views say missing', async () => {
  const res = await request(ctx, 'GET', '/api/overview');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.projects, []);
  assert.deepEqual(res.json.index, []);
  assert.equal(res.json.registry, false);
  for (const p of ['/api/tasks', '/api/agents', '/api/scout', '/api/schedules', '/api/runs']) {
    const r = await request(ctx, 'GET', p);
    assert.equal(r.status, 200, p);
  }
  const agents = await request(ctx, 'GET', '/api/agents');
  assert.equal(agents.json.latest, null);
  assert.equal(agents.json.roadmap, null);
  const scout = await request(ctx, 'GET', '/api/scout');
  assert.equal(scout.json.candidates, null);
});

test('index.html carries the key meta and no data', async () => {
  const state = tmpState();
  writeJson(path.join(state, 'registry.json'), {
    coreRoot: '/usr/core',
    projects: { 'secret-project-name': { path: '/usr/p', profiles: ['core'], coreVersion: '0.1.0' } },
  });
  const c = await start({ state });
  const res = await request(c, 'GET', '/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.ok(res.text.includes(`<meta name="core-key" content="${coreKey}">`));
  assert.ok(!res.text.includes('secret-project-name'));
  assert.doesNotMatch(res.text, /<script>|<style>|style="/, 'no inline script or style');
});

test('mutations need the key, a matching Origin and JSON', async () => {
  const body = { jobs: { collect: { enabled: false } } };
  assert.equal((await post(ctx, '/api/schedules', body, { 'x-core-key': '' })).status, 403, 'empty key');
  const noKey = await request(ctx, 'POST', '/api/schedules', {
    body,
    headers: { Origin: ctx.origin, 'Content-Type': 'application/json' },
  });
  assert.equal(noKey.status, 403, 'no key');
  assert.equal((await post(ctx, '/api/schedules', body, { 'x-core-key': 'x'.repeat(48) })).status, 403, 'wrong key');
  assert.equal((await post(ctx, '/api/schedules', body, { 'x-core-key': 'short' })).status, 403, 'short key');
  const evil = format({ protocol: 'http', slashes: true, host: 'evil.test' });
  assert.equal((await post(ctx, '/api/schedules', body, { Origin: evil })).status, 403, 'wrong origin');
  assert.equal((await post(ctx, '/api/schedules', body, { Origin: 'null' })).status, 403, 'null origin');
  const noOrigin = await request(ctx, 'POST', '/api/schedules', {
    body,
    headers: { 'x-core-key': coreKey, 'Content-Type': 'application/json' },
  });
  assert.equal(noOrigin.status, 403, 'missing origin');
  const sec = format({ protocol: 'https', slashes: true, host: ctx.host });
  assert.equal((await post(ctx, '/api/schedules', body, { Origin: sec })).status, 403, 'other scheme');
  assert.equal((await post(ctx, '/api/schedules', body, { 'Content-Type': 'text/plain' })).status, 415);
  const big = { jobs: {}, pad: 'x'.repeat(17 * 1024) };
  assert.equal((await post(ctx, '/api/schedules', big)).status, 413);
  const s = await request(ctx, 'GET', '/api/schedules');
  assert.equal(s.json.jobs.collect.enabled, true, 'nothing saved by rejected requests');
});

test('a correct POST /api/schedules saves and keeps the stored lastRun', async () => {
  const state = tmpState();
  writeJson(path.join(state, 'schedules.json'), {
    jobs: { collect: { enabled: true, every: 'hourly', hour: 0, weekday: 1, lastRun: '2026-10-01T00:00:00.000Z' } },
  });
  const c = await start({ state });
  const res = await post(c, '/api/schedules', {
    jobs: { collect: { enabled: false, lastRun: null }, scout: { enabled: true, every: 'daily', hour: 5 } },
  });
  assert.equal(res.status, 200);
  const saved = JSON.parse(fs.readFileSync(path.join(state, 'schedules.json'), 'utf8'));
  assert.equal(saved.jobs.collect.enabled, false);
  assert.equal(saved.jobs.collect.lastRun, '2026-10-01T00:00:00.000Z');
  assert.equal(saved.jobs.scout.hour, 5);
  assert.equal(saved.jobs.evaluate.hour, 7);
  const bad = await post(c, '/api/schedules', { jobs: { scout: { hour: 30 } } });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.error);
  assert.ok(!/at .*\.mjs/.test(bad.text), 'no stack trace');
});

test('POST /api/run validates the job, returns 202 and refuses a duplicate in flight', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const c = await start({ runJob: async () => (await gate, { exitCode: 0, output: 'ok' }) });
  assert.equal((await post(c, '/api/run', { job: 'deploy' })).status, 400);
  assert.equal((await post(c, '/api/run', { job: '../collect' })).status, 400);
  const res = await post(c, '/api/run', { job: 'evaluate' });
  assert.equal(res.status, 202);
  assert.match(res.json.id, /^run-evaluate-/);
  assert.equal((await post(c, '/api/run', { job: 'evaluate' })).status, 409);
  release();
  for (let i = 0; i < 50; i++) {
    const runs = await request(c, 'GET', '/api/runs');
    if (runs.json.runs.length) {
      assert.equal(runs.json.runs[0].id, res.json.id);
      assert.equal(runs.json.runs[0].status, 'ok');
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail('run was never recorded');
});

test('path traversal and unknown routes are 404', async () => {
  for (const p of ['/../package.json', '/%2e%2e/', '/%2e%2e/package.json', '/index.html/../app.js', '/dashboard/app.js', '/nope', '/api/nope']) {
    assert.equal((await request(ctx, 'GET', p)).status, 404, p);
  }
});

test('GET /api/tasks validates and filters parameters', async () => {
  for (const q of ['?project=../x', '?class=a%20b', '?project=' + 'a'.repeat(65), '?bad%24key=1']) {
    assert.equal((await request(ctx, 'GET', `/api/tasks${q}`)).status, 400, q);
  }
  const state = tmpState();
  const rec = (id, project, cls, ts) => ({ schema: 'core-task-record/1', id, ts, project, class: cls, task: id, score: 50 });
  fs.writeFileSync(
    path.join(state, 'tasks.jsonl'),
    [rec('a', 'alpha', 'feature', '2026-10-01T00:00:00Z'), rec('b', 'beta', 'fix', '2026-09-01T00:00:00Z')]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  );
  writeJson(path.join(state, 'registry.json'), { coreRoot: '/usr/core', projects: { alpha: { profiles: ['core'] }, gamma: {} } });
  const c = await start({ state, clock: () => Date.parse('2026-10-02T00:00:00Z') });
  const res = await request(c, 'GET', '/api/tasks?project=alpha&class=feature');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.tasks.map((t) => t.id), ['a']);
  assert.deepEqual(res.json.projects, ['alpha', 'beta']);
  const ov = await request(c, 'GET', '/api/overview');
  const alpha = ov.json.projects.find((p) => p.name === 'alpha');
  assert.equal(alpha.tasks7d, 1);
  assert.equal(alpha.lastTask.id, 'a');
  const gamma = ov.json.projects.find((p) => p.name === 'gamma');
  assert.equal(gamma.tasks30d, 0);
  assert.equal(gamma.lastTask, null);
});

test('task counts are null, not zero, when tasks.jsonl is absent', async () => {
  const state = tmpState();
  writeJson(path.join(state, 'registry.json'), { projects: { alpha: {} } });
  const c = await start({ state });
  const ov = await request(c, 'GET', '/api/overview');
  assert.equal(ov.json.projects[0].tasks7d, null);
  assert.equal(ov.json.projects[0].tasks30d, null);
});

test('adopt is re-checked on the server against the newest scout file', async () => {
  const state = tmpState();
  const adopted = [];
  const cand = (id, eligible) => ({
    id,
    repo: 'owner/repo',
    eligible,
    license: { spdx: 'MIT', pass: true },
    trust: { pass: eligible, flags: [] },
  });
  fs.mkdirSync(path.join(state, 'candidates'), { recursive: true });
  writeJson(path.join(state, 'candidates', 'scout-20261001t000000z.json'), { ts: 'old', candidates: [cand('old-skill', true)] });
  writeJson(path.join(state, 'candidates', 'scout-20261002t000000z.json'), {
    ts: 'new',
    candidates: [cand('good-skill', true), cand('bad-skill', false)],
    errors: [],
  });
  const c = await start({ state, adopt: async (id) => (adopted.push(id), { ok: true }) });
  assert.equal((await post(c, '/api/adopt', { id: 'Bad Id!' })).status, 400);
  assert.equal((await post(c, '/api/adopt', { id: 'bad-skill' })).status, 409);
  assert.equal((await post(c, '/api/adopt', { id: 'old-skill' })).status, 404, 'only the newest scout run counts');
  assert.equal((await post(c, '/api/adopt', { id: 'good-skill' }, { 'x-core-key': 'nope' })).status, 403);
  const ok = await post(c, '/api/adopt', { id: 'good-skill' });
  assert.equal(ok.status, 200);
  assert.deepEqual(adopted, ['good-skill']);
});

test('GET-only and POST-only routes reject the other method', async () => {
  assert.equal((await post(ctx, '/api/overview', {})).status, 405);
  assert.equal((await request(ctx, 'GET', '/api/run')).status, 405);
  assert.equal((await post(ctx, '/', {})).status, 405);
});

test('GET /api/schedules reports freshness and the last result per job', async () => {
  const state = tmpState();
  const now = Date.parse('2026-10-05T12:00:00Z');
  writeJson(path.join(state, 'schedules.json'), {
    jobs: {
      collect: { enabled: true, every: 'hourly', hour: 0, weekday: 1, lastRun: new Date(now - 10 * 60000).toISOString() },
      evaluate: { enabled: true, every: 'daily', hour: 7, weekday: 1, lastRun: null },
    },
  });
  fs.mkdirSync(path.join(state, 'runs'));
  const run = { id: 'run-collect-1', job: 'collect', startedAt: 'a', finishedAt: 'b', status: 'failed', exitCode: 3, summary: '' };
  fs.writeFileSync(path.join(state, 'runs', 'index.jsonl'), JSON.stringify(run) + '\n');
  const c = await start({ state, clock: () => now });
  const res = await request(c, 'GET', '/api/schedules');
  assert.equal(res.status, 200);
  assert.equal(res.json.status.collect.freshness, 'fresh', 'freshness is separate from the failed result');
  assert.equal(res.json.status.collect.lastResult.status, 'failed');
  assert.equal(res.json.status.collect.lastResult.exitCode, 3);
  assert.equal(res.json.status.evaluate.freshness, 'missed', 'enabled and never ran');
  assert.equal(res.json.status.evaluate.lastResult, null);
  assert.equal(res.json.status.scout.freshness, 'disabled');
});
