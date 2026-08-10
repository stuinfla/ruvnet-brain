import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeSearchOutcome } from '../../kb/search-outcome.mjs';

/**
 * ISSUE #132 — "Searched 0 RuvNet repos ()" told a user their brain was empty when the truth was
 * that the router declined to guess. The reporter repeated that conclusion to their own user twice,
 * on a machine holding 1.5 GB across 30+ working repos.
 *
 * These assert what the message SAYS, because the defect was entirely in what it said. A source-only
 * check would pass on any wording at all.
 */
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const DECLINE = {
  repos: [],
  routing: { attempted: true, accepted: false, reason: 'card router was ambiguous (closest=ruvnet-brain overlap=2)' },
  installedRepoCount: 31,
};

describe('issue #132 — a routing decline is not an empty corpus', () => {
  it('never renders the sentence that caused the misreport', () => {
    const { header, emptyBody } = describeSearchOutcome(DECLINE);
    const message = header + emptyBody;
    expect(message, 'this exact banner is what read as "the corpus is empty"').not.toMatch(/Searched 0 RuvNet repos/);
    expect(message, 'and so did this').not.toMatch(/nothing in the corpus matched/);
  });

  it('says what actually happened, why, and how much corpus is installed', () => {
    const { declined, header } = describeSearchOutcome(DECLINE);
    expect(declined).toBe(true);
    expect(header).toMatch(/NO SEARCH WAS RUN/);
    expect(header, 'the reader needs the router\'s own reason, not a generic apology')
      .toMatch(/card router was ambiguous/);
    expect(header, 'the installed count is the fact that makes the wrong reading impossible')
      .toMatch(/31 repo store\(s\) are installed/);
  });

  it('tells the model explicitly not to repeat the false conclusion', () => {
    // The failure was a model reading a message and drawing an expensive inference. The instruction
    // is in-band for the same reason the evidence-grade caveat is.
    expect(describeSearchOutcome(DECLINE).emptyBody).toMatch(/Do NOT report to the user that the brain has no data/);
  });

  it('TEETH: a genuine empty result still reads as a genuine empty result', () => {
    // If the fix had simply deleted the old wording, the real "searched and found nothing" case
    // would have lost the message it needs — a different wrong answer, not a fix.
    const { declined, header, emptyBody } = describeSearchOutcome({
      repos: ['ruvector', 'ruflo'], routing: { attempted: true, accepted: true }, installedRepoCount: 31,
    });
    expect(declined).toBe(false);
    expect(header).toMatch(/Searched 2 RuvNet repos \(ruvector, ruflo\)/);
    expect(emptyBody).toMatch(/nothing in the corpus matched/);
  });

  it('TEETH: an install with NO stores is not reassured that its corpus is intact', () => {
    // The first version of this fix told a user with zero stores "Your corpus is intact: 0 repo
    // store(s) are installed" — reassurance that is absurd and false, and the same class of
    // confidently-wrong sentence #132 is about, pointed the other way. Found by the existing
    // token-meter suite, which runs the server against an empty KB. On a genuinely empty install the
    // original wording is the accurate one.
    const { declined, header, emptyBody } = describeSearchOutcome({ ...DECLINE, installedRepoCount: 0 });
    expect(declined).toBe(false);
    expect(header + emptyBody).not.toMatch(/corpus is intact/);
    expect(emptyBody).toMatch(/no results/);
  });

  it('TEETH: zero repos WITHOUT a decline is not labelled a decline', () => {
    // Zero repos can also mean a filter matched nothing. Claiming "the router declined" there would
    // be the same confident-wrong sentence pointed the other way.
    expect(describeSearchOutcome({ repos: [], routing: null, installedRepoCount: 31 }).declined).toBe(false);
    expect(describeSearchOutcome({ repos: [], routing: { attempted: true, accepted: true }, installedRepoCount: 3 }).declined)
      .toBe(false);
  });

  it('the server uses this module rather than keeping a second copy of the wording', () => {
    // forge-mcp-all.mjs starts a server on import, so it cannot be imported here. This is the one
    // thing that must be checked in source: that the seam is actually wired.
    const server = fs.readFileSync(path.join(ROOT, 'kb', 'forge-mcp-all.mjs'), 'utf8');
    expect(server).toMatch(/import \{ describeSearchOutcome \} from '\.\/search-outcome\.mjs'/);
    expect(server).toMatch(/describeSearchOutcome\(\{/);
    expect(server, 'a leftover inline banner would drift from the tested one')
      .not.toMatch(/`Searched \$\{repos\.length\} RuvNet repos/);
  });
});
