// The search server's entry: started by the launcher (`bin/rb5 server`, `bin/rb5.cmd server`) with a
// Node it has checked, and by the installer's own post-switch check. It loads the server of the app
// named by the pointer file. It never runs or imports anything from the current project.
import './runtime.mjs';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { brainHome } from '../../contract/home.mjs';

const home = brainHome();
let pointer = null;
try {
  pointer = JSON.parse(fs.readFileSync(path.join(home, 'current.json'), 'utf8'));
} catch {}

if (pointer?.app) {
  const main = await import(pathToFileURL(path.join(home, 'app', pointer.app, 'server', 'main.mjs')).href);
  await main.run({ home });
} else {
  // Not installed: answer the protocol with one plain sentence instead of failing to start.
  const text = 'RuvNet Brain NOT INSTALLED · run: ruvnet-brain install';
  const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id === undefined) return;
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'ruvnet-brain', version: 'not-installed' } } });
    else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'search_ruvnet', description: text, inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }] } });
    else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text }], isError: true } });
    else send({ jsonrpc: '2.0', id: m.id, result: {} });
  });
}
