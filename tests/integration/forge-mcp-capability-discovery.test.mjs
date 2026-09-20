import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
let tempDirs = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeCorpus(repo, title, sourcePath, preview, sourceText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mcp-family-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
  fs.writeFileSync(path.join(dir, `${repo}.rvf`), 'candidate store');
  fs.writeFileSync(path.join(dir, 'other.rvf'), 'candidate store');
  fs.writeFileSync(path.join(dir, 'capability-cards.md'), [
    `## ${repo}`,
    'Store vectors locally and privately with zero servers and HNSW.',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, `${repo}.meta.json`), JSON.stringify({
    entries: { witness: { path: sourcePath, kind: 'doc', title, preview } },
  }));
  fs.writeFileSync(path.join(dir, `${repo}.passages.jsonl`), JSON.stringify({
    id: `witness:${repo}`, path: sourcePath, title, text: sourceText,
  }) + '\n');
  return dir;
}

function callSearch(dir, query) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [path.join(REPO_ROOT, 'kb/forge-mcp-all.mjs')], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        RUVNET_BRAIN_KB: dir,
        XDG_CACHE_HOME: path.join(dir, 'cache'),
        HOME: path.join(dir, 'home'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP query timed out: ${stderr}`));
    }, 10_000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`MCP exited ${code}: ${stderr}`));
      try {
        const replies = stdout.trim().split('\n').map(JSON.parse);
        resolve({ reply: replies.find((item) => item.id === 2), stdout, stderr });
      } catch (error) { reject(new Error(`invalid MCP stdout: ${error.message}\n${stdout}\n${stderr}`)); }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'search_ruvnet', arguments: { query } },
    }) + '\n');
    child.stdin.end();
  });
}

describe('forge-mcp-all — broad family questions use source-witness discovery', () => {
  it('does not return a curated card for the default-k local storage smoke query', async () => {
    const sourceText = fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures/retrieval/ruvector-router-wasm-reviewed-passage.txt'), 'utf8');
    const dir = makeCorpus(
      'ruvector',
      'Browser vector database',
      'crates/ruvector-router-wasm/README.md',
      'Client-side vector database, IndexedDB persistence, zero server dependencies.',
      sourceText,
    );
    const { reply } = await callSearch(
      dir,
      'How should I store embeddings in this project without running a server?',
    );
    const serialized = JSON.stringify(reply);

    expect(serialized).toContain('source-backed-discovery');
    expect(serialized).toContain('crates/ruvector-router-wasm/README.md');
    expect(serialized).not.toContain('FAST LANE');
    expect(serialized).toContain('"k":6');
    expect(serialized).toContain('"verdict":"unproven"');
    expect(serialized).toContain('reviewed-source-catalog');
    expect(serialized).toContain('44404f0c1ae135b021ece8e5e30c271fb1900ea0c4f583f1f891ee3196386662');
    expect(serialized).toContain('native/server-side compatibility and runtime behavior not verified');
    expect(serialized).not.toContain('Say coverage is thin');
  });

  it('uses the reviewed cross-project source section for the default-k transfer query', async () => {
    const sourceText = fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures/retrieval/ruflo-cross-project-transfer-reviewed-passage.txt'), 'utf8');
    const dir = makeCorpus(
      'ruflo',
      'Cross-project pattern transfer',
      'plugins/ruflo-intelligence/agents/intelligence-specialist.md',
      'Explicit cross-project pattern transfer using IPFS store and load operations.',
      sourceText,
    );
    const { reply } = await callSearch(dir, 'How can agents carry useful learning from one project to another?');
    const serialized = JSON.stringify(reply);

    expect(serialized).toContain('source-backed-discovery');
    expect(serialized).toContain('"k":6');
    expect(serialized).toContain('3af770c2c5bceb4b612eac6757656d6e2be74b914bdf75f1d6f422af54dcdd36');
    expect(serialized).toContain('Requires `PINATA_API_JWT` configured.');
    expect(serialized).toContain('runtime configuration and credential availability not verified');
  });
});
