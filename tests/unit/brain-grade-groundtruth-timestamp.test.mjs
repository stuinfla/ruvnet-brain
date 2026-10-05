import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readPanel, staleness } from '../../scripts/brain-score.mjs';

describe('ground-truth grading completion timestamp', () => {
  it('stamps the actual generated report after grading, without paid network calls', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-producer-'));
    try {
      for (const name of ['scripts', 'kb', 'data', 'repo']) fs.mkdirSync(path.join(root, name));
      fs.copyFileSync(path.resolve('scripts/brain-grade-groundtruth.mjs'), path.join(root, 'scripts/brain-grade-groundtruth.mjs'));
      fs.writeFileSync(path.join(root, 'kb/forge-ask.mjs'), 'export async function searchKb() { return [{ path: "source.mjs", fullText: "evidence" }]; }');
      fs.writeFileSync(path.join(root, 'kb/forge-rerank.mjs'), 'export async function rerankKb() { throw new Error("unexpected rerank"); }');
      fs.writeFileSync(path.join(root, 'repo/source.mjs'), 'source');
      fs.writeFileSync(path.join(root, 'questions.json'), JSON.stringify([{ q: 'fixture question' }]));
      // Set an earlier clock until the vendor result arrives. This rejects a start-time stamp.
      fs.writeFileSync(path.join(root, 'preload.mjs'), `
const RealDate = Date;
globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : ['2000-01-01T00:00:00Z'])); } };
globalThis.fetch = async () => {
  globalThis.Date = RealDate;
  return { ok: true, json: async () => ({ choices: [{ message: { content: '{"strict":98,"realUse":99,"reason":"fixture"}' } }] }) };
};
`);
      const before = Date.now();
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(root, 'preload.mjs')).href,
        path.join(root, 'scripts/brain-grade-groundtruth.mjs'), '--name', 'fixture', '--models', 'fixture/model',
        '--questions', path.join(root, 'questions.json'), '--repo', path.join(root, 'repo')],
      { encoding: 'utf8', env: { ...process.env, OPENROUTER_API_KEY: 'fixture-no-network' } });
      expect(result.status, result.stderr).toBe(0);
      const artifact = JSON.parse(fs.readFileSync(path.join(root, 'data/grade-fixture-big.json'), 'utf8'));
      expect(artifact.summary.avgStrict).toBe(98);
      expect(Date.parse(artifact.summary.generatedAt)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(artifact.summary.generatedAt)).toBeLessThanOrEqual(Date.now());
      const panel = readPanel(path.join(root, 'data'));
      expect(panel).toMatchObject({ value: 98, at: artifact.summary.generatedAt });
      expect(staleness(panel.at, 14).stale).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
