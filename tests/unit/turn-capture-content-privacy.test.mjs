import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { contentPathExcludes, pathIsExcluded, maskExcludedPaths, privateTurn, privateContinuityEvent, captureFailureReason, payloadReferencesExcludedResource, privateTransitionObservation } from '../../plugin/scripts/turn-capture-privacy.mjs';
import { captureTurnOutcome, resolveTurnDb, runSteps, turnRecordingStatus } from '../../plugin/scripts/turn-outcome-capture.mjs';
import { resolveProjectStore } from '../../plugin/scripts/project-store-resolver.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
function fixture() {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'turn-content-privacy-'))); roots.push(home);
  const projectDir = path.join(home, 'project'); const brainHome = path.join(home, 'brain');
  fs.mkdirSync(path.join(projectDir, '.swarm'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.swarm', 'memory.db'), '');
  const policy = path.join(brainHome, 'turn-capture', 'policy.json'); fs.mkdirSync(path.dirname(policy), { recursive: true });
  const env = { RUVNET_BRAIN_HOME: brainHome, RUFLO_BIN: process.execPath, RUVNET_HOOK_HOST: 'codex' };
  const write = (extra) => fs.writeFileSync(policy, JSON.stringify({ schemaVersion: 1, projects: {}, ...extra }));
  return { home, projectDir, brainHome, env, write };
}
const SAFE = 'The synthetic project task finished with a verified local check. The implementation preserves the canonical project store, explicit consent and pending failure evidence. This explanatory outcome is substantive and contains no owner instruction. ';
const VAULT = '/Users/SyntheticOwner/Vaults/private';
const FILE = `${VAULT}/client-title.md`;

describe('content exclusions separate from capture-origin consent', () => {
  it.each([
    [VAULT, FILE, true], [VAULT, `${VAULT}-public/note.md`, false],
    [`${VAULT}/*.md`, FILE, true], [`${VAULT}/*.md`, `${VAULT}/nested/title.md`, false],
    [`${VAULT}/**/*.md`, `${VAULT}/nested/deep/title.md`, true], [`${VAULT}/**/*.md`, FILE, true],
    [`${VAULT}/**`, `${VAULT}/nested/title.md`, true],
    ['C:\\Private\\**\\*.md', 'c:\\private\\deep\\note.md', true],
    ['/', '/private/note.md', true], ['C:/', 'C:/private/note.md', true],
    ['/project/private', '/project/public/../private/client-title.md', true],
    ['/project/private', 'public/../private/client-title.md', true],
    ['C:/Private', 'C:\\Public\\..\\Private\\client-title.md', true],
  ])('matches rooted prefix/glob %s against %s', (raw, file, expected) => {
    const patterns = contentPathExcludes([raw]); expect(pathIsExcluded(file, patterns, '/project')).toBe(expected);
    if (expected) expect(maskExcludedPaths(`Read "${file}".`, patterns, '/project')).not.toContain(file);
  });
  it('drops excluded files and scrubs outcome/actions including known relative file references', () => {
    const patterns = contentPathExcludes(['/project/private']);
    const result = privateTurn({ finalText: 'Read private/client.md and client.md.', files: ['private/client.md', 'src/public.mjs'], actions: ['Inspect private/client.md'] }, patterns, '/project');
    expect(result.files).toEqual(['src/public.mjs']); expect(JSON.stringify(result)).not.toContain('client.md');
    expect(maskExcludedPaths(`Read "${FILE}". Then check public code.`, [VAULT])).toBe('Read "[REDACTED:excluded-path]". Then check public code.');
  });
  it.each(['broken', {}, ['relative/note'], ['/private/../note'], ['/private/[x]'], ['/private/**/**'], Array(17).fill('/private'), [null], ['/private/***']])('refuses malformed exclusion %j even when forced', (contentPathExcludes) => {
    const h = fixture(); h.write({ contentPathExcludes });
    expect(resolveTurnDb(h).skipped).toContain('invalid');
    const report = captureTurnOutcome({ ...h, event: 'Stop', payload: { session_id: 's', last_assistant_message: SAFE }, env: { ...h.env, RUVNET_TURN_CAPTURE: 'force' }, ruflo: process.execPath, launch: () => { throw new Error('must not launch'); } });
    expect(report.queued).toBe(false); expect(fs.existsSync(path.join(h.projectDir, '.swarm', 'turn-outbox'))).toBe(false);
  });
  it('filters before the store call: private paths and secrets never reach ruflo memory store, and the exact readback proves it', () => {
    const h = fixture(); h.write({ paths: { [VAULT]: 'off' }, contentPathExcludes: [VAULT] });
    const transcript = path.join(h.home, 'mixed.jsonl'); const publicFile = path.join(h.projectDir, 'public.mjs');
    fs.writeFileSync(transcript, JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { file_path: publicFile } }, { type: 'tool_use', name: 'Read', input: { file_path: FILE } }, { type: 'text', text: `${SAFE} Read "${FILE}" using sk-syntheticprivacy0123456789.` }] } }) + '\n');
    let outgoing;
    const run = (_, args) => { if (args[1] === 'store') { outgoing = args[args.indexOf('--value') + 1]; return { status: 0 }; } return { status: 0, stdout: outgoing ?? '' }; };
    const result = captureTurnOutcome({ ...h, write: undefined, event: 'Stop', host: 'claude', payload: { session_id: 's', transcript_path: transcript }, ruflo: process.execPath, run, launch: () => ({}) }); // h.write is the policy helper, not the injected store writer
    expect(result.recorded).toBe(true); expect(result.receipt).toMatchObject({ verified: true, status: 0 });
    for (const text of [outgoing, result.value]) { expect(text).not.toContain(FILE); expect(text).not.toContain('sk-syntheticprivacy0123456789'); expect(text).toContain(publicFile); }
    const receiptText = fs.readFileSync(path.join(h.brainHome, 'turn-capture', 'receipts.jsonl'), 'utf8'); // the only local trace of the write
    expect(receiptText).not.toContain(FILE); expect(JSON.parse(receiptText.trim().split('\n').pop())).toMatchObject({ verified: true });
    expect(fs.existsSync(path.join(h.projectDir, '.swarm', 'turn-outbox'))).toBe(false);
  });
  it('does not queue a private-only path-bearing outcome without safe public metadata', () => {
    const h = fixture(); h.write({ contentPathExcludes: [VAULT] });
    const launch = () => { throw new Error('must not launch private-only outcome'); };
    const result = captureTurnOutcome({ ...h, event: 'Stop', host: 'codex', payload: { session_id: 'private-only', last_assistant_message: `${SAFE} Read "${FILE}".` }, ruflo: process.execPath, launch });
    expect(result.queued).toBe(false); expect(result.skipped).toContain('explicitly excluded resource');
    expect(fs.existsSync(path.join(h.projectDir, '.swarm', 'turn-outbox'))).toBe(false); expect(fs.readFileSync(path.join(h.projectDir, '.swarm', 'memory.db'), 'utf8')).toBe('');
  });
});

describe('bounded failure reasons and first-use disclosure', () => {
  it('resolves an existing symlink resource without reading its private body', () => {
    const h = fixture(); const privateDir = path.join(h.projectDir, 'private'); fs.mkdirSync(privateDir); const file = path.join(privateDir, 'client.md'); fs.writeFileSync(file, 'Synthetic private body');
    const alias = path.join(h.projectDir, 'public-link.md'); fs.symlinkSync(file, alias);
    expect(pathIsExcluded(alias, [privateDir], h.projectDir)).toBe(true); expect(maskExcludedPaths(`Read "${alias}"`, [privateDir], h.projectDir)).not.toContain(alias);
  });
  it('matches native filesystem symlink-and-dotdot semantics for absolute and relative resources', () => {
    const h = fixture(); const privateDir = path.join(h.projectDir, 'private'); fs.mkdirSync(path.join(privateDir, 'deep'), { recursive: true });
    const alias = path.join(h.projectDir, 'public-alias'); fs.symlinkSync(path.join(privateDir, 'deep'), alias, 'dir');
    // Normal Win32 paths normalize .. before resolving a directory link; POSIX resolves the link first.
    // Prove the native destination through actual file I/O, not a simulated Windows path helper.
    const expectedPrivate = process.platform !== 'win32'; const rawPath = `${alias}/../new.md`;
    const publicTarget = path.join(h.projectDir, 'new.md'); const privateTarget = path.join(privateDir, 'new.md');
    expect(pathIsExcluded(rawPath, [privateDir], h.projectDir)).toBe(expectedPrivate);
    expect(pathIsExcluded('public-alias/../new.md', [privateDir], h.projectDir)).toBe(expectedPrivate);
    fs.writeFileSync(rawPath, 'Synthetic native path-resolution witness');
    expect(fs.readFileSync(expectedPrivate ? privateTarget : publicTarget, 'utf8')).toBe('Synthetic native path-resolution witness');
    expect(fs.existsSync(expectedPrivate ? publicTarget : privateTarget)).toBe(false);
    expect(pathIsExcluded(rawPath, [privateDir], h.projectDir)).toBe(expectedPrivate);
    expect(pathIsExcluded('private/deep/../new.md', [privateDir], h.projectDir)).toBe(true);
    expect(pathIsExcluded(`${privateDir}/deep/../new.md`, [privateDir], h.projectDir)).toBe(true);
  });
  it('refuses ambiguous physical resource resolution instead of treating it as public', () => {
    const h = fixture(); const a = path.join(h.projectDir, 'cycle-a'); const b = path.join(h.projectDir, 'cycle-b'); fs.symlinkSync(b, a); fs.symlinkSync(a, b);
    expect(() => pathIsExcluded(`${a}/missing.md`, ['/project/private'], h.projectDir)).toThrow('resource resolution unavailable');
  });
  it('removes known relative paths and basenames from continuity summaries as well as files', () => {
    const event = { id: 'original', summary: 'Completed private/client-title.md and client-title.md', detail: { files: ['private/client-title.md', 'public.mjs'] } };
    const filtered = privateContinuityEvent(event, ['/project/private'], '/project');
    expect(filtered.detail.files).toEqual(['public.mjs']); expect(filtered.summary).not.toContain('client-title.md'); expect(filtered.id).toBe('original');
  });
  it('classifies every supported resource alias on the normalized host envelope', () => {
    const payload = { hookEventName: 'post_tool_use', toolName: 'NotebookEdit', toolInput: { file_path: '/project/public/a', notebook_path: '/project/private/b' } };
    expect(payloadReferencesExcludedResource(payload, ['/project/private'], '/project')).toBe(true);
    expect(privateTransitionObservation({ id: 'same', error: 'PRIVATE_BODY_TOKEN' }, ['/project/private'], '/project', payload).error).toBe('[REDACTED:excluded-resource-error]');
  });
  it('withholds assistant outcome derived from a known excluded Read before turn journaling', () => {
    const h = fixture(); h.write({ contentPathExcludes: [VAULT] });
    const transcript = path.join(h.home, 'read.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: FILE } }, { type: 'text', text: `Decision: Confidential client title. ${SAFE}` }] } }) + '\n');
    const report = captureTurnOutcome({ ...h, event: 'Stop', host: 'claude', payload: { session_id: 'read', transcript_path: transcript, last_assistant_message: `Decision: Confidential client title. ${SAFE}` }, ruflo: process.execPath, launch: () => { throw new Error('must not journal private outcome'); } });
    expect(report.queued).toBe(false); expect(report.skipped).toContain('explicitly excluded resource'); expect(fs.existsSync(path.join(h.projectDir, '.swarm', 'turn-outbox'))).toBe(false);
  });
  it('delivers the notice through actual SessionStart core default output filtering', () => {
    const h = fixture(); h.write({});
    for (const file of ['.last-update-check', '.seed-attempted']) fs.writeFileSync(path.join(h.brainHome, file), String(Math.floor(Date.now() / 1000)));
    fs.writeFileSync(path.join(h.brainHome, '.auto-update-pref'), 'no');
    const module = pathToFileURL(path.resolve(import.meta.dirname, '../../plugin/scripts/session-start-core.mjs')).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import {runSessionStart} from ${JSON.stringify(module)}; await runSessionStart({runHeartbeat:false});`], {
      cwd: h.projectDir, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, ...h.env, HOME: h.home, USERPROFILE: h.home, RUVNET_AUTO_UPDATE: 'off', RUVNET_TURN_CAPTURE: 'force', RUVNET_VERBOSE_HOOKS: '0', RUVNET_BRAIN_METER: '0' },
    });
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain('[RuvNet Brain — TURN CAPTURE]'); expect(result.stdout).toContain('contentPathExcludes');
  });
  it('selects the actual terminal error and redacts before bounding', () => {
    const reason = captureFailureReason({ stderr: '[INFO] storing\n[ERROR] token=sk-syntheticprivacy0123456789 SQLITE_BUSY database is locked\n[INFO] shutting down' }, 1);
    expect(reason).toContain('SQLITE_BUSY'); expect(reason).not.toContain('sk-syntheticprivacy0123456789'); expect(reason.length).toBeLessThanOrEqual(300);
    expect(captureFailureReason({ error: new Error('spawn timeout'), stderr: '[INFO] storing' }, 1)).toBe('spawn timeout');
  });
  it.each([
    { stderr: '[INFO] starting\n[WARN] retrying', stdout: '[ERROR] SQLITE_BUSY token=sk-syntheticprivacy0123456789 database is locked' },
    { stdout: '[INFO] starting\n[WARN] retrying', stderr: '[ERROR] SQLITE_BUSY token=sk-syntheticprivacy0123456789 database is locked' },
  ])('selects a terminal error across mixed output streams', (result) => {
    const reason = captureFailureReason(result, 1);
    expect(reason).toContain('[ERROR] SQLITE_BUSY'); expect(reason).toContain('database is locked');
    expect(reason).not.toContain('sk-syntheticprivacy0123456789'); expect(reason.length).toBeLessThanOrEqual(300);
  });
  it('normal status does not consume first-use notice; one eligible project notice includes live opt-out', () => {
    const h = fixture(); h.write({}); expect(turnRecordingStatus(h).notice).toBeUndefined();
    const first = turnRecordingStatus({ ...h, noticeOnFirstUse: true });
    expect(first.notice).toContain('contentPathExcludes'); expect(first.notice).toContain('never raw user prompts'); expect(first.notice).toContain('"off"');
    expect(first.state).toBe('unknown'); expect(turnRecordingStatus({ ...h, noticeOnFirstUse: true }).notice).toBeUndefined();
    const files = fs.readdirSync(path.join(h.brainHome, 'turn-capture', 'notices')); expect(files).toHaveLength(1);
  });
  it.each(['off', 'invalid', 'unadopted'])('does not announce or create notice for %s', (mode) => {
    const h = fixture(); h.write(mode === 'off' ? { projects: { [h.projectDir]: 'off' } } : mode === 'invalid' ? { contentPathExcludes: 'broken' } : {});
    if (mode === 'unadopted') fs.rmSync(path.join(h.projectDir, '.swarm'), { recursive: true });
    expect(turnRecordingStatus({ ...h, noticeOnFirstUse: true }).notice).toBeUndefined(); expect(fs.existsSync(path.join(h.brainHome, 'turn-capture', 'notices'))).toBe(false);
  });
});
