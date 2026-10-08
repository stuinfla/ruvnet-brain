import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { contentPathExcludes, pathIsExcluded, maskExcludedPaths, privateTurn, privateContinuityEvent, privateProgressionState, captureFailureReason, payloadReferencesExcludedResource, privateTransitionObservation } from '../../plugin/scripts/turn-capture-privacy.mjs';
import { captureTurnOutcome, resolveTurnDb, runSteps, turnRecordingStatus } from '../../plugin/scripts/turn-outcome-capture.mjs';
import { ProjectProgressionStore } from '../../plugin/scripts/project-progression-store.mjs';
import { ContinuityJournal, drain } from '../../plugin/scripts/continuity-journal.mjs';
import { createStore } from '../helpers/continuity-fixture.mjs';
import { enrichStateWithObservation } from '../../plugin/scripts/project-progression-hook.mjs';
import { buildProjectProgression } from '../../plugin/scripts/project-progression-producer.mjs';
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
  it('filters before the durable queue and rereads changed policy before exact delivery', () => {
    const h = fixture(); h.write({ paths: { [VAULT]: 'off' }, contentPathExcludes: [VAULT] });
    const transcript = path.join(h.home, 'mixed.jsonl'); const publicFile = path.join(h.projectDir, 'public.mjs');
    fs.writeFileSync(transcript, JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { file_path: publicFile } }, { type: 'tool_use', name: 'Read', input: { file_path: FILE } }, { type: 'text', text: `${SAFE} Read "${FILE}" using sk-syntheticprivacy0123456789.` }] } }) + '\n');
    let steps; const result = captureTurnOutcome({ ...h, event: 'Stop', host: 'claude', payload: { session_id: 's', transcript_path: transcript }, ruflo: process.execPath, launch: (items) => { steps = items; return {}; } });
    expect(result.queued).toBe(true); expect(result.recorded).toBe(false);
    expect(result.value).not.toContain(FILE); expect(result.value).not.toContain('sk-syntheticprivacy0123456789'); expect(result.value).toContain(publicFile);
    const journal = fs.readFileSync(steps[0].journalFile, 'utf8'); expect(journal).not.toContain(FILE);
    expect(JSON.parse(journal).binding.projectRoot).toBe(h.projectDir);
    h.write({ contentPathExcludes: [VAULT, '/second/private'] });
    let outgoing; const rows = runSteps({ steps }, { ...h, run: (_, args) => { outgoing = args[args.indexOf('--value') + 1]; return { status: 0 }; }, read: () => outgoing ?? null });
    expect(rows[0]).toMatchObject({ verified: true, status: 0 }); expect(outgoing).not.toContain(FILE);
    const breadcrumb = JSON.parse(fs.readFileSync(path.join(h.projectDir, '.swarm', 'agentdb-turns.jsonl'), 'utf8')); expect(Object.keys(breadcrumb).sort()).toEqual(['hash', 'key', 'len', 'ts']);
  });
  it('does not queue a private-only path-bearing outcome without safe public metadata', () => {
    const h = fixture(); h.write({ contentPathExcludes: [VAULT] });
    const launch = () => { throw new Error('must not launch private-only outcome'); };
    const result = captureTurnOutcome({ ...h, event: 'Stop', host: 'codex', payload: { session_id: 'private-only', last_assistant_message: `${SAFE} Read "${FILE}".` }, ruflo: process.execPath, launch });
    expect(result.queued).toBe(false); expect(result.skipped).toContain('explicitly excluded resource');
    expect(fs.existsSync(path.join(h.projectDir, '.swarm', 'turn-outbox'))).toBe(false); expect(fs.readFileSync(path.join(h.projectDir, '.swarm', 'memory.db'), 'utf8')).toBe('');
  });
  it('refuses newly excluded immutable turn content without writing or deleting the original journal', () => {
    const h = fixture(); h.write({}); let steps;
    captureTurnOutcome({ ...h, event: 'Stop', host: 'codex', payload: { session_id: 's', last_assistant_message: `${SAFE} "${FILE}"` }, ruflo: process.execPath, launch: (items) => { steps = items; return {}; } });
    const original = fs.readFileSync(steps[0].journalFile, 'utf8'); expect(original).toContain(FILE);
    h.write({ contentPathExcludes: [VAULT] }); let outgoing;
    const rows = runSteps({ steps }, { ...h, run: (_, args) => { outgoing = args[args.indexOf('--value') + 1]; return { status: 1, stderr: '[INFO] storing\n[ERROR] file is not a database' }; }, read: () => null });
    expect(outgoing).toBeUndefined(); expect(rows[0].error).toBe('content exclusions changed; immutable turn retained'); expect(rows[0].verified).toBe(false);
    expect(fs.readFileSync(steps[0].journalFile, 'utf8')).toBe(original);
  });
});

describe('bounded failure reasons and first-use disclosure', () => {
  it('resolves an existing symlink resource without reading its private body', () => {
    const h = fixture(); const privateDir = path.join(h.projectDir, 'private'); fs.mkdirSync(privateDir); const file = path.join(privateDir, 'client.md'); fs.writeFileSync(file, 'Synthetic private body');
    const alias = path.join(h.projectDir, 'public-link.md'); fs.symlinkSync(file, alias);
    expect(pathIsExcluded(alias, [privateDir], h.projectDir)).toBe(true); expect(maskExcludedPaths(`Read "${alias}"`, [privateDir], h.projectDir)).not.toContain(alias);
  });
  it('resolves existing directory aliases for missing leaf and nested suffix before Write or NotebookEdit failure capture', () => {
    const h = fixture(); const privateDir = path.join(h.projectDir, 'private'); const publicDir = path.join(h.projectDir, 'public');
    fs.mkdirSync(privateDir); fs.mkdirSync(publicDir); const alias = path.join(h.projectDir, 'public-alias'); const safeAlias = path.join(h.projectDir, 'safe-alias');
    fs.symlinkSync(privateDir, alias, 'dir'); fs.symlinkSync(publicDir, safeAlias, 'dir');
    for (const suffix of ['missing.md', 'nested/new-notebook.ipynb']) {
      const file = `${alias}/${suffix}`; expect(pathIsExcluded(file, [privateDir], h.projectDir)).toBe(true);
      for (const [tool, field] of [['Write', 'file_path'], ['NotebookEdit', 'notebook_path']]) {
        const payload = { hook_event_name: 'PostToolUse', tool_name: tool, tool_input: { [field]: file }, tool_response: { error: 'PRIVATE_BODY_TOKEN', exit_code: 1 } };
        expect(privateTransitionObservation({ id: 'same', error: 'PRIVATE_BODY_TOKEN' }, [privateDir], h.projectDir, payload).error).toBe('[REDACTED:excluded-resource-error]');
        expect(JSON.stringify(enrichStateWithObservation({ commands: [] }, payload, { contentPathExcludes: [privateDir], projectDir: h.projectDir }))).not.toContain('PRIVATE_BODY_TOKEN');
        const publicPayload = { ...payload, tool_input: { [field]: `${safeAlias}/${suffix}` } };
        expect(pathIsExcluded(`${safeAlias}/${suffix}`, [privateDir], h.projectDir)).toBe(false);
        expect(enrichStateWithObservation({ commands: [] }, publicPayload, { contentPathExcludes: [privateDir], projectDir: h.projectDir }).commands[0].error).toBe('PRIVATE_BODY_TOKEN');
      }
    }
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
  it('refuses a raw ledger-text plan ID or excluded evidence binding instead of rewriting it', () => {
    const state = { plan: [{ id: 'Inspect /project/private/client-title.md', status: 'open' }], currentGoal: 'Keep owner work active' }; const original = JSON.stringify(state);
    expect(() => privateProgressionState(state, ['/project/private'], '/project')).toThrow('immutable progression binding'); expect(JSON.stringify(state)).toBe(original);
    expect(() => privateProgressionState({ evidence: { transcript: { path: '/project/private/session.jsonl' } } }, ['/project/private'], '/project')).toThrow('immutable progression binding');
  });
  it('withholds actual Read output supplied by an explicitly excluded resource', () => {
    const state = enrichStateWithObservation({ commands: [], failures: [] }, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/project/public/../private/client-title.md' }, tool_response: { stdout: '# Confidential client title\nSensitive private body', exit_code: 0 } });
    const filtered = privateProgressionState(state, ['/project/private'], '/project');
    expect(JSON.stringify(filtered)).not.toContain('Confidential client'); expect(JSON.stringify(filtered)).not.toContain('Sensitive private body'); expect(filtered.commands[0].outcome).toBe('success'); expect(filtered.commands[0].stdout).toBe('[REDACTED:excluded-resource-output]');
    const mixed = enrichStateWithObservation({ commands: [], failures: [] }, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/project/private/client-title.md', command: 'status' }, tool_response: { stdout: '# Confidential client title', exit_code: 0 } });
    expect(JSON.stringify(privateProgressionState(mixed, ['/project/private'], '/project'))).not.toContain('Confidential client');
    const older = { commands: [{ filePath: '[REDACTED:excluded-path]', stdout: '# Confidential client title', outcome: 'success' }] };
    expect(JSON.stringify(privateProgressionState(older, ['/project/private'], '/project'))).not.toContain('Confidential client');
  });
  it.each(['file_path', 'notebook_path', 'path'])('classifies original %s resource and withholds private outputs while retaining public outputs', (field) => {
    const observe = (file) => ({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'NotebookEdit', tool_input: { [field]: file }, tool_response: { error: 'PRIVATE_BODY_TOKEN', exit_code: 1 } });
    const privacy = { contentPathExcludes: ['/project/private'], projectDir: '/project' };
    const privateState = enrichStateWithObservation({ commands: [], failures: [] }, observe('/project/private/client.ipynb'), privacy);
    expect(JSON.stringify(privateState)).not.toContain('PRIVATE_BODY_TOKEN'); expect(privateState.commands[0].outcome).toBe('failure');
    expect(privateTransitionObservation({ id: 'original', error: 'PRIVATE_BODY_TOKEN', signal: 'PRIVATE_SIGNAL_TOKEN' }, privacy.contentPathExcludes, privacy.projectDir, observe('/project/private/client.ipynb'))).toEqual({ id: 'original', error: '[REDACTED:excluded-resource-error]', signal: '[REDACTED:excluded-resource-signal]' });
    const publicPayload = observe('/project/public/client.ipynb'); expect(enrichStateWithObservation({ commands: [] }, publicPayload, privacy).commands[0].error).toBe('PRIVATE_BODY_TOKEN');
    expect(privateTransitionObservation({ error: 'public error' }, privacy.contentPathExcludes, privacy.projectDir, publicPayload).error).toBe('public error');
  });
  it.each(['command', 'cmd'])('classifies untruncated %s before bounding away an excluded reference', (field) => {
    const privacy = { contentPathExcludes: ['/project/private'], projectDir: '/project' };
    const observe = (dir) => ({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { [field]: `echo ${'x'.repeat(4100)}; cat /project/${dir}/client-title.md` }, tool_response: { stdout: 'PRIVATE_BODY_TOKEN', exit_code: 0 } });
    const privateState = enrichStateWithObservation({ commands: [] }, observe('private'), privacy);
    expect(privateState.commands[0].stdout).toBe('[REDACTED:excluded-resource-output]'); expect(privateState.commands[0].command).toBe('[REDACTED:excluded-resource-command]'); expect(privateState.commands[0].outcome).toBe('success');
    const publicState = enrichStateWithObservation({ commands: [] }, observe('public'), privacy);
    expect(publicState.commands[0].stdout).toBe('PRIVATE_BODY_TOKEN'); expect(publicState.commands[0].command).toContain('[truncated]');
  });
  it('classifies every supported resource alias on the normalized host envelope', () => {
    const payload = { hookEventName: 'post_tool_use', toolName: 'NotebookEdit', toolInput: { file_path: '/project/public/a', notebook_path: '/project/private/b' } };
    expect(payloadReferencesExcludedResource(payload, ['/project/private'], '/project')).toBe(true);
    expect(privateTransitionObservation({ id: 'same', error: 'PRIVATE_BODY_TOKEN' }, ['/project/private'], '/project', payload).error).toBe('[REDACTED:excluded-resource-error]');
  });
  it('uses the same raw-resource privacy classification in producer observation digests', () => {
    const h = fixture(); fs.rmSync(path.join(h.projectDir, '.swarm', 'memory.db')); createStore(path.join(h.projectDir, '.swarm', 'memory.db')); h.write({ contentPathExcludes: ['/project/private'] });
    const resolution = resolveProjectStore({ projectDir: h.projectDir });
    const produce = (privateResource, body) => buildProjectProgression({ resolution, projectDir: h.projectDir, host: 'claude', trigger: 'PostToolUse', env: { ...h.env, RUVNET_WORK_LEDGER: path.join(h.home, 'absent.json') }, now: () => '2026-10-05T00:00:00.000Z', payload: { session_id: 's', tool_name: 'Bash', tool_input: { command: `echo ${'x'.repeat(4100)}; cat /project/${privateResource ? 'private' : 'public'}/client-title.md` }, tool_response: { stdout: body, exit_code: 0 } } });
    expect(produce(true, 'PRIVATE_BODY_A').meaningDigest).toBe(produce(true, 'PRIVATE_BODY_B').meaningDigest);
    expect(produce(false, 'PUBLIC_BODY_A').meaningDigest).not.toBe(produce(false, 'PUBLIC_BODY_B').meaningDigest);
  });
  it('rereads exclusions before continuity delivery and refuses an older unfiltered same-ID row', () => {
    const h = fixture(); fs.rmSync(path.join(h.projectDir, '.swarm', 'memory.db')); createStore(path.join(h.projectDir, '.swarm', 'memory.db')); h.write({});
    const journal = new ContinuityJournal({ projectRoot: h.projectDir, projectDir: h.projectDir, env: h.env, ruflo: process.execPath });
    const original = { kind: 'decision', id: 'a'.repeat(64), at: new Date().toISOString(), summary: `Decision: inspect "${FILE}"`, detail: { command: `cat "${FILE}"` }, source: 'assistant-detected', authoritative: false };
    journal.record([original]); const bytes = fs.readFileSync(journal.path, 'utf8'); expect(bytes).toContain(FILE);
    h.write({ contentPathExcludes: [VAULT] }); let outgoing;
    const result = drain(journal, { store: ({ value }) => { outgoing = value; return { status: 1 }; }, readBack: () => ({ content: JSON.stringify(original), readPath: 'fixture' }), budgetMs: 1000 });
    expect(outgoing).toBeUndefined(); expect(result.committed).toBe(0); expect(result.skipped).toBe('content exclusions changed; immutable continuity retained');
    expect(journal.scan().events.size).toBe(1); expect(fs.readFileSync(journal.path, 'utf8')).toContain(FILE);
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
  it('filters derived event/state content while preserving all source and evidence identities', () => {
    const event = { id: 'original-id', project: '/project', source: 'tool-result', summary: `PASS inspect "${FILE}"`, detail: { command: `cat "${FILE}"`, files: [FILE, '/project/public.mjs'], sha: 'exact-sha' } };
    const filtered = privateContinuityEvent(event, [VAULT], '/project');
    expect(filtered.id).toBe(event.id); expect(filtered.source).toBe(event.source); expect(filtered.detail.files).toEqual(['/project/public.mjs']);
    expect(JSON.stringify(filtered)).not.toContain(FILE);
    const evidence = { transcript: { path: '/source/session.jsonl', excerptSha256: 'original-source-binding' } };
    const state = { currentGoal: `Inspect "${FILE}"`, nextAction: `Read "${FILE}"`, changedFiles: [FILE], commands: [{ command: `cat "${FILE}"`, outcome: 'success' }], evidence, provenance: { currentGoal: { source: 'transcript-derived', authoritative: false } } };
    const result = privateProgressionState(state, [VAULT], '/project');
    expect(result.currentGoal).not.toContain(FILE); expect(result.nextAction).not.toContain(FILE); expect(result.changedFiles).toEqual([]);
    expect(result.evidence).toBe(evidence); expect(result.provenance).toBe(state.provenance); expect(result.commands[0].outcome).toBe('success');
  });
  it('refuses delivery of a frozen progression when live exclusions changed, retaining original bytes', () => {
    const h = fixture(); h.write({});
    const snapshot = { sourceIdentity: { capturePath: h.projectDir, checkoutPath: h.projectDir }, completeProjectState: { currentGoal: `Inspect "${FILE}"` } };
    const original = JSON.stringify(snapshot); const context = { brainHome: h.brainHome, deadlineAt: Infinity, signal: undefined,
      resolution: { canonicalAgentDbPath: path.join(h.projectDir, '.swarm', 'memory.db') } };
    expect(() => ProjectProgressionStore.prototype.requireCaptureConsent.call(context, snapshot)).not.toThrow();
    h.write({ contentPathExcludes: [VAULT] });
    expect(() => ProjectProgressionStore.prototype.requireCaptureConsent.call(context, snapshot)).toThrow('frozen snapshot retained');
    expect(JSON.stringify(snapshot)).toBe(original);
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
