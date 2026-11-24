import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  recordLifecycleCheckpoint,
  readLifecycleState,
  formatHandoffBrief,
} from '../../plugin/scripts/project-lifecycle.mjs';
import {
  auditMarkdownDocs,
  stampMarkdownFile,
  syncMarkdownDocs,
  formatEasternStamp,
} from '../../plugin/scripts/doc-sync-engine.mjs';
import {
  scanHygiene,
  cleanHygiene,
} from '../../plugin/scripts/codebase-hygiene.mjs';

const tempDirs = [];
function makeTmp(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-v5-suite-'));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (content === null) {
      fs.mkdirSync(full, { recursive: true });
    } else {
      fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
    }
  }
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop();
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('v5.0 Cross-Host Project Lifecycle Engine (AgentDB)', () => {
  it('persists checkpoints across multiple AI hosts and builds a provider-agnostic handoff brief', async () => {
    const dir = makeTmp({
      'package.json': { name: 'rupro-demo-app', version: '2.1.0' },
    });

    const cp1 = await recordLifecycleCheckpoint({
      cwd: dir,
      host: 'claude-code',
      event: 'session-end',
      summary: 'Implemented auth middleware and initial schema',
      decisions: ['Use RVF for vector store', 'Use AgentDB for session memory'],
      nextSteps: ['Add rate limiting'],
    });
    expect(cp1.ok).toBe(true);
    expect(fs.existsSync(path.join(dir, '.swarm', 'memory.db'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '.swarm', 'lifecycle-checkpoints.jsonl'))).toBe(true);

    const cp2 = await recordLifecycleCheckpoint({
      cwd: dir,
      host: 'antigravity',
      event: 'stop',
      summary: 'Added rate limiting and verified all tests',
      decisions: ['Route routine checks through Gemini Flash'],
      nextSteps: ['Deploy to production'],
    });
    expect(cp2.ok).toBe(true);

    const state = readLifecycleState(dir);
    expect(state.ok).toBe(true);
    expect(state.project).toBe('rupro-demo-app');
    expect(state.dbPresent).toBe(true);
    expect(state.checkpointCount).toBe(2);
    expect(state.hostsSeen).toEqual(['claude-code', 'antigravity']);
    expect(state.latest.host).toBe('antigravity');
    expect(state.recentDecisions).toContain('Use RVF for vector store');
    expect(state.recentDecisions).toContain('Route routine checks through Gemini Flash');

    const brief = formatHandoffBrief(state);
    expect(brief).toContain('[RuvNet Brain — Cross-Host Project Lifecycle (rupro-demo-app)]');
    expect(brief).toContain('antigravity');
    expect(brief).toContain('Deploy to production');
  });
});

describe('v5.0 Markdown Auto-Currency & Timestamp Engine', () => {
  it('detects missing timestamps and broken links, then stamps Eastern Updated/Created headers while preserving frontmatter', () => {
    const dir = makeTmp({
      'package.json': { name: 'doc-demo', version: '2.3.4' },
      'src/app.mjs': 'export const ok = true;\n',
      'README.md': '# Demo\nSee [app](src/app.mjs) and [missing](src/missing.mjs).\n',
      'docs/spec.md': '---\ntitle: Spec\n---\n\n# Spec\nBody text.\n',
    });

    const stamp = formatEasternStamp(new Date('2026-11-24T13:00:00Z'));
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+[A-Z]{2,4}$/);

    const auditBefore = auditMarkdownDocs(dir);
    expect(auditBefore.scanned).toBe(2);
    expect(auditBefore.missingStamp).toBe(2);
    expect(auditBefore.brokenLinkDocs).toBe(1);

    const dry = syncMarkdownDocs({ cwd: dir, apply: false });
    expect(dry.mode).toBe('dry-run');
    expect(dry.wouldStampCount).toBe(2);

    const applied = syncMarkdownDocs({ cwd: dir, apply: true });
    expect(applied.mode).toBe('apply');
    expect(applied.stampedNow).toBe(2);

    const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
    expect(readme).toMatch(/^Updated: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [A-Z]{2,4} \| Version 2\.3\.4/m);
    expect(readme).toMatch(/^Created: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [A-Z]{2,4}/m);

    const spec = fs.readFileSync(path.join(dir, 'docs/spec.md'), 'utf8');
    expect(spec.startsWith('---\ntitle: Spec\n---\n')).toBe(true);
    expect(spec).toContain('Updated:');

    // Re-stamping updates in place rather than duplicating
    stampMarkdownFile(path.join(dir, 'README.md'), { cwd: dir, version: '2.3.4' });
    const readme2 = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
    expect((readme2.match(/^Updated:/gm) || []).length).toBe(1);
  });
});

describe('v5.0 Safe Dead-Code & Directory Hygiene Engine', () => {
  it('classifies backup/temp junk and empty directories as safe-auto and refuses non-junk source files', () => {
    const dir = makeTmp({
      'src/real-code.mjs': 'export const keep = 1;\n',
      'src/config.json.bak-20261124': '{}',
      'src/temp.tmp-1234': 'tmp',
      'src/legacy-deprecated.mjs': 'export const old = 1;\n',
    });
    fs.mkdirSync(path.join(dir, 'empty-folder'), { recursive: true });

    const scan = scanHygiene(dir);
    expect(scan.ok).toBe(true);
    expect(scan.summary.safeAutoCount).toBe(3);
    expect(scan.summary.reviewCount).toBe(1);

    // Refuses to delete real source code even if passed explicitly
    const refused = cleanHygiene({ cwd: dir, paths: ['src/real-code.mjs', '../outside.txt'], apply: true });
    expect(refused.cleanedCount).toBe(0);
    expect(refused.rejected.length).toBe(2);
    expect(fs.existsSync(path.join(dir, 'src/real-code.mjs'))).toBe(true);

    // Cleans safe-auto items cleanly
    const cleaned = cleanHygiene({ cwd: dir, apply: true });
    expect(cleaned.ok).toBe(true);
    expect(cleaned.cleanedCount).toBe(3);
    expect(fs.existsSync(path.join(dir, 'src/config.json.bak-20261124'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'empty-folder'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'src/real-code.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'src/legacy-deprecated.mjs'))).toBe(true);
  });
});
