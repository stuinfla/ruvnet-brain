// Runs the REAL `run:` block of .github/workflows/ntfy-alerts.yml under `bash -e` (GitHub's default shell for a
// run step) with curl and gh stubbed on PATH, over an event matrix. A page = one curl invocation.
// The rule under test (4.7.21): page a first red, never a repeat red; never a pull_request-event run; never a star;
// never a reopened issue/PR; and if the previous-run lookup fails, page anyway.
// Fix round (4.7.21): a workflow_dispatch run is never deduplicated (protected-release dispatches both corpus nights and code
// releases), the previous run is looked up across events (a green manual re-run is a recovery), and a repeat red pages
// again when the previous red's page is not proven delivered (a non-green ntfy-alerts run since it started).
// Review round 2 (Codex r4 #3): proof is affirmative and tied to the previous red. An empty notifier history, a notifier
// run still in progress, or a green run for some OTHER red proves nothing, so each pages; only the ntfy-alerts run
// titled for the previous red's id (the workflow's run-name) that completed green counts as delivered.
// Review round 3 (Codex r5 #3): a green run alone is not a receipt (an empty topic exits 0 without sending). The previous
// red's notifier run must also show its "page delivered" step succeeded; that step runs only when the send step wrote
// delivered=sent (POST accepted) or delivered=repeat (proven repeat) to $GITHUB_OUTPUT. The receipt step's `if:` is read
// from the YAML and evaluated against the outputs the real block wrote, so the chain below is the workflow's own.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const WORKFLOW = fs.readFileSync(new URL('../../.github/workflows/ntfy-alerts.yml', import.meta.url), 'utf8');
const hasJq = process.platform !== 'win32' && spawnSync('jq', ['--version']).status === 0;

/** The send step's env keys and its run block, read from the YAML as GitHub would see them. */
function sendStep() {
  const lines = WORKFLOW.split('\n');
  const start = lines.findIndex((l) => /^ {6}- name: send$/.test(l));
  const env = []; let run = null;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {8}env:$/.test(lines[i])) {
      for (i++; i < lines.length && /^ {10}\S/.test(lines[i]); i++) env.push(lines[i].trim().split(':')[0]);
      i--; continue;
    }
    if (/^ {8}run: \|$/.test(lines[i])) {
      const body = [];
      for (i++; i < lines.length && (lines[i] === '' || /^ {10}/.test(lines[i])); i++) body.push(lines[i].slice(10));
      run = body.join('\n'); break;
    }
  }
  return { env, run };
}
const { env: ENV_KEYS, run: RUN } = sendStep();
/** The receipt step that follows `send`: its name and its `if:`, as GitHub would see them. */
const RECEIPT = (() => {
  const m = WORKFLOW.match(/^ {6}- name: (page delivered)\n {8}if: (.*)$/m);
  return m ? { name: m[1], cond: m[2] } : null;
})();
const SEND_ID = WORKFLOW.match(/^ {6}- name: send\n {8}id: (\S+)$/m)?.[1];
/** GitHub's evaluation of the receipt step's `if:` for one send-step result (only the form the workflow uses). */
const receiptRan = (outputs) => RECEIPT?.cond === `steps.${SEND_ID}.outputs.delivered != ''` && (outputs.delivered ?? '') !== '';
// Pre-4.7.21 the block interpolated `${{ github.event_name }}`; translate that one expression so the same matrix
// runs against the old file (fail-before evidence). The new file must contain no interpolation at all.
const SCRIPT = RUN.replaceAll('${{ github.event_name }}', '${EVENT}');

let work;
beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-ntfy-filter-'));
  fs.mkdirSync(path.join(work, 'bin'));
  fs.writeFileSync(path.join(work, 'send.sh'), SCRIPT);
  // curl: record the invocation, deliver nothing.
  fs.writeFileSync(path.join(work, 'bin', 'curl'), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$STUB_LOG/curl.log"\nexit "${STUB_CURL_EXIT:-0}"\n', { mode: 0o755 });
  // gh: record the invocation, then answer from STUB_GH_RESPONSE (a file) or fail like an API/auth error.
  fs.writeFileSync(path.join(work, 'bin', 'gh'), [
    '#!/bin/bash', 'printf "%s\\n" "$*" >> "$STUB_LOG/gh.log"',
    'if [ "$STUB_GH_MODE" = fail ]; then echo \'{"message":"Bad credentials","status":"401"}\'; echo "gh: Bad credentials (HTTP 401)" >&2; exit 1; fi',
    // The delivery check reads this workflow's own run history (ntfy-alerts.yml); answer it from its own file.
    // A notifier run's jobs (the delivery receipt): answered per run id from STUB_JOBS_DIR, else no jobs.
    'case "$*" in *actions/runs/*/jobs*)',
    '  if [ "$STUB_GH_JOBS_MODE" = fail ]; then echo "gh: HTTP 502" >&2; exit 1; fi',
    '  id=$(printf "%s" "$*" | sed -n "s|.*actions/runs/\\([0-9]*\\)/jobs.*|\\1|p")',
    '  if [ -f "$STUB_JOBS_DIR/$id.json" ]; then cat "$STUB_JOBS_DIR/$id.json"; else echo \'{"total_count":0,"jobs":[]}\'; fi; exit 0 ;; esac',
    'case "$*" in *ntfy-alerts.yml*)',
    '  if [ "$STUB_GH_SELF_MODE" = fail ]; then echo "gh: HTTP 502" >&2; exit 1; fi',
    '  cat "$STUB_GH_SELF_RESPONSE"; exit 0 ;; esac',
    'cat "$STUB_GH_RESPONSE"', ''].join('\n'), { mode: 0o755 });
});
afterAll(() => { if (work) fs.rmSync(work, { recursive: true, force: true }); });

const run = (id, run_number, conclusion, event = 'schedule') =>
  ({ id, run_number, conclusion, status: 'completed', event, run_started_at: `2026-10-${String(run_number % 28 + 1).padStart(2, '0')}T08:00:00Z` });
// ntfy-alerts' own runs, for the delivery check. Their titles come from the workflow's own run-name template, so a
// changed template that the delivery check does not follow fails here.
const RUN_NAME = WORKFLOW.match(/^run-name: .*format\('([^']*\{0\}[^']*)', github\.event\.workflow_run\.id\)/m)?.[1];
// (Falls back to the expected template so the matrix still runs against a pre-fix workflow for fail-before evidence.)
const titleFor = (triggerId) => (RUN_NAME ?? 'ntfy-alerts for run {0}').replace('{0}', String(triggerId));
// `self` is this run (in progress; never counted).
const SELF = { id: 5555, status: 'in_progress', conclusion: null, display_title: titleFor(9000) };
// `receipt`: the conclusion of that run's "page delivered" step (null = no such step, as in a pre-round-3 run). A green
// notifier run defaults to a successful receipt (a page that went out); anything else defaults to a skipped one.
const nrun = (id, conclusion, forRun = 8999, status = 'completed', receipt = conclusion === 'success' ? 'success' : 'skipped') =>
  ({ id, status, conclusion, display_title: titleFor(forRun), receipt });
const jobsFor = (r) => ({ total_count: 1, jobs: [{ name: 'notify', conclusion: r.conclusion,
  steps: [{ name: 'send', conclusion: r.conclusion }, ...(r.receipt ? [{ name: 'page delivered', conclusion: r.receipt }] : [])] }] });
const CURRENT = { WR_ID: '9000', WR_RUN_NUMBER: '90' };
const red = (over = {}) => ({ EVENT: 'workflow_run', WR_CONC: 'failure', WR_NAME: 'learning-replay', WR_BRANCH: 'main',
  WR_URL: 'https://github.com/stuinfla/ruvnet-brain/actions/runs/9000', WR_EVENT: 'schedule', WR_WORKFLOW_ID: '777',
  REPO: 'stuinfla/ruvnet-brain', SELF_RUN_ID: '5555', ...CURRENT, ...over });

let n = 0;
// `self` = ntfy-alerts' own runs since the previous red started; the default is "every page since went out".
function send(vars, { history = null, ghMode = 'ok', self = [SELF, nrun(5554, 'success')], selfTotal = null, selfMode = 'ok', jobsMode = 'ok', curlExit = 0 } = {}) {
  const log = fs.mkdtempSync(path.join(work, `case-${n++}-`));
  const jobsDir = path.join(log, 'jobs'); fs.mkdirSync(jobsDir);
  for (const r of self) fs.writeFileSync(path.join(jobsDir, `${r.id}.json`), JSON.stringify(jobsFor(r)));
  const output = path.join(log, 'github-output'); fs.writeFileSync(output, '');
  const response = path.join(log, 'runs.json');
  fs.writeFileSync(response, history === null ? '' : JSON.stringify({ total_count: history.length, workflow_runs: history }));
  const selfResponse = path.join(log, 'self-runs.json');
  fs.writeFileSync(selfResponse, JSON.stringify({ total_count: selfTotal ?? self.length, workflow_runs: self }));
  const result = spawnSync('bash', ['-e', path.join(work, 'send.sh')], { encoding: 'utf8', timeout: 20_000,
    env: { PATH: `${path.join(work, 'bin')}${path.delimiter}${process.env.PATH}`, HOME: work, TOPIC: 'test-topic-not-real',
      STUB_LOG: log, STUB_GH_RESPONSE: response, STUB_GH_MODE: ghMode, STUB_GH_SELF_RESPONSE: selfResponse,
      STUB_GH_SELF_MODE: selfMode, STUB_JOBS_DIR: jobsDir, STUB_GH_JOBS_MODE: jobsMode, GITHUB_OUTPUT: output,
      STUB_CURL_EXIT: String(curlExit), ...vars } });
  const read = (f) => fs.existsSync(path.join(log, f)) ? fs.readFileSync(path.join(log, f), 'utf8').trim().split('\n').filter(Boolean) : [];
  const outputs = Object.fromEntries(read('github-output').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { status: result.status, stderr: result.stderr, stdout: result.stdout, pages: read('curl.log'), gh: read('gh.log'), outputs };
}

describe.skipIf(!hasJq)('ntfy-alerts send step', () => {
  it('reads every variable it uses from the step env, with no ${{ }} interpolation inside run:', () => {
    expect(RUN).not.toContain('${{');
    const assigned = new Set([...RUN.matchAll(/(?:^|\s|;)([A-Z][A-Z0-9_]*)=/g)].map((m) => m[1]));
    for (const m of RUN.matchAll(/\bfor ([A-Z][A-Z0-9_]*) in\b/g)) assigned.add(m[1]);
    const used = new Set([...RUN.matchAll(/\$\{?([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]));
    // GITHUB_OUTPUT is provided by the runner to every step.
    const undeclared = [...used].filter((v) => !assigned.has(v) && !ENV_KEYS.includes(v) && v !== 'GITHUB_OUTPUT');
    expect(undeclared).toEqual([]);
    for (const key of ['GH_TOKEN', 'REPO', 'WR_ID', 'WR_RUN_NUMBER', 'WR_WORKFLOW_ID', 'EVENT']) expect(ENV_KEYS).toContain(key);
  });

  it('every notifier run is titled with the id of the run that triggered it (and nothing attacker-controlled)', () => {
    expect(RUN_NAME).toBe('ntfy-alerts for run {0}');
    const line = WORKFLOW.match(/^run-name: (.*)$/m)[1];
    expect(line).not.toMatch(/title|login|body|head_commit|display_title/);
  });

  it('triggers: no stars, no reopened; the token can read run history and nothing else', () => {
    expect(WORKFLOW).not.toMatch(/^ {2}watch:/m);
    expect(WORKFLOW).not.toMatch(/types: \[[^\]]*reopened/);
    expect(WORKFLOW.match(/^ {4}types: \[opened\]$/gm)).toHaveLength(2);
    expect(WORKFLOW).toMatch(/^permissions:\n {2}actions: read\n/m);
    expect(WORKFLOW).not.toMatch(/: write\b/);
    expect(WORKFLOW).toMatch(/timeout-minutes: 5\n/);
  });

  it('a first red on main pages exactly once, after looking up the same workflow and branch (any event)', () => {
    const r = send(red(), { history: [run(9000, 90, 'failure'), run(8999, 89, 'success'), run(8998, 88, 'failure')] });
    expect(r.status, r.stderr).toBe(0);
    expect(r.pages).toHaveLength(1);
    expect(r.pages[0]).toContain('Title: 🔴 CI failure: learning-replay');
    expect(r.pages[0]).toContain('https://ntfy.sh/test-topic-not-real');
    expect(r.pages[0]).not.toContain('lookup failed');
    expect(r.gh).toEqual(['api -X GET repos/stuinfla/ruvnet-brain/actions/workflows/777/runs -f branch=main -f status=completed -f per_page=20']);
  });

  it('a repeat red (previous completed run also red, its page delivered) does not page', () => {
    for (const prior of ['failure', 'timed_out', 'startup_failure']) {
      const r = send(red(), { history: [run(9000, 90, 'failure'), run(8999, 89, prior), run(8998, 88, 'success')] });
      expect(r.status, `${prior}: ${r.stderr}`).toBe(0);
      expect(r.pages, prior).toHaveLength(0);
      // The delivery check is bounded to ntfy-alerts runs created since the previous red started.
      expect(r.gh[1], prior).toBe(`api -X GET repos/stuinfla/ruvnet-brain/actions/workflows/ntfy-alerts.yml/runs -f created=>=${run(8999, 89).run_started_at} -f per_page=100`);
    }
  });

  it('workflow_dispatch runs always page: a corpus-night red does not silence the next code-release red (and back)', () => {
    // protected-release: night N corpus run (dispatch) red and paged; the next day a code release (dispatch) fails.
    const history = [run(9000, 90, 'failure', 'workflow_dispatch'), run(8999, 89, 'failure', 'workflow_dispatch')];
    for (const name of ['protected-release', 'learning-replay']) {
      const r = send(red({ WR_EVENT: 'workflow_dispatch', WR_NAME: name }), { history });
      expect(r.status, r.stderr).toBe(0);
      expect(r.pages, name).toHaveLength(1);
      expect(r.pages[0]).toContain(`Title: 🔴 CI failure: ${name}`);
      expect(r.gh, name).toHaveLength(0);
    }
  });

  it('a green manual (workflow_dispatch) run between two scheduled reds is a recovery: the second red pages', () => {
    const history = [run(9000, 90, 'failure', 'schedule'), run(8999, 89, 'success', 'workflow_dispatch'),
      run(8998, 88, 'failure', 'schedule')];
    const r = send(red(), { history });
    expect(r.status, r.stderr).toBe(0);
    expect(r.pages).toHaveLength(1);
    expect(r.pages[0]).not.toContain('repeat');
    // ...while pull_request-event runs in the same history say nothing about the branch and are passed over.
    const viaPr = [run(9000, 90, 'failure'), run(8999, 89, 'success', 'pull_request'), run(8998, 88, 'failure')];
    expect(send(red(), { history: viaPr, self: [SELF, nrun(5554, 'success', 8998)] }).pages).toHaveLength(0);
  });

  it('a failed delivery of the first red does not silence the next red (sustained ntfy outage)', () => {
    // Night 1: first red; ntfy refuses the POST -> the step fails (red in Actions), nothing arrived.
    const first = send(red({ WR_ID: '8999', WR_RUN_NUMBER: '89' }), { history: [run(8999, 89, 'failure'), run(8998, 88, 'success')], curlExit: 22 });
    expect(first.status).toBe(22);
    expect(first.pages).toHaveLength(1);
    // Night 2: previous red, and the ntfy-alerts run that handled it is red -> page again, and say why.
    const history = [run(9000, 90, 'failure'), run(8999, 89, 'failure'), run(8998, 88, 'success')];
    for (const failed of ['failure', 'timed_out', 'cancelled', 'startup_failure']) {
      // 5554 is a green notifier run for some other red; 5550 is the one that handled red 8999.
      const r = send(red(), { history, self: [SELF, nrun(5554, 'success', 8998), nrun(5550, failed)] });
      expect(r.status, `${failed}: ${r.stderr}`).toBe(0);
      expect(r.pages, failed).toHaveLength(1);
      expect(r.pages[0], failed).toContain("(repeat: the previous red's page may not have arrived)");
    }
    // An unreadable or truncated delivery history pages too (cannot prove delivery).
    for (const [label, opts] of [['self lookup 502', { selfMode: 'fail' }], ['truncated', { selfTotal: 500 }]]) {
      const r = send(red(), { history, ...opts });
      expect(r.pages, label).toHaveLength(1);
      expect(r.pages[0], label).toContain('repeat:');
    }
    // This run itself (in progress) and green or skipped ntfy runs prove nothing undelivered.
    expect(send(red(), { history, self: [SELF, nrun(5554, 'success'), nrun(5553, 'skipped', 8000)] }).pages).toHaveLength(0);
  });

  it('delivery needs affirmative evidence tied to the previous red: no notifier run, an unfinished one, or another red\'s green run pages', () => {
    const history = [run(9000, 90, 'failure'), run(8999, 89, 'failure'), run(8998, 88, 'success')];
    const cases = [
      ['empty notifier history', []],
      ['only this run', [SELF]],
      ['the previous red\'s notifier run is still in progress', [SELF, nrun(5554, null, 8999, 'in_progress')]],
      ['the previous red\'s notifier run is queued', [SELF, nrun(5554, null, 8999, 'queued')]],
      ['green notifier runs, all for other reds', [SELF, nrun(5554, 'success', 8998), nrun(5553, 'success', 7000)]],
      ['a pre-4.7.21 untitled green run', [SELF, { id: 5554, status: 'completed', conclusion: 'success', display_title: 'ntfy-alerts' }]],
      ['the previous red\'s notifier run was skipped', [SELF, nrun(5554, 'skipped')]],
    ];
    for (const [label, self] of cases) {
      const r = send(red(), { history, self });
      expect(r.status, `${label}: ${r.stderr}`).toBe(0);
      expect(r.pages, label).toHaveLength(1);
      expect(r.pages[0], label).toContain("(repeat: the previous red's page may not have arrived)");
    }
    // The proof is the previous red's own green notifier run; a red notifier run for a DIFFERENT workflow's page
    // no longer turns a delivered repeat into a second page.
    const proven = send(red(), { history, self: [SELF, nrun(5554, 'success'), nrun(5552, 'failure', 7777)] });
    expect(proven.pages).toHaveLength(0);
  });

  it('cancelled and skipped runs are passed over when finding the previous result', () => {
    const history = [run(9000, 90, 'failure'), run(8999, 89, 'cancelled'), run(8997, 88, 'skipped'), run(8996, 87, 'failure')];
    expect(send(red(), { history, self: [SELF, nrun(5554, 'success', 8996)] }).pages).toHaveLength(0);
    const recovered = [run(9000, 90, 'failure'), run(8999, 89, 'cancelled'), run(8996, 87, 'success')];
    expect(send(red(), { history: recovered }).pages).toHaveLength(1);
  });

  it('a newer run listed above the current one is not mistaken for the previous run', () => {
    const history = [run(9100, 91, 'failure'), run(9000, 90, 'failure'), run(8999, 89, 'success')];
    expect(send(red(), { history }).pages).toHaveLength(1);
  });

  it('the very first run of a workflow pages', () => {
    expect(send(red(), { history: [run(9000, 90, 'failure')] }).pages).toHaveLength(1);
    expect(send(red(), { history: [] }).pages).toHaveLength(1);
  });

  it('a failed or malformed lookup pages (fail loud), and says so in the body', () => {
    for (const [label, opts] of [['gh 401', { ghMode: 'fail' }], ['empty body', { history: null }]]) {
      const r = send(red(), opts);
      expect(r.status, `${label}: ${r.stderr}`).toBe(0);
      expect(r.pages, label).toHaveLength(1);
      expect(r.pages[0], label).toContain('(previous-run lookup failed)');
    }
    const noNumber = send(red({ WR_RUN_NUMBER: '' }), { history: [run(9000, 90, 'failure'), run(8999, 89, 'failure')] });
    expect(noNumber.pages).toHaveLength(1);
  });

  it('a pull_request-event run never pages, even on release/*', () => {
    const r = send(red({ WR_EVENT: 'pull_request', WR_BRANCH: 'release/4.7.21', WR_NAME: 'integration-linux' }),
      { history: [run(9000, 90, 'failure'), run(8999, 89, 'success')] });
    expect(r.pages).toHaveLength(0);
    expect(r.gh).toHaveLength(0);
  });

  it('a first red on a release/* push and on a scheduled job pages; a working-branch push does not', () => {
    const fresh = { history: [run(9000, 90, 'failure'), run(8999, 89, 'success')] };
    expect(send(red({ WR_EVENT: 'push', WR_BRANCH: 'release/4.7.21', WR_NAME: 'release-candidate-preflight' }), fresh).pages).toHaveLength(1);
    expect(send(red({ WR_EVENT: 'schedule', WR_BRANCH: 'dream/x' }), fresh).pages).toHaveLength(1);
    expect(send(red({ WR_EVENT: 'push', WR_BRANCH: 'fix/thing' }), fresh).pages).toHaveLength(0);
  });

  it('green, cancelled and skipped runs never page or look anything up', () => {
    for (const conclusion of ['success', 'cancelled', 'skipped', 'neutral', 'action_required', 'stale']) {
      const r = send(red({ WR_CONC: conclusion }), { history: [] });
      expect(r.pages, conclusion).toHaveLength(0);
      expect(r.gh, conclusion).toHaveLength(0);
    }
  });

  it('a star does not page', () => {
    expect(send({ EVENT: 'watch', SENDER: 'someone' }).pages).toHaveLength(0);
  });

  it("a person's new issue or PR pages once; the owner's and bots' do not", () => {
    const marker = path.join(work, 'injected');
    const issue = send({ EVENT: 'issues', ISSUE_NUM: '501', ISSUE_TITLE: `Search broke; $(touch ${marker})`, ISSUE_USER: 'alice', ISSUE_USER_TYPE: 'User' });
    expect(issue.pages).toHaveLength(1);
    expect(issue.pages[0]).toContain('Title: 🐛 New issue #501');
    expect(issue.pages[0]).toContain(`Search broke; $(touch ${marker}) — by alice`);
    expect(fs.existsSync(marker)).toBe(false);
    expect(send({ EVENT: 'pull_request_target', PR_NUM: '7', PR_TITLE: 'fix', PR_USER: 'bob', PR_USER_TYPE: 'User' }).pages).toHaveLength(1);
    expect(send({ EVENT: 'issues', ISSUE_NUM: '1', ISSUE_TITLE: 't', ISSUE_USER: 'stuinfla', ISSUE_USER_TYPE: 'User' }).pages).toHaveLength(0);
    expect(send({ EVENT: 'pull_request_target', PR_NUM: '2', PR_TITLE: 't', PR_USER: 'dependabot[bot]', PR_USER_TYPE: 'Bot' }).pages).toHaveLength(0);
  });

  it('an empty topic sends nothing, warns, and leaves no delivery receipt', () => {
    const r = send({ ...red(), TOPIC: '' }, { history: [] });
    expect(r.status, r.stderr).toBe(0);
    expect(r.pages).toHaveLength(0);
    expect(r.outputs).toEqual({});
    expect(receiptRan(r.outputs)).toBe(false);
    expect(r.stdout).toContain('::warning::NTFY_TOPIC is not set');
  });

  it('the receipt step follows send, runs only on a recorded delivery, and reads nothing attacker-controlled', () => {
    expect(SEND_ID).toBe('send');
    expect(RECEIPT).toEqual({ name: 'page delivered', cond: "steps.send.outputs.delivered != ''" });
    // The lookup checks the receipt by the step's exact name.
    expect(RUN).toContain(`.name == "${RECEIPT.name}" and .conclusion == "success"`);
    expect(WORKFLOW.slice(WORKFLOW.indexOf('- name: page delivered'))).not.toMatch(/github\.event/);
  });

  it('Codex r5 #3: an empty-topic green run for a red does not silence the next red once the topic is configured', () => {
    // Night 1: red 8999 arrives while NTFY_TOPIC is empty. The real block exits 0 (a green notifier run), sends nothing.
    const night1 = send(red({ WR_ID: '8999', WR_RUN_NUMBER: '89', TOPIC: '' }), { history: [run(8999, 89, 'failure'), run(8998, 88, 'success')] });
    expect(night1.status, night1.stderr).toBe(0);
    expect(night1.pages).toHaveLength(0);
    // Its notifier run is green; its receipt step is whatever GitHub's `if:` makes of the outputs it actually wrote.
    const n1 = nrun(5550, 'success', 8999, 'completed', receiptRan(night1.outputs) ? 'success' : 'skipped');
    expect(n1.receipt).toBe('skipped');
    // Night 2: topic configured, red 9000. The earlier green run is not a receipt: page, and say why.
    const history = [run(9000, 90, 'failure'), run(8999, 89, 'failure'), run(8998, 88, 'success')];
    const night2 = send(red(), { history, self: [SELF, n1] });
    expect(night2.status, night2.stderr).toBe(0);
    expect(night2.pages).toHaveLength(1);
    expect(night2.pages[0]).toContain("(repeat: the previous red's page may not have arrived)");
    expect(night2.outputs).toEqual({ delivered: 'sent' });
    // The receipt was read from the candidate run's own jobs.
    expect(night2.gh[2]).toBe('api -X GET repos/stuinfla/ruvnet-brain/actions/runs/5550/jobs');
    // Night 3: night 2's page went out, so a third consecutive red is a proven repeat and does not page.
    const n2 = nrun(5560, 'success', 9000, 'completed', receiptRan(night2.outputs) ? 'success' : 'skipped');
    const night3 = send(red({ WR_ID: '9001', WR_RUN_NUMBER: '91' }),
      { history: [run(9001, 91, 'failure'), ...history], self: [SELF, n1, n2] });
    expect(night3.pages).toHaveLength(0);
    expect(night3.outputs).toEqual({ delivered: 'repeat' });
  });

  it('a delivered page still deduplicates a whole red streak (each repeat carries the receipt forward)', () => {
    const first = send(red({ WR_ID: '8999', WR_RUN_NUMBER: '89' }), { history: [run(8999, 89, 'failure'), run(8998, 88, 'success')] });
    expect(first.pages).toHaveLength(1);
    expect(first.outputs).toEqual({ delivered: 'sent' });
    let self = [SELF, nrun(5550, 'success', 8999, 'completed', receiptRan(first.outputs) ? 'success' : 'skipped')];
    let history = [run(8999, 89, 'failure'), run(8998, 88, 'success')];
    for (let night = 0; night < 3; night++) {
      const id = 9000 + night; const num = 90 + night;
      history = [run(id, num, 'failure'), ...history];
      const r = send(red({ WR_ID: String(id), WR_RUN_NUMBER: String(num) }), { history, self });
      expect(r.status, `night ${night}: ${r.stderr}`).toBe(0);
      expect(r.pages, `night ${night}`).toHaveLength(0);
      expect(r.outputs, `night ${night}`).toEqual({ delivered: 'repeat' });
      self = [...self, nrun(5560 + night, 'success', id, 'completed', receiptRan(r.outputs) ? 'success' : 'skipped')];
    }
  });

  it('a green notifier run without a successful receipt step, or an unreadable receipt, pages', () => {
    const history = [run(9000, 90, 'failure'), run(8999, 89, 'failure'), run(8998, 88, 'success')];
    for (const [label, self, opts] of [
      ['receipt skipped', [SELF, nrun(5554, 'success', 8999, 'completed', 'skipped')], {}],
      ['no receipt step (pre-round-3 run)', [SELF, nrun(5554, 'success', 8999, 'completed', null)], {}],
      ['receipt step failed', [SELF, nrun(5554, 'success', 8999, 'completed', 'failure')], {}],
      ['jobs lookup 502', [SELF, nrun(5554, 'success')], { jobsMode: 'fail' }],
      // A receipt on a DIFFERENT red's notifier run proves nothing for this one.
      ['receipt only on another red\'s run', [SELF, nrun(5554, 'success', 8999, 'completed', 'skipped'), nrun(5553, 'success', 8998)], {}],
    ]) {
      const r = send(red(), { history, self, ...opts });
      expect(r.status, `${label}: ${r.stderr}`).toBe(0);
      expect(r.pages, label).toHaveLength(1);
      expect(r.pages[0], label).toContain("(repeat: the previous red's page may not have arrived)");
    }
    // Two green runs titled for the same red (a re-run): one receipt is enough.
    const twice = send(red(), { history, self: [SELF, nrun(5554, 'success', 8999, 'completed', 'skipped'), nrun(5556, 'success')] });
    expect(twice.pages).toHaveLength(0);
  });
});
