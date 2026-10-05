import runtime from './runtime.js';
import { createTurnCache, inspectDecision, classificationText, refusalStream, REFUSAL } from './routing.js';
export function register(on) {
  const cache = createTurnCache();
  let ready = false;
  on('session.start', async ($, e, next) => {
    ready = false; cache.clear();
    const nonce = await $.env.get('RNB_CLAUDE_MOD_NONCE');
    const receiptPath = await $.env.get('RNB_CLAUDE_MOD_RECEIPT');
    const version = (await $.session.version()).version;
    const sessionId = await $.session.id();
    const pluginRoot = $.plugin.root;
    const result = await $.process.run([runtime.nodePath, runtime.helperPath, '--ready'], {
      stdin: JSON.stringify({ nonce, receiptPath, version, sessionId, pluginRoot }), timeoutMs: 8000,
    });
    if (result.exitCode !== 0) throw new Error(REFUSAL);
    const receipt = JSON.parse(result.stdout);
    if (receipt.nonce !== nonce || receipt.status !== 'ready') throw new Error(REFUSAL);
    ready = true; return next(e);
  }).catch(($, e) => { ready = false; return { cwd: e.cwd }; });
  on('prompt.submit', async ($, e, next) => {
    // Direct delivery into a running turn has no authoritative new turn.start boundary.
    if (e.turnId && !e.wait) return { drop: REFUSAL };
    if (!ready || typeof e.text !== 'string' || (!e.text.trim() && !e.attachments?.length) || e.text.length > 200000) return { drop: REFUSAL };
    const result = await $.process.run([runtime.nodePath, runtime.helperPath, '--decision'], {
      stdin: JSON.stringify({ prompt: classificationText(e.text, e.attachments), enginePath: runtime.enginePath, policyPath: runtime.policyPath }), timeoutMs: 8000,
    });
    if (result.exitCode !== 0) return { drop: REFUSAL };
    const now = await $.clock.now();
    const decision = inspectDecision(JSON.parse(result.stdout), classificationText(e.text, e.attachments), now);
    const entry = cache.enqueue(e.text, decision, now);
    try {
      const answer = await next(e);
      if ('drop' in answer) cache.remove(entry);
      return answer;
    } catch (error) { cache.remove(entry); throw error; }
  }).catch(() => ({ drop: REFUSAL }));
  on('turn.start', async ($, e, next) => {
    if (!ready) throw new Error(REFUSAL);
    const now = await $.clock.now();
    const pending = cache.pending();
    if (!pending) throw new Error(REFUSAL);
    if (pending?.text === e.text) cache.bind(e, now);
    else {
      // Settings hooks may settle a different prompt. Reassess with the original class floor.
      const minimumClass = pending?.decision.taskClass;
      const text = classificationText(e.text, pending ? [{}] : undefined);
      const result = await $.process.run([runtime.nodePath, runtime.helperPath, '--decision'], {
        stdin: JSON.stringify({ prompt: text, minimumClass, enginePath: runtime.enginePath, policyPath: runtime.policyPath }), timeoutMs: 8000,
      });
      if (result.exitCode !== 0) throw new Error(REFUSAL);
      const decision = inspectDecision(JSON.parse(result.stdout), text, now, minimumClass);
      cache.bind(e, now, decision);
    }
    return next(e);
  }).catch(($, e) => ({ turnId: e.turnId }));
  on('turn.step', async function* ($, e, next) {
    if (!ready) return yield* refusalStream(e);
    const decision = cache.get(e, await $.clock.now());
    return yield* next({ ...e, model: decision.model, effort: decision.effort });
  }).catch(async function* ($, e) { return yield* refusalStream(e); });
  on('turn.complete', async ($, e, next) => { cache.complete(e.turnId); return next(e); })
    .catch(($, e) => { cache.complete(e.turnId); return { text: REFUSAL }; });
  on('session.end', async ($, e, next) => { ready = false; cache.clear(); return next(e); })
    .catch(($, e) => { ready = false; cache.clear(); return { sessionId: e.sessionId }; });
}
