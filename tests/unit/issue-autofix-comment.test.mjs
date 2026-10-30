// ADR-107 reporter comments. Scratch mutants (AUTOFIX_COMMENT_UNDER_TEST=<copy>) are run against this file to prove
// that each promise (marker first, honesty, specific thanks, scrubbed notes, dedupe, safe posting) goes red when broken.
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BOT_MARKER as WATCH_MARKER, judgeIssue } from '../../scripts/issue-watch.mjs';
import { findClosingKeywords } from '../../scripts/issue-autofix-policy.mjs';

const C = await import(process.env.AUTOFIX_COMMENT_UNDER_TEST
  ? pathToFileURL(process.env.AUTOFIX_COMMENT_UNDER_TEST).href : '../../scripts/issue-autofix-comment.mjs');

const NOW = Date.parse('2026-10-29T15:00:00Z');
const SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const URL = `https://github.com/stuinfla/ruvnet-brain/commit/${SHA}`;
const ISSUE_TEXT = 'Running `npx ruvnet-brain --update` on Windows dies with ENOENT: no such file or directory, open scripts/update-paths.mjs';
const THANKS = 'Thank you for chasing down that ENOENT in scripts/update-paths.mjs on Windows, it took real digging.';
const entry = (o = {}) => ({ whatWasWrong: 'The updater joined the path with a forward slash.', whatChanged: 'It now uses path.join.', ...o });
const base = (o = {}) => ({ kind: 'fixed', issueNumber: 7, login: 'alice', thanks: THANKS, entry: entry(), version: '5.0.2', sha: SHA, commitUrl: URL,
  testPath: 'tests/unit/update-paths.test.mjs', platformCaveat: [], at: '2026-10-29T15:00:00.000Z', ...o });
const render = (o) => C.renderComment(base(o));
const throwsCode = (fn, code = 'comment-failed') => { try { fn(); } catch (e) { expect(e.name).toBe('AutofixAbort'); expect(e.code).toBe(code); expect(e.stage).toBe('S13'); return; } throw new Error('did not throw'); };
const BODIES = { fixed: () => render({ kind: 'fixed' }), shipping: () => render({ kind: 'shipping' }), findings: () => render({ kind: 'findings', entry: entry({ whatItNeeds: 'A decision on Windows path handling.' }) }),
  'not-fixed': () => render({ kind: 'not-fixed', entry: entry({ whatItNeeds: 'A person to pick the path API.' }), facts: { verified: ['root cause reproduced on macOS'], notVerified: ['Windows'] } }),
  reply: () => render({ kind: 'reply', entry: entry({ whatWasWrong: 'You asked for a Windows installer.', whatItNeeds: 'A product decision.' }) }) };

describe('re-exports', () => {
  it('BOT_MARKER and OWNER_LOGIN are issue-watch\'s own values, not copies', () => {
    expect(C.BOT_MARKER).toBe(WATCH_MARKER);
    expect(C.OWNER_LOGIN).toBe('stuinfla');
  });
});

describe('the marker comes FIRST (a missing prefix would silence the SLA page)', () => {
  const old = { createdAt: new Date(NOW - 10 * 3_600_000).toISOString() };
  for (const [kind, make] of Object.entries(BODIES)) {
    it(`${kind} starts with BOT_MARKER, does not impersonate the acknowledgment, and judgeIssue still breaches`, () => {
      const body = make();
      expect(body.startsWith(C.BOT_MARKER)).toBe(true);
      expect(body.startsWith(`${C.BOT_MARKER} acknowledgment`)).toBe(false);
      expect(judgeIssue(old, [{ author: { login: 'stuinfla' }, body }], NOW).breach).toBe(true);
    });
    it(`${kind} ends with its hidden marker`, () => expect(BODIES[kind]().trimEnd().endsWith('-->')).toBe(true));
  }
  it('guard: the same body with the marker only at the END would count as a human reply', () => {
    const wrong = `${BODIES.fixed().replace(C.BOT_MARKER, '')}\n${C.BOT_MARKER}`;
    expect(judgeIssue(old, [{ author: { login: 'stuinfla' }, body: wrong }], NOW).breach).toBe(false);
  });
});

describe('honesty about fixed / shipping / findings', () => {
  it('fixed names the version, the commit, the new test and the install verification', () => {
    const b = render({});
    expect(b).toContain('Fixed in **v5.0.2**, published to npm and GitHub and install-verified on Linux, macOS and Windows.');
    expect(b).toContain(`[abcdef0](${URL})`);
    expect(b).toContain('(`tests/unit/update-paths.test.mjs`) that fails on the old code and passes now');
    expect(b).toContain('npx ruvnet-brain@latest --update');
    expect(b).toContain('<!-- ruvnet-autofix v1 issue=7 outcome=fixed version=5.0.2 sha=' + SHA + ' -->');
  });
  it('shipping NEVER says "Fixed in" and says verification is pending', () => {
    const b = render({ kind: 'shipping' });
    expect(b).not.toMatch(/fixed in/i);
    expect(b).not.toContain('install-verified on');
    expect(b).toContain('shipping in **v5.0.2**, which is still finishing verification');
    expect(b).toContain('outcome=shipping');
  });
  it('a model-written note cannot smuggle "Fixed in" into shipping or findings, but fixed keeps its own', () => {
    const sneaky = entry({ whatChanged: 'Fixed in v9 already.', whatWasWrong: 'It was fixed in the last build.' });
    expect(render({ kind: 'shipping', entry: sneaky })).not.toMatch(/fixed in/i);
    expect(render({ kind: 'findings', entry: sneaky })).not.toMatch(/fixed in/i);
  });
  it('findings claims no fix, no version and no commit, and tells the reporter a person is flagged', () => {
    const b = BODIES.findings();
    expect(b).toContain('I dug into this rather than guess at a patch');
    expect(b).toContain('What it needs: A decision on Windows path handling.');
    expect(b).toContain('flagged it for the maintainer');
    expect(b).not.toMatch(/Fixed in|shipping in|install-verified|new test/);
    expect(b).toMatch(/outcome=findings at=2026-10-29T15:00:00\.000Z -->$/); // sync-version-ignore: the fixture's own `at` timestamp passed into renderComment
    expect(b).not.toContain('version=');
  });
  it('not-fixed claims nothing shipped, carries the machine facts, and is marked not-fixed with a timestamp', () => {
    const b = BODIES['not-fixed']();
    expect(b).toContain('it did not pass verification, so nothing was shipped');
    expect(b).toContain('**Checked:** root cause reproduced on macOS. **Not checked:** Windows.');
    expect(b).toContain('What it needs: A person to pick the path API.');
    expect(b).not.toMatch(/Fixed in|shipping in|install-verified|new test|version=/);
    expect(b).toMatch(/outcome=not-fixed at=2026-10-29T15:00:00\.000Z -->$/); // sync-version-ignore: the fixture's own `at` timestamp
    expect(render({ kind: 'not-fixed' })).not.toContain('**Checked:**'); // no facts, no facts line
  });
  it('reply changes nothing, says so, and needs no version or sha', () => {
    const b = render({ kind: 'reply', version: undefined, sha: undefined, entry: entry({ whatWasWrong: 'You asked for X.', whatChanged: '' }) });
    expect(b).toContain('nothing has been changed'); expect(b).toContain('You asked for X.');
    expect(b).not.toMatch(/Fixed in|shipping in|install-verified|version=|sha=/);
    expect(b).toMatch(/outcome=reply at=/);
  });
  it('fixed and shipping carry the facts line when facts are given', () => {
    expect(render({ facts: { verified: ['Linux install'], notVerified: [] } })).toContain('**Checked:** Linux install.');
    expect(render({ facts: { verified: [], notVerified: ['Windows'] } })).toContain('**Checked:** nothing yet. **Not checked:** Windows.');
  });
  it('findings with no whatItNeeds degrades to a plain sentence rather than "undefined"', () => expect(render({ kind: 'findings' })).not.toMatch(/undefined|null/));
  it('the test sentence is omitted when there is no test path (never claim a test that is not there)', () => expect(render({ testPath: '' })).not.toContain('new test'));
  it('a commit URL that is not a github.com commit link is not linked', () => {
    const b = render({ commitUrl: 'https://evil.example/x' });
    expect(b).not.toContain('evil.example');
    expect(b).toContain('`abcdef0`');
  });
  it('platform caveat names only platforms the evidence did NOT run on, joined in prose', () => {
    expect(render({ platformCaveat: ['windows'] })).toContain('Our tests ran on macOS and Linux; if you can confirm on Windows, that closes the loop.');
    expect(render({ platformCaveat: ['windows', 'grok', 'codex'] })).toContain('if you can confirm on Windows, Grok and Codex, that closes');
    expect(render({ platformCaveat: ['macos', 'linux'] })).not.toContain('Our tests ran on');
    expect(render({ platformCaveat: [] })).not.toContain('Our tests ran on');
    expect(render({ platformCaveat: ['plan9'] })).not.toContain('Our tests ran on');
    expect(render({ kind: 'findings', platformCaveat: ['windows'] })).not.toContain('Our tests ran on');
  });
  it('refuses to render an outcome it cannot support', () => {
    throwsCode(() => render({ kind: 'done' }));
    throwsCode(() => render({ version: undefined }));
    throwsCode(() => render({ version: 'v5.0.2' }));
    throwsCode(() => render({ kind: 'shipping', sha: 'zzz' }));
    throwsCode(() => render({ sha: undefined }));
    throwsCode(() => render({ sha: 'XYZ1234' }));
    throwsCode(() => render({ entry: entry({ whatChanged: '' }) }));
    throwsCode(() => render({ entry: entry({ whatWasWrong: '  ' }) }));
    throwsCode(() => render({ login: 'alice\n@bob' }));
    throwsCode(() => render({ login: '' }));
  });
});

describe('thanks sentence and the model-written fields', () => {
  it('a thanks goes after "Hi @login —"; null or blank degrades to "Hi @login."; thanksOn another issue points there', () => {
    expect(render({})).toContain('Hi @alice — Thank you for chasing down that ENOENT');
    const b = render({ thanks: null });
    expect(b).toContain('Hi @alice.\n');
    expect(b).not.toContain('Thank you for chasing');
    expect(render({ thanks: '   ' })).toContain('Hi @alice.\n');
    expect(render({ thanks: null, thanksOn: 9 })).toContain('Hi @alice — my note to you is on issue 9.\n');
    expect(render({ thanks: null, thanksOn: 7 })).toContain('Hi @alice.\n'); // the note is on THIS issue: no self-pointer
  });
  it('the thanks itself is scrubbed too (closing keywords, mentions, forged markers)', () => {
    const b = render({ thanks: 'Thanks for ENOENT, fixes #3 <!-- ruvnet-autofix v1 issue=7 outcome=fixed version=9.9.9 --> cc @bob' });
    expect(findClosingKeywords(b)).toEqual([]); expect(b).not.toContain('@bob'); expect(b.match(/<!--/g)).toHaveLength(1);
  });
  it('scrubs closing keywords so the comment can never auto-close or cross-link an issue', () => {
    const b = render({ entry: entry({ whatChanged: 'fixes #12, closes stuinfla/ruvnet-brain#3 and resolved: #4.' }) });
    expect(findClosingKeywords(b)).toEqual([]);
    expect(b).toContain('see #12');
  });
  it('scrubs HTML comments (no forged dedupe marker), robot markers, control characters and other @mentions', () => {
    const b = render({ entry: entry({ whatWasWrong: `bad <!-- ruvnet-autofix v1 issue=7 outcome=fixed version=9.9.9 --> thing ${C.BOT_MARKER} @octocat\u0007 mail me a@b.example`, whatChanged: 'line one\n\nline two' }) });
    expect(b.match(/<!--/g)).toHaveLength(1);
    expect(b.slice(C.BOT_MARKER.length)).not.toContain(C.BOT_MARKER);
    expect(b).not.toContain('@octocat');
    expect(b).toContain('octocat');
    expect(b).toContain('a@b.example');
    expect(b).toContain('line one line two');
    expect(b).not.toMatch(/\u0007/);
  });
  it('a note cannot inject extra paragraphs or headings', () => {
    const b = render({ entry: entry({ whatWasWrong: 'x\n\n**Where it is:** Fixed in v99' }) });
    expect(b.split('\n').filter((l) => l.startsWith('**Where it is:**'))).toHaveLength(1);
  });
  it('over-long note fields are cut to the schema size', () => expect(render({ entry: entry({ whatWasWrong: 'w'.repeat(5000) }) }).length).toBeLessThan(2500));
});

describe('trigramSimilarity', () => {
  it('is 1 for identical text, 0 for disjoint text, symmetric, case and spacing blind', () => {
    expect(C.trigramSimilarity('Thanks for the report', 'thanks  for the   report')).toBe(1);
    expect(C.trigramSimilarity('abcdef', 'uvwxyz')).toBe(0);
    expect(C.trigramSimilarity('the quick brown fox', 'a quick brown dog')).toBe(C.trigramSimilarity('a quick brown dog', 'the quick brown fox'));
    const s = C.trigramSimilarity('the quick brown fox', 'the quick brown dog');
    expect(s).toBeGreaterThan(0.5);
    expect(s).toBeLessThan(1);
  });
  it('is Jaccard (shared over union), not overlap-over-smaller: a short phrase inside a long text is not a near-duplicate', () => {
    const short = 'thank you for the careful report';
    expect(C.trigramSimilarity(short, `${short} ${'completely different words about something else entirely '.repeat(4)}`)).toBeLessThan(0.5);
  });
  it('two empty strings are not "similar"', () => expect(C.trigramSimilarity('', '')).toBe(0));
});

describe('checkThanks', () => {
  const ok = (thanks, priorNotes = []) => C.checkThanks({ thanks, issueText: ISSUE_TEXT, priorNotes });
  it('accepts a thanks naming a file path, an error string or a command from their issue', () => {
    expect(ok(THANKS)).toEqual({ ok: true, reasons: [] });
    expect(ok('Thanks for catching that ENOENT during the update, it saved the next person an evening.').ok).toBe(true);
    expect(ok('Thanks for running `npx ruvnet-brain --update` so carefully and writing down what happened.').ok).toBe(true);
    expect(ok('I appreciate you spotting "no such file or directory" and sending the exact line.').ok).toBe(true);
  });
  it('rejects generic thanks: not-specific', () => {
    for (const t of ['Thanks so much for reporting this issue, really appreciate your time!', 'Thank you for the detailed bug report.', 'Thanks for your help with the update problem on Windows.'])
      expect(ok(t)).toEqual({ ok: false, reasons: ['not-specific'] });
  });
  it('rejects a specific-looking token that is NOT in their issue (invented detail)', () => expect(ok('Thanks for tracing that crash to scripts/other-file.mjs.').reasons).toEqual(['not-specific']));
  it('a quoted phrase made only of filler does not count; a short token does not count', () => {
    expect(ok('Thanks for the "issue report" you sent.').reasons).toEqual(['not-specific']);
    expect(ok('Thanks for the .mjs hint.').reasons).toEqual(['not-specific']);
  });
  it('a quoted phrase of pure filler is not specific even when it appears verbatim in their issue', () =>
    expect(C.checkThanks({ thanks: 'Thanks for explaining "the issue" so clearly.', issueText: 'so the issue is that the updater fails.' }).reasons).toEqual(['not-specific']));
  it('empty or blank thanks: empty', () => { expect(ok('')).toEqual({ ok: false, reasons: ['empty'] }); expect(ok('   ')).toEqual({ ok: false, reasons: ['empty'] }); expect(C.checkThanks({})).toEqual({ ok: false, reasons: ['empty'] }); });
  it('too-similar to a note we already sent that person (0.5 or more), even when specific', () => {
    const prior = ['Thank you for chasing down that ENOENT in scripts/update-paths.mjs on Windows, it took real digging.'];
    expect(ok(THANKS, prior)).toEqual({ ok: false, reasons: ['too-similar'] });
    const sibling = 'Thank you for chasing down that ENOENT in scripts/update-paths.mjs on Windows, it took real work.';
    expect(C.trigramSimilarity(sibling, prior[0])).toBeGreaterThanOrEqual(0.5);
    expect(ok(sibling, prior).reasons).toEqual(['too-similar']);
  });
  it('a genuinely different note to the same person passes', () => {
    const prior = ['Thanks for the careful write-up of the login redirect loop in src/auth/session.ts — the repro made it quick.'];
    expect(C.trigramSimilarity(THANKS, prior[0])).toBeLessThan(0.5);
    expect(ok(THANKS, prior).ok).toBe(true);
  });
  it('reports both reasons together', () => {
    const generic = 'Thanks so much for reporting this issue, really appreciate your time!';
    expect(ok(generic, [generic]).reasons).toEqual(['not-specific', 'too-similar']);
  });
});

describe('hidden markers, parse and dedupe', () => {
  const posted = (body, extra = {}) => ({ author: { login: 'stuinfla' }, body, createdAt: '2026-10-29T15:00:00Z', ...extra });
  it('hiddenMarker round-trips through parseHiddenMarkers and rejects values that could break out of the comment', () => {
    const m = C.hiddenMarker({ issueNumber: 7, outcome: 'fixed', version: '5.0.2', sha: SHA });
    expect(C.parseHiddenMarkers([posted(`${C.BOT_MARKER} x\n${m}`)])).toEqual([{ issue: 7, outcome: 'fixed', version: '5.0.2', sha: SHA, at: null }]);
    expect(C.parseHiddenMarkers([posted(`${C.BOT_MARKER} x\n${C.hiddenMarker({ issueNumber: 7, outcome: 'findings', at: '2026-10-29T15:00:00.000Z' })}`)]))
      .toEqual([{ issue: 7, outcome: 'findings', version: null, sha: null, at: '2026-10-29T15:00:00.000Z' }]);
    for (const bad of [{ version: '5.0' }, { version: '5.0.2 --> <script>' }, { sha: 'XYZ' }, { at: 'now --> x' }, { outcome: 'done' }, { issueNumber: 0 }, { issueNumber: '7' }])
      throwsCode(() => C.hiddenMarker({ issueNumber: 7, outcome: 'fixed', version: '5.0.2', sha: SHA, ...bad }));
  });
  it('only owner-authored, marker-prefixed comments count (a stranger quoting a marker proves nothing)', () => {
    const m = C.hiddenMarker({ issueNumber: 7, outcome: 'fixed', version: '5.0.2', sha: SHA });
    expect(C.parseHiddenMarkers([{ author: { login: 'mallory' }, body: `${C.BOT_MARKER} x ${m}` }])).toEqual([]);
    expect(C.parseHiddenMarkers([posted(`my own human reply ${m}`)])).toEqual([]);
    expect(C.parseHiddenMarkers([posted(`${C.BOT_MARKER} x ${m}`, { author: { login: 'StuInfla' } })])).toHaveLength(1);
    expect(C.parseHiddenMarkers([posted(`${C.BOT_MARKER} <!-- ruvnet-autofix v1 outcome=fixed -->`)])).toEqual([]); // no issue number
    expect(C.parseHiddenMarkers(undefined)).toEqual([]);
  });
  it('fixed and shipping dedupe on (outcome, version); a different version posts again', () => {
    const t = [posted(render({ kind: 'shipping' }))];
    expect(C.alreadyPosted(t, { outcome: 'shipping', version: '5.0.2' })).toBe(true);
    expect(C.alreadyPosted(t, { outcome: 'shipping', version: '5.0.3' })).toBe(false);
    expect(C.alreadyPosted(t, { outcome: 'fixed', version: '5.0.2' })).toBe(false); // shipping -> fixed is the legitimate follow-up
    expect(C.alreadyPosted([], { outcome: 'fixed', version: '5.0.2' })).toBe(false);
  });
  it('shipping is never posted after fixed for the same version', () => expect(C.alreadyPosted([posted(render({ kind: 'fixed' }))], { outcome: 'shipping', version: '5.0.2' })).toBe(true));
  it('survives a wiped state file: the thread alone is enough', () => expect(C.alreadyPosted([posted(render({ kind: 'fixed' }))], { outcome: 'fixed', version: '5.0.2' })).toBe(true));
  it('findings are not repeated unless the issue changed after the last findings comment (our own label bump does not count)', () => {
    const t = [posted(BODIES.findings())]; // at = 15:00:00
    expect(C.alreadyPosted(t, { outcome: 'findings', issueUpdatedAt: '2026-10-29T14:00:00Z' })).toBe(true);
    expect(C.alreadyPosted(t, { outcome: 'findings', issueUpdatedAt: '2026-10-29T15:00:05Z' })).toBe(true); // our label edit, seconds later
    expect(C.alreadyPosted(t, { outcome: 'findings', issueUpdatedAt: '2026-10-29T15:09:00Z' })).toBe(true);
    expect(C.alreadyPosted(t, { outcome: 'findings', issueUpdatedAt: '2026-10-29T15:11:00Z' })).toBe(false); // reporter came back
    expect(C.alreadyPosted(t, { outcome: 'findings' })).toBe(true); // cannot show a change: stay quiet
    expect(C.alreadyPosted([], { outcome: 'findings', issueUpdatedAt: '2026-10-30T00:00:00Z' })).toBe(false);
  });
  it('not-fixed dedupes like findings (only a reporter update after the grace reopens it); reply is once per issue, ever', () => {
    const nf = [posted(BODIES['not-fixed']())];
    expect(C.alreadyPosted(nf, { outcome: 'not-fixed', issueUpdatedAt: '2026-10-29T15:05:00Z' })).toBe(true);
    expect(C.alreadyPosted(nf, { outcome: 'not-fixed', issueUpdatedAt: '2026-10-29T15:11:00Z' })).toBe(false);
    expect(C.alreadyPosted(nf, { outcome: 'not-fixed' })).toBe(true);
    expect(C.alreadyPosted(nf, { outcome: 'findings', issueUpdatedAt: '2026-10-29T14:00:00Z' })).toBe(false); // a different outcome
    const r = [posted(BODIES.reply())];
    expect(C.alreadyPosted(r, { outcome: 'reply' })).toBe(true);
    expect(C.alreadyPosted(r, { outcome: 'reply', issueUpdatedAt: '2030-01-01T00:00:00Z' })).toBe(true); // ever, even after updates
    expect(C.alreadyPosted([], { outcome: 'reply' })).toBe(false);
    expect(C.alreadyPosted([{ ...posted(BODIES.reply()), author: { login: 'mallory' } }], { outcome: 'reply' })).toBe(false);
  });
  it('a later findings comment moves the baseline forward', () => {
    const later = BODIES.findings().replace('at=2026-10-29T15:00:00.000Z', 'at=2026-10-30T09:00:00.000Z');
    const t = [posted(BODIES.findings()), posted(later, { createdAt: '2026-10-30T09:00:01Z' })];
    expect(C.alreadyPosted(t, { outcome: 'findings', issueUpdatedAt: '2026-10-30T09:05:00Z' })).toBe(true);
  });
});

describe('postOutcome: the only writer', () => {
  const mkCtx = (fail = {}) => {
    const calls = [];
    const exec = (cmd, args) => { calls.push([cmd, ...args]); const k = args[1]; return fail[k] ? { status: 1, stdout: '', stderr: fail[k], signal: null, timedOut: false } : { status: 0, stdout: '', stderr: '', signal: null, timedOut: false }; };
    return { ctx: { repo: 'stuinfla/ruvnet-brain', exec, ghBin: 'gh' }, calls };
  };
  it('comments, then closes with reason completed, only for a fixed body', () => {
    const { ctx, calls } = mkCtx();
    const body = render({});
    expect(C.postOutcome(ctx, { issueNumber: 7, body, close: true })).toEqual({ commented: true, closed: true, labeled: false, error: null });
    expect(calls).toEqual([['gh', 'issue', 'comment', '7', '--repo', 'stuinfla/ruvnet-brain', '--body', body],
      ['gh', 'issue', 'close', '7', '--repo', 'stuinfla/ruvnet-brain', '--reason', 'completed']]);
  });
  it('findings: comment then the autofix label, no close', () => {
    const { ctx, calls } = mkCtx();
    expect(C.postOutcome(ctx, { issueNumber: 7, body: BODIES.findings(), addLabels: ['autofix:needs-owner'] })).toMatchObject({ commented: true, labeled: true, closed: false });
    expect(calls.map((c) => c.slice(1, 3).join(' '))).toEqual(['issue comment', 'issue edit']);
    expect(calls[1]).toContain('autofix:needs-owner');
  });
  it('refuses a body without the marker FIRST, before any gh call', () => {
    const { ctx, calls } = mkCtx();
    throwsCode(() => C.postOutcome(ctx, { issueNumber: 7, body: `hello\n${C.BOT_MARKER}\n${C.hiddenMarker({ issueNumber: 7, outcome: 'fixed', version: '5.0.2', sha: SHA })}` }));
    throwsCode(() => C.postOutcome(ctx, { issueNumber: 7, body: ` ${render({})}` }));
    throwsCode(() => C.postOutcome(ctx, { issueNumber: 7, body: '' }));
    expect(calls).toEqual([]);
  });
  it('refuses closing keywords, an acknowledgment lookalike, a missing or foreign hidden marker', () => {
    const { ctx, calls } = mkCtx();
    const marker = C.hiddenMarker({ issueNumber: 7, outcome: 'fixed', version: '5.0.2', sha: SHA });
    throwsCode(() => C.postOutcome(ctx, { issueNumber: 7, body: `${C.BOT_MARKER} fix report\n\nfixes #12\n${marker}` }));
    throwsCode(() => C.postOutcome(ctx, { issueNumber: 7, body: `${C.BOT_MARKER} acknowledgment\n${marker}` }));
    throwsCode(() => C.postOutcome(ctx, { issueNumber: 7, body: `${C.BOT_MARKER} fix report\n\nno marker here` }));
    throwsCode(() => C.postOutcome(ctx, { issueNumber: 8, body: render({}) })); // marker says issue 7: wrong thread
    expect(calls).toEqual([]);
  });
  it('only a fixed comment may close; labels must be in the autofix: namespace', () => {
    const { ctx, calls } = mkCtx();
    throwsCode(() => C.postOutcome(ctx, { issueNumber: 7, body: render({ kind: 'shipping' }), close: true }));
    throwsCode(() => C.postOutcome(ctx, { issueNumber: 7, body: BODIES.findings(), close: true }));
    throwsCode(() => C.postOutcome(ctx, { issueNumber: 7, body: BODIES['not-fixed'](), close: true }));
    throwsCode(() => C.postOutcome(ctx, { issueNumber: 7, body: BODIES.reply(), close: true }));
    throwsCode(() => C.postOutcome(ctx, { issueNumber: 7, body: BODIES.findings(), addLabels: ['bug'] }));
    throwsCode(() => C.postOutcome({ ...ctx, repo: 'x; rm -rf /' }, { issueNumber: 7, body: render({}) }));
    expect(calls).toEqual([]);
  });
  it('a failed comment stops everything: no label, no close', () => {
    const { ctx, calls } = mkCtx({ comment: 'HTTP 502' });
    expect(C.postOutcome(ctx, { issueNumber: 7, body: render({}), close: true })).toEqual({ commented: false, closed: false, labeled: false, error: 'comment: HTTP 502' });
    expect(calls).toHaveLength(1);
  });
  it('a failed close after a posted comment is reported, not hidden', () => {
    const { ctx } = mkCtx({ close: 'locked' });
    expect(C.postOutcome(ctx, { issueNumber: 7, body: render({}), close: true })).toEqual({ commented: true, closed: false, labeled: false, error: 'close: locked' });
  });
  it('an exec that throws a forbidden-command abort propagates; any other throw becomes an error string', () => {
    const abort = Object.assign(new Error('x'), { name: 'AutofixAbort', code: 'forbidden-command' });
    expect(() => C.postOutcome({ repo: 'a/b', ghBin: 'gh', exec: () => { throw abort; } }, { issueNumber: 7, body: render({}) })).toThrow(abort);
    expect(C.postOutcome({ repo: 'a/b', ghBin: 'gh', exec: () => { throw new Error('spawn gh ENOENT'); } }, { issueNumber: 7, body: render({}) }).error).toContain('ENOENT');
  });
  it('uses GH_BIN when no ghBin is given', () => {
    const calls = [];
    const prev = process.env.GH_BIN; process.env.GH_BIN = '/fake/gh';
    try { C.postOutcome({ repo: 'a/b', exec: (c, a) => { calls.push(c); return { status: 0, stdout: '', stderr: '' }; } }, { issueNumber: 7, body: render({}) }); }
    finally { if (prev === undefined) delete process.env.GH_BIN; else process.env.GH_BIN = prev; }
    expect(calls).toEqual(['/fake/gh']);
  });
});
