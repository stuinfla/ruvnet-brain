// tests/unit/forge-ask-routing.test.mjs — kb/forge-ask.mjs's intent-classification/routing layer
// (ARCHETYPES table, specificEntity, isOrientationQuery, routePrimer, conceptNouns,
// crateOverviewTarget — ~250 of its 828 lines) is the actual logic that decides what search_ruvnet
// returns. It is not just uncovered — tests/unit/forge-ask-all.test.mjs does
// `vi.mock('../../kb/forge-ask.mjs', () => ({ searchKb: vi.fn() }))`, so this engine never runs
// under any test, even indirectly (memory `test-coverage-gaps-2026-07-07`, single highest-value
// gap in the repo).
//
// WHY NOT TEST searchKb() ITSELF: it requires a real built .rvf + passages.jsonl + meta.json trio
// on disk (`fs.existsSync(conf.rvf)` throws otherwise) and a live local embedding call
// (`embed()` -> @xenova/transformers) — the same heavy prerequisite as forge-guard.mjs's
// checkStore() parity/truncation tests (left `it.todo` there for the same reason).
//
// WHAT'S DIFFERENT HERE: the functions below are PURE — plain strings/Sets/Maps in, a value out,
// zero I/O — so unlike searchKb() itself, they need no fixture store at all, only one prerequisite:
// they are currently unexported (only `searchKb` has `export`, forge-ask.mjs lines 54-503). Adding
// `export` to each (no logic change) is enough to make every case below a real, fixture-free test.
// Flag to Stuart before applying, per this repo's established pattern (same ask as
// check-indexation.mjs / self-update.mjs's own gap skeletons) — confirm the export list matches
// intent before landing it, since this is the module a wrong routing choice would be hardest to
// notice in (a wrong search result reads as "plausible", not as a crash).
import { describe, it, expect } from 'vitest';
import { codeDocIntent, isImplIntent } from '../../kb/forge-ask.mjs';

describe.todo('forge-ask.mjs — specificEntity() (requires exporting, see file header)', () => {
  it.todo('named:true, crates:["ruvector-coherence"] for "what does ruvector-coherence do" when ' +
    '"ruvector-coherence" is in the crateTokens set — a real crate name suppresses PRIMER routing');
  it.todo('named:true for an ADR reference ("ADR-014") even with no crate token match');
  it.todo('named:true for a bare file token ("forge-ask.mjs") even with no crate token match');
  it.todo('named:false for a Title-Cased but generic orientation query ("What Is RuVector") when ' +
    'every capitalized word is either a COMMON_TITLE_WORD or the product\'s own name');
  it.todo('named:true for a genuine multi-word proper noun ("Tell me about Prime Radiant") that is ' +
    'NOT in COMMON_TITLE_WORDS');
});

describe.todo('forge-ask.mjs — isOrientationQuery() (requires exporting)', () => {
  it.todo('true for a short query with no code-signal token ("how do I get started with ruvector")');
  it.todo('false for any query containing a code-signal token ("what does ruv_fann::train() do") ' +
    'even though it is short — SPECIFIC_SIGNAL_RE overrides the length check');
  it.todo('false for a >14-word query with no strong playbook verb (word-count cap)');
  it.todo('true for a >14-word query that DOES contain a strong playbook verb ("set up", "end to ' +
    'end", "from scratch") — STRONG_PLAYBOOK_RE bypasses the word-count cap on purpose');
});

describe.todo('forge-ask.mjs — routePrimer() / ARCHETYPES dispatch (requires exporting)', () => {
  it.todo('routes "is ruvector production ready" to the discovered maturity PRIMER path via the ' +
    '"maturity" archetype\'s section-matcher preference list');
  it.todo('routes "which crates make up the workspace" to the crates-inventory PRIMER, not the ' +
    'first crates-flavored section in file order — proves the ordered `sec` preference list, not ' +
    'just "some section matched"');
  it.todo('returns null (falls through to vector pipeline) when an archetype\'s query regex matches ' +
    'but the KB has no discovered PRIMER section satisfying any of its `sec` matchers (e.g. ' +
    '"hardware" archetype on a KB with no hardware section)');
  it.todo('returns { conceptQuery: true } (no force-route) for a "whatis" query about a concrete ' +
    'concept noun ("what is a witness chain") — isProductOverviewQuery() must say false here');
  it.todo('force-routes a "whatis" query about the product itself ("what is ruvector") to PRIMER#1 ' +
    '— isProductOverviewQuery() must say true here, the opposite branch from the case above');
});

describe.todo('forge-ask.mjs — conceptNouns() (requires exporting)', () => {
  it.todo('returns ["witness"] for "what is a witness chain" against a ruvector prodRe — proves ' +
    '"chain" is deliberately dropped via CONCEPT_STOP even though queryTerms() would otherwise ' +
    'keep it (length >= 3, not a generic STOPWORD) — the exact kind of silent behavior change a ' +
    'future CONCEPT_STOP edit could reintroduce with nothing to catch it');
});

describe.todo('forge-ask.mjs — crateOverviewTarget() (requires exporting)', () => {
  it.todo('returns the first entity crate for a metric query ("ruvector-coherence throughput") via CRATE_METRIC_RE');
  it.todo('returns the first entity crate for an overview query ("what does ruvector-coherence do") via CRATE_OVERVIEW_RE');
  it.todo('returns null when entityCrates is empty, regardless of query wording');
});

// Found live 2026-09-12 against the real release candidate: CODE_INTENT_RE's bare `implementation`
// alternative (and IMPL_INTENT_RE's independent `\bimplement(ed|ation)?\b`) fired on a document-
// naming noun phrase ("... implementation report") — not a request to see code — which then gated
// symbolRoute()'s +1.5 boost and codeDocIntent's own +0.60 source-file promotion for EVERY source
// file in the store, mass-promoting hundreds of unrelated .rs/.js files past the one document that
// actually answered the question. Fixed with a shared negative-lookahead exclusion
// (IMPLEMENTATION_DOC_NOUN) so "implementation" followed by report/summary/overview/write-up does
// not trigger either classifier, while "implement"/"implemented" and every other trigger in both
// regexes are untouched.
describe('forge-ask.mjs — codeDocIntent() / isImplIntent() — document-reference exclusion (#286)', () => {
  it('RED->GREEN: the sealed synaptic-mesh canary query no longer classifies as code/impl intent', () => {
    const q = 'In the synaptic-mesh repository, Which roles does the Synaptic Neural Mesh '
      + 'implementation report assign to QuDAG Core, ruv-FANN WASM and Neural Mesh?';
    expect(codeDocIntent(q)).toBe(null);
    expect(isImplIntent(q)).toBe(false);
  });

  it('excludes "implementation" immediately followed by a document noun, in any of the covered forms', () => {
    for (const q of [
      'implementation report', 'implementation reports', 'Implementation Summary',
      'implementation overview', 'implementation write-up', 'implementation writeup',
    ]) {
      expect(codeDocIntent(q)).toBe(null);
      expect(isImplIntent(q)).toBe(false);
    }
  });

  it('preserves genuine implementation requests that name no document noun', () => {
    expect(codeDocIntent('Explain the mesh implementation')).toBe('code');
    expect(isImplIntent('Explain the mesh implementation')).toBe(true);
    expect(isImplIntent('implement mesh')).toBe(true);
    expect(codeDocIntent('How is mesh implemented?')).toBe('code');
    expect(isImplIntent('How is mesh implemented?')).toBe(true);
    expect(codeDocIntent('What is ADR-007 implementation status?')).toBe('code');
  });

  it('preserves a mixed request whose OTHER code signal keeps firing independent of the document-noun exclusion', () => {
    // "function" (CODE_INTENT_RE) fires on its own; the "implementation report" phrase is still excluded.
    expect(codeDocIntent('Which function generates the implementation report?')).toBe('code');
    expect(isImplIntent('Which function generates the implementation report?')).toBe(false);
  });

  it('control: a real question-mark usage of the bare word stays code-intent (does not over-exclude)', () => {
    const q = 'In the metaharness repository, What does MetaHarness ADR-145 propose changing about '
      + 'the fixed SWE-bench model and Darwin genome, and what real baseline must precede implementation?';
    expect(codeDocIntent(q)).toBe('code');
    expect(isImplIntent(q)).toBe(true);
  });

  it('control: "implementation status" (not a covered document noun) stays code-intent', () => {
    const q = "What does ADR-007 decide about rvDNA v2 as a ruLake substrate, and what is its implementation status?";
    expect(codeDocIntent(q)).toBe('code');
    expect(isImplIntent(q)).toBe(true);
  });

  it('a genuinely correct collateral flip: a documentation-location query no longer gets code-intent', () => {
    // Verified against the real candidate bundle (kb/forge-ask-all.mjs searchAll): before this fix,
    // docs/README.md did not even reach the top 10 for this query and raw .ts/.js source files did;
    // after the fix, docs/README.md ranks #1 and every top-10 result is documentation-shaped.
    const q = "Where is AgentDB's documentation organized — guides, implementation reports, and ADRs?";
    expect(codeDocIntent(q)).toBe(null);
    expect(isImplIntent(q)).toBe(false);
  });
});
