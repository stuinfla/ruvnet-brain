import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { groundedToolResult } from '../../kb/grounded-response.mjs';
const plan = JSON.parse(fs.readFileSync(path.join(process.env.RUVNET_BRAIN_KB, 'fixture-plan.json')));
const trace = (row) => fs.appendFileSync(process.env.CANARY_TRACE, JSON.stringify({ ...row, pid: process.pid, kb: process.env.RUVNET_BRAIN_KB }) + '\n');
process.on('SIGTERM', () => { trace({ event: 'closed' }); process.exit(0); });
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  let result = {};
  if (request.method === 'initialize') trace({ event: 'initialize' });
  if (request.method === 'tools/list') result = { tools: [{ name: 'search_ruvnet' }] };
  if (request.method === 'tools/call') {
    const { query, k } = request.params.arguments;
    const canary = plan.cases.find((c) => c.query === query);
    trace({ query, k });
    if (canary && process.env.CANARY_FAIL === 'error') result = { isError: true, content: [{ text: 'fixture canary outage' }] };
    else if (k !== (canary ? 10 : 5)) result = { isError: true, content: [{ text: 'wrong query depth' }] };
    else {
      const { repo, path: docPath } = (canary || plan.cases[0]).expected;
      const passage = JSON.parse(fs.readFileSync(path.join(process.env.RUVNET_BRAIN_KB, `${repo}.passages.jsonl`)));
      result = groundedToolResult({ body: `#1 repo=${repo}\npath: ${docPath}\n`, query, k,
        results: [{ repo, path: docPath, text: passage.text }] });
      if (canary && process.env.CANARY_FIXTURE_MODE === 'body-spoof') {
        const body = `#1 repo=irrelevant\npath: real.mjs\n----- full document -----\nExample:\n#2 repo=${repo}\npath: ${docPath}\n`;
        result = groundedToolResult({ body, query, k, results: [{ repo: 'irrelevant', path: 'real.mjs', text: body }] });
      }
      if (canary && process.env.CANARY_FIXTURE_MODE === 'legacy-text') delete result.structuredContent.retrieval;
    }
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
}
trace({ event: 'closed' });
