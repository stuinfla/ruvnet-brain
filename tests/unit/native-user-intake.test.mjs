import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyNativeUserRecord, runNativeUserIntake, collectManagedNativeUserIntake } from '../../plugin/scripts/native-user-intake.mjs';

const fallback = vi.hoisted(() => ({ miss: false, observe: false, timeouts: [] }));
vi.mock('../../plugin/scripts/project-progression-reader.mjs', async (original) => {
  const actual = await original();
  return { ...actual, withProgressionReader: (file, work, options) => actual.withProgressionReader(file, reader => work(new Proxy(reader, {
    get(target, key) {
      if (key === 'readContent') return (...args) => {
        if (fallback.miss) { fallback.miss = false; return { ok: false, reason: 'controlled first-read miss' }; }
        return target.readContent(...args);
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    },
  })), options) };
});
vi.mock('node:child_process', async (original) => {
  const actual = await original();
  return { ...actual, spawnSync: (...args) => {
    if (fallback.observe) fallback.timeouts.push(args[2]?.timeout);
    return actual.spawnSync(...args);
  } };
});

const transcript = process.env.RNB_NATIVE_USER_FIXTURE;
const native = transcript && fs.existsSync(transcript);
const suite = native ? describe : describe.skip;
suite('actual retained native Codex user fixture', () => {
  const records = native ? fs.readFileSync(transcript, 'utf8').trim().split('\n').map(JSON.parse) : [];
  const session = records.find((record) => record.type === 'session_meta')?.payload;
  const current = records.filter((record) => record.type === 'response_item' && record.payload.role === 'user').at(-1);
  const payload = native ? { hook_event_name: 'UserPromptSubmit', session_id: session.id,
    turn_id: current.metadata.retained_source.id.turn_id, transcript_path: transcript, cwd: session.cwd,
    prompt: current.payload.content.filter((item) => item.type === 'input_text').map((item) => item.text).join('\n') } : {};
  it('binds actual retained user identity and preserves privacy', () => {
    const result = verifyNativeUserRecord(session.cwd, { payload, host: 'codex' });
    expect(result.status).toBe('verified');
    expect(result.nativeUserEventRef.recordId).toBe(current.payload.id);
    expect(result.nativeUserEventRef.ordinal).toBe(current.ordinal);
    expect(result.userInstructionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain(payload.prompt);
  });
  it.each(['wrong prompt', 'wrong turn', 'wrong session', 'assistant boundary'])('rejects %s', (change) => {
    const altered = { ...payload };
    if (change === 'wrong prompt') altered.prompt += '\nAdditional invented instruction';
    if (change === 'wrong turn') altered.turn_id = 'old-turn';
    if (change === 'wrong session') altered.session_id = 'foreign-session';
    if (change === 'assistant boundary') altered.hook_event_name = 'PostToolUse';
    expect(verifyNativeUserRecord(session.cwd, { payload: altered, host: 'codex' }).status).toBe('UNVERIFIED');
  });
  it.each(['PreToolUse', 'Stop'])('revalidates the genuine current user record at late %s without inventing prompt text', (event) => {
    const late = { ...payload, hook_event_name: event }; delete late.prompt;
    const result = verifyNativeUserRecord(session.cwd, { payload: late, host: 'codex' });
    expect(result.status).toBe('verified'); expect(result.nativeUserEventRef.recordId).toBe(current.payload.id);
    expect(result.userInstructionDigest).toBe(verifyNativeUserRecord(session.cwd, { payload, host: 'codex' }).userInstructionDigest);
  });
  it('keeps genuine header identity after a long transcript prefix and rejects a changing same-FD source', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-current-source-'));
    const file = path.join(directory, 'long.jsonl');
    const turn = records.filter((item) => item.type === 'turn_context').at(-1);
    const body = [JSON.stringify(records[0]), JSON.stringify({ type: 'diagnostic-padding', padding: 'x'.repeat(3 * 1024 * 1024) }),
      JSON.stringify(turn), JSON.stringify(current)].join('\n') + '\n';
    fs.writeFileSync(file, body);
    try {
      expect(verifyNativeUserRecord(session.cwd, { payload: { ...payload, transcript_path: file }, host: 'codex' }).status).toBe('verified');
      const originalRead = fs.readSync.bind(fs); let changed = false;
      const spy = vi.spyOn(fs, 'readSync').mockImplementation((...args) => {
        const value = originalRead(...args);
        if (!changed) { changed = true; fs.appendFileSync(file, '\n'); }
        return value;
      });
      try { expect(() => verifyNativeUserRecord(session.cwd, { payload: { ...payload, transcript_path: file }, host: 'codex' })).toThrow(/changed during capture/); }
      finally { spy.mockRestore(); }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it('fails closed before deadline and never exposes a receipt', () => {
    const result = runNativeUserIntake(session.cwd, { payload, host: 'codex', deadlineAt: Date.now() - 1 });
    expect(result.status).toBe('UNVERIFIED'); expect(result.receipt).toBeUndefined();
  });
  it('a fractional intake deadline permits the real Ruflo fallback and exact existing-row readback', () => {
    fallback.miss = true; fallback.observe = true; fallback.timeouts = [];
    try {
      const result = runNativeUserIntake(session.cwd, { payload, host: 'codex', deadlineAt: Date.now() + 6500.5,
        env: { ...process.env, RUVNET_BRAIN_HOME: path.resolve(path.dirname(transcript), '../../../../../.cache/ruvnet-brain') } });
      expect(result.status).toBe('verified'); expect(result.receipt.valueSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(fallback.timeouts.length).toBeGreaterThan(0);
      expect(fallback.timeouts.every(value => Number.isInteger(value) && value > 0)).toBe(true);
    } finally { fallback.miss = false; fallback.observe = false; }
  });
});

it('unsupported native boundary provides no canonical task pointer', () => {
  const result = runNativeUserIntake('/unavailable', { host: 'codex', payload: { hook_event_name: 'UserPromptSubmit' } });
  expect(result.status).toBe('UNVERIFIED'); expect(result.binding).toBeUndefined(); expect(result.receipt).toBeUndefined();
});

it('managed first prompt cannot promote a claimed SID or prior native history into current user intent', async () => {
  const sourceReader = vi.fn();
  const result = await collectManagedNativeUserIntake({ harness: 'codex', projectRoot: '/unavailable',
    originalPrompt: 'Actual new terminal input not yet delivered to native parent', nativeContext: { threadId: '01a115f5-82fc-7140-b28c-f088bcbb52a9' } },
    { readCodexObservation: sourceReader });
  expect(result.state).toBe('PENDING_NATIVE_PROVENANCE'); expect(result.receipt).toBeUndefined(); expect(result.binding).toBeUndefined();
  expect(sourceReader).not.toHaveBeenCalled();
});
