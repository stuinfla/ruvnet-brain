// The two tools the server offers, and the checks on their arguments. Descriptions follow the vendor
// guidance for agent-facing search tools: say what comes back and how big it is, offer a brief and a
// full mode, name things instead of using opaque ids, and say how to get more.
export const MAX_EXTRA_TERMS = 8;
export const MAX_TERM_CHARS = 200;

export const SEARCH = {
  name: 'search_ruvnet',
  description:
    "Search RuvNet Brain's signed knowledge pack of rUv's public work (code, docs, decisions, history). " +
    'Pass the user\'s own words as `query`, unchanged. Optionally pass `extra_terms`: your technical phrasings ' +
    'and the names likely to appear in the answer (APIs, packages, functions); they never replace the question. ' +
    'Returns cited passages in sections (FILES, HISTORY), each with repository, path, lines, commit, standing ' +
    'and date, capped at 24,000 characters (brief) or 44,000 (full). Use read_ruvnet for more lines of a cited file.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: "The user's question or problem, in the user's own words." },
      extra_terms: {
        type: 'array',
        items: { type: 'string' },
        maxItems: MAX_EXTRA_TERMS,
        description: 'Optional. Up to 8 extra phrasings or likely terms (technical names, synonyms). Searched only in addition to the query.',
      },
      detail: { type: 'string', enum: ['brief', 'full'], description: 'brief (default) or full: longer excerpts, larger cap.' },
      k: { type: 'number', description: 'Ignored in version 5; use detail.' },
    },
    required: ['query'],
  },
};

export const READ = {
  name: 'read_ruvnet',
  description:
    'Read lines of one file cited by search_ruvnet, from the same signed pack. `ref` is "repo/path" or ' +
    '"repo/path#L120-260" (#L120 reads from line 120 on). Returns the lines with their citation, capped at ' +
    '24,000 characters (brief) or 44,000 (full); when cut, it says which lines to ask for next.',
  inputSchema: {
    type: 'object',
    properties: {
      ref: { type: 'string', description: 'repo/path, optionally followed by #L<from>-<to>, exactly as cited.' },
      detail: { type: 'string', enum: ['brief', 'full'], description: 'brief (default) or full: a larger cap.' },
    },
    required: ['ref'],
  },
};

export const detailOf = (args) => (args?.detail === 'full' || args?.detail === 'brief' ? args.detail : undefined);

/** The extra terms as a clean list, plus a note when some were left out. */
export function extraTerms(args) {
  let raw = args?.extra_terms;
  if (raw === undefined || raw === null) return { terms: [], note: null };
  if (typeof raw === 'string') raw = [raw];
  if (!Array.isArray(raw)) return { terms: [], note: 'extra_terms must be a list of strings; it was ignored.' };
  const clean = [...new Set(raw.filter((t) => typeof t === 'string').map((t) => t.trim().slice(0, MAX_TERM_CHARS)).filter(Boolean))];
  const terms = clean.slice(0, MAX_EXTRA_TERMS);
  const dropped = raw.length - terms.length;
  return { terms, note: dropped > 0 ? `${dropped} of the extra_terms were empty, repeated, not text or over the limit of ${MAX_EXTRA_TERMS}; they were ignored.` : null };
}
