// ADR-107: the autofix job across interruptions and over several nights, against fakes only (see
// issue-autofix-simulate.test.mjs for the harness). Kill switch at every boundary, a network drop mid-release and the
// next run resuming it without a second push/PR/dispatch, red after main moved (halt) and the follow-up that still
// runs while halted, and the personal-note guards driven through the real orchestrator with a fake model.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BOT_MARKER } from '../../scripts/issue-watch.mjs';
import { readNs } from '../../scripts/issue-autofix-state.mjs';
import { CANNED, HOURS, NOW, adoptEnv, bobIssue, humanIssue, makeWorld } from '../fixtures/issue-autofix/harness.mjs';

const T = 240_000;
let w; let restore; let mainBefore;
const issue = (n = 7) => w.ghState().issues.find((i) => i.number === n);
const comments = (n = 7) => issue(n).comments;
const rec = (n = 7) => readNs(w.paths.state)[n] || {};
const count = (re) => w.ghCalls().filter((c) => re.test(c.argv.join(' '))).length;
const pushedMain = (cmds) => cmds.some((c) => /push origin [0-9a-f]{40}:refs\/heads\/main/.test(c));

function setup(opts) { w = makeWorld(opts); restore = adoptEnv(w); mainBefore = w.originRef('refs/heads/main'); }
afterEach(() => { restore?.(); w?.cleanup(); w = null; });

describe('kill switch and lock', () => {
  it.each([
    ['variable unset', { variable: null }, null],
    ['variable off', { variable: 'off' }, null],
    ['variable "ON" (not exactly on)', { variable: 'ON' }, null],
    ['gh unreachable (unreadable counts as off)', { offline: true }, null],
    ['local off file', {}, 'offFile'],
  ])('%s: zero spawns, zero writes, exit 0', async (_n, gh, file) => {
    setup({ gh });
    if (file) { fs.mkdirSync(path.dirname(w.paths[file]), { recursive: true }); fs.writeFileSync(w.paths[file], ''); }
    const { receipt, commands } = await w.run();
    expect(receipt).toMatchObject({ status: 'disabled', exitCode: 0 });
    expect(w.claudeCalls()).toHaveLength(0);
    expect(commands.filter((c) => /^git /.test(c))).toHaveLength(0);
    expect(fs.existsSync(w.paths.clone)).toBe(false);
  }, T);

  it('flipped off during the build: the job stops at the next boundary, nothing is pushed or posted', async () => {
    setup({ script: { flipVariable: true } });
    const { receipt, commands } = await w.run();
    expect(receipt).toMatchObject({ status: 'disabled', exitCode: 0, abort: { code: 'kill-switch-off' } });
    expect(w.claudeCalls().map((c) => c.stage)).toEqual(['plan', 'build']);
    expect(commands.some((c) => /push origin/.test(c))).toBe(false);
    expect(comments()).toHaveLength(0);
    expect(rec().failCount).toBe(0);
  }, T);

  it('flipped off while the PR checks run: the branch is pushed, main is not; re-armed, the next run finishes it', async () => {
    setup({ gh: { flipVariableOnPrChecks: true } });
    const first = await w.run();
    expect(first.receipt).toMatchObject({ status: 'paused', exitCode: 0 });
    expect(pushedMain(first.commands)).toBe(false);
    expect(w.originRef('refs/heads/main')).toBe(mainBefore);
    expect(readNs(w.paths.state)._release).toMatchObject({ phase: 'paused', version: '9.9.10' });
    w.setGh({ variable: 'on', flipVariableOnPrChecks: false });
    const second = await w.run({ now: NOW + 2 * HOURS });
    expect(second.receipt.status).toBe('shipped');
    expect(count(/^pr create/)).toBe(1); // the PR from the first run is reused
    expect(count(/^workflow run/)).toBe(1);
    expect(issue().state).toBe('CLOSED');
  }, T);

  it('a live lock holder: exit 75, no spawn, no write; a dead holder is taken over and released', async () => {
    setup();
    fs.writeFileSync(w.paths.lock, JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString(), mode: 'supervised' }));
    expect((await w.run()).receipt).toMatchObject({ status: 'stood-down', exitCode: 75, abort: { code: 'lock-held' } });
    expect(w.claudeCalls()).toHaveLength(0);
    fs.writeFileSync(w.paths.lock, JSON.stringify({ pid: 2 ** 22 + 77, startedAt: new Date().toISOString(), mode: 'autofix' }));
    w.setGh({ issues: [] });
    expect((await w.run()).receipt.status).toBe('nothing-eligible');
    expect(fs.existsSync(w.paths.lock)).toBe(false);
  }, T);
});

describe('an unstable connection: resumable, never doubled', () => {
  it('the network drops after the PR checks: paused before main; the next run pushes main once, dispatches once, comments once', async () => {
    setup({ gh: { dropAfterPrChecks: true } });
    const first = await w.run();
    expect(first.receipt.status).toBe('paused');
    expect(pushedMain(first.commands)).toBe(false);
    expect(w.pages.at(-1)).toMatchObject({ title: 'AUTOFIX PAUSED v9.9.10 at S10' }); // the kill-switch re-read is the first call to fail
    w.setGh({ offline: false, dropAfterPrChecks: false });
    const second = await w.run({ now: NOW + 3 * HOURS });
    expect(second.receipt.status).toBe('shipped');
    expect(second.commands.filter((c) => /push origin release\//.test(c))).toHaveLength(0); // already on the remote at that SHA
    expect(w.claudeCalls().filter((c) => c.stage === 'plan')).toHaveLength(1); // the fix is not redone
    expect(count(/^pr create/)).toBe(1);
    expect(count(/^workflow run/)).toBe(1);
    expect(comments()).toHaveLength(1);
    const third = await w.run({ now: NOW + 26 * HOURS });
    expect(count(/^workflow run/)).toBe(1);
    expect(comments()).toHaveLength(1);
    expect(third.receipt.status).not.toBe('shipped');
  }, T);

  it('main moved, then the connection died before the dispatch: no halt; the resume dispatches exactly once', async () => {
    setup();
    // the dispatch call is the first to hit the dead connection
    w.setGh({ offlineOn: 'workflow run' });
    const first = await w.run();
    expect(first.receipt.status).toBe('paused');
    expect(first.receipt.exitCode).toBe(1); // main is ahead of npm: the watchdog must see it
    expect(w.originRef('refs/heads/main')).not.toBe(mainBefore);
    expect(fs.existsSync(w.paths.haltFile)).toBe(false);
    expect(w.pages.at(-1)).toMatchObject({ title: 'AUTOFIX PAUSED v9.9.10 at S11', priority: 'urgent' });
    w.setGh({ offlineOn: null, offline: false });
    const second = await w.run({ now: NOW + HOURS });
    expect(second.receipt.status).toBe('shipped');
    expect(count(/^workflow run/)).toBe(2); // one refused by the dead connection, one that ran
    expect(w.ghState().releaseRuns).toHaveLength(1);
  }, T);
});

describe('red after main moved: halt, and the follow-up that still runs while halted', () => {
  it('a red protected-release halts, pages URGENT, says nothing public; the next run only follows up', async () => {
    setup({ gh: { releaseOutcome: 'failure', publishOnRelease: false } });
    const { receipt } = await w.run();
    expect(receipt).toMatchObject({ status: 'halted', exitCode: 1 });
    expect(JSON.parse(fs.readFileSync(w.paths.haltFile, 'utf8'))).toMatchObject({ stage: 'S11', code: 'release-failed', version: '9.9.10' });
    expect(w.pages.at(-1)).toMatchObject({ title: 'AUTOFIX HALTED v9.9.10 at S11', priority: 'urgent' });
    expect(comments()).toHaveLength(0);
    const spawned = w.claudeCalls().length;
    const second = await w.run({ now: NOW + 24 * HOURS });
    expect(second.receipt).toMatchObject({ status: 'halted', exitCode: 0 });
    expect(w.claudeCalls()).toHaveLength(spawned);
    expect(fs.existsSync(w.paths.haltFile)).toBe(true);
  }, T);

  it('published but not install-verified: one recovery dispatch, an honest "shipping" comment, halt; once verified, the halted job still says "fixed" and closes', async () => {
    setup({ gh: { releaseOutcome: 'failure', publishOnRelease: true } });
    const { receipt } = await w.run();
    expect(receipt.release).toMatchObject({ phase: 'published-unverified', recoveryDispatched: true });
    expect(w.ghState().dispatches).toHaveLength(1);
    expect(comments()[0].body).toMatch(/shipping in \*\*v9\.9\.10\*\*/);
    expect(comments()[0].body).not.toMatch(/Fixed in/);
    expect(rec().awaitingVerification).toMatchObject({ version: '9.9.10' });
    expect(fs.existsSync(w.paths.haltFile)).toBe(true);
    // the recovery rail verified it overnight; the halt file is still there
    const st = w.ghState(); st.releaseRuns[0].conclusion = 'success'; fs.writeFileSync(w.files.state, JSON.stringify(st));
    const next = await w.run({ now: NOW + 24 * HOURS });
    expect(next.receipt.status).toBe('halted');
    expect(next.receipt.followUp).toEqual([expect.objectContaining({ number: 7, outcome: 'fixed' })]);
    expect(comments()).toHaveLength(2);
    expect(comments()[1].body).toMatch(/Fixed in \*\*v9\.9\.10\*\*/);
    expect(issue().state).toBe('CLOSED');
    expect(rec().awaitingVerification).toBeUndefined();
    expect(w.ghState().dispatches).toHaveLength(1); // the recovery rail was asked once, ever
  }, T);
});

describe('personal notes: never a form letter', () => {
  it('a fake model that writes the SAME note for two people: the second is rejected and regenerated', async () => {
    const same = { ...CANNED.notes.alice, perIssue: undefined };
    const forBoth = (n) => ({ thanks: same.thanks.replace('`Hello, World!`', n === 8 ? "`titleCase('HELLO world')`" : '`Hello, World!`'), perIssue: [{ ...CANNED.notes[n === 7 ? 'alice' : 'bob'].perIssue[0] }] });
    setup({ issues: [humanIssue(), bobIssue()], script: { noteSeq: [forBoth(7), forBoth(8), CANNED.notes.bob] } });
    await w.run();
    const notes = w.claudeCalls().filter((c) => c.stage === 'note');
    expect(notes.map((c) => c.login)).toEqual(['alice', 'bob', 'bob']);
    expect(notes[2].prompt).toMatch(/YOUR PREVIOUS DRAFT WAS REJECTED/);
    expect(comments(8)[0].body).toContain(CANNED.notes.bob.thanks);
    expect(comments(8)[0].body).not.toContain('made the cause plain within a minute');
  }, T);

  it('boilerplate on every attempt: four attempts, then no thanks at all and the owner is paged', async () => {
    const form = { thanks: 'Thanks for reporting this! We appreciate your feedback and hope this helps.', perIssue: CANNED.notes.alice.perIssue };
    setup({ script: { noteSeq: [form] } });
    await w.run();
    expect(w.claudeCalls().filter((c) => c.stage === 'note')).toHaveLength(4);
    expect(comments()[0].body).toMatch(/^Hi @alice\.$/m);
    expect(comments()[0].body).not.toMatch(/appreciate|hope this helps/i);
    expect(w.pages.map((p) => p.title)).toContain('AUTOFIX NEEDS OWNER: write a personal thank-you to @alice');
  }, T);

  it('one note per person per night, covering all of that person\'s issues', async () => {
    const two = { thanks: 'Both of your reports, `Hello, World!` turning into `hello,-world!` and the shouted `HELLO world`, came with the exact input, which made each of them quick to pin down.',
      perIssue: [CANNED.notes.alice.perIssue[0], { ...CANNED.notes.bob.perIssue[0] }] };
    setup({ issues: [humanIssue(), bobIssue({ author: { login: 'alice' } })], script: { notes: { alice: two } } });
    await w.run();
    expect(w.claudeCalls().filter((c) => c.stage === 'note')).toHaveLength(1);
    expect(comments(7)[0].body).toContain(two.thanks);
    expect(comments(8)[0].body).toMatch(/^Hi @alice — my note to you is on issue 7\.$/m);
  }, T);

  it('someone who waited ten days gets a plain apology, or no note', async () => {
    const old = humanIssue({ createdAt: new Date(NOW - 10 * 24 * HOURS).toISOString(), updatedAt: new Date(NOW - 10 * 24 * HOURS).toISOString() });
    setup({ issues: [old], script: { noteSeq: [CANNED.notes.alice, { ...CANNED.notes.alice, thanks: `Sorry this sat for ten days. ${CANNED.notes.alice.thanks}` }] } });
    await w.run();
    expect(w.claudeCalls().filter((c) => c.stage === 'note')).toHaveLength(2);
    expect(comments()[0].body).toMatch(/Hi @alice — Sorry this sat for ten days\./);
  }, T);
});

describe('findings, replies, and what is never said', () => {
  const unfixable = { plan: { ...CANNED.plan, classification: 'needs-owner', risk: 'medium', whatItNeeds: 'a decision on whether slugs keep unicode letters' } };
  const withNote = (n, extra = {}) => ({ notes: { alice: { thanks: CANNED.notes.alice.thanks, perIssue: [{ number: n, whatWasWrong: 'slugify only collapses whitespace.', whatItNeeds: 'a decision on unicode letters.', ...extra }] } } });

  it('unfixable with a root cause: one findings comment and the label; a re-run and a wiped state file add nothing', async () => {
    setup({ script: { ...unfixable, ...withNote(7) } });
    expect((await w.run()).receipt.status).toBe('replied');
    expect(comments()).toHaveLength(1);
    expect(comments()[0].body.startsWith(`${BOT_MARKER} findings`)).toBe(true);
    expect(issue().labels.map((l) => l.name)).toContain('autofix:needs-owner');
    await w.run({ now: NOW + 24 * HOURS });
    fs.rmSync(w.paths.state);
    const st = w.ghState(); st.issues[0].labels = []; fs.writeFileSync(w.files.state, JSON.stringify(st));
    await w.run({ now: NOW + 25 * HOURS });
    expect(comments()).toHaveLength(1);
  }, T);

  it('a design or question label gets a personal reply once, never a fix', async () => {
    setup({ issues: [humanIssue({ labels: [{ name: 'enhancement' }] })], script: withNote(7) });
    await w.run();
    expect(w.claudeCalls().map((c) => c.stage)).toEqual(['note']);
    expect(comments()[0].body).toMatch(new RegExp(`^${BOT_MARKER} note — RuvNet Brain`));
    expect(comments()[0].body).toContain("This needs the maintainer's call");
    await w.run({ now: NOW + 24 * HOURS });
    expect(comments()).toHaveLength(1);
  }, T);
});

describe('stand-down, daily cap, dry run', () => {
  it('one release a day: an issue filed after the night shipped waits for tomorrow', async () => {
    setup();
    expect((await w.run()).receipt.status).toBe('shipped');
    w.setGh({ issues: [...w.ghState().issues, bobIssue()] });
    const second = await w.run({ now: NOW + HOURS });
    expect(second.receipt).toMatchObject({ status: 'stood-down', exitCode: 0, abort: { code: 'daily-cap' } });
    expect(w.pages.filter((p) => /STANDING DOWN/.test(p.title))).toHaveLength(0);
  }, T);

  it('stands down, with a page, while any release-blocker is open', async () => {
    setup({ issues: [humanIssue(), humanIssue({ number: 9, title: 'blocker', labels: [{ name: 'release-blocker' }] })] });
    const { receipt } = await w.run();
    expect(receipt.status).toBe('stood-down');
    expect(w.pages[0].title).toBe('AUTOFIX STANDING DOWN: release-blocker #9');
    expect(w.claudeCalls()).toHaveLength(0);
  }, T);

  it('three consecutive stand-down days with an eligible issue exit 1', async () => {
    setup();
    fs.mkdirSync(path.dirname(w.paths.holdFile), { recursive: true }); fs.writeFileSync(w.paths.holdFile, '');
    const codes = [];
    for (const day of [0, 1, 2]) codes.push((await w.run({ now: NOW + day * 24 * HOURS })).receipt.exitCode);
    expect(codes).toEqual([0, 0, 1]);
  }, T);

  it('disarmed, a plain --dry-run still plans and prints, says it is not armed, and writes nothing', async () => {
    setup({ gh: { variable: null } });
    const { receipt, commands } = await w.run({ simulate: false });
    expect(receipt).toMatchObject({ status: 'dry-run', exitCode: 0 });
    expect(commands).toContain('# kill switch: NOT armed (variable-unset)');
    expect(commands.some((c) => /would fix #7/.test(c))).toBe(true);
    expect(w.claudeCalls()).toHaveLength(0);
    expect(w.ghWrites()).toHaveLength(0);
  }, T);

  it('a plain --dry-run plans and prints but executes no write and creates nothing', async () => {
    setup({ issues: [humanIssue(), bobIssue({ labels: [{ name: 'question' }] })] });
    const { receipt, commands } = await w.run({ simulate: false });
    expect(receipt).toMatchObject({ status: 'dry-run', exitCode: 0, dryRun: true });
    expect(commands.some((c) => /would fix #7; would reply to #8/.test(c))).toBe(true);
    expect(w.claudeCalls()).toHaveLength(0);
    expect(w.ghWrites()).toHaveLength(0);
    expect(fs.existsSync(w.paths.receipts)).toBe(false);
  }, T);
});

describe('--rehearse: the real night with every GitHub write refused', () => {
  it('fixes for real in its own clone, pushes nothing, comments nothing, keeps its own state, and shows what it would post', async () => {
    setup({ gh: { variable: null } }); // disarmed: a rehearsal needs no switch, it cannot write to GitHub
    const { receipt, commands } = await w.run({ rehearse: {} });
    expect(receipt).toMatchObject({ status: 'rehearsed', exitCode: 0 });
    expect(receipt.ready).toEqual([expect.objectContaining({ number: 7 })]);
    expect(w.claudeCalls().map((c) => c.stage)).toEqual(['plan', 'build', 'redteam', 'verify', 'note']);
    expect(commands.filter((c) => /^\[dry-run, not executed\] .*issue comment/.test(c))).toHaveLength(1);
    expect(w.ghWrites()).toHaveLength(0);
    expect(comments()).toHaveLength(0);
    expect(w.originRef('refs/heads/main')).toBe(mainBefore);
    expect(w.originRef('refs/heads/release/9.9.10')).toBe('');
    expect(fs.existsSync(w.paths.state)).toBe(false); // the real state file is never written
    const again = await w.run({ rehearse: {}, now: NOW + 60_000 }); // a fresh state each time: the breaker does not carry over
    expect(again.receipt.ready).toEqual([expect.objectContaining({ number: 7 })]);
    expect(receipt.comments[0].body).toMatch(new RegExp(`^${BOT_MARKER} fix report — RuvNet Brain\\n\\nHi @alice — You gave`));
  }, T);
});

