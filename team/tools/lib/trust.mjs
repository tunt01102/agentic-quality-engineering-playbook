// Trust scan for scouted skills (SDD sections 3.2 and 7.5).
//
// The scan is ADVISORY. It catches the obvious shapes of the drop criteria so a person reviews fewer
// bad candidates; it does not prove a skill is safe. A clean result means "no pattern matched", never
// "trusted". Human review of the full content before adoption is the control.
import path from 'node:path';
import { parseFrontmatter } from './util.mjs';

export const MAX_FILE_BYTES = 64 * 1024;

// Zero-width, directional-override and invisible-operator characters: U+200B..U+200F,
// U+202A..U+202E, U+2060..U+2064 and U+FEFF.
const INVISIBLE_RE = /[​-‏‪-‮⁠-⁤﻿]/g;

/**
 * Normalise text before scanning: NFKC (folds full-width and compatibility look-alikes), remove
 * invisible characters, and unwrap HTML comments. Comment markers are removed but the comment body is
 * kept, because text hidden in a comment is invisible in rendered Markdown yet still read by the model;
 * deleting it would hide exactly what the scan must see. Newlines are preserved so line numbers hold.
 */
export function normalise(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(INVISIBLE_RE, '')
    .replace(/<!--/g, '    ')
    .replace(/--!?>/g, '   ');
}

// Each rule: a name and the patterns that flag it. Patterns run on the normalised full text, so a
// phrase split across a line break is still caught; the reported line is where the match starts.
const RULES = [
  {
    name: 'writes-outside-repo',
    patterns: [
      /\$HOME\b|\$\{HOME\}|\bhomedir\(|%USERPROFILE%|\$env:USERPROFILE/i,
      /(?:^|[\s"'`(=])[~][\\/]\.?[A-Za-z_]/m,
      /(?:^|[\s"'`(=])\/etc\//m,
    ],
  },
  {
    name: 'edits-harness',
    patterns: [
      /\bsettings(?:\.local)?\.json\b/i,
      /\bhooks?\s+config(?:uration)?\b|["']hooks["']\s*:|\b(?:PreToolUse|PostToolUse|UserPromptSubmit|SessionStart)\b/,
      /\bpermissions\s*["']?\s*[:={]|\b(?:edit|change|modify|update|grant|add)\s+(?:the\s+|your\s+)?permissions\b|\ballowedTools\b|\bdangerously-skip-permissions\b/i,
      /\bclaude\s+mcp\s+add\b/i,
    ],
  },
  {
    name: 'unpinned-remote-code',
    patterns: [
      // npx <package> without a pinned number after the package name (scoped packages included).
      /\bnpx\s+(?:-{1,2}[\w-]+\s+)*(?:@[\w.-]+\/)?[\w.-]+(?![\w.\/-]*@[0-9])(?=[\s`'")]|$)/m,
      // pip install <package> with no == pin (requirement files and local paths are allowed).
      /\bpip3?\s+install\s+(?:-{1,2}(?!r\b|requirement\b)[\w-]+\s+)*(?![-.\/])[A-Za-z0-9_.[\]-]+(?!\S*==)(?=\s|`|$)/m,
      /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/i,
      /\biex\b|\bInvoke-Expression\b/i,
    ],
  },
  {
    name: 'exfiltration',
    patterns: [
      /\b(?:curl|wget)\b[^\n]*?(?:\s-d\b|\s--data\b|\s--data-\w+|\s-F\b|\s--form\b|\s-X\s*POST\b|\s--upload-file\b|\s-T\s|\s--post-data\b)/i,
      /\bfetch\s*\([^)]*method\s*:\s*['"`](?:POST|PUT|PATCH)/i,
      /\b(?:requests|httpx|axios|session)\.(?:post|put|patch)\s*\(/i,
      /\bweb-?hooks?\b/i,
    ],
  },
  {
    name: 'mandatory-trigger',
    patterns: [/\bMUST BE USED\b|\balways use this skill\b|\bMANDATORY for\b|\buse proactively for every\b/i],
  },
  {
    name: 'prompt-injection',
    patterns: [
      /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|prompts?|rules|directions|messages)/i,
      /\byou are now\b/i,
      /\bsystem prompt\b/i,
      /\bdo not tell the user\b|\bdon'?t tell the user\b/i,
      /\breveal your\b/i,
    ],
  },
  {
    name: 'encoded-blob',
    patterns: [/[A-Za-z0-9+/]{200,}={0,2}/],
  },
];

const FRONTMATTER_ALLOWED = new Set(['name', 'description', 'license', 'metadata']);
// Keys that change what the skill can do; always flagged (they are also outside the allowlist).
export const FRONTMATTER_ALWAYS_FLAGGED = ['allowed-tools', 'hooks', 'model', 'tools', 'mcpServers', 'permissionMode'];

const ALLOWED_NON_MARKDOWN = /^(?:LICEN[CS]E(?:\.md|\.txt)?|NOTICE(?:\.md|\.txt)?)$/i;

function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function frontmatterFlags(file, text) {
  const { data, raw } = parseFrontmatter(text);
  const rawLines = raw.split(/\r?\n/);
  const flags = [];
  // Every top-level line must be a plain allowlisted `key: value`; quoted keys, spaces before the colon or
  // anything else a YAML parser would still read as a key are flagged rather than silently skipped.
  rawLines.forEach((l, i) => {
    if (!l.trim() || /^\s/.test(l) || l.startsWith('#')) return;
    const m = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s|$)/.exec(l);
    if (!m || !FRONTMATTER_ALLOWED.has(m[1])) flags.push({ file, rule: 'frontmatter-keys', line: i + 2, key: m ? m[1] : l.slice(0, 40) });
  });
  for (const key of Object.keys(data)) {
    if (FRONTMATTER_ALLOWED.has(key)) continue;
    if (flags.some((f) => f.key === key)) continue;
    const idx = rawLines.findIndex((l) => l.startsWith(`${key}:`));
    flags.push({ file, rule: 'frontmatter-keys', line: idx >= 0 ? idx + 2 : 1, key });
  }
  return flags;
}

/**
 * Scan candidate files. `files` is [{path, text}]. Returns {pass, flags: [{file, rule, line}]};
 * pass is true only when nothing matched. Advisory: see the note at the top of this file.
 */
export function scanFiles(files) {
  const flags = [];
  for (const { path: file, text } of files) {
    const raw = String(text ?? '');
    const base = path.posix.basename(String(file).replace(/\\/g, '/'));
    if (!/\.md$/i.test(base) && !ALLOWED_NON_MARKDOWN.test(base)) {
      flags.push({ file, rule: 'non-markdown', line: 0 });
    }
    if (Buffer.byteLength(raw, 'utf8') > MAX_FILE_BYTES) flags.push({ file, rule: 'size', line: 0 });
    const norm = normalise(raw);
    if (base === 'SKILL.md') flags.push(...frontmatterFlags(file, norm));
    for (const rule of RULES) {
      const seen = new Set();
      for (const pattern of rule.patterns) {
        const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
        for (const m of norm.matchAll(re)) {
          const line = lineAt(norm, m.index + (m[0].length - m[0].trimStart().length));
          if (seen.has(line)) continue;
          seen.add(line);
          flags.push({ file, rule: rule.name, line });
        }
      }
    }
  }
  return { pass: flags.length === 0, flags };
}

export const RULE_NAMES = [...RULES.map((r) => r.name), 'frontmatter-keys', 'non-markdown', 'size'];
