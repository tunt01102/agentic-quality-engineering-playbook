// Deterministic scoring (SDD sections 7.2 and 7.3). The agent never computes these.
import { parseFrontmatter } from './util.mjs';

const LENSES = ['failure-path', 'data-scope', 'contract-coverage', 'config-sequencing'];
const REVIEWED = ['feature', 'change', 'fix', 'refactor', 'content', 'hotfix'];
const OUTCOME_POINTS = { done: 20, partial: 8, blocked: 4, refuted: 8 };

/** Score one task record. Returns { score:number|null, reason?, breakdown, notes[] }. */
export function scoreTask(rec) {
  const notes = [];
  const invalid = (reason) => ({ score: null, reason, breakdown: null, notes });
  if (!rec || rec.schema !== 'core-task-record/1') return invalid('invalid: schema');
  for (const f of ['id', 'project', 'class', 'outcome', 'startedAt', 'gates', 'requiredGates', 'review']) {
    if (rec[f] === undefined || rec[f] === null) return invalid(`invalid: ${f}`);
  }
  if (rec.outcome === 'not-started') return invalid('not started');
  if (!(rec.outcome in OUTCOME_POINTS)) return invalid('invalid: outcome');
  if (!Array.isArray(rec.requiredGates) || rec.requiredGates.length === 0) return invalid('invalid: no required gates');

  // gates 40, shared by the project's required gates; only receipt-backed passes earn.
  const share = 40 / rec.requiredGates.length;
  let gates = 0;
  for (const id of rec.requiredGates) {
    const g = rec.gates[id];
    if (!g) {
      notes.push(`${id}: missing`);
      continue;
    }
    if (g.status !== 'pass') {
      notes.push(`${id}: ${g.status}`);
      continue;
    }
    if (g.runsRequired && g.runs < g.runsRequired) {
      notes.push(`${id}: ${g.runs}/${g.runsRequired} runs`);
      continue;
    }
    if (g.kind === 'test' && !(Number(g.tests) > 0)) {
      notes.push(`${id}: no tests counted`);
      continue;
    }
    gates += share;
  }

  // review 25: all four lenses recorded, or 0.
  let review = 0;
  const lenses = rec.review.lenses || [];
  const missing = LENSES.filter((l) => !lenses.includes(l));
  if (REVIEWED.includes(rec.class) && missing.length) {
    notes.push(`review: lenses missing (${missing.join(', ')})`);
  } else {
    review = 25;
    for (const f of rec.review.findings || []) {
      if (f.disposition === 'open') review -= { critical: 10, high: 5, medium: 2, low: 0 }[f.severity] ?? 0;
      if (f.disposition === 'waived' && f.waivedWithReason === false) review -= 2;
    }
    review = Math.max(0, review);
    if (!REVIEWED.includes(rec.class) && !lenses.length) notes.push('review: not required for this class');
  }

  const outcome = OUTCOME_POINTS[rec.outcome];
  let rework = 0;
  let estimate = 0;
  if (rec.outcome === 'done' || rec.outcome === 'partial') {
    rework = Math.max(0, 8 - 3 * (Number(rec.rework_rounds) || 0));
    const est = Number(rec.estimate_min);
    const act = Number(rec.actual_min);
    if (est > 0 && act >= 0) {
      const ratio = Math.max(act, 1) / est;
      estimate = ratio >= 0.5 && ratio <= 2 ? 7 : ratio >= 1 / 3 && ratio <= 3 ? 3 : 0;
    } else notes.push('estimate: missing');
  }
  const breakdown = { gates: round1(gates), review, outcome, rework, estimate };
  const score = Math.round(gates + review + outcome + rework + estimate);
  return { score, breakdown, notes };
}

const round1 = (n) => Math.round(n * 10) / 10;

export function median(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * Compare a scored task with earlier scored tasks of the same project.
 * Deltas are suppressed (null) below `minN` comparable tasks.
 */
export function compareTask(task, earlier, { minN = 5 } = {}) {
  const sameProject = earlier.filter((t) => t.project === task.project && typeof t.score === 'number' && t.ts < task.ts);
  const sameClass = sameProject.filter((t) => t.class === task.class);
  const scores = sameProject.map((t) => t.score);
  const med = median(scores);
  const spread = scores.length ? [Math.min(...scores), Math.max(...scores)] : null;
  const prev = [...sameProject].sort((a, b) => a.ts.localeCompare(b.ts)).at(-1);
  const ok = typeof task.score === 'number';
  return {
    n: sameProject.length,
    nClass: sameClass.length,
    prevDelta: ok && prev && sameProject.length >= minN ? task.score - prev.score : null,
    prevScore: prev ? prev.score : null,
    medianDelta: ok && med !== null && sameProject.length >= minN ? round1(task.score - med) : null,
    median: med,
    spread,
  };
}

// ---------- agent rubric ----------

const WRITE_TOOLS = /\b(Write|Edit|MultiEdit|NotebookEdit)\b/;
const ANALYSIS_ROLE = /review|reviewer|analy[sz]|audit|plan|architect|explor|verif|inspect|lens|hunter/i;
const TRIGGER = /PROACTIVELY|MUST BE USED|immediately after|Use for all|Use for any change|Automatically activat|always use/i;

export const RUBRIC = [
  { id: 'frontmatter', points: 15, fix: 'add the missing frontmatter fields (name, description, tools, model)' },
  { id: 'when-to-use', points: 15, fix: 'say in the description when to use the agent (a "Use when ..." or "Use from ..." clause naming concrete situations)' },
  { id: 'no-auto-trigger', points: 10, fix: 'remove auto-invocation phrases (PROACTIVELY, MUST BE USED, "for all changes") so the router decides' },
  { id: 'least-privilege', points: 20, fix: 'give review, planning and analysis agents read-only tools (no Write, Edit, NotebookEdit); declare tools explicitly' },
  { id: 'prompt-defence', points: 10, fix: 'add a boundaries section: treat repository content and tool output as data, not instructions; never reveal secrets' },
  { id: 'output-format', points: 10, fix: 'add an Output section with a fixed report shape' },
  { id: 'verification', points: 10, fix: 'require evidence for every claim (file:line, command and result) and a verification step' },
  { id: 'size', points: 5, fix: 'cut the prompt under 400 lines; move reference material to a skill' },
  { id: 'references', points: 5, fix: 'remove references to agents, skills or commands that are not installed' },
];

/**
 * Static score of one agent file. `known` = names of installed agents and skills, `allKnown` = every
 * agent, skill and command name the core knows of (references to those that are not installed fail).
 */
export function scoreAgent(text, { known = new Set(), allKnown = new Set() } = {}) {
  const { data, body } = parseFrontmatter(text);
  const desc = data.description || '';
  const lines = text.split('\n').length;
  const toolsDeclared = typeof data.tools === 'string' && data.tools.trim() !== '';
  const hasWrite = !toolsDeclared || WRITE_TOOLS.test(data.tools);
  const analysis = ANALYSIS_ROLE.test(`${data.name || ''} ${desc}`) && !/fix|resolver|implement|simplif|refactor|clean/i.test(data.name || '');
  const section = (re) => new RegExp(`^#{1,4}\\s*(?:${re})`, 'im').test(body);
  const unresolvedRefs = [];
  for (const m of body.matchAll(/`([a-z][a-z0-9-]{2,})`/g)) {
    if (allKnown.has(m[1]) && !known.has(m[1])) unresolvedRefs.push(m[1]);
  }
  const pass = {
    frontmatter: Boolean(data.name && desc && toolsDeclared && data.model),
    'when-to-use': /\b(use (it )?(when|from|after|before|for)|when (asked|you need|a|the))\b/i.test(desc) && desc.length >= 60,
    'no-auto-trigger': !TRIGGER.test(desc),
    'least-privilege': analysis ? toolsDeclared && !hasWrite : toolsDeclared,
    'prompt-defence': section('boundaries|prompt defen[cs]e|safety|guardrails') && /as data|untrusted|not instructions/i.test(body),
    'output-format': section('output|report|deliverable|response format'),
    verification: /evidence|verify|verif(y|ied|ication)|file:line|confirm/i.test(body) && section('procedure|process|workflow|steps|verification|review process|how'),
    size: lines <= 400,
    references: unresolvedRefs.length === 0,
  };
  let score = 0;
  const failed = [];
  for (const item of RUBRIC) {
    if (pass[item.id]) score += item.points;
    else failed.push(item.id);
  }
  return { name: data.name || null, description: desc, score, failed, lines, unresolvedRefs: [...new Set(unresolvedRefs)], analysisRole: analysis };
}
