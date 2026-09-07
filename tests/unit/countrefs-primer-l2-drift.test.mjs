// Primer admission is now exercised by primer-grounding.test.mjs against actual writes.
// Remaining L2 generation/retry behavior needs an isolated provider seam; no paid calls run here.
import { describe, it } from 'vitest';

describe.todo('build-l2.mjs grounding gate — per-topic scope + retry-then-reject (requires export, see file header)', () => {
  it.todo('accepted=true when the article cites >= 2 of the CURRENT topic\'s retrieved paths (line 54 threshold)');
  it.todo('triggers exactly one retry generation when the first attempt cites < 2 real paths (line 53), then re-evaluates the retried article\'s citations');
  it.todo('accepted=false when even the retried article still cites < 2 real paths, and the article is written under kb/l2/rejected/ instead of kb/l2/ (line 55-57)');
  it.todo('does NOT count a real, valid repo path as cited if that path was not among the CURRENT topic\'s k=8 retrieved sources — proves the grounding is scoped to retrieved evidence, not "any real path anywhere"');
});
