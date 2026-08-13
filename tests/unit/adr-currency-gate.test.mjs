import { describe, expect, it } from 'vitest';
import { refusalText, staleGovernorsOf } from '../../plugin/scripts/adr-currency-gate.mjs';

/**
 * THE GATE MOVED FROM THE LAST MOMENT TO THE FIRST.
 *
 * 2026-08-13: three commits touched code governed by ADR-055, 065, 066 and 067, and left all four
 * describing a world the code had left. The pre-push gate caught it — correctly, and it is a good
 * gate — but only after the files were written, after three commits, after I had moved on. My own
 * words for the reconciliation were "real work I skipped", and the owner quoted that line back as
 * the exhibit for a broader complaint: that the right thing only ever happens because a hook forces
 * it at the last second.
 *
 * He is right about the shape. A gate at the end cannot influence the work; it can only penalise it
 * afterwards, and it trains running at the wall and letting it sort you out. So this one fires on
 * the edit and refuses DEBT rather than change — you may edit governed code, but not while a
 * document governing it is still unreconciled from the previous round.
 *
 * EVERY CASE HERE IS INJECTED, AND THAT IS LOAD-BEARING. The first mutation run of this module
 * reported "STALE ADR -> DID NOT FIRE" while all three allow-cases passed, because `fs.readFileSync`
 * was hardcoded where the test needed a seam: the read threw on the fixture path, the loop
 * `continue`d, and no candidate was ever found. A suite of only allow-cases would have shipped a
 * green, unfireable guard — the fourth instance of that class in one day.
 */
const DOC = 'docs/adr/0099-fake.md';
const read = () => '---\nid: ADR-099\n---\n';
const mod = (drift, governs = ['plugin/scripts/foo.mjs']) => ({
  DEFAULT_DIRS: ['docs/adr'],
  isGitRepo: () => true,
  listDocs: () => [DOC],
  parseFrontmatter: () => ({ keys: { id: 'ADR-099', governs } }),
  evaluateDoc: () => ({ drift: { state: drift, why: 'code moved 3 commits after the doc' } }),
});
const run = (file, m) => staleGovernorsOf(file, { readFile: read, docCurrency: m });

describe('it refuses debt, at the moment the debt would grow', () => {
  it('TEETH: a STALE governing document refuses the edit, and names itself', async () => {
    const stale = await run('plugin/scripts/foo.mjs', mod('presumed-stale'));
    expect(stale, 'the guard must fire on the broken shape').toHaveLength(1);
    expect(stale[0].id).toBe('ADR-099');
  });

  it('a CURRENT governing document allows freely', async () => {
    // Without this the "fix" is "always refuse", which is how a gate gets disabled inside a week —
    // and a disabled gate protects nothing, which is worse than the debt it was stopping.
    expect(await run('plugin/scripts/foo.mjs', mod('current'))).toEqual([]);
  });

  it('a file no document governs is never touched, even with a stale ADR present', async () => {
    expect(await run('plugin/scripts/unrelated.mjs', mod('presumed-stale'))).toEqual([]);
  });

  it('`lagging` is not `presumed-stale` — only the state that means nobody checked', async () => {
    // doc-currency distinguishes movement that is merely recent from movement nobody reconciled.
    // Collapsing them would make this fire constantly and become noise.
    expect(await run('plugin/scripts/foo.mjs', mod('lagging'))).toEqual([]);
  });

  it('a directory prefix in `governs` covers files beneath it', async () => {
    const m = mod('presumed-stale', ['plugin/scripts']);
    expect(await run('plugin/scripts/deep/thing.mjs', m)).toHaveLength(1);
    // …and does NOT swallow a sibling directory that merely shares a prefix string.
    expect(await run('plugin/scripts-other/thing.mjs', m)).toEqual([]);
  });
});

describe('it fails OPEN, because a gate that invents a reason is worse than none', () => {
  it('TEETH: not a git repo → allow, silently', async () => {
    // A sibling hook reviewed the same day turned a missing `sqlite3` into a confident claim that
    // the memory store was corrupt. Anything this cannot positively determine must allow.
    expect(await run('plugin/scripts/foo.mjs', { ...mod('presumed-stale'), isGitRepo: () => false })).toEqual([]);
  });

  it('a document whose frontmatter has no `governs` is skipped, not guessed at', async () => {
    const m = { ...mod('presumed-stale'), parseFrontmatter: () => ({ keys: { id: 'ADR-099' } }) };
    expect(await run('plugin/scripts/foo.mjs', m)).toEqual([]);
  });

  it('an evaluation that throws does not block the edit', async () => {
    const m = { ...mod('presumed-stale'), evaluateDoc: () => { throw new Error('git unavailable'); } };
    expect(await run('plugin/scripts/foo.mjs', m)).toEqual([]);
  });
});

describe('the refusal is actionable', () => {
  it('names the document, the fix, and what no script may write', async () => {
    // A wall that reports a problem without the remedy is one people route around — the console
    // learner card (#136) shipped exactly that failure and the owner called it unconscionable.
    const t = refusalText('plugin/scripts/foo.mjs', [{ id: 'ADR-099', doc: DOC }]);
    expect(t).toContain('ADR-099');
    expect(t).toContain('Currency-log row');
    expect(t).toMatch(/doc-currency\.mjs --fix/);
    expect(t, 'the human keeps the claims a script must never make').toMatch(/no script may write it/);
  });
});
