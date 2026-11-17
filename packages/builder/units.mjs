// Structural units of one document, ported from the measured chunker (branch
// worktree-agent-a00e59ae16c567ff6: kb/forge-chunk-v2.mjs markdownUnits/blockUnits/plainUnits/
// indentUnits and kb/forge-chunk-code-v2.mjs heuristicUnits). A unit is a line range
// { start, end, symbol, isSymbol, packSig?, split? } (0-based rows); the units of a file always
// partition its lines. Code uses the reference's line/brace heuristic: the tree-sitter grammars it
// used when present are a package dependency this builder does not have (see the work-package report).
import path from 'node:path';

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;

/** Markdown: one unit per heading section; an oversized section splits into blocks. */
export function markdownUnits(lines, title = '') {
  const sections = [];
  const stack = [];
  let fence = null;
  let cur = { start: 0, heading: null, path: title };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fm = line.match(FENCE_RE);
    if (fence) {
      if (fm && fm[1][0] === fence[0] && fm[1].length >= fence.length && !line.trim().slice(fm[1].length).trim()) fence = null;
      continue;
    }
    if (fm) {
      fence = fm[1];
      continue;
    }
    const hm = line.match(HEADING_RE);
    if (!hm) continue;
    if (i > cur.start || cur.heading !== null) {
      cur.end = i - 1;
      if (cur.end >= cur.start) sections.push(cur);
    }
    const level = hm[1].length;
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, text: hm[2].replace(/[`*_]/g, '').trim() });
    cur = { start: i, heading: i, path: stack.map((s) => s.text).join(' > ') };
  }
  cur.end = lines.length - 1;
  if (cur.end >= cur.start) sections.push(cur);
  return sections.map((s) => {
    const sig = s.heading !== null ? [s.heading] : [];
    return { start: s.start, end: s.end, symbol: s.path, isSymbol: true, packSig: sig, split: () => ({ sig, units: blockUnits(lines, s.start, s.end, s.path) }) };
  });
}

/** Blocks between blank lines; a fenced block or a table is one block. */
export function blockUnits(lines, start, end, symbol) {
  const units = [];
  let i = start;
  while (i <= end) {
    const blockStart = i;
    let packSig = [];
    const fm = lines[i].match(FENCE_RE);
    if (fm) {
      const marker = fm[1];
      i++;
      while (i <= end && !(lines[i].match(FENCE_RE) && lines[i].trim().startsWith(marker[0].repeat(marker.length)))) i++;
      packSig = [blockStart];
      i = Math.min(i, end) + 1;
    } else if (/^\s*\|/.test(lines[i])) {
      while (i <= end && /^\s*\|/.test(lines[i])) i++;
      packSig = [blockStart, blockStart + 1].filter((row) => row < i);
    } else {
      while (i <= end && lines[i].trim() && !lines[i].match(FENCE_RE)) i++;
    }
    while (i <= end && !lines[i].trim()) i++;
    units.push({ start: blockStart, end: i - 1, symbol, isSymbol: false, packSig });
  }
  return units;
}

const CLOSER_RE = /^\s*[\]}][,;]?\s*$/;
const OPENER_RE = /^\s*[[{]\s*$/;

function keyOf(lines, row) {
  const key = lines[row].match(/^\s*(?:-\s+)?"?([^":\s][^":]*?)"?\s*:/);
  if (key) return key[1].trim();
  for (let r = row; r < Math.min(lines.length, row + 6); r++) {
    const m = lines[r].match(/^\s*"?(?:name|id|title|key)"?\s*:\s*"?([^",]+)"?/);
    if (m) return m[1].trim();
  }
  return lines[row].trim().slice(0, 40);
}

/** JSON/YAML by indentation: members of the shallowest level with two or more members. */
export function indentUnits(lines, start = 0, end = lines.length - 1, parent = '') {
  const indent = (row) => lines[row].match(/^\s*/)[0].length;
  const rows = [];
  for (let r = start; r <= end; r++) if (lines[r].trim() && !CLOSER_RE.test(lines[r]) && !(r === start && OPENER_RE.test(lines[r]))) rows.push(r);
  const levels = [...new Set(rows.map(indent))].sort((a, b) => a - b);
  let starts = null;
  for (const level of levels) {
    const at = rows.filter((r) => indent(r) === level);
    if (at.length >= 2) {
      starts = at;
      break;
    }
  }
  if (!starts) return null;
  starts = starts.filter((r) => r > start);
  starts.unshift(start);
  return starts
    .map((s, k) => {
      const e = k + 1 < starts.length ? starts[k + 1] - 1 : end;
      const key = keyOf(lines, k === 0 && rows[0] !== undefined ? Math.max(start, rows[0]) : s);
      const symbol = parent ? `${parent}.${key}` : key;
      return {
        start: s, end: e, symbol, isSymbol: true, packSig: [s],
        split: () => {
          const units = indentUnits(lines, s, e, symbol);
          return units && units.length > 1 ? { sig: [s], units } : null;
        },
      };
    })
    .filter((u) => u.end >= u.start);
}

const DEF_RE = /\b(?:fn|func|function|def|class|struct|enum|trait|interface|impl|module|mod|type|object|message|service|table|view|procedure|fun|protocol|extension)\s+([A-Za-z_][\w.:<>]*)/i;

/** Line/brace heuristic: a unit starts at a column-0 line after a blank, indented or closing line. */
export function heuristicUnits(lines) {
  const starts = [0];
  let prev = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      prev = '';
      continue;
    }
    const top = !/^\s/.test(line) && !/^[}\])]/.test(line);
    if (i > 0 && top && prev !== null && (prev === '' || /^\s/.test(prev) || /[;}]\s*$|^end\b/.test(prev.trim()))) starts.push(i);
    prev = line;
  }
  const units = [];
  for (let k = 0; k < starts.length; k++) {
    const start = starts[k];
    const end = k + 1 < starts.length ? starts[k + 1] - 1 : lines.length - 1;
    if (end < start) continue;
    let symbol = '';
    let defRow = start;
    for (let r = start; r <= Math.min(end, start + 6); r++) {
      const m = lines[r].match(DEF_RE);
      if (m) {
        symbol = m[1];
        defRow = r;
        break;
      }
    }
    units.push({ start, end, symbol, isSymbol: Boolean(symbol), packSig: [defRow] });
  }
  return units;
}

/** Units for a document of a content type (the registry of the reference's content adapters). */
export function unitsFor(type, lines, relPath) {
  switch (type) {
    case 'code':
    case 'sections':
      return heuristicUnits(lines);
    case 'markdown':
      return markdownUnits(lines, path.posix.basename(relPath));
    case 'tree':
      return indentUnits(lines) || blockUnits(lines, 0, lines.length - 1, '');
    case 'text':
      return blockUnits(lines, 0, lines.length - 1, '');
    default:
      throw new Error(`no unit builder for content type "${type}" (${relPath})`);
  }
}

const LANG_BY_EXT = {
  '.rs': 'rust', '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'tsx', '.js': 'javascript',
  '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript', '.py': 'python', '.go': 'go', '.sh': 'bash',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp', '.java': 'java', '.rb': 'ruby', '.swift': 'swift', '.kt': 'kotlin',
  '.sql': 'sql', '.proto': 'proto',
};

export function languageOf(relPath, type) {
  const ext = path.posix.extname(relPath).toLowerCase();
  if (type === 'code') return LANG_BY_EXT[ext] || ext.slice(1) || 'text';
  return ext ? ext.slice(1) : type;
}

const ADR_RE = /(^|\/)(adrs?|decisions?)(\/|$)|(^|\/)adr[-_]?\d/i;
const TEST_DIR_RE = /(^|\/)(tests?|__tests__|specs?|e2e|integration-tests?)(\/|$)/i;
const TEST_NAME_RE = /\.(test|spec|e2e)\.[cm]?[jt]sx?$|_test\.(go|rs|py)$|(^|\/)test_[^/]+\.py$|_spec\.rb$|Tests?\.(java|kt|swift)$/;
const EXAMPLE_RE = /(^|\/)(examples?|demos?|samples?)(\/|$)/i;
const CLI_PATH_RE = /(^|\/)(bin|cli|commands?)(\/|$)|(^|\/)(cli|main)\.(rs|ts|js|mjs|py|go)$/i;
const CLI_BODY_RE = /#\[derive\([^)]*\bParser\b|\bclap::|from ['"]commander['"]|require\(['"]commander['"]\)|from ['"]yargs|\bargparse\.ArgumentParser|cobra\.Command|^#!.*\bnode\b/m;

/** Passage kind: source | test | example | cli | doc | adr | skill | config. */
export function kindOf(relPath, type, head = '') {
  if (type === 'markdown' || type === 'text') {
    if (ADR_RE.test(relPath)) return 'adr';
    if (path.posix.basename(relPath) === 'SKILL.md') return 'skill';
    if (EXAMPLE_RE.test(relPath)) return 'example';
    return 'doc';
  }
  if (type === 'tree' || type === 'sections') return 'config';
  if (TEST_NAME_RE.test(relPath) || TEST_DIR_RE.test(relPath)) return 'test';
  if (EXAMPLE_RE.test(relPath)) return 'example';
  if (CLI_PATH_RE.test(relPath) || CLI_BODY_RE.test(head.slice(0, 4096))) return 'cli';
  return 'source';
}
