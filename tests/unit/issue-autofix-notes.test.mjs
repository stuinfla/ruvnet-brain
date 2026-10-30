// issue-autofix-notes.test.mjs — guards + regenerate loop for the personal thank-you notes (ADR-107).
// Owner's standing order: never a form letter. Every guard here is proven by a red case and a green twin.
import { beforeAll, describe, it, expect, vi } from 'vitest';
import {
  MAX_REGENERATIONS, WAIT_APOLOGY_DAYS, BOILERPLATE, groupByPerson, reporterWords, waitedDays, noteText,
  checkNote, generatePersonNote,
} from '../../scripts/issue-autofix-notes.mjs';

const NOW = Date.parse('2026-10-30T12:00:00Z');
const DAY = 86_400_000;
const daysAgo = (d) => new Date(NOW - d * DAY).toISOString();

const issue21 = {
  number: 21, title: 'search_ruvnet returns nothing after --update', createdAt: daysAgo(2), author: { login: 'alice' },
  body: 'After running `npx ruvnet-brain --update` the tool search_ruvnet answers with an empty list. Log shows ENOENT for kb/manifest.json.',
  comments: [
    { author: { login: 'stuinfla' }, body: 'Owner here: please try `brain-doctor --deep-scan` and paste it.', createdAt: daysAgo(1) },
    { author: { login: 'bob' }, body: 'Same here, my `vectorStore.rebuildIndex()` call crashes on "a totally separate laptop"', createdAt: daysAgo(1) },
    { author: { login: 'ALICE' }, body: 'Extra detail: it only happens with "two stores overlaid at once".', createdAt: daysAgo(1) },
  ],
};
const issue34 = {
  number: 34, title: 'Installer prints wrong version', createdAt: daysAgo(10), author: { login: 'Alice' },
  body: 'The banner says `4.7.19` but `npm view ruvnet-brain version` says the newer one.', comments: [],
};
const fixedFacts = { verified: ['new test fails before and passes after', 'install-verified on Linux, macOS and Windows'], notVerified: ['the exact setup you described'], summary: 'manifest written before index' };
const findingsFacts = { verified: [], notVerified: ['the exact setup you described'], summary: 'stale cached banner file' };
const items = [{ issue: issue21, kind: 'fixed', facts: fixedFacts }, { issue: issue34, kind: 'findings', facts: findingsFacts }];

const goodNote = () => ({
  thanks: 'Your search_ruvnet report pinned it down: the ENOENT on kb/manifest.json after --update was exactly the clue that mattered, and the follow-up about two stores overlaid at once ruled out half the suspects. The `4.7.19` banner mismatch you spotted on #34 is real too. Sorry #34 sat for ten days with no answer.',
  perIssue: [
    { number: 21, whatWasWrong: 'The update step skipped writing the manifest when two stores were overlaid, so search read an empty index.', whatChanged: 'The update now writes the manifest first; a new test fails before the change and passes after, and the install was checked on Linux, macOS and Windows.' },
    { number: 34, whatWasWrong: 'The banner reads its version from a stale cached file.', whatItNeeds: 'Nothing from you; the cause is identified but not changed yet, and the exact setup you described was not reproduced.' },
  ],
});
const check = (note, over = {}) => checkNote({ note, login: 'alice', items, priorNotes: [], now: NOW, ...over });
const withThanks = (extra) => { const n = goodNote(); n.thanks += ' ' + extra; return n; };

// A single-issue person for the simpler guards.
const issue50 = { number: 50, title: 'Doctor crashes', createdAt: daysAgo(10), author: { login: 'dana' }, comments: [],
  body: 'Running `ruvnet-brain --doctor` throws TypeError in plugin/scripts/doctor.mjs line 88.' };
const danaItems = [{ issue: issue50, kind: 'fixed', facts: { verified: ['new test fails before and passes after'], notVerified: [], summary: 'x' } }];
const danaNote = (thanks) => ({ thanks, perIssue: [{ number: 50, whatWasWrong: 'The doctor read a field that older installs never wrote.', whatChanged: 'It now checks the field exists first.' }] });
const danaCheck = (thanks, over = {}) => checkNote({ note: danaNote(thanks), login: 'dana', items: danaItems, priorNotes: [], now: NOW, ...over });

describe('helpers', () => {
  it('exports the frozen constants', () => {
    expect(MAX_REGENERATIONS).toBe(3); expect(WAIT_APOLOGY_DAYS).toBe(7);
    expect(BOILERPLATE).toContain('thanks for reporting'); expect(BOILERPLATE).toContain('we value');
  });
  it('(15) reporterWords keeps title, body and the reporter\'s own comments only', () => {
    const w = reporterWords(issue21, 'alice');
    expect(w).toContain('search_ruvnet returns nothing'); expect(w).toContain('ENOENT');
    expect(w).toContain('two stores overlaid at once');
    expect(w).not.toContain('brain-doctor'); expect(w).not.toContain('vectorStore');
    expect(reporterWords(issue21, 'stuinfla')).not.toContain('brain-doctor');
  });
  it('waitedDays counts whole days', () => {
    expect(waitedDays(issue34, NOW)).toBe(10);
    expect(waitedDays({ createdAt: new Date(NOW - 7.9 * DAY).toISOString() }, NOW)).toBe(7);
  });
  it('noteText joins every prose field', () => {
    const t = noteText(goodNote());
    expect(t).toContain('Sorry #34'); expect(t).toContain('stale cached file'); expect(t).toContain('was not reproduced');
  });
  it('(12) groupByPerson merges Alice/alice, oldest issue first, one group per person', () => {
    const bobIssue = { ...issue50, number: 60, author: { login: 'bob' }, createdAt: daysAgo(3) };
    const g = groupByPerson([items[0], { issue: bobIssue, kind: 'reply', facts: findingsFacts }, items[1]]);
    expect(g.map((x) => x.login)).toEqual(['alice', 'bob']);
    expect(g[0].items.map((i) => i.issue.number)).toEqual([34, 21]);
    expect(g[1].items).toHaveLength(1);
  });
});

describe('checkNote', () => {
  it('(13) a realistic good note for a 2-issue person passes', () => {
    expect(check(goodNote())).toEqual({ ok: true, reasons: [] });
  });
  it('structure: empty, missing-issue, extra-issue, too-short, too-long', () => {
    expect(check(null).reasons).toContain('empty');
    const n = goodNote(); n.perIssue = [n.perIssue[0], { number: 99, whatWasWrong: 'x' }];
    expect(check(n).reasons).toEqual(expect.arrayContaining(['missing-issue:34', 'extra-issue:99']));
    const blank = goodNote(); blank.perIssue[1].whatWasWrong = '  ';
    expect(check(blank).reasons).toContain('missing-issue:34');
    expect(danaCheck('Sorry, ENOENT.').reasons).toContain('too-short');
    expect(check(withThanks('Sorry. '.repeat(80))).reasons).toContain('too-long');
    const longField = goodNote(); longField.perIssue[0].whatChanged = 'a'.repeat(601);
    expect(check(longField).reasons).toContain('too-long');
  });
  it('(4) a note that would fit any issue is rejected', () => {
    const anyIssue = 'Thanks for the search_ruvnet note. Reports like this make the project better for everyone. Every contribution matters to the community. Clear write-ups help us improve. Sorry for the wait.';
    const r = check({ ...goodNote(), thanks: anyIssue }).reasons;
    expect(r).toContain('generic'); expect(r).not.toContain('not-specific');
    const r2 = check({ ...goodNote(), thanks: 'Thank you so much for this report, it really helps the project and everyone who uses it. Sorry it took a while.' }).reasons;
    expect(r2).toEqual(expect.arrayContaining(['generic', 'not-specific']));
  });
  it('boilerplate phrases are rejected, case-insensitively', () => {
    for (const p of ['Thanks for reporting this.', 'GREAT CATCH there.', 'Let me know if it recurs.', 'We value this.']) {
      expect(check(withThanks(p)).reasons).toContain('boilerplate');
    }
  });
  it('(5) 10-day wait needs a plain apology; "Sorry this sat for ten days" passes', () => {
    const base = 'Your trace of the TypeError in plugin/scripts/doctor.mjs made the bad field obvious within minutes of reading it.';
    expect(danaCheck(base).reasons).toEqual(['no-apology']);
    expect(danaCheck(base + ' Sorry this sat for ten days.')).toEqual({ ok: true, reasons: [] });
    const fresh = { ...issue50, createdAt: daysAgo(WAIT_APOLOGY_DAYS) };
    expect(checkNote({ note: danaNote(base), login: 'dana', items: [{ ...danaItems[0], issue: fresh }], priorNotes: [], now: NOW }).ok).toBe(true);
  });
  it('(6) quoting only another commenter\'s or the owner\'s words is not-specific', () => {
    const n = { ...goodNote(), thanks: 'Your point about `vectorStore.rebuildIndex()` crashing on a totally separate laptop, and the brain-doctor --deep-scan output, sent us the right way. Sorry for the ten-day wait on the banner.' };
    expect(check(n).reasons).toContain('not-specific');
  });
  it('a quoted reporter phrase and a long verbatim run count as specific', () => {
    const quoted = 'Sorry for the slow reply. The detail that it only bites with two stores overlaid at once is what made it reproducible here, hours earlier than otherwise.';
    expect(check({ ...goodNote(), thanks: quoted }).reasons).not.toContain('not-specific');
    const plain = { number: 70, title: 'Hangs', createdAt: daysAgo(1), author: { login: 'erin' }, comments: [], body: 'The installer hangs forever on my old laptop whenever the wifi drops.' };
    const r = checkNote({ note: { thanks: 'You noticed the installer hangs forever on my old laptop pattern only when the network blinks, which is a sharp observation to make.', perIssue: [{ number: 70, whatWasWrong: 'w' }] }, login: 'erin', items: [{ issue: plain, kind: 'reply', facts: findingsFacts }], priorNotes: [], now: NOW });
    expect(r.reasons).not.toContain('not-specific');
  });
  it('(7) @mentions other than the person are rejected; their own and backticked packages are fine', () => {
    expect(check(withThanks('Also @someoneelse saw it.')).reasons).toContain('mentions-other');
    expect(check(withThanks('Thanks @Alice, and `@types/node` was fine. Mail me at a@b.co'))).toEqual({ ok: true, reasons: [] });
    expect(check(withThanks('Running `npm i -D @types/node` changed nothing here.'))).toEqual({ ok: true, reasons: [] });
  });
  it('(8) closing keywords with an issue reference are rejected', () => {
    for (const s of ['This fixes #12.', 'Closes: owner/repo#3', 'resolved https://github.com/o/r/issues/9']) {
      expect(check(withThanks(s)).reasons).toContain('closing-keyword');
    }
    expect(check(withThanks('The fix for the banner is still open.')).reasons).not.toContain('closing-keyword');
  });
  it('marker and HTML comments are rejected', () => {
    expect(check(withThanks('🤖 Automated')).reasons).toContain('marker');
    expect(check(withThanks('<!-- hidden -->')).reasons).toContain('marker');
  });
  it('(9) local paths and token-shaped strings are rejected', () => {
    expect(check(withThanks('It read /Users/stuart/.npmrc first.')).reasons).toContain('path-leak');
    for (const p of ['/home/bob/x', 'C:\\Users\\bob', '~/.claude', '/private/var/folders', '/tmp/x']) {
      expect(check(withThanks(`See ${p} there.`)).reasons).toContain('path-leak');
    }
    expect(check(withThanks('ghp_' + 'a1B2'.repeat(9))).reasons).toContain('secret');
    for (const s of ['sk-ant-api03-EXAMPLEabcdefghijklmnop', 'AKIAABCDEFGHIJKLMNOP', '-----BEGIN RSA PRIVATE KEY-----', 'npm_' + 'x'.repeat(36), 'github_pat_' + 'Z'.repeat(30)]) {
      expect(check(withThanks(s)).reasons).toContain('secret');
    }
  });
  it('(10) model internals are rejected; the reporter\'s own backticked command is not', () => {
    expect(check(withThanks('Claude found the cause.')).reasons).toContain('model-internals');
    for (const s of ['The prompt said so.', 'Our autofix ran.', 'As an AI I checked.', 'GPT-5 agreed.', 'the bot noticed']) {
      expect(check(withThanks(s)).reasons).toContain('model-internals');
    }
    const iss = { ...issue50, body: issue50.body + ' I ran `claude mcp add brain` first.' };
    const ok = checkNote({ note: danaNote('Your TypeError trace in plugin/scripts/doctor.mjs right after `claude mcp add brain` made it plain. Sorry this sat ten days.'), login: 'dana', items: [{ ...danaItems[0], issue: iss }], priorNotes: [], now: NOW });
    expect(ok).toEqual({ ok: true, reasons: [] });
  });
  it('(11) overclaims: findings said fixed, or a platform that was not verified', () => {
    const n = goodNote(); n.perIssue[1].whatItNeeds = 'Nothing; this is fixed in the next release.';
    expect(check(n).reasons).toContain('overclaim:34');
    const thanksClaim = withThanks('#34 is live now.');
    expect(check(thanksClaim).reasons).toContain('overclaim:34');
    const neg = goodNote(); neg.perIssue[1].whatItNeeds = 'It is not fixed yet, and will be once it is released.';
    expect(check(neg).reasons).not.toContain('overclaim:34');
    const plat = (verified, text) => checkNote({ note: danaNote('Your TypeError trace in plugin/scripts/doctor.mjs pointed straight at the bad field. Sorry it sat ten days. ' + text), login: 'dana', items: [{ ...danaItems[0], facts: { verified, notVerified: [], summary: '' } }], priorNotes: [], now: NOW });
    expect(plat(['macOS and Linux tests'], 'It was verified on Windows.').reasons).toContain('overclaim:50');
    expect(plat(['macOS and Linux tests'], 'It was verified on macOS.').ok).toBe(true);
    expect(plat(['macOS and Linux tests'], 'It was not tested on Windows.').ok).toBe(true);
    expect(plat(['Windows host scenario'], 'Tested on Windows.').ok).toBe(true);
  });
  it('(1)(14) similarity to any earlier note, any person', () => {
    const same = [{ login: 'bob', text: noteText(goodNote()), at: daysAgo(3) }];
    const r = check(goodNote(), { priorNotes: same }).reasons;
    expect(r.filter((x) => x.startsWith('too-similar:')).sort()).toEqual(['too-similar:closing', 'too-similar:ngram', 'too-similar:opening', 'too-similar:trigram']);
    const opening = [{ login: 'bob', text: 'Your `search_ruvnet` report pinned something else entirely about bananas and weather.', at: daysAgo(3) }];
    expect(check(goodNote(), { priorNotes: opening }).reasons).toEqual(['too-similar:opening']);
    const closing = [{ login: 'carol', text: 'Something wholly unrelated about weather and gardens, you described was not reproduced.', at: daysAgo(3) }];
    expect(check(goodNote(), { priorNotes: closing }).reasons).toEqual(['too-similar:closing']);
    const ngram = [{ login: 'carol', text: 'Bananas grow tall. The update step skipped writing the manifest yesterday. Gardens.', at: daysAgo(3) }];
    expect(check(goodNote(), { priorNotes: ngram }).reasons).toEqual(['too-similar:ngram']);
    const near = noteText(goodNote()).replace(/\b(\w+) (\w+) (\w+) (\w+) (\w+)\b/g, '$1 $2 $3 $4 X$5');
    expect(check(goodNote(), { priorNotes: [{ login: 'z', text: near, at: daysAgo(1) }] }).reasons).toContain('too-similar:trigram');
  });
});

describe('generatePersonNote', () => {
  const BOILER = { thanks: 'Thanks for reporting this! We appreciate your feedback.', perIssue: goodNote().perIssue };
  it('(1) the same note for two different people: the second is rejected as too similar', async () => {
    const gen = vi.fn(async () => goodNote());
    const first = await generatePersonNote({ login: 'alice', items, priorNotes: [], now: NOW, generate: gen });
    expect(first.ok).toBe(true);
    const prior = [{ login: 'alice', text: noteText(first.note), at: new Date(NOW).toISOString() }];
    const second = await generatePersonNote({ login: 'alice2', items: items.map((i) => ({ ...i, issue: { ...i.issue, author: { login: 'alice2' } } })), priorNotes: prior, now: NOW, generate: gen });
    expect(second.ok).toBe(false);
    expect(second.rejections.every((r) => r.some((x) => x.startsWith('too-similar:')))).toBe(true);
  });
  it('(2) pure boilerplate every time: 4 calls, feedback on calls 2-4, then refused', async () => {
    const gen = vi.fn(async () => BOILER);
    const res = await generatePersonNote({ login: 'alice', items, priorNotes: [], now: NOW, generate: gen });
    expect(res.ok).toBe(false); expect(res.note).toBeNull();
    expect(gen).toHaveBeenCalledTimes(1 + MAX_REGENERATIONS); expect(res.attempts).toBe(4);
    expect(res.rejections).toHaveLength(4);
    expect(res.rejections[0]).toEqual(expect.arrayContaining(['boilerplate', 'not-specific', 'generic']));
    expect(gen.mock.calls[0][0]).toEqual({ attempt: 0, feedback: [] });
    for (const k of [1, 2, 3]) {
      const { attempt, feedback } = gen.mock.calls[k][0];
      expect(attempt).toBe(k); expect(feedback.length).toBeGreaterThan(0);
      expect(feedback.every((f) => typeof f === 'string' && f.length > 10)).toBe(true);
    }
    expect(gen.mock.calls[1][0].feedback.join(' ')).toMatch(/search_ruvnet|ENOENT|kb\/manifest\.json/);
    expect(gen.mock.calls[1][0].feedback.join(' ')).not.toMatch(/vectorStore|deep-scan/);
  });
  it('(3) boilerplate first, then specific and distinct: ok on attempt 2', async () => {
    const gen = vi.fn().mockResolvedValueOnce(BOILER).mockResolvedValueOnce(goodNote());
    const res = await generatePersonNote({ login: 'alice', items, priorNotes: [], now: NOW, generate: gen });
    expect(res).toMatchObject({ ok: true, attempts: 2 }); expect(res.note).toEqual(goodNote());
    expect(res.rejections).toHaveLength(1);
  });
  it('a throwing or null generate counts as generate-failed; max is honoured', async () => {
    const gen = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(null);
    const res = await generatePersonNote({ login: 'alice', items, priorNotes: [], now: NOW, generate: gen, max: 1 });
    expect(res).toMatchObject({ ok: false, attempts: 2, note: null, rejections: [['generate-failed'], ['generate-failed']] });
    expect(gen.mock.calls[1][0].feedback.length).toBeGreaterThan(0);
  });
});

describe('truthful notes are not rejected as overclaims (real drafts, rehearsal 2026-10-30)', () => {
  const issue = { number: 500, title: 'Fleet scan counts nested metadata directory as another project', author: { login: 'Obi' }, createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), comments: [],
    body: 'findMemoryStores pushes { project: dir, db: resolved }; my fixture got "2 distinct real project paths, 1 unique canonical DB path" and 2,774 rows counted twice for 7,306.' };
  const item = { issue, kind: 'not-fixed', facts: { verified: [], notVerified: ['a fix that passes every check'] } };
  const entry = { number: 500, whatWasWrong: 'That resolver walks up to the Git root, so line 1948 pushes { project: dir, db: resolved } and keeps the nested directory instead of resolved.projectRoot.', whatItNeeds: 'The fix I tried didn\'t pass verification, so it has not shipped. It needs to carry the resolved project root.' };
  let N;
  beforeAll(async () => { N = await import('../../scripts/issue-autofix-notes.mjs'); });
  const check = (thanks, e = entry) => N.checkNote({ note: { thanks, perIssue: [e] }, login: 'Obi', items: [item], priorNotes: [], now: Date.now() }).reasons;
  it('"nothing has shipped yet" and quoted code are truthful', () => {
    expect(check('Your fixture made this easy to follow: getting "2 distinct real project paths, 1 unique canonical DB path" isolates the defect cleanly. I tried a fix and it did not get through verification, so nothing has shipped yet.')).not.toContain('overclaim:500');
  });
  it('a real overclaim on a not-fixed issue is still caught', () => {
    expect(check('Your fixture with "2 distinct real project paths, 1 unique canonical DB path" was perfect, and this is fixed now in the latest release.')).toContain('overclaim:500');
    expect(check('Your fixture with "2 distinct real project paths, 1 unique canonical DB path" was perfect.', { ...entry, whatItNeeds: 'Nothing; it shipped this morning.' })).toContain('overclaim:500');
  });
});

