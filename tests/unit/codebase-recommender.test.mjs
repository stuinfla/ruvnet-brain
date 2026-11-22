import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  scanCodebase,
  recommendForProject,
  formatHookAdvisory,
  buildCodebaseAdvocacyCandidate,
} from '../../plugin/scripts/codebase-recommender.mjs';

const tempDirs = [];
function makeTmpProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-codebase-rec-'));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop();
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('codebase-recommender — proactive codebase + prompt technology advisor', () => {
  it('returns silent (ok: false, no-project-code) in an empty directory', () => {
    const empty = makeTmpProject({});
    const report = recommendForProject({ cwd: empty, prompt: 'build something' });
    expect(report.ok).toBe(false);
    expect(report.reason).toBe('no-project-code');
    expect(formatHookAdvisory(report)).toBe('');
    expect(buildCodebaseAdvocacyCandidate({ cwd: empty, prompt: 'build something' })).toBeNull();
  });

  it('inspects dependencies and source files to recommend @ruvector/typesafe, @claude-flow/aidefence, @metaharness/router, and @ruvector/rvf', () => {
    const dir = makeTmpProject({
      'package.json': {
        name: 'medical-claim-extractor',
        dependencies: {
          express: '^4.19.0',
          openai: '^4.0.0',
          'pdf-parse': '^1.1.1',
          pgvector: '^0.2.0',
        },
      },
      'src/api/extract.ts': `
        import express from 'express';
        import OpenAI from 'openai';
        const client = new OpenAI();
        const app = express();
        app.post('/api/extract', async (req, res) => {
          const out = await client.chat.completions.create({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: req.body.letter }],
          });
          const parsed = JSON.parse(out.choices[0].message.content);
          res.json(parsed);
        });
      `,
    });

    const scan = scanCodebase(dir);
    expect(scan).not.toBeNull();
    expect(scan.fileCount).toBe(1);
    expect(scan.signals.llmCalls.length).toBeGreaterThan(0);
    expect(scan.signals.untypedLlmParsing.length).toBeGreaterThan(0);
    expect(scan.signals.vectorClassical.length).toBeGreaterThan(0);

    const report = recommendForProject({
      cwd: dir,
      prompt: 'improve extraction accuracy, block prompt injection, and lower our OpenAI model cost',
      limit: 5,
    });
    expect(report.ok).toBe(true);
    const caps = report.recommendations.map((r) => r.capability);
    expect(caps).toContain('ruvector');
    expect(caps).toContain('aidefence');
    expect(caps).toContain('metaharness-router');
    expect(caps).toContain('typesafe');

    // Every recommendation cites actual file evidence from the scanned project
    for (const rec of report.recommendations) {
      expect(rec.evidence.length).toBeGreaterThan(0);
    }

    // Hook advisory output obeys the question-free statement contract
    const hookText = formatHookAdvisory(report);
    expect(hookText).toContain('[RuvNet Brain — proactive codebase & technology recommendations');
    expect(hookText).not.toContain('?');

    const candidate = buildCodebaseAdvocacyCandidate({
      cwd: dir,
      prompt: 'how can we improve extraction accuracy and lower our model cost in this app',
    });
    expect(candidate).not.toBeNull();
    expect(candidate.channel).toBe('advocacy');
    expect(candidate.findingId).toMatch(/^recommend:codebase:/);
    expect(candidate.copy).not.toContain('?');
  });

  it('skips technologies that are already integrated unless the user explicitly asks about them', () => {
    const dir = makeTmpProject({
      'package.json': {
        name: 'already-wired-app',
        dependencies: {
          '@claude-flow/aidefence': '^3.0.0',
          '@ruvector/rvf': '^0.3.0',
          openai: '^4.0.0',
        },
      },
      'src/index.ts': `
        import OpenAI from 'openai';
        const raw = JSON.parse(await callModel());
      `,
    });

    const report = recommendForProject({ cwd: dir, prompt: 'improve reliability of JSON parsing' });
    const caps = report.recommendations.map((r) => r.capability);
    expect(caps).not.toContain('aidefence');
    expect(caps).not.toContain('ruvector');
    expect(caps).toContain('typesafe');
  });
});
