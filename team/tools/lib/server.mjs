// Local dashboard server (SDD section 8): loopback only, exact Host, Origin and key checks, strict CSP.
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { JOBS, freshness, isRunning, loadSchedules, newRunId, runNow, runningJobs, saveSchedules, tick } from './schedule.mjs';
import { TEAM_ROOT, TeamError, VERSION, assertId, newKey, readJson, readJsonl } from './util.mjs';

const DASHBOARD_DIR = path.join(TEAM_ROOT, 'dashboard');
const STATIC = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/app.css', { file: 'app.css', type: 'text/css; charset=utf-8' }],
]);
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};
const PARAM_RE = /^[A-Za-z0-9._-]{0,64}$/;
const MAX_BODY = 16 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function sameSecret(given, expected) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        // Stop buffering, drain the rest so the 413 response can still be delivered.
        req.removeAllListeners('data');
        req.removeAllListeners('end');
        req.resume();
        reject(new HttpError(413, 'request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new HttpError(400, 'invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// ---- state readers: absent files mean "no data yet" (null), never zeros ----

function median(nums) {
  const s = nums.filter((n) => typeof n === 'number' && Number.isFinite(n)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function tsMs(r) {
  const t = Date.parse(r?.ts);
  return Number.isNaN(t) ? null : t;
}

function byTsDesc(a, b) {
  return (tsMs(b) ?? 0) - (tsMs(a) ?? 0);
}

function newestFile(dir, re) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const hits = names.filter((n) => re.test(n)).sort();
  return hits.length ? hits[hits.length - 1] : null;
}

function readTasks(state) {
  const { records, bad, missing } = readJsonl(path.join(state, 'tasks.jsonl'));
  return { tasks: records.filter((r) => r && typeof r === 'object'), bad: bad.length, missing };
}

function overview(state, clock) {
  const registry = readJson(path.join(state, 'registry.json'), null);
  const { tasks, bad, missing } = readTasks(state);
  const scores = readJsonl(path.join(state, 'agent-scores.jsonl'));
  const now = clock();
  const projects = Object.entries(registry?.projects || {}).map(([name, p]) => {
    const mine = tasks.filter((t) => t.project === name).sort(byTsDesc);
    const last = mine[0];
    const within = (days) => mine.filter((t) => tsMs(t) !== null && now - tsMs(t) <= days * DAY_MS).length;
    return {
      name,
      path: p?.path ?? null,
      profiles: Array.isArray(p?.profiles) ? p.profiles : [],
      coreVersion: p?.coreVersion ?? null,
      eccCommit: p?.eccCommit ?? null,
      installedAt: p?.installedAt ?? null,
      lastCheck: p?.lastCheck ?? null,
      lastTask: last ? { id: last.id, ts: last.ts, task: last.task, class: last.class, score: last.score ?? null } : null,
      tasks7d: missing ? null : within(7),
      tasks30d: missing ? null : within(30),
    };
  });
  const index = scores.records
    .filter((r) => r && r.index)
    .map((r) => ({
      ts: r.ts,
      staticMean: r.index.staticMean ?? null,
      taskMedian30: r.index.taskMedian30 ?? null,
      taskN: r.index.taskN ?? null,
    }))
    .sort((a, b) => (tsMs(a) ?? 0) - (tsMs(b) ?? 0));
  return {
    version: VERSION,
    coreRoot: registry?.coreRoot ?? null,
    registry: registry !== null,
    tasksFile: !missing,
    projects,
    index,
    badLines: { tasks: bad, agentScores: scores.bad.length },
  };
}

function tasksView(state, query) {
  for (const [k, v] of query) {
    if (!PARAM_RE.test(k) || !PARAM_RE.test(v)) throw new HttpError(400, 'invalid query parameter');
  }
  const project = query.get('project') || '';
  const cls = query.get('class') || '';
  const { tasks, bad, missing } = readTasks(state);
  const projects = [...new Set(tasks.map((t) => t.project).filter((v) => typeof v === 'string'))].sort();
  const classes = [...new Set(tasks.map((t) => t.class).filter((v) => typeof v === 'string'))].sort();
  const list = tasks
    .filter((t) => (!project || t.project === project) && (!cls || t.class === cls))
    .sort(byTsDesc)
    .slice(0, 500);
  return { missing, badLines: bad, projects, classes, tasks: list };
}

function agentsView(state) {
  const { records, bad, missing } = readJsonl(path.join(state, 'agent-scores.jsonl'));
  const evals = records.filter((r) => r && Array.isArray(r.agents)).sort((a, b) => (tsMs(a) ?? 0) - (tsMs(b) ?? 0));
  const history = {};
  for (const e of evals) {
    for (const a of e.agents) {
      if (!a || typeof a.name !== 'string') continue;
      (history[a.name] ||= []).push({ ts: e.ts, static: a.static ?? null, outcome: a.outcome?.median ?? null });
    }
  }
  let roadmap = null;
  const runsDir = path.join(state, 'runs');
  const file = newestFile(runsDir, /^evaluate-[A-Za-z0-9._-]+\.md$/);
  if (file) {
    const text = fs.readFileSync(path.join(runsDir, file), 'utf8');
    roadmap = { file, text: text.length > 200000 ? `${text.slice(0, 200000)}\n[truncated]` : text };
  }
  return { missing, badLines: bad.length, latest: evals.length ? evals[evals.length - 1] : null, history, roadmap };
}

function latestScout(state) {
  const dir = path.join(state, 'candidates');
  const file = newestFile(dir, /^scout-[A-Za-z0-9._-]+\.json$/);
  return file ? { file, data: readJson(path.join(dir, file), null) } : null;
}

function adoptedIds(state) {
  const lock = readJson(path.join(state, 'adopted.lock.json'), null);
  return Object.keys(lock?.skills || {});
}

function scoutView(state) {
  const latest = latestScout(state);
  return {
    file: latest?.file ?? null,
    ts: latest?.data?.ts ?? null,
    candidates: Array.isArray(latest?.data?.candidates) ? latest.data.candidates : null,
    errors: Array.isArray(latest?.data?.errors) ? latest.data.errors : [],
    adopted: adoptedIds(state),
  };
}

/** Schedules plus, per job, its freshness (from lastRun and cadence) and its last recorded result. */
function schedulesView(state, jobs, clock) {
  const { records } = readJsonl(path.join(state, 'runs', 'index.jsonl'));
  const now = new Date(clock());
  const status = {};
  for (const job of Object.keys(jobs)) {
    const last = [...records].reverse().find((r) => r && r.job === job);
    status[job] = {
      freshness: freshness(jobs[job], now),
      lastResult: last ? { id: last.id, status: last.status, exitCode: last.exitCode, finishedAt: last.finishedAt } : null,
    };
  }
  return { jobs, status, running: runningJobs() };
}

function runsView(state) {
  const { records, bad, missing } = readJsonl(path.join(state, 'runs', 'index.jsonl'));
  return { missing, badLines: bad.length, runs: records.slice(-50).reverse() };
}

// ---- server ----

/** Build the dashboard server (not listening). Port 0 means "whatever port it gets bound to". */
export function createServer({
  state,
  port = 0,
  host = '127.0.0.1',
  key = newKey(),
  runJob,
  adopt,
  clock = Date.now,
} = {}) {
  if (!state) throw new TeamError('state directory required', 2);
  const coreKey = key;
  const doAdopt = adopt || (async (id, opts) => (await import('./scout.mjs')).adopt(id, opts));
  let server;

  const allowedHosts = () => {
    const p = port || server.address()?.port;
    return [`${host}:${p}`, `localhost:${p}`];
  };

  function checkMutation(req) {
    const origin = req.headers.origin;
    if (!origin || origin === 'null') throw new HttpError(403, 'origin required');
    let url;
    try {
      url = new URL(origin);
    } catch {
      throw new HttpError(403, 'bad origin');
    }
    if (url.protocol !== 'http:' || url.host !== req.headers.host) throw new HttpError(403, 'origin mismatch');
    if (!sameSecret(req.headers['x-core-key'], coreKey)) throw new HttpError(403, 'missing or wrong key');
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') throw new HttpError(415, 'content type must be application/json');
  }

  function serveStatic(res, entry, method) {
    let body = fs.readFileSync(path.join(DASHBOARD_DIR, entry.file));
    if (entry.file === 'index.html') {
      body = body.toString('utf8').replace(
        /<meta name="core-key" content="[^"]*">/,
        `<meta name="core-key" content="${escapeAttr(coreKey)}">`,
      );
    }
    if (method === 'HEAD') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': entry.type });
      return res.end();
    }
    return send(res, 200, body, entry.type);
  }

  async function postRoute(pathname, req, res) {
    checkMutation(req);
    const body = await readBody(req);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body must be an object');

    if (pathname === '/api/schedules') {
      const current = loadSchedules(state);
      if (body.jobs !== null && typeof body.jobs === 'object' && !Array.isArray(body.jobs)) {
        // The stored lastRun is owned by the scheduler, never by the client.
        for (const [job, cfg] of Object.entries(body.jobs)) {
          if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) continue;
          const { lastRun, ...rest } = cfg;
          body.jobs[job] = current.jobs[job] ? { ...current.jobs[job], ...rest, lastRun: current.jobs[job].lastRun } : rest;
        }
        // Jobs the client left out keep their stored settings.
        body.jobs = { ...current.jobs, ...body.jobs };
      }
      const saved = saveSchedules(state, body);
      return send(res, 200, schedulesView(state, saved.jobs, clock));
    }

    if (pathname === '/api/run') {
      const job = body.job;
      if (typeof job !== 'string' || !JOBS.includes(job)) throw new HttpError(400, 'unknown job');
      if (isRunning(job)) throw new HttpError(409, `${job} is already running`);
      const id = newRunId(job, new Date(clock()));
      runNow(job, { state, runJob, clock, id }).catch((err) => {
        process.stderr.write(`dashboard: run ${id} failed to record: ${err.message}\n`);
      });
      return send(res, 202, { id, job });
    }

    if (pathname === '/api/adopt') {
      const id = assertId(body.id, 'candidate id');
      const latest = latestScout(state);
      const cand = Array.isArray(latest?.data?.candidates) ? latest.data.candidates.find((c) => c?.id === id) : null;
      if (!cand) throw new HttpError(404, 'candidate not found in the newest scout run');
      if (cand.eligible !== true || cand.trust?.pass !== true || cand.license?.pass !== true) {
        throw new HttpError(409, 'candidate is not eligible for adoption');
      }
      if (adoptedIds(state).includes(id)) throw new HttpError(409, 'candidate already adopted');
      const result = await doAdopt(id, { state });
      return send(res, 200, { adopted: id, result: result ?? null });
    }

    throw new HttpError(404, 'not found');
  }

  async function handle(req, res) {
    if (!allowedHosts().includes(req.headers.host)) throw new HttpError(421, 'unexpected Host header');
    const raw = req.url || '/';
    const q = raw.indexOf('?');
    const pathname = q >= 0 ? raw.slice(0, q) : raw;
    const query = new URLSearchParams(q >= 0 ? raw.slice(q + 1) : '');
    const method = req.method;

    const entry = STATIC.get(pathname);
    if (entry) {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method not allowed');
      return serveStatic(res, entry, method);
    }

    const getRoutes = {
      '/api/overview': () => overview(state, clock),
      '/api/tasks': () => tasksView(state, query),
      '/api/agents': () => agentsView(state),
      '/api/scout': () => scoutView(state),
      '/api/schedules': () => schedulesView(state, loadSchedules(state).jobs, clock),
      '/api/runs': () => runsView(state),
    };
    const postRoutes = new Set(['/api/schedules', '/api/run', '/api/adopt']);

    if (method === 'GET' && getRoutes[pathname]) return send(res, 200, getRoutes[pathname]());
    if (method === 'POST' && postRoutes.has(pathname)) return postRoute(pathname, req, res);
    if (getRoutes[pathname] || postRoutes.has(pathname)) throw new HttpError(405, 'method not allowed');
    throw new HttpError(404, 'not found');
  }

  server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) return res.destroy();
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      if (err instanceof TeamError && err.code !== 2) return send(res, 400, { error: err.message });
      if (err instanceof TeamError) {
        process.stderr.write(`dashboard: ${err.message}\n`);
        return send(res, 500, { error: 'could not run; see the dashboard log' });
      }
      process.stderr.write(`dashboard: internal error: ${err?.message}\n`);
      return send(res, 500, { error: 'internal error' });
    });
  });
  server.coreKey = coreKey;
  return server;
}

/** Listen on 127.0.0.1 and tick the schedules every minute while running. */
export function serve({ port = 4417, state, runJob } = {}) {
  const server = createServer({ state, port, runJob });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const bound = server.address().port;
      process.stdout.write(`dashboard: 127.0.0.1:${bound}\n`);
      const timer = setInterval(() => {
        tick({ state, runJob }).catch((err) => process.stderr.write(`dashboard: tick failed: ${err.message}\n`));
      }, 60 * 1000);
      timer.unref();
      server.on('close', () => clearInterval(timer));
      resolve(server);
    });
  });
}
