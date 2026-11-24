import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanHygiene } from '../../plugin/scripts/codebase-hygiene.mjs';
import { auditMarkdownDocs } from '../../plugin/scripts/doc-sync-engine.mjs';
import { recommendForProject } from '../../plugin/scripts/codebase-recommender.mjs';
import { carryLiveNodeModules } from '../../kb/forge-update.mjs';
import { formatHandoffBrief } from '../../plugin/scripts/project-lifecycle.mjs';

describe('v5.1 on-ramp hardening (regression gates for real audit findings)', () => {
  it('codebase-hygiene uses quarantine or del-ledger, never fs.rmSync', () => {
    const src = fs.readFileSync(path.resolve('plugin/scripts/codebase-hygiene.mjs'), 'utf8');
    expect(src).not.toContain('fs.rmSync');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-hygiene-'));
    fs.writeFileSync(path.join(tmp, 'foo.bak-1'), 'junk');
    const dry = cleanHygiene({ cwd: tmp, apply: false });
    expect(dry.wouldClean).toContain('foo.bak-1');
  });

  it('doc-sync-engine detects backticked broken paths and package.json versionDrift', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-docsync-'));
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'demo', version: '3.2.1' }));
    fs.writeFileSync(
      path.join(tmp, 'README.md'),
      'Updated: 2026-01-01 00:00:00 EST | Version 1.0.0\nRef `src/does-not-exist.mjs` here.\n',
    );
    const res = auditMarkdownDocs(tmp);
    expect(res.versionDriftDocs).toBe(1);
    expect(res.brokenLinkDocs).toBe(1);
    expect(res.findings[0].brokenLinks).toContain('src/does-not-exist.mjs');
  });

  it('codebase-recommender orders ruPro blueprint by architectural layer and detects rsi', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-rec-'));
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { openai: '^4.0.0' } }));
    fs.writeFileSync(path.join(tmp, 'index.mjs'), 'import OpenAI from "openai"; const x = JSON.parse(await client.chat.completions.create({}));');
    const rec = recommendForProject({ cwd: tmp, prompt: 'add recursive self-improvement with SONA and cost routing' });
    expect(rec.ok).toBe(true);
    expect(rec.fileCount).toBeGreaterThan(0);
    const layers = rec.blueprint.steps.map((s) => s.layer);
    expect(layers).toContain('rsi');
    const order = ['storage', 'memory', 'security', 'routing', 'orchestration', 'rsi', 'quality', 'extension'];
    for (let i = 1; i < layers.length; i++) {
      expect(order.indexOf(layers[i])).toBeGreaterThanOrEqual(order.indexOf(layers[i - 1]));
    }
  });

  it('forge-update carryLiveNodeModules preserves links-*.json even when node_modules is absent', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-upd-'));
    const liveDir = path.join(tmp, 'live');
    const candidateDir = path.join(tmp, 'cand');
    fs.mkdirSync(liveDir, { recursive: true });
    fs.mkdirSync(candidateDir, { recursive: true });
    fs.writeFileSync(path.join(liveDir, 'links-ruflo.json'), '{"nodes":1}');
    const carried = carryLiveNodeModules({ candidateDir, liveDir });
    expect(carried).toBe(true);
    expect(fs.existsSync(path.join(candidateDir, 'links-ruflo.json'))).toBe(true);
  });

  it('session-start-core whitelists Cross-Host Project Lifecycle handoff brief', () => {
    const coreSrc = fs.readFileSync(path.resolve('plugin/scripts/session-start-core.mjs'), 'utf8');
    const brief = formatHandoffBrief({
      project: 'demo',
      hostsSeen: ['antigravity'],
      recentDecisions: [],
      latest: { host: 'antigravity', ts: '2026-11-24T00:00:00Z', summary: 'test', git: { branch: 'main', sha: 'abc' } },
    });
    expect(brief.startsWith('[RuvNet Brain — Cross-Host Project Lifecycle')).toBe(true);
    expect(coreSrc).toContain('[RuvNet Brain — Cross-Host Project Lifecycle');
  });
});
