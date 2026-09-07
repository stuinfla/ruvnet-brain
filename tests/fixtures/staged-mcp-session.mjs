import fs from 'node:fs';
import crypto from 'node:crypto';
import readline from 'node:readline';
const trace = (event, extra = {}) => fs.appendFileSync(process.env.SESSION_TRACE, JSON.stringify({ event, pid: process.pid, ...extra }) + '\n');
trace('start');
process.on('SIGTERM', () => { trace('terminate'); if (process.env.IGNORE_TERM !== '1') process.exit(0); });
const lines = readline.createInterface({ input: process.stdin });
lines.on('close', () => {
  trace('closed');
  if (process.env.IGNORE_TERM !== '1') process.exit(0);
  else setInterval(() => {}, 1000);
});
lines.on('line', (line) => {
  const request = JSON.parse(line);
  const send = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  if (request.method === 'initialize') { trace('initialize'); send({}); }
  if (request.method === 'tools/list') send({ tools: [{ name: 'search_ruvnet' }] });
  if (request.method === 'tools/call') {
    const { query, k } = request.params.arguments;
    trace('search', { query, k });
    if (query === 'split-utf8') {
      const text = 'source ─ 🧠 exact';
      const result = { content: [{ text }], structuredContent: { retrieval: {
        schemaVersion: 1, kind: 'ruvnet-brain.retrieval-result', query, k,
        results: [{ rank: 1, repo: 'fixture', path: 'README.md', text,
          contentSha256: crypto.createHash('sha256').update(text).digest('hex') }],
      } } };
      const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
      const cuts = [];
      for (let i = 0; i < bytes.length; i++) if (bytes[i] >= 0xc0) cuts.push(i + 1);
      cuts.push(bytes.length);
      void (async () => {
        let start = 0;
        for (const end of cuts) {
          process.stdout.write(bytes.subarray(start, end)); start = end;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      })();
      return;
    }
    if (query === 'hang') return;
    if (query === 'exit') return process.exit(2);
    setTimeout(() => {
      trace('response', { query });
      send({ ...(query === 'error' ? { isError: true } : {}), content: [{ text: query }], structuredContent: { query, k } });
    }, 15);
  }
});
