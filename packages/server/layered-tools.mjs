// The five layered tools (L+, contract 1.3) and the checks on their arguments. They read the installed
// public pack's layered store (engine/layered/query.mjs) inside a worker thread under the recipe's
// deadline, exactly as search_ruvnet and read_ruvnet do; they never open a private pack.
// The answer rules travel with the tools: RULES is the L+ prompt rule text, verbatim from the
// held-out run (layered/test-run/RESULTS.md, "What L+ is"), and is in the description of search_ruvnet
// and map_ruvnet and in the plug-in's skill.
export const RULES =
  'Rules: (a) before saying something does not exist or is not supported, search at least three different ways (plain ' +
  'words, likely product name, likely file or crate name) and say what you searched; (b) for a recommended capability, ' +
  'open its source and state: what to call, defaults and limits, what it does not do, known pitfalls or contradictions ' +
  'between docs and code, and version history if the question is about a change over time; (c) cite file and line for ' +
  'every specific number, default or command.';

const KINDS = ['status', 'marker', 'command', 'flag', 'mcp-tool', 'mcp-schema', 'default', 'const', 'env', 'signature', 'doc-number-line', 'test'];
const PAGE = 'One compact JSON answer under 20,000 characters; when there is more, `next` is the cursor (or the source_ruvnet call) for the next page.';
const cursor = { type: 'integer', minimum: 0, description: 'Optional. The `next` value of the previous page.' };

export const LAYERED = [
  {
    name: 'map_ruvnet',
    tool: 'map',
    description:
      "Map of rUv's capabilities (packages, crates, plugins, MCP tools, CLI commands, repositories) matching `query`: each with " +
      'its one-line description copied verbatim from its source (manifest, README, tool or command definition) with source_path and ' +
      'line, typed links (depends-on, tool-in-package, plugin-provides-*) with evidence path:line, and `dive`, the facts_ruvnet call ' +
      `for its verbatim extracts. Use it first to find what exists and what it is called. ${PAGE} ${RULES}`,
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'A capability, product, package, tool or command name, or plain words for the problem.' }, cursor },
      required: ['query'],
    },
  },
  {
    name: 'facts_ruvnet',
    tool: 'facts',
    description:
      'Verbatim extracts (L2) for a capability, each with repo, path and exact line range: commands, flags, MCP tool definitions and ' +
      'input schemas, defaults, constants, environment variables, exported signatures, status and limitation sections, TODO / not ' +
      'implemented / experimental markers, numbers stated in docs, and test names. `target` is a map_ruvnet id or name, a ' +
      'repository name, a file or folder path, or a symbol. Non-test rows first. Use it to state what to call, defaults and limits, ' +
      `and what is not done. ${PAGE}`,
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'An id or name from map_ruvnet, a repository name, a path, or a symbol.' },
        kind: { type: 'string', enum: KINDS, description: 'Optional. Only rows of this kind.' },
        repo: { type: 'string', description: 'Optional. Only rows of this repository.' },
        cursor,
      },
      required: ['target'],
    },
  },
  {
    name: 'find_ruvnet',
    tool: 'find',
    description:
      'Full-text search over the map and the verbatim extracts (identifiers are split, so efSearch matches "ef search"). Each hit ' +
      'gives repo, path, lines, the first 240 characters of the verbatim text and `dive`, the call that opens it. All-words matches ' +
      'first, test files last. Use different words, product names and file or crate names before concluding something does not ' +
      `exist. ${PAGE}`,
    inputSchema: {
      type: 'object',
      properties: { words: { type: 'string', description: 'Words, names or identifiers to find.' }, cursor },
      required: ['words'],
    },
  },
  {
    name: 'context_ruvnet',
    tool: 'context',
    description:
      'Context of one file: the capability that owns it, the ADRs it mentions (with their Status lines), the ADR lines that name ' +
      'it, and the commit the pack was built from. Per-file history is not in this store; search_ruvnet gives the HISTORY section. ' +
      'One compact JSON answer under 20,000 characters.',
    inputSchema: {
      type: 'object',
      properties: { repo: { type: 'string', description: 'Repository name, as cited.' }, path: { type: 'string', description: 'File path inside the repository, as cited.' } },
      required: ['repo', 'path'],
    },
  },
  {
    name: 'source_ruvnet',
    tool: 'source',
    description:
      'Read a file of the pack line by line (L3), as numbered [line, text] pairs: 200 lines by default, `from` and `to` to choose. ' +
      'The text is the source as the pack holds it (secrets replaced, line numbers unchanged). Open the source of anything you ' +
      `recommend, and cite file and line for every number, default or command. ${PAGE}`,
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository name, as cited.' },
        path: { type: 'string', description: 'File path inside the repository, as cited.' },
        from: { type: 'integer', minimum: 1, description: 'Optional. First line (default 1).' },
        to: { type: 'integer', minimum: 1, description: 'Optional. Last line (default from + 199).' },
      },
      required: ['repo', 'path'],
    },
  },
];

export const LAYERED_NAMES = new Map(LAYERED.map((t) => [t.name, t]));
/** The definitions as tools/list sends them (no internal fields). */
export const layeredList = () => LAYERED.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

const MAX_TEXT = 500;
const MAX_PATH = 1024;
const MAX_INT = 10_000_000;

function text(v, what, max = MAX_TEXT) {
  if (typeof v !== 'string' || !v.trim()) return [null, `${what} is required and must be text`];
  if (v.length > max) return [null, `${what} is over ${max} characters`];
  if (v.includes('\0')) return [null, `${what} contains a NUL character`];
  return [v.trim(), null];
}
function int(v, what, min) {
  if (v === undefined || v === null) return [undefined, null];
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  if (!Number.isInteger(n) || n < min || n > MAX_INT) return [null, `${what} must be a whole number from ${min} to ${MAX_INT}`];
  return [n, null];
}
function repoPath(args) {
  const [repo, e1] = text(args?.repo, 'repo', 200);
  if (e1) return [null, e1];
  const [p, e2] = text(args?.path, 'path', MAX_PATH);
  if (e2) return [null, e2];
  if (/\\/.test(p) || /^([a-zA-Z]:|\/|~)/.test(p) || p.split('/').some((s) => !s || s === '.' || s === '..')) return [null, `${p} is not a path inside a repository`];
  return [{ repo, path: p }, null];
}

/** Checks one call's arguments at the boundary. Returns { args } for the engine, or { error }. */
export function checkArgs(tool, args) {
  const errs = [];
  const take = ([v, e]) => (e ? (errs.push(e), undefined) : v);
  let out;
  if (tool === 'map') out = { query: take(text(args?.query, 'query')), cursor: take(int(args?.cursor, 'cursor', 0)) ?? 0 };
  else if (tool === 'find') out = { words: take(text(args?.words, 'words')), cursor: take(int(args?.cursor, 'cursor', 0)) ?? 0 };
  else if (tool === 'facts') {
    out = { target: take(text(args?.target, 'target', MAX_PATH)), cursor: take(int(args?.cursor, 'cursor', 0)) ?? 0, kind: null, repo: null };
    if (args?.kind !== undefined && args.kind !== null) (KINDS.includes(args.kind) ? (out.kind = args.kind) : errs.push(`kind must be one of ${KINDS.join(', ')}`));
    if (args?.repo !== undefined && args.repo !== null) out.repo = take(text(args.repo, 'repo', 200));
  } else if (tool === 'context') out = take(repoPath(args));
  else if (tool === 'source') {
    out = take(repoPath(args)) ?? {};
    out.from = take(int(args?.from, 'from', 1)) ?? 1;
    const to = take(int(args?.to, 'to', 1));
    if (to !== undefined && to !== null && to < out.from) errs.push(`to (${to}) is before from (${out.from})`);
    out.to = to ?? null;
  } else errs.push(`unknown layered tool ${tool}`);
  return errs.length ? { error: errs.join('; ') } : { args: out };
}
