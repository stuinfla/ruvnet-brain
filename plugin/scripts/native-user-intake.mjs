/** Native user records are evidence; intake alone never grants execution authority. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { normalizeHostEvent } from './hook-input.mjs';
import { resolveTurnDb } from './turn-outcome-capture.mjs';
import { currentTurnRecords, CONTINUITY_NAMESPACE, eventKey } from './continuity-events.mjs';
import { ContinuityJournal } from './continuity-journal.mjs';
import { resolveProjectStore } from './project-store-resolver.mjs';
import { withProgressionReader } from './project-progression-reader.mjs';
import { rufloRunDir } from './project-progression-store.mjs';
import { rufloInvocation } from './ruflo-bin.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const text = (content, type) => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter((item) => item?.type === type && typeof item.text === 'string').map((item) => item.text).join('\n') : '';
const unverified = (reason) => ({ status: 'UNVERIFIED', reason });

/** Header identity and current-turn tail belong to one owned inode and one stable size tuple. */
function nativeTranscriptWindows(file, check) {
  if (typeof process.getuid !== 'function') throw new Error('native transcript owner proof unavailable on this host');
  check(); const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || (process.getuid && before.uid !== BigInt(process.getuid()))) throw new Error('native transcript is not an owned regular source');
    const size = Number(before.size), tailBytes = 2 * 1024 * 1024, headerBytes = 256 * 1024;
    if (!Number.isSafeInteger(size)) throw new Error('native transcript size unverified');
    const read = (offset, length) => {
      const buffer = Buffer.alloc(length); let got = 0;
      while (got < length) { check(); const count = fs.readSync(fd, buffer, got, Math.min(65536, length - got), offset + got);
        if (!count) throw new Error('native transcript truncated during capture'); got += count; }
      const lines = buffer.toString('utf8').split('\n');
      if (offset > 0) lines.shift();
      if (offset + length < size) lines.pop();
      return lines;
    };
    const header = read(0, Math.min(size, headerBytes));
    const tail = read(Math.max(0, size - tailBytes), Math.min(size, tailBytes));
    check(); const after = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(file, { bigint: true });
    if (current.isSymbolicLink() || !['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every((field) => before[field] === after[field] && after[field] === current[field])) throw new Error('native transcript changed during capture');
    const parse = (lines) => lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    return { header: parse(header), records: parse(tail), lines: tail };
  } finally { fs.closeSync(fd); }
}

/** Read only the current genuine user record, never tool results or compaction summaries. */
export function verifyNativeUserRecord(projectDir, { payload, host, deadlineAt = Infinity, signal, parentRead = false } = {}) {
  const check = () => { if (signal?.aborted || Date.now() >= deadlineAt) throw new Error('native intake deadline exceeded or aborted'); };
  check(); const input = normalizeHostEvent(payload) || {};
  if ((!parentRead && !['UserPromptSubmit', 'PreToolUse', 'Stop'].includes(input.hook_event_name)) || !['codex', 'claude'].includes(host)) return unverified('unsupported native user boundary');
  if (!input.session_id || !input.transcript_path || (input.hook_event_name === 'UserPromptSubmit' && (typeof input.prompt !== 'string' || !input.prompt.trim()))) return unverified('native user identity or prompt missing');
  if (!input.cwd || fs.realpathSync.native(input.cwd) !== fs.realpathSync.native(projectDir)) return unverified('native project provenance mismatch');
  const { header, records, lines } = nativeTranscriptWindows(input.transcript_path, check);
  let record; let nativeId; let userText;
  if (host === 'codex') {
    const meta = header.find((item) => item.type === 'session_meta')?.payload;
    const turn = records.filter((item) => item.type === 'turn_context').at(-1)?.payload;
    const turnId = parentRead ? input.turn_id ?? turn?.turn_id : input.turn_id;
    if (meta?.source && typeof meta.source === 'object' || meta?.parent_thread_id || meta?.parentThreadId) return unverified('native child/delegated session is not the human parent intake');
    if (!meta || meta.id !== input.session_id || !turn || !turnId || turn.turn_id !== turnId
      || fs.realpathSync.native(meta.cwd) !== fs.realpathSync.native(projectDir)
      || fs.realpathSync.native(turn.cwd) !== fs.realpathSync.native(projectDir)) return unverified('native session or current turn provenance mismatch');
    record = records.filter((item) => item.type === 'response_item' && item.payload?.type === 'message' && item.payload?.role === 'user').at(-1);
    if (!record || !record.payload.id || record.metadata?.retained_source?.complete !== true
      || record.metadata.retained_source.id?.role !== 'user' || record.metadata.retained_source.id.message_id !== record.payload.id
      || record.metadata.retained_source.id.turn_id !== turnId
      || record.payload.internal_chat_message_metadata_passthrough?.turn_id !== turnId) return unverified('current native user record not yet exposed');
    userText = text(record.payload.content, 'input_text');
    nativeId = { kind: 'codex-turn-id', id: turnId, recordId: record.payload.id, ordinal: record.ordinal };
  } else {
    const current = currentTurnRecords(lines);
    record = records.filter((item) => item.type === 'user' && item.message?.role === 'user'
      && !item.isMeta && !item.isCompactSummary && !item.isSidechain && !item.message.content?.some?.((part) => part?.type === 'tool_result')
      && text(item.message.content, 'text').trim()).at(-1);
    if (!record?.uuid || record.sessionId !== input.session_id || !record.cwd
      || fs.realpathSync.native(record.cwd) !== fs.realpathSync.native(projectDir)
      || !record.promptId || ((!parentRead || input.prompt_id !== undefined) && input.prompt_id !== record.promptId)) return unverified('current native prompt record identity unavailable');
    userText = text(record.message.content, 'text');
    if (sha(current.userMessage) !== sha(userText)) return unverified('current native user boundary differs');
    nativeId = { kind: 'claude-prompt-id', id: record.promptId, recordId: record.uuid };
  }
  if (!userText?.trim() || (input.prompt !== undefined && sha(userText) !== sha(input.prompt))) return unverified('native prompt digest mismatch');
  check(); return { status: 'verified', userInstructionDigest: sha(userText), nativeSessionId: input.session_id,
    nativeUserEventRef: { ...nativeId, transcriptPathDigest: sha(fs.realpathSync.native(input.transcript_path)), recordSha256: sha(JSON.stringify(record)) } };
}

/** Fsync through the existing journal and expose a receipt only for exact committed bytes. */
export function runNativeUserIntake(projectDir, { payload, host, env = process.env, deadlineAt = Date.now() + 2500, signal,
  journalFactory = (options) => new ContinuityJournal(options), parentRead = false } = {}) {
  try {
    const native = verifyNativeUserRecord(projectDir, { payload, host, deadlineAt, signal, parentRead });
    if (native.status !== 'verified') return native;
    const consent = resolveTurnDb({ projectDir, brainHome: env.RUVNET_BRAIN_HOME || path.join(env.HOME || os.homedir(), '.cache', 'ruvnet-brain'), deadlineAt, signal });
    if (consent.skipped) return unverified(consent.skipped);
    const resolution = resolveProjectStore({ projectDir, deadlineAt });
    const detail = { schemaVersion: 1, kind: 'native-user-intake', status: 'native-user-intake', host,
      origin: { kind: 'native-transcript' },
      nativeSessionId: native.nativeSessionId, nativePromptId: native.nativeUserEventRef.id,
      projectId: resolution.projectIdentity.id, worktreeId: sha(resolution.checkoutRoot),
      userInstructionDigest: native.userInstructionDigest, nativeUserEventRef: native.nativeUserEventRef };
    const event = { kind: 'decision', authoritative: false, id: sha(JSON.stringify(detail)), at: new Date().toISOString(),
      source: 'nativeUserPromptSubmit', summary: 'Verified native user intake; no execution authority granted', detail };
    const journal = journalFactory({ projectRoot: resolution.projectRoot, projectDir, env, deadlineAt, signal });
    journal.record([event]);
    const stored = [...journal.scan().events.values()].find((row) => row.event.id === event.id && row.event.kind === event.kind);
    if (!stored || stored.event.source !== event.source || stored.event.authoritative !== false
      || JSON.stringify(stored.event.detail) !== JSON.stringify(detail)) return unverified('native intake privacy policy rejected immutable evidence');
    const value = JSON.stringify(stored.event); const key = eventKey(stored.event);
    const read = () => withProgressionReader(resolution.canonicalAgentDbPath, (reader) => reader.readContent(CONTINUITY_NAMESPACE, key), { deadlineAt, signal });
    let back = read();
    if ((!back.ok || back.value !== value) && journal.ruflo) {
      journal.requireBudget(); const cwd = rufloRunDir(resolution.canonicalAgentDbPath);
      try {
        const invocation = rufloInvocation(journal.ruflo, ['memory', 'store', '--key', key, '--value', value, '--namespace', CONTINUITY_NAMESPACE,
          '--no-upsert', '--provenance', 'system_observation', '--path', resolution.canonicalAgentDbPath]);
        spawnSync(invocation.executable, invocation.args, { cwd, encoding: 'utf8', timeout: Math.max(1, Math.floor(deadlineAt - Date.now())), killSignal: 'SIGKILL',
          env: { ...env, RUFLO_DAEMON_AUTOSTART: '0' } });
      } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
      journal.requireBudget(); back = read();
    }
    if (!back.ok || back.value !== value) return unverified('native intake pending exact canonical readback');
    journal.appendRecords([{ type: 'commit', key, digest: stored.digest, committedAt: new Date().toISOString(), readPath: 'canonical progression reader' }]);
    return { status: 'verified', origin: { kind: 'native-transcript' }, receipt: { namespace: CONTINUITY_NAMESPACE, key, valueSha256: sha(value) },
      nativeUserEventRef: native.nativeUserEventRef, binding: { ...detail, userInstructionRef: key } };
  } catch (error) { return unverified(error.message); }
}

/** Before planning, consult the actual native parent source, not a copied context summary.
 * The caller supplies the existing Codex native-observation reader; no host/model is launched. */
export async function collectManagedNativeUserIntake(request, { env = process.env, readCodexObservation,
  deadlineAt = Math.min(request.deadline ?? Infinity, Date.now() + 1900), signal,
  nativeUserEventRef = request.nativeUserInstruction?.nativeUserEventRef } = {}) {
  const pending = (reason) => ({ ...unverified(reason), state: 'PENDING_NATIVE_PROVENANCE' });
  try {
    const host = request.harness === 'codex' ? 'codex' : request.harness === 'claude-code' ? 'claude' : null;
    const sessionId = request.nativeContext?.threadId ?? request.nativeContext?.sessionId;
    if (!host || !/^[a-f0-9-]{36}$/i.test(sessionId ?? '') || typeof request.originalPrompt !== 'string' || !request.originalPrompt.trim()) return pending('actual native parent/current user identity unavailable');
    if (nativeUserEventRef?.kind !== (host === 'codex' ? 'codex-turn-id' : 'claude-prompt-id')
      || !nativeUserEventRef.id || !nativeUserEventRef.recordId || !/^[a-f0-9]{64}$/.test(nativeUserEventRef.recordSha256 ?? '')) {
      return pending('current native USER record reference unavailable; parent history or a claimed SID cannot bind this new request');
    }
    const home = env.HOME || os.homedir(); let transcript;
    if (host === 'codex') {
      if (typeof readCodexObservation !== 'function') return pending('existing native Codex source reader unavailable');
      const nativeHome = fs.realpathSync(env.CODEX_HOME || path.join(home, '.codex'));
      const observed = await readCodexObservation(sessionId, { home: nativeHome, allowHistory: true, deadline: deadlineAt, signal });
      transcript = observed?.evidence?.path;
      if (observed?.sessionId !== sessionId || typeof transcript !== 'string' || !transcript.startsWith(path.join(nativeHome, 'sessions') + path.sep)
        || fs.realpathSync(transcript) !== transcript) return pending('actual native Codex parent source unavailable');
    } else {
      const projects = fs.realpathSync(path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects'));
      const matches = [];
      for (const directory of fs.readdirSync(projects)) {
        if (signal?.aborted || Date.now() >= deadlineAt) throw new Error('native parent intake deadline exceeded');
        const folder = path.join(projects, directory), stat = fs.lstatSync(folder);
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        const file = path.join(folder, `${sessionId}.jsonl`);
        if (fs.existsSync(file) && fs.realpathSync(file) === file) matches.push(file);
      }
      if (matches.length !== 1) return pending('actual native Claude parent source unavailable or ambiguous');
      [transcript] = matches;
    }
    // Expected SID/project/text are request bindings, not fabricated hook-event fields. The
    // source guard derives turn/prompt IDs exclusively from the current genuine native record.
    const payload = { session_id: sessionId, cwd: request.projectRoot, transcript_path: transcript, prompt: request.originalPrompt,
      ...(host === 'codex' ? { turn_id: nativeUserEventRef.id } : { prompt_id: nativeUserEventRef.id }) };
    const current = verifyNativeUserRecord(request.projectRoot, { host, payload, deadlineAt, signal, parentRead: true });
    if (current.status !== 'verified' || JSON.stringify(current.nativeUserEventRef) !== JSON.stringify(nativeUserEventRef)) return pending('current native USER source reference differs from the submitted native boundary');
    const result = runNativeUserIntake(request.projectRoot, { host, env, deadlineAt, signal, parentRead: true, payload });
    if (result.status === 'verified' && JSON.stringify(result.nativeUserEventRef) !== JSON.stringify(nativeUserEventRef)) return pending('current native USER source reference differs from the submitted native boundary');
    return result.status === 'verified' ? result : pending(result.reason);
  } catch (error) { return pending(error.message); }
}
