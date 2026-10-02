// continuity-events.test.mjs — the typed material events, read from real sources (ADR-100 §1).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  CONTINUITY_SECRETS,
  collectCommits, collectReleases, collectTurnEvents, eventIdOf, eventKey, makeEvent, userLevelAgentdbHooks,
} from '../../plugin/scripts/continuity-events.mjs';
import { ContinuityJournal } from '../../plugin/scripts/continuity-journal.mjs';
import { adoptedProject, cleanup, commit, git, tmp, transcript } from '../helpers/continuity-fixture.mjs';

let savedCwdRoot;
beforeAll(() => { savedCwdRoot = process.env.RUVNET_RUFLO_CWD_ROOT; process.env.RUVNET_RUFLO_CWD_ROOT = tmp('cont-cwd-'); });
afterAll(() => { if (savedCwdRoot === undefined) delete process.env.RUVNET_RUFLO_CWD_ROOT; else process.env.RUVNET_RUFLO_CWD_ROOT = savedCwdRoot; });
afterEach(cleanup);

const read = (file) => fs.readFileSync(file, 'utf8').split('\n');

describe('continuity events: git', () => {
  it('records each commit by SHA with its subject, files and branch; a tag becomes a release', () => {
    const p = adoptedProject();
    const first = commit(p.dir, p.env, 'a.txt', 'feat: first fixture change');
    const second = commit(p.dir, p.env, 'b.txt', 'fix: second fixture change');
    git(p.dir, p.env, 'tag', 'v9.9.9');
    const events = collectCommits({ checkoutRoot: p.dir, sinceMs: Date.now() - 3_600_000, host: 'claude', session: 's1', project: 'x' });
    expect(events.map((e) => e.detail.sha)).toEqual([second, first]);
    expect(events[0]).toMatchObject({ kind: 'commit', source: 'git', authoritative: true, summary: `${second.slice(0, 8)} fix: second fixture change` });
    expect(events[0].detail).toMatchObject({ branch: 'main', merge: false, files: ['b.txt'] });
    const releases = collectReleases({ checkoutRoot: p.dir, sinceMs: Date.now() - 3_600_000, host: 'claude', session: 's1', project: 'x' });
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({ kind: 'release', summary: `v9.9.9 -> ${second.slice(0, 8)}`, detail: { tag: 'v9.9.9', sha: second, channel: 'code' } });
  });

  it('the key sorts chronologically and ends in the content id, so dedupe is a key lookup', () => {
    const a = makeEvent({ kind: 'decision', at: Date.parse('2026-10-01T10:00:00Z'), source: 'explicit', authoritative: true, summary: 'Use the outbox' });
    const b = makeEvent({ kind: 'decision', at: Date.parse('2026-10-02T10:00:00Z'), source: 'explicit', authoritative: true, summary: '  use the OUTBOX ' });
    expect(a.id).toBe(b.id);
    expect(eventKey(a) < eventKey(b)).toBe(true);
    expect(eventIdOf(eventKey(a))).toBe(`decision:${a.id}`);
  });
});

describe('continuity events: one Claude turn', () => {
  it('gates (with exit outcome), agent findings, decisions and an owner correction; secrets redacted', () => {
    const dir = tmp('cont-turn-');
    const file = transcript(dir, {
      user: 'Never publish from a dirty tree again. From now on the release must run from a clean worktree. token=abcd1234efgh5678',
      tools: [
        { name: 'Bash', input: { command: 'npm test', description: 'Run unit tests' }, result: 'Tests 3 failed | 40 passed\nExit code 1', isError: true },
        { name: 'Bash', input: { command: 'ls -la', description: 'List files' }, result: 'a b c' },
        { name: 'Agent', input: { subagent_type: 'reviewer', description: 'Review the diff' }, result: [{ type: 'text', text: 'Found one real bug: the lock is released before the commit line is fsynced.' }] },
      ],
      assistant: ['Here is what happened.\n**Decision:** keep the outbox as the only recovery transport.\nLesson: never trust a CLI success line without a read-back.'],
    });
    const events = collectTurnEvents({ lines: read(file), host: 'claude', session: 's1', project: 'x', env: {} });
    const kinds = events.map((e) => e.kind).sort();
    expect(kinds).toEqual(['decision', 'finding', 'gate', 'lesson', 'lesson']);
    const gate = events.find((e) => e.kind === 'gate');
    expect(gate.detail).toMatchObject({ command: 'npm test', outcome: 'fail', exitCode: 1 });
    expect(gate.summary).toMatch(/^FAIL npm test — Exit code 1$/);
    expect(events.find((e) => e.kind === 'finding')).toMatchObject({ authoritative: false, detail: { agent: 'reviewer' } });
    expect(events.find((e) => e.kind === 'decision').summary).toBe('Decision: keep the outbox as the only recovery transport.');
    const owner = events.find((e) => e.source === 'owner-correction-detected');
    expect(owner.authoritative).toBe(false);
    expect(owner.summary).toMatch(/Never publish from a dirty tree/);
    expect(owner.summary).not.toMatch(/abcd1234efgh5678/);
  });

  it('a user message that is not a correction is NEVER stored; the detector can be switched off', () => {
    const dir = tmp('cont-turn-');
    const plain = transcript(dir, { user: 'Please summarize the billing module for me and suggest improvements.' });
    expect(collectTurnEvents({ lines: read(plain), host: 'claude', session: 's', project: 'x', env: {} })).toEqual([]);
    const correction = transcript(dir, { user: 'You must never skip the read-back step, ever.' });
    expect(collectTurnEvents({ lines: read(correction), host: 'claude', session: 's', project: 'x', env: { RUVNET_CONTINUITY_LESSON_DETECT: 'off' } })).toEqual([]);
  });

  // Review S1a: the old detector matched bare "never" / "do not" / "you must", so almost every task prompt
  // was saved as a standing lesson. Ordinary imperatives must yield NOTHING; only durable-rule phrasing counts.
  const ORDINARY = [
    'Fix the login bug, and do not touch the CSS.',
    'never mind, go ahead with the original plan',
    'Please don\'t change the public API in this pass.',
    'You must update the tests too before you finish this.',
    'That\'s wrong, try again with the other config file.',
    'Do not push yet, I want to look at the diff first.',
    'It never loads on Safari when the cache is cold, why?',
    'Why does the build always fail on CI but not locally?',
    'Stop asking and just run the migration on staging.',
    'I told you to use the release branch, not main.',
    'Remember the file we edited yesterday? Open it again.',
    'Never mind the lint warnings for now, focus on the failing test.',
  ];
  const DURABLE = [
    ['From now on, run the full suite before every merge.', /From now on, run the full suite/],
    ['Never again publish from a dirty tree.', /Never again publish/],
    ['Standing rule: every release needs install verification on three OSes.', /Standing rule: every release/],
    ['Remember that the owner never clicks GitHub approvals. Thanks.', /Remember that the owner never clicks/],
    ['Always read back the write before calling it stored.', /Always read back the write/],
    ['Going forward, use the outbox for every store write.', /Going forward, use the outbox/],
  ];
  it('ordinary task imperatives are NEVER captured as lessons (negative corpus)', () => {
    const dir = tmp('cont-turn-');
    for (const user of ORDINARY) {
      const events = collectTurnEvents({ lines: read(transcript(dir, { user })), host: 'claude', session: 's', project: 'x', env: {} });
      expect(events, user).toEqual([]);
    }
  });
  it('durable-rule phrasing is captured as detected-unconfirmed, keeping only the rule sentence', () => {
    const dir = tmp('cont-turn-');
    for (const [user, rule] of DURABLE) {
      const events = collectTurnEvents({ lines: read(transcript(dir, { user: `${user} Also the deploy log is in /tmp/x.` })), host: 'claude', session: 's', project: 'x', env: {} });
      expect(events, user).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'lesson', source: 'owner-correction-detected', authoritative: false, detail: { status: 'detected-unconfirmed' } });
      expect(events[0].summary, user).toMatch(rule);
      expect(events[0].summary, 'the rest of the prompt is not stored').not.toMatch(/deploy log/);
    }
  });

  it('Codex (no transcript format) still yields decisions from last_assistant_message', () => {
    const events = collectTurnEvents({ lines: null, lastAssistantMessage: 'Done.\nDecision: ship the journal behind the existing boundary.', host: 'codex', session: 'c1', project: 'x', env: {} });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'decision', host: 'codex' });
  });

  it('an event seen at three boundaries is journalled once', () => {
    const p = adoptedProject();
    const journal = new ContinuityJournal({ projectRoot: p.dir });
    const e = makeEvent({ kind: 'lesson', source: 'explicit', authoritative: true, summary: 'Read back every write.' });
    expect(journal.record([e])).toHaveLength(1);
    expect(journal.record([e])).toHaveLength(0);
    expect(journal.record([makeEvent({ kind: 'lesson', source: 'explicit', authoritative: true, summary: 'read back EVERY write.', at: Date.now() + 5000 })])).toHaveLength(0);
    expect(journal.pending()).toHaveLength(1);
  });
});

describe('redaction happens BEFORE truncation (review S2)', () => {
  // A synthetic key body: 1600 base64-ish characters, far past SUMMARY_LIMIT, so a truncate-first
  // implementation cuts off the END marker and the regex that needs it never fires.
  const body = Array.from({ length: 40 }, (_, i) => `QUJD${String(i).padStart(4, '0')}ZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo`).join('\n');
  const key = `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----`;
  const leaks = (text) => /BEGIN [A-Z ]*PRIVATE KEY|END [A-Z ]*PRIVATE KEY|ZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo/.test(text);

  it('a long pasted private key in an agent finding is redacted whole, never half-kept', () => {
    const dir = tmp('cont-turn-');
    const file = transcript(dir, { user: 'check the deploy box', tools: [{ name: 'Agent', input: { subagent_type: 'auditor' },
      result: [{ type: 'text', text: `Found a key committed in deploy/: ${key}\nRotate it.` }] }] });
    const [finding] = collectTurnEvents({ lines: read(file), host: 'claude', session: 's', project: 'x', env: {} });
    expect(finding.kind).toBe('finding');
    expect(leaks(JSON.stringify(finding)), finding.summary).toBe(false);
    expect(finding.summary).toContain('[REDACTED:private-key]');
    expect(finding.summary.length).toBeLessThanOrEqual(400);
  });

  it('an explicit event carrying a key, an unterminated BEGIN block, or a headless key tail is redacted', () => {
    for (const summary of [`Lesson: keys leak. ${key}`, `Pasted: -----BEGIN RSA PRIVATE KEY-----\n${body}`, `tail only: ${body}\n-----END RSA PRIVATE KEY----- done`]) {
      const e = makeEvent({ kind: 'lesson', source: 'explicit', authoritative: true, summary });
      expect(leaks(JSON.stringify(e)), e.summary).toBe(false);
      expect(e.summary).toContain('[REDACTED:private-key]');
    }
  });

  it('redaction stays linear on adversarial input (it runs inside the capture boundary budget)', () => {
    for (const text of [`x PRIVATE KEY----- ${'A'.repeat(60_000)}`, `${'A '.repeat(30_000)}-----END RSA PRIVATE KEY-----`]) {
      const started = Date.now();
      makeEvent({ kind: 'finding', source: 'agent-result', authoritative: false, summary: text });
      expect(Date.now() - started).toBeLessThan(250); // a backtracking tail regex took 1532 ms on 20 KB
    }
  });
});

// Re-review S3: gate summaries land in .swarm and are quoted in the SessionStart brief, and these shapes
// survived redaction. Each secret is synthetic (EXAMPLE-style), never a real credential.
// Re-review a6 SHOULD-FIX 2: the URL-userinfo pattern was quadratic (measured 1,186 ms on 64 KB 'a.a.…', 2,869 ms
// on 100 KB). EVERY redaction pattern is timed here on 64 KB and 100 KB adversarial inputs, so a future pattern
// cannot regress it: each must finish in < 50 ms (best of three runs, to ignore a scheduler hiccup).
describe('every secret pattern is linear (re-review a6 SF2)', () => {
  const UNITS = ['a.', 'sk-', 'KEY', '"token', 'x=', 'a://', '\\', '@', ':', ' -p', '-u ', 'X-', 'Bearer "', 'export A ', 'apiKey:',
    'a:', 'a b', '"a":', "'", '"', 'mysql ', '--password ', 'X-Api-Key:', 'https://a:', 'A=', 'npm_', 'Authorization: ', 'a-', 'a_', '-p', 'a@'];
  it.each(CONTINUITY_SECRETS.map((entry, i) => [i, entry]))('pattern #%i stays under 50 ms on 64 KB and 100 KB adversarial input', (_i, [pattern, replacement]) => {
    for (const unit of UNITS) for (const size of [64 * 1024, 100 * 1024]) {
      const input = unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
      let best = Infinity;
      for (let run = 0; run < 3 && best >= 50; run += 1) {
        const started = performance.now(); input.replace(pattern, replacement); best = Math.min(best, performance.now() - started);
      }
      expect(best, `${JSON.stringify(unit)} × ${size}`).toBeLessThan(50);
    }
  });
});

// Re-review a6 SHOULD-FIX 3: shapes that still leaked. Every value is BUILT AT RUNTIME (no credential-shaped
// literal in this file — push protection and scripts/development-push-check.mjs reject those).
describe('more secret shapes are redacted (re-review a6 SF3)', () => {
  const v = (tag) => ['zq', tag, 'Wv', '7Rk', 'Pm', '42x'].join('');           // a synthetic secret value
  const CASES = () => [
    ['--password value', `mysqldump --password ${v('a')} db`, v('a')],
    ['--pass value', `tool --pass ${v('b')} run`, v('b')],
    ['--password=value', `tool --password=${v('c')}`, v('c')],
    ['mysql -p attached', `mysql -u root -p${v('d')} app`, v('d')],
    ['curl -u user:pass', `curl -u deploy:${v('e')} https://example.invalid`, v('e')],
    ['--user user:pass', `curl --user deploy:${v('f')} https://example.invalid`, v('f')],
    ['X-Api-Key header', `curl -H "X-Api-Key: ${v('g')}" https://example.invalid`, v('g')],
    ['X-Auth-Token header', `X-Auth-Token: ${v('h')}`, v('h')],
    ['X-Secret header', `X-Secret-Value: ${v('i')}`, v('i')],
    ['quoted Bearer', `Bearer "${v('j')}"`, v('j')],
    ['JS object key', `const cfg = { apiKey: "${v('k')}" }`, v('k')],
    ['JS key, single quotes', `clientSecret: '${v('l')}'`, v('l')],
    ['numeric JSON value', `{"password": 98765${'4'.repeat(6)}}`, `98765${'4'.repeat(6)}`],
    ['export without =', `export TOKEN ${v('m')}`, v('m')],
    ['setenv', `setenv API_SECRET ${v('n')}`, v('n')],
    ['URL password with @ (the part after the first @)', `https://bot:${v('o')}@x${v('p')}@registry.example.invalid/pkg`, v('p')],
    ['URL password with @ (the part before it)', `https://bot:${v('o')}@x${v('p')}@registry.example.invalid/pkg`, v('o')],
    ['unterminated quoted env value', `DB_PASSWORD="${v('q')} and the rest of the line`, 'and the rest of the line'],
  ];
  it.each(CASES().map(([label, text, secret]) => [label, text, secret]))('%s is not stored', (_label, text, secret) => {
    const e = makeEvent({ kind: 'finding', source: 'agent-result', authoritative: false, summary: `Ran: ${text} (done)` });
    expect(JSON.stringify(e)).not.toContain(secret);
    expect(e.summary).toMatch(/REDACTED/);
  });
  it('ordinary text near the new patterns is left alone', () => {
    for (const text of ['mkdir -p build/out', 'ls -la -u', 'X-Request-Id: 1234-abcd', 'export PATH /usr/bin', 'const port: 8080', 'https://example.invalid/a@b']) {
      expect(makeEvent({ kind: 'finding', source: 'agent-result', authoritative: false, summary: text }).summary, text).toBe(text);
    }
  });
});

describe('secrets in commands, outputs and findings are redacted (re-review S3)', () => {
  const SECRETS = [
    ['env token', 'NPM_TOKEN=npm' + '_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789', 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'],
    ['aws secret', 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY'],
    ['env password quoted', 'DB_PASSWORD="correct horse battery"', 'correct horse battery'],
    ['json password', '{"password": "hunter2-is-not-a-password"}', 'hunter2-is-not-a-password'],
    ['json api key', '{"apiKey":"ak-1234567890abcdef"}', 'ak-1234567890abcdef'],
    ['url userinfo', 'git clone https://alice:s3cretpassw0rd@git.example.com/repo.git', 's3cretpassw0rd'],
    ['basic auth header', 'Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1l', 'YWxhZGRpbjpvcGVuc2VzYW1l'],
    ['bearer header', 'curl -H "Authorization: Bearer abc.def.ghi-jkl"', 'abc.def.ghi-jkl'],
    ['bare npm token', 'token in log: npm' + '_ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210', 'npm' + '_ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210'],
    ['github token', 'using gho' + '_16C7e42F292c6912E7710c838347Ae178B4a here', 'gho' + '_16C7e42F292c6912E7710c838347Ae178B4a'],
    ['github pat', 'git' + 'hub_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz', 'abcdefghijklmnopqrstuvwxyz'],
    ['openai key', `export key ${['sk', 'proj', 'AbCdEfGhIjKlMnOpQrStUvWx'].join('-')}`, 'AbCdEfGhIjKlMnOpQrStUvWx'],
    ['aws key id', 'aws_access_key_id AKI' + 'AIOSFODNN7EXAMPLE', 'AKI' + 'AIOSFODNN7EXAMPLE'],
    ['slack token', 'SLACK xox' + 'b-123456789012-abcdefghijklmnop', 'xox' + 'b-123456789012-abcdefghijklmnop'],
  ];
  it.each(SECRETS)('%s is not stored', (_label, text, secret) => {
    const e = makeEvent({ kind: 'finding', source: 'agent-result', authoritative: false, summary: `Found: ${text} (rotate it)` });
    expect(JSON.stringify(e)).not.toContain(secret);
    expect(e.summary).toMatch(/REDACTED/);
  });

  it('a gate command and its output tail, read from a real transcript, keep no secret', () => {
    const dir = tmp('cont-turn-');
    const file = transcript(dir, { user: 'publish it', tools: [{ name: 'Bash',
      input: { command: 'NPM_TOKEN=npm' + '_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 npm run release:check', description: 'Run release check' },
      result: 'checked https://bot:pa55w0rd-example@registry.example.com\nExit code 1', isError: true }] });
    const [gate] = collectTurnEvents({ lines: read(file), host: 'claude', session: 's', project: 'x', env: {} });
    expect(gate.kind).toBe('gate');
    const all = JSON.stringify(gate);
    expect(all).not.toContain('aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789');
    expect(all).not.toContain('pa55w0rd-example');
  });

  it('stays linear on adversarial input for every new pattern', () => {
    // The last two backtracked quadratically with a `[\w]*(?:KEY|…)[\w]*` name pattern (1.6 s and 2.0 s, measured).
    for (const text of [`NPM_TOKEN=${'a'.repeat(60_000)}`, `{"password": "${'\\\\'.repeat(30_000)}`, `https://${'u'.repeat(30_000)}:${'p'.repeat(30_000)}`,
      'KEY'.repeat(20_000), `"${'token'.repeat(12_000)}`]) {
      const started = Date.now();
      makeEvent({ kind: 'finding', source: 'agent-result', authoritative: false, summary: text });
      expect(Date.now() - started).toBeLessThan(250);
    }
  });
});

describe('user-level hook detection (read-only)', () => {
  it('detects the owner turn-capture / autocapture / ensure hooks from settings.json and never writes it', () => {
    const home = tmp('cont-home-');
    expect(userLevelAgentdbHooks({ home })).toMatchObject({ turnCapture: false, autocapture: false, ensure: false });
    const settings = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    const body = JSON.stringify({ hooks: {
      Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'node "${HOME}/.claude/hooks/agentdb-turn-capture.mjs" || true' }] }],
      SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'bash "${HOME}/.claude/hooks/agentdb-ensure.sh" || true' }] }],
    } });
    fs.writeFileSync(settings, body);
    expect(userLevelAgentdbHooks({ home })).toMatchObject({ turnCapture: true, autocapture: false, ensure: true });
    expect(fs.readFileSync(settings, 'utf8')).toBe(body);
  });
});
