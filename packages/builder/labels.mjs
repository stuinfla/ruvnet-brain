// The label line under each passage header, ported from kb/structured-labels.mjs on branch
// worktree-agent-a00e59ae16c567ff6 (itself a port of extractLabels / extractPaths in rUv's ruflo
// v3/@claude-flow/cli/src/memory/structured-distill.ts, whose ADR-076 measured putting labels and
// paths first). `[lang, kind, <identifiers>, <action verbs>]` plus up to three paths, trimmed from the
// end until it fits the recipe's label budget.
const ACTION_VOCAB = [
  'refactor', 'fix', 'add', 'remove', 'rename', 'extract', 'inline', 'split', 'merge', 'delete', 'rewrite', 'simplify', 'optimize',
  'test', 'mock', 'stub', 'verify', 'assert', 'expect', 'document', 'explain', 'comment', 'debug', 'trace', 'log', 'diagnose',
  'wire', 'route', 'dispatch', 'register', 'unregister', 'parse', 'validate', 'sanitize', 'normalize',
  'cache', 'invalidate', 'flush', 'persist', 'load', 'embed', 'distill', 'train', 'consolidate', 'recall',
];
const VERBS = new Set(ACTION_VOCAB);
const PATH_RE = /\b([a-zA-Z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|c|cpp|h|hpp|rb|md|json|yaml|yml|toml|sql))(?::(\d+))?\b/g;
const NOUN_RE = /\b([A-Z][a-zA-Z0-9]{3,}|[A-Z][A-Z0-9_]{3,}|[a-z][a-zA-Z0-9]{4,}[A-Z][a-zA-Z0-9]{1,})\b/g;

function extractPaths(text) {
  const found = new Set();
  for (const m of text.matchAll(PATH_RE)) found.add(m[2] ? `${m[1]}:${m[2]}` : m[1]);
  return [...found];
}

function extractLabels(text) {
  const lower = text.toLowerCase();
  const labels = new Set();
  for (const v of ACTION_VOCAB) if (lower.includes(v)) labels.add(v);
  const counts = new Map();
  for (const m of text.matchAll(NOUN_RE)) {
    const t = m[1];
    if (/^[a-zA-Z]+$/.test(t) && t.length > 20) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  // Stable order: by count, then first appearance (Map order), as the reference's stable sort gives.
  for (const [t] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) labels.add(t);
  return [...labels];
}

export function labelLine({ lang, kind, body, counter, maxTokens }) {
  const labels = extractLabels(body);
  let items = [lang, kind, ...labels.filter((l) => !VERBS.has(l)), ...labels.filter((l) => VERBS.has(l))].filter(Boolean);
  let paths = extractPaths(body).slice(0, 3);
  const render = () => `[${items.join(', ')}]${paths.length ? ` paths: ${paths.join(' ')}` : ''}`;
  let line = render();
  while (counter.count(line) > maxTokens && (paths.length || items.length > 2)) {
    if (paths.length) paths = paths.slice(0, -1);
    else items = items.slice(0, -1);
    line = render();
  }
  return counter.count(line) > maxTokens ? `[${kind}]` : line;
}
