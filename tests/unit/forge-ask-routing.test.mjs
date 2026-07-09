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
