// Dashboard client. Every value is rendered with textContent or createElement; never innerHTML.
const coreKey = document.querySelector('meta[name="core-key"]').getAttribute('content');
// The SVG namespace, read from an <svg> the HTML parser created, for createElementNS.
const svgProto = document.getElementById('svg-proto').content.firstElementChild;
const SVG_NS = svgProto.namespaceURI;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const NO_DATA = 'no data yet';
const DASH = '—';

const $ = (id) => document.getElementById(id);

// Light or dark tokens follow the system setting (see app.css :root[data-theme]).
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => {
  document.documentElement.dataset.theme = darkQuery.matches ? 'dark' : 'light';
};
applyTheme();
darkQuery.addEventListener('change', applyTheme);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null) continue;
    if (k === 'text') node.textContent = String(v);
    else if (k === 'className') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function clear(node) {
  node.replaceChildren();
  return node;
}

function fmt(v, digits = 0) {
  if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return DASH;
  return typeof v === 'number' ? v.toFixed(digits) : String(v);
}

function signed(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DASH;
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
}

function when(ts) {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return DASH;
  return new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function duration(a, b) {
  const ms = Date.parse(b) - Date.parse(a);
  if (!Number.isFinite(ms) || ms < 0) return DASH;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function setStatus(message, kind = '') {
  const node = $('status');
  node.textContent = message || '';
  node.className = `status ${kind}`;
}

async function api(pathname, body) {
  const opts = body === undefined
    ? { headers: { Accept: 'application/json' } }
    : {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-core-key': coreKey, Accept: 'application/json' },
        body: JSON.stringify(body),
      };
  const res = await fetch(pathname, opts);
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) throw new Error(data?.error || `request failed (${res.status})`);
  return data;
}

function table(node, headers, rows, emptyText = NO_DATA) {
  clear(node);
  node.append(el('thead', {}, el('tr', {}, headers.map((h) => el('th', { scope: 'col', text: h })))));
  const tbody = el('tbody');
  if (!rows.length) {
    tbody.append(el('tr', {}, el('td', { colSpan: headers.length, className: 'empty', text: emptyText })));
  }
  for (const r of rows) tbody.append(r);
  node.append(tbody);
}

function cell(content, className) {
  return el('td', { className }, content instanceof Node ? content : fmt(content));
}

// ---- charts ----

function lineChart(container, series, { min = 0, max = 100 } = {}) {
  clear(container);
  const points = series.flatMap((s) => s.points.filter((p) => typeof p.y === 'number'));
  if (!points.length) {
    container.append(el('p', { className: 'empty', text: NO_DATA }));
    return;
  }
  const w = 600;
  const h = 200;
  const pad = { l: 32, r: 10, t: 10, b: 22 };
  const xs = points.map((p) => p.x);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const sx = (x) => pad.l + (x1 === x0 ? (w - pad.l - pad.r) / 2 : ((x - x0) / (x1 - x0)) * (w - pad.l - pad.r));
  const sy = (y) => pad.t + (1 - (y - min) / (max - min)) * (h - pad.t - pad.b);
  const root = svgProto.cloneNode(false);
  root.setAttribute('viewBox', `0 0 ${w} ${h}`);
  root.setAttribute('role', 'img');
  root.removeAttribute('aria-hidden');
  root.append(svg('title'));
  root.firstChild.textContent = series.map((s) => s.label).join(' and ') + ' over time';
  for (const v of [0, 25, 50, 75, 100]) {
    root.append(svg('line', { x1: pad.l, x2: w - pad.r, y1: sy(v), y2: sy(v), class: 'grid' }));
    const label = svg('text', { x: pad.l - 6, y: sy(v) + 4, class: 'axis', 'text-anchor': 'end' });
    label.textContent = String(v);
    root.append(label);
  }
  for (const [lx, anchor] of [[x0, 'start'], [x1, 'end']]) {
    const label = svg('text', { x: sx(lx), y: h - 6, class: 'axis', 'text-anchor': x0 === x1 ? 'middle' : anchor });
    label.textContent = new Date(lx).toLocaleDateString();
    root.append(label);
    if (x0 === x1) break;
  }
  series.forEach((s, i) => {
    const pts = s.points.filter((p) => typeof p.y === 'number');
    if (!pts.length) return;
    const d = pts.map((p, j) => `${j ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
    root.append(svg('path', { d, class: `line s${i}` }));
    for (const p of pts) {
      const dot = svg('circle', { cx: sx(p.x), cy: sy(p.y), r: 3, class: `dot s${i}` });
      const tip = svg('title');
      tip.textContent = `${s.label}: ${p.y.toFixed(1)} (${new Date(p.x).toLocaleString()})`;
      dot.append(tip);
      root.append(dot);
    }
  });
  container.append(root);
  container.append(
    el('div', { className: 'legend' },
      series.map((s, i) => el('span', { className: `key s${i}` }, el('i'), s.missing ? `${s.label} (${NO_DATA})` : s.label))),
  );
}

function sparkline(values) {
  const nums = values.filter((v) => typeof v === 'number');
  if (nums.length < 2) return document.createTextNode(nums.length ? fmt(nums[0]) : DASH);
  const w = 80;
  const h = 20;
  const root = svgProto.cloneNode(false);
  root.setAttribute('viewBox', `0 0 ${w} ${h}`);
  root.setAttribute('class', 'spark');
  const step = w / (nums.length - 1);
  const d = nums.map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${(h - 2 - (v / 100) * (h - 4)).toFixed(1)}`).join(' ');
  root.append(svg('path', { d, class: 'line s0' }));
  return root;
}

function bar(value, max, label) {
  const pct = typeof value === 'number' && max > 0 ? Math.max(0, Math.min(1, value / max)) * 100 : 0;
  const outer = el('span', { className: 'bar', title: `${label}: ${fmt(value)} of ${max}` });
  const inner = el('span', { className: 'fill' });
  inner.style.width = `${pct}%`;
  outer.append(inner);
  return el('span', { className: 'bar-row' }, el('span', { className: 'bar-label', text: label }), outer, el('span', { className: 'bar-num', text: fmt(value) }));
}

// ---- overview ----

async function loadOverview() {
  const data = await api('/api/overview');
  $('version').textContent = `v${data.version}`;
  $('project-count').textContent = data.registry ? String(data.projects.length) : NO_DATA;
  const rows = data.projects.map((p) => {
    const check = p.lastCheck;
    const drift = check ? el('span', { className: `pill ${check.status}`, text: check.status + (check.problems ? ` (${check.problems})` : '') }) : DASH;
    const last = p.lastTask ? `${p.lastTask.task || p.lastTask.id} · ${when(p.lastTask.ts)}` : DASH;
    const counts = data.tasksFile ? `${fmt(p.tasks7d)} / ${fmt(p.tasks30d)}` : NO_DATA;
    return el('tr', {},
      cell(p.name),
      cell((p.profiles || []).join(', ') || DASH),
      cell(p.coreVersion),
      cell(drift),
      cell(last),
      cell(counts, 'num'));
  });
  table($('projects-table'), ['Project', 'Profiles', 'Version', 'Drift', 'Last task', 'Tasks 7d / 30d'], rows,
    data.registry ? 'no projects registered' : NO_DATA);
  const idx = data.index || [];
  const toPts = (k) => idx.map((r) => ({ x: Date.parse(r.ts), y: r[k] })).filter((p) => Number.isFinite(p.x));
  const stat = toPts('staticMean');
  const task = toPts('taskMedian30');
  lineChart($('index-chart'), [
    { label: 'Static mean', points: stat, missing: !stat.some((p) => typeof p.y === 'number') },
    { label: 'Task median (30d)', points: task, missing: !task.some((p) => typeof p.y === 'number') },
  ]);
}

// ---- tasks ----

const BREAKDOWN = [['gates', 40], ['review', 25], ['outcome', 20], ['rework', 8], ['estimate', 7]];

function fillSelect(select, values) {
  const current = select.value;
  select.replaceChildren(el('option', { value: '', text: 'All' }), ...values.map((v) => el('option', { value: v, text: v })));
  select.value = values.includes(current) ? current : '';
}

function delta(v, n) {
  return typeof v === 'number' ? `${signed(v)} (n=${fmt(n)})` : `${DASH} (n=${fmt(n)})`;
}

function showTask(t) {
  const box = clear($('task-detail'));
  box.hidden = false;
  box.append(el('h2', { text: t.task || t.id }));
  const meta = el('dl', { className: 'meta' });
  const add = (k, v) => meta.append(el('dt', { text: k }), el('dd', { text: fmt(v) }));
  add('Id', t.id);
  add('Project', t.project);
  add('Class', t.class);
  add('When', when(t.ts));
  add('Outcome', t.outcome);
  add('Premise', t.premise);
  add('Score', t.score);
  if (t.score === null && t.scoreReason) add('Why no score', t.scoreReason);
  add('Minutes (actual / estimate)', `${fmt(t.actual_min)} / ${fmt(t.estimate_min)}`);
  box.append(meta);
  const gates = Object.entries(t.gates || {});
  const gt = el('table');
  table(gt, ['Gate', 'Status', 'Runs', 'Tests'], gates.map(([name, g]) =>
    el('tr', {}, cell(name), cell(el('span', { className: `pill ${g?.status}`, text: fmt(g?.status) })), cell(g?.runs, 'num'), cell(g?.tests, 'num'))),
  'no gates recorded');
  box.append(el('h3', { text: 'Gates' }), el('div', { className: 'table-wrap' }, gt));
  const findings = t.review?.findings || [];
  const counts = {};
  for (const f of findings) {
    const k = `${f?.severity || 'unknown'} / ${f?.disposition || 'open'}`;
    counts[k] = (counts[k] || 0) + 1;
  }
  const ft = el('table');
  table(ft, ['Severity / disposition', 'Count'], Object.entries(counts).sort().map(([k, n]) => el('tr', {}, cell(k), cell(n, 'num'))),
    'no findings recorded');
  box.append(
    el('h3', { text: 'Review (self-reported)' }),
    el('p', { className: 'muted small', text: `Lenses: ${(t.review?.lenses || []).join(', ') || DASH}` }),
    el('div', { className: 'table-wrap' }, ft),
  );
  box.scrollIntoView({ block: 'nearest' });
}

async function loadTasks() {
  const params = new URLSearchParams();
  const project = $('filter-project').value;
  const cls = $('filter-class').value;
  if (project) params.set('project', project);
  if (cls) params.set('class', cls);
  const qs = params.toString();
  const data = await api(`/api/tasks${qs ? `?${qs}` : ''}`);
  fillSelect($('filter-project'), data.projects);
  fillSelect($('filter-class'), data.classes);
  $('task-detail').hidden = true;
  const rows = data.tasks.map((t) => {
    const breakdown = el('div', { className: 'bars' }, BREAKDOWN.map(([k, max]) => bar(t.breakdown?.[k] ?? null, max, k)));
    const score = t.score === null || t.score === undefined
      ? el('span', { className: 'muted', title: t.scoreReason || '', text: DASH })
      : el('strong', { text: fmt(t.score) });
    const tr = el('tr', { className: 'clickable', tabIndex: 0 },
      cell(when(t.ts), 'nowrap'),
      cell(t.project),
      cell(t.class),
      cell(t.task || t.id),
      cell(score, 'num'),
      cell(breakdown),
      cell(delta(t.comparison?.prevDelta, t.comparison?.n), 'num'),
      cell(delta(t.comparison?.medianDelta, t.comparison?.n), 'num'));
    tr.addEventListener('click', () => showTask(t));
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        showTask(t);
      }
    });
    return tr;
  });
  table($('tasks-table'), ['When', 'Project', 'Class', 'Task', 'Score', 'Breakdown', 'vs previous', 'vs median'], rows,
    data.missing ? NO_DATA : 'no matching tasks');
}

// ---- agents ----

async function loadAgents() {
  const data = await api('/api/agents');
  const latest = data.latest;
  $('agents-meta').textContent = latest
    ? `Latest evaluation ${when(latest.ts)}; static mean ${fmt(latest.index?.staticMean, 1)}, task median (30d) ${fmt(latest.index?.taskMedian30, 1)} (n=${fmt(latest.index?.taskN)}).`
    : NO_DATA;
  const rows = (latest?.agents || []).map((a) => {
    const hist = (data.history?.[a.name] || []).map((h) => h.static);
    const outcome = a.outcome?.median === null || a.outcome?.median === undefined
      ? `insufficient data (n=${fmt(a.outcome?.n)})`
      : `${fmt(a.outcome.median, 1)} (n=${fmt(a.outcome.n)})`;
    const failed = (a.failed || []).length ? el('ul', { className: 'plain' }, a.failed.map((f) => el('li', { text: f }))) : DASH;
    return el('tr', {},
      cell(a.name),
      cell(el('span', { className: `pill ${a.origin}`, text: fmt(a.origin) })),
      cell(a.static, 'num'),
      cell(sparkline(hist)),
      cell(outcome),
      cell(failed));
  });
  table($('agents-table'), ['Agent', 'Origin', 'Static', 'History', 'Outcome median (n)', 'Failed rubric items'], rows);
  $('roadmap-file').textContent = data.roadmap ? data.roadmap.file : '';
  $('roadmap').textContent = data.roadmap ? data.roadmap.text : NO_DATA;
}

// ---- scout ----

async function adoptCandidate(c, button) {
  const files = (c.files || []).map((f) => `  ${f.path} (${f.size} bytes)`).join('\n');
  const ok = window.confirm(
    [
      `Adopt skill "${c.id}" from ${c.repo}?`,
      '',
      c.description || '',
      '',
      'Files',
      files,
      '',
      `Licence ${c.license?.spdx ?? 'unknown'}, trust flags ${(c.trust?.flags || []).length}.`,
      '',
      `Read every file under candidates/files/${c.id}/ in the state directory before continuing.`,
    ].join('\n'),
  );
  if (!ok) return;
  button.disabled = true;
  try {
    await api('/api/adopt', { id: c.id });
    setStatus(`Adopted ${c.id}.`, 'ok');
    await loadScout();
  } catch (err) {
    button.disabled = false;
    setStatus(`Adopt failed: ${err.message}`, 'error');
  }
}

async function loadScout() {
  const data = await api('/api/scout');
  const adopted = new Set(data.adopted || []);
  $('scout-meta').textContent = data.candidates ? `Scout run ${when(data.ts)} · ${data.candidates.length} candidates` : NO_DATA;
  const rows = (data.candidates || []).map((c) => {
    const flags = c.trust?.flags?.length || 0;
    const trust = el('span', { className: `pill ${c.trust?.pass ? 'pass' : 'fail'}`, text: `${c.trust?.pass ? 'pass' : 'fail'} · ${flags} flag${flags === 1 ? '' : 's'}` });
    const licence = el('span', { className: `pill ${c.license?.pass ? 'pass' : 'fail'}`, text: c.license?.spdx || 'unknown' });
    let action = DASH;
    if (adopted.has(c.id)) action = el('span', { className: 'pill pass', text: 'adopted' });
    else if (c.eligible === true) {
      const btn = el('button', { type: 'button', className: 'small-btn', text: 'Adopt' });
      btn.addEventListener('click', () => adoptCandidate(c, btn));
      action = btn;
    }
    return el('tr', {},
      cell(c.id),
      cell(el('span', { title: c.description || '', text: c.repo || DASH })),
      cell(c.stars, 'num'),
      cell(c.fit?.score, 'num'),
      cell(licence),
      cell(trust),
      cell(action));
  });
  table($('scout-table'), ['Id', 'Repository', 'Stars', 'Fit', 'Licence', 'Trust', ''], rows,
    data.candidates ? 'no candidates in the newest run' : NO_DATA);
  const errs = clear($('scout-errors'));
  for (const e of data.errors || []) errs.append(el('li', { text: typeof e === 'string' ? e : JSON.stringify(e) }));
}

// ---- schedules ----

function scheduleRow(job, cfg, running, status) {
  const enabled = el('input', { type: 'checkbox', name: `${job}.enabled`, checked: !!cfg.enabled });
  const every = el('select', { name: `${job}.every` }, ['hourly', 'daily', 'weekly'].map((v) => el('option', { value: v, text: v })));
  every.value = cfg.every;
  const hour = el('input', { type: 'number', name: `${job}.hour`, min: '0', max: '23', step: '1', value: String(cfg.hour) });
  const weekday = el('select', { name: `${job}.weekday` }, DAYS.map((d, i) => el('option', { value: String(i), text: d })));
  weekday.value = String(cfg.weekday);
  const sync = () => {
    hour.disabled = every.value === 'hourly';
    weekday.disabled = every.value !== 'weekly';
  };
  every.addEventListener('change', sync);
  sync();
  const run = el('button', { type: 'button', className: 'small-btn', text: running ? 'Running…' : 'Run now', disabled: running });
  run.addEventListener('click', async () => {
    run.disabled = true;
    try {
      const res = await api('/api/run', { job });
      setStatus(`Started ${job} (${res.id}).`, 'ok');
      setTimeout(() => loadSchedules().catch(report), 1500);
    } catch (err) {
      run.disabled = false;
      setStatus(`Run failed to start: ${err.message}`, 'error');
    }
  });
  return el('fieldset', { className: 'job' },
    el('legend', { text: job }),
    el('label', { className: 'check' }, enabled, 'Enabled'),
    el('label', {}, 'Every', every),
    el('label', {}, 'Hour', hour),
    el('label', {}, 'Weekday', weekday),
    lastLine(cfg, status),
    run);
}

const FRESHNESS_HELP = {
  fresh: 'ran within its cadence',
  stale: 'missed one or two slots',
  missed: 'missed more than two slots, or never ran while enabled',
  disabled: 'not scheduled',
};

function lastLine(cfg, status) {
  const result = status?.lastResult;
  const fresh = status?.freshness;
  return el('p', { className: 'small last' },
    el('span', { className: 'muted', text: `Last run: ${cfg.lastRun ? when(cfg.lastRun) : 'never'}` }),
    result
      ? el('span', { className: `pill ${result.status}`, title: 'last result', text: `${result.status} \u00b7 exit ${fmt(result.exitCode)}` })
      : el('span', { className: 'pill', title: 'last result', text: 'no result yet' }),
    fresh ? el('span', { className: `pill fresh-${fresh}`, title: `freshness: ${FRESHNESS_HELP[fresh] || fresh}`, text: fresh }) : null);
}

async function loadSchedules() {
  const [sched, runs] = await Promise.all([api('/api/schedules'), api('/api/runs')]);
  const form = clear($('schedule-form'));
  const running = new Set(sched.running || []);
  for (const [job, cfg] of Object.entries(sched.jobs)) form.append(scheduleRow(job, cfg, running.has(job), sched.status?.[job]));
  form.append(el('div', { className: 'actions' }, el('button', { type: 'submit', text: 'Save schedules' })));
  const rows = (runs.runs || []).map((r) => el('tr', {},
    cell(r.job),
    cell(el('span', { className: `pill ${r.status}`, text: fmt(r.status) })),
    cell(when(r.startedAt), 'nowrap'),
    cell(duration(r.startedAt, r.finishedAt), 'num'),
    cell(r.exitCode, 'num'),
    cell(r.summary || DASH)));
  table($('runs-table'), ['Job', 'Status', 'Started', 'Duration', 'Exit code', 'Summary'], rows, runs.missing ? NO_DATA : 'no runs yet');
}

async function saveSchedules(e) {
  e.preventDefault();
  const form = $('schedule-form');
  const jobs = {};
  for (const fs of form.querySelectorAll('fieldset.job')) {
    const job = fs.querySelector('legend').textContent;
    const val = (n) => form.elements.namedItem(`${job}.${n}`);
    jobs[job] = {
      enabled: val('enabled').checked,
      every: val('every').value,
      hour: Number.parseInt(val('hour').value, 10),
      weekday: Number.parseInt(val('weekday').value, 10),
    };
  }
  try {
    await api('/api/schedules', { jobs });
    setStatus('Schedules saved.', 'ok');
    await loadSchedules();
  } catch (err) {
    setStatus(`Save failed: ${err.message}`, 'error');
  }
}

// ---- tabs ----

const LOADERS = { overview: loadOverview, tasks: loadTasks, agents: loadAgents, scout: loadScout, schedules: loadSchedules };

function report(err) {
  setStatus(`Could not load data: ${err.message}`, 'error');
}

function show(tab) {
  if (!LOADERS[tab]) tab = 'overview';
  for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const s of document.querySelectorAll('.tab')) s.hidden = s.id !== `tab-${tab}`;
  setStatus('');
  LOADERS[tab]().catch(report);
}

for (const b of document.querySelectorAll('[data-tab]')) {
  b.addEventListener('click', () => {
    history.replaceState(null, '', `#${b.dataset.tab}`);
    show(b.dataset.tab);
  });
}
$('filter-project').addEventListener('change', () => loadTasks().catch(report));
$('filter-class').addEventListener('change', () => loadTasks().catch(report));
$('schedule-form').addEventListener('submit', saveSchedules);
show(location.hash.slice(1));
