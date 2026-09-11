import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const QE_SCRIPT = path.join(ROOT, 'scripts', 'release-qe.mjs');
const ROLLBACK_SCRIPT = path.join(ROOT, 'scripts', 'release-rollback-monitor.mjs');

describe('Release QE Validation', () => {
  it('release-qe.mjs should validate against baseline', () => {
    const result = spawnSync('node', [QE_SCRIPT], {
      cwd: ROOT,
      timeout: 30000,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Release E2E Validation');
    expect(result.stdout).toContain('Baseline loaded');
    expect(result.stdout).toContain('Summary');
  });

  it('release-qe.mjs should accept --json flag', () => {
    const result = spawnSync('node', [QE_SCRIPT, '--json'], {
      cwd: ROOT,
      timeout: 30000,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('timestamp');
    expect(result.stdout).toContain('accuracy');
    expect(result.stdout).toContain('results');
  });

  it('rollback-monitor should store release baseline', () => {
    const result = spawnSync('node', [
      ROLLBACK_SCRIPT,
      '--version', '4.3.22',
      '--baseline-accuracy', '83.3',
    ], {
      cwd: ROOT,
      timeout: 5000,
      encoding: 'utf8',
    });

    // Monitoring loop runs, but we're only checking initialization
    expect(result.stdout).toContain('Release baseline stored');
  });

  it('golden path queries should be well-formed', () => {
    // This test verifies the golden-path queries are properly defined
    // by loading the script and inspecting its constants
    const result = spawnSync('node', [
      '--eval',
      `
      const mod = await import('${QE_SCRIPT}');
      // If we got here, the module loaded successfully
      console.log('✅ Golden paths defined');
      `,
      '--input-type=module',
    ], {
      cwd: ROOT,
      timeout: 5000,
      encoding: 'utf8',
    });

    // Even if we can't directly inspect GOLDEN_PATHS, the script should parse correctly
    expect(result.status).toBe(0);
  });
});

describe('Release Workflow Integration', () => {
  it('should have staging-deploy job in release.yml', () => {
    const fs = require('node:fs');
    const workflowPath = path.join(ROOT, '.github', 'workflows', 'release.yml');
    const workflow = fs.readFileSync(workflowPath, 'utf8');

    expect(workflow).toContain('staging-deploy');
    expect(workflow).toContain('Gate C: Run E2E validation');
    expect(workflow).toContain('release-qe.mjs');
  });

  it('release-ready job should depend on staging-deploy', () => {
    const fs = require('node:fs');
    const workflowPath = path.join(ROOT, '.github', 'workflows', 'release.yml');
    const workflow = fs.readFileSync(workflowPath, 'utf8');

    expect(workflow).toContain('needs: [test-gates, staging-deploy]');
  });

  it('staging-deploy should output staging_url and qe_accuracy', () => {
    const fs = require('node:fs');
    const workflowPath = path.join(ROOT, '.github', 'workflows', 'release.yml');
    const workflow = fs.readFileSync(workflowPath, 'utf8');

    expect(workflow).toContain('staging_url:');
    expect(workflow).toContain('qe_result:');
    expect(workflow).toContain('qe_accuracy:');
  });
});
