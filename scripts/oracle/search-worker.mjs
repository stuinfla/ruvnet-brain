import { pathToFileURL } from 'node:url';

const entry = process.argv[2];
if (!entry) process.exit(64);
process.on('disconnect', () => process.exit(0));
let searchAll;
try {
  const loaded = await import(pathToFileURL(entry).href);
  if (typeof loaded.searchAll !== 'function') throw new Error('search entry does not export searchAll');
  searchAll = loaded.searchAll;
  if (process.argv[3] === 'warmup') {
    if (typeof loaded.warmQueryEmbedder !== 'function') throw new Error('search warmup failed: search entry does not export warmQueryEmbedder');
    try { await loaded.warmQueryEmbedder(); } catch (error) { throw new Error(`search warmup failed: ${String(error?.message || error)}`); }
  }
  process.send?.({ type: 'ready' });
} catch (error) {
  process.send?.({ type: 'init-error', error: String(error?.message || error) });
  process.exitCode = 1;
}

process.on('message', async (message) => {
  if (message?.type !== 'search' || typeof searchAll !== 'function') return;
  try {
    const { timeoutMs: _timeoutMs, ...request } = message.request || {};
    const result = await searchAll(request);
    process.send?.({ type: 'result', id: message.id, result });
  } catch (error) {
    process.send?.({ type: 'error', id: message.id, error: String(error?.message || error) });
  }
});
