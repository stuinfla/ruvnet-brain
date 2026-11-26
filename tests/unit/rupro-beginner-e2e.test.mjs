import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recommendForProject } from '../../plugin/scripts/codebase-recommender.mjs';
import { recordLifecycleCheckpoint, readLifecycleState } from '../../plugin/scripts/project-lifecycle.mjs';
import { cleanHygiene, scanHygiene } from '../../plugin/scripts/codebase-hygiene.mjs';
import { summarizeOutcomeCorrelation } from '../../scripts/metaharness-router.mjs';

describe('ruPro beginner end-to-end proof (isolated scratch project)', () => {
  it('translates a plain-English beginner goal + Express/OpenAI/Pinecone app into an ordered, verified, safe ruPro blueprint', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rupro-beginner-'));
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: 'acme-support-bot',
        version: '0.1.0',
        dependencies: { express: '^4.19.0', openai: '^4.0.0', '@pinecone-database/pinecone': '^2.0.0' },
        devDependencies: { vitest: '^2.0.0' },
      }, null, 2));
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'server.js'), [
        "import express from 'express';",
        "import OpenAI from 'openai';",
        "const app = express();",
        "const client = new OpenAI();",
        "app.post('/chat', async (req, res) => {",
        "  const emb = await client.embeddings.create({ model: 'text-embedding-3-small', input: req.body.q });",
        "  const reply = await client.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: req.body.q }] });",
        "  res.json(JSON.parse(reply.choices[0].message.content));",
        "});",
      ].join('\n'));
      fs.writeFileSync(path.join(dir, 'src', 'server.js.bak'), '// stale backup');

      const report = recommendForProject({
        cwd: dir,
        prompt: 'I want my support bot to remember users across sessions, search our docs locally without Pinecone, protect against prompt injection, and auto-generate tests.',
        limit: 6,
      });

      expect(report.ok).toBe(true);
      expect(report.fileCount).toBeGreaterThanOrEqual(1);
      expect(report.blueprint.stepCount).toBeGreaterThanOrEqual(3);

      const layers = report.blueprint.steps.map((s) => s.layer);
      const order = ['storage', 'memory', 'security', 'routing', 'orchestration', 'rsi', 'quality', 'extension'];
      for (let i = 1; i < layers.length; i++) {
        expect(order.indexOf(layers[i])).toBeGreaterThanOrEqual(order.indexOf(layers[i - 1]));
      }
      for (const step of report.blueprint.steps) {
        expect(step.plainEnglish).toBeTruthy();
        expect(step.verify).toBeTruthy();
        expect(step.undo).not.toMatch(/delete \.swarm\/memory\.db|git checkout -- package\.json|rm -rf/i);
      }

      // Prove real cross-host lifecycle checkpoint writes & reads back in this scratch project
      const cp = await recordLifecycleCheckpoint({
        cwd: dir,
        host: 'antigravity',
        event: 'beginner-onramp',
        summary: 'Initialized ruPro beginner support-bot checkpoint',
      });
      expect(cp.ok).toBe(true);
      const summary = readLifecycleState(dir);
      expect(summary.ok).toBe(true);
      expect(summary.checkpointCount).toBeGreaterThanOrEqual(1);
      expect(summary.latest?.summary).toContain('beginner support-bot');

      // Prove safe quarantine cleans .bak clutter without ever touching src/server.js
      const scan = scanHygiene(dir);
      expect(scan.safeAuto.some((x) => x.path === 'src/server.js.bak')).toBe(true);
      const cleaned = cleanHygiene({ cwd: dir, apply: true, paths: ['src/server.js.bak'] });
      expect(cleaned.cleanedCount).toBe(1);
      expect(fs.existsSync(path.join(dir, 'src', 'server.js'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'src', 'server.js.bak'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tracks real decisionId-correlated routing outcomes separately from legacy rows', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-corr-'));
    try {
      const file = path.join(dir, 'outcomes.jsonl');
      fs.writeFileSync(file, [
        JSON.stringify({ ts: '2026-11-24T00:00:00Z', embedding: [0.1, 0.2], scores: { a: 0.9 } }),
        JSON.stringify({ ts: '2026-11-24T01:00:00Z', decisionId: 'dec-123', embedding: [0.3, 0.4], scores: { a: 0.85 } }),
      ].join('\n') + '\n');
      expect(summarizeOutcomeCorrelation(file)).toEqual({ total: 2, correlated: 1, legacy: 1 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
