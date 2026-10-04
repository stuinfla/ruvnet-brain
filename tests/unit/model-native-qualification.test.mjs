import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { runNativeQualification, inspectNativeQualificationHost } from '../../scripts/model-native-qualification.mjs';

const usage = () => ({ rate_limits_available: true, rate_limits: { extra_usage: { is_enabled: false }, five_hour: { utilization: 4, locked_reason: null }, seven_day: { utilization: 7, locked_reason: null }, model_scoped: [], limits: [] } });
function fixture(host, variation = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'native-qualification-test-'));
  const binary = path.join(cwd, 'native'); fs.writeFileSync(binary, 'fixture native binary');
  const packets = []; let child;
  const options = { host, binary, cwd, model: host === 'codex' ? 'gpt-6.1-sol' : 'claude-sonnet-4-6', effort: 'medium', prompt: 'Return the word READY.',
    deadline: Date.now() + 2000, env: { OPENAI_API_KEY: 'must-not-pass', ANTHROPIC_API_KEY: 'must-not-pass' },
    versionProbe: () => host === 'codex' ? 'codex-cli 0.160.0' : '2.1.289 (Claude Code)', authCheck: () => {},
    spawnHost: (_binary, args, opts) => {
      expect(opts.env.OPENAI_API_KEY).toBeUndefined(); expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined(); expect(opts.shell).toBe(false);
      if (host === 'claude-code') expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual(['--tools', '']);
      child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = [];
      child.kill = (signal) => { child.killed.push(signal); queueMicrotask(() => child.emit('close')); };
      const emit = (packet) => child.stdout.write(`${JSON.stringify(packet)}\n`);
      child.stdin = new Writable({ write(bytes, _encoding, done) {
        const p = JSON.parse(bytes.toString()); packets.push(p); done();
        queueMicrotask(() => {
          if (variation.stall) return;
          if (host === 'codex') {
            const respond = (result) => emit({ id: p.id, result });
            if (p.method === 'initialize') respond({});
            if (p.method === 'account/read') respond({ account: { type: 'chatgpt', email: 'private@example.invalid' } });
            if (p.method === 'account/rateLimits/read') respond({ ordinaryUsageAllowed: variation.allowance !== false });
            if (p.method === 'model/list') respond({ data: [{ model: options.model, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }], nextCursor: null });
            if (p.method === 'thread/start') respond({ thread: { id: 'native-thread' } });
            if (p.method === 'thread/read') respond({ thread: { id: 'native-thread', model: options.model, reasoningEffort: 'medium', modelProvider: 'openai' } });
            if (p.method === 'thread/settings/update') {
              respond({});
              if (!p.params.model || !p.params.effort) return; // Native empty updates emit nothing.
              emit({ method: 'thread/settings/updated', params: { threadId: 'native-thread', threadSettings: { model: variation.mismatch ? 'different-model' : options.model, effort: 'medium', modelProvider: 'openai', serviceTier: 'default' } } });
            }
            if (p.method === 'turn/start') {
              respond({ turn: { id: 'native-turn' } });
              if (variation.tool) return emit({ id: 'tool-request', method: 'item/commandExecution/requestApproval', params: {} });
              emit({ method: 'item/completed', params: { threadId: 'native-thread', turnId: 'unrelated-turn', item: { type: 'agentMessage', text: 'IGNORE' } } });
              emit({ method: 'item/completed', params: { threadId: 'native-thread', turnId: 'native-turn', item: { type: 'agentMessage', text: 'READY' } } });
              emit({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'native-turn', status: 'completed' } } });
            }
          } else {
            const respond = (response) => emit({ type: 'control_response', response: { subtype: 'success', request_id: p.request_id, response } });
            if (p.request?.subtype === 'initialize') respond({ session_state: 'idle', models: [{ value: 'sonnet', resolvedModel: options.model, supportsEffort: true, supportedEffortLevels: ['medium'] }] });
            if (p.request?.subtype === 'get_usage') respond(variation.allowance === false ? {} : usage());
            if (p.request?.subtype === 'apply_flag_settings') respond({});
            if (p.request?.subtype === 'get_settings') respond({ applied: { model: variation.mismatch ? 'different-model' : options.model, effort: 'medium' } });
            if (p.type === 'user') emit({ type: 'result', subtype: 'success', is_error: false, result: 'READY', session_id: 'native-session', uuid: 'native-completion', duration_api_ms: 1, num_turns: 1, usage: {} });
          }
        });
      } });
      return child;
    } };
  return { options, packets, get child() { return child; }, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

describe('native qualification identity and safety boundaries', () => {
  it('binds actual settings, matching native completion and redacted protocol bytes for both hosts', async () => {
    for (const host of ['codex', 'claude-code']) {
      const f = fixture(host);
      try {
        const r = await runNativeQualification(f.options);
        expect(r.failure).toBeUndefined(); expect(r.completed).toBe(true); expect(r.output).toBe('READY');
        expect(r.nativeModel).toBe(f.options.model); expect(r.nativeEffort).toBe('medium'); expect(r.backendIdentityProved).toBe(false);
        expect(r.sourceReceipt.nativeSettings.before.model).toBe(r.nativeModel); expect(r.sourceReceipt.nativeSettings.after.effort).toBe(r.nativeEffort);
        expect(r.sourceReceipt.nativeTurn).toMatchObject({ status: 'completed', toolEvents: [] });
        if (host === 'codex') {
          expect(f.packets.filter((p) => p.method === 'thread/settings/update')).toHaveLength(1);
          expect(f.packets.filter((p) => p.method === 'thread/read')).toHaveLength(1);
          expect(r.sourceReceipt.nativeSettings.after.serviceTier).toBeUndefined();
          expect(r.sourceReceipt.nativeSettings.after.serviceTierBasis).toBe('pre-turn-native-settings-and-fixed-host-configuration');
        }
        expect(r.transcriptSha256).toBe(crypto.createHash('sha256').update(r.transcript).digest('hex'));
        expect(r.transcript).not.toContain('private@example.invalid'); expect(f.child.killed).toEqual(['SIGTERM']);
      } finally { f.cleanup(); }
    }
  });
  it('performs native discovery without sending any inference turn and uses resolved Claude model IDs', async () => {
    for (const host of ['codex', 'claude-code']) {
      const f = fixture(host);
      try {
        const r = await inspectNativeQualificationHost(f.options);
        expect(r.available).toBe(true); expect(r.nativeSubscription).toBe(true); expect(r.completed).toBe(false);
        expect(f.packets.some((p) => p.method === 'turn/start' || p.type === 'user')).toBe(false);
        expect(r.catalogStatus).toBe('verified');
        expect(r.models).toEqual([{ id: f.options.model, efforts: ['medium'] }]);
      } finally { f.cleanup(); }
    }
  });
  it('fails closed before inference for unknown allowance or mismatched actual native settings', async () => {
    for (const host of ['codex', 'claude-code']) for (const variation of [{ allowance: false }, { mismatch: true }]) {
      const f = fixture(host, variation);
      try {
        const r = await runNativeQualification(f.options);
        expect(r.completed).toBe(false); expect(r.failure).toMatch(/allowance|mismatch/); expect(r.output).toBe('');
        expect(f.packets.some((p) => p.method === 'turn/start' || p.type === 'user')).toBe(false);
      } finally { f.cleanup(); }
    }
  });
  it('refuses tool inference and terminates stalled native processes at the shared deadline', async () => {
    for (const variation of [{ tool: true }, { stall: true }]) {
      const f = fixture('codex', variation); f.options.deadline = Date.now() + 80;
      try {
        const r = await runNativeQualification(f.options);
        expect(r.completed).toBe(false);
        expect(r.failure).toMatch(variation.tool ? /tool inference refused/ : /deadline exhausted|Native metadata timeout: initialize/);
        expect(f.child.killed).toContain('SIGTERM'); expect(r.elapsedMs).toBeLessThan(500);
      } finally { f.cleanup(); }
    }
  });
});
