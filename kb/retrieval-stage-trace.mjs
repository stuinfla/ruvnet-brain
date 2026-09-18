import fs from 'node:fs';

// Explicit local diagnostics only. A failed trace destination must not change a retrieval answer.
export function appendStageTrace(record) {
  const target = process.env.KB_RETRIEVAL_STAGE_TRACE;
  if (!target) return;
  try { fs.appendFileSync(target, `${JSON.stringify({ schema: 1, ...record })}\n`, { mode: 0o600 }); }
  catch (error) { if (process.env.KB_DEBUG) console.error(`[retrieval] stage trace unavailable: ${error.message}`); }
}
