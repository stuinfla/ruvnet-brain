import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createProgressionSnapshot } from '../../plugin/scripts/project-progression-contract.mjs';
import { ProjectProgressionStore } from '../../plugin/scripts/project-progression-store.mjs';
import {
  SESSION_CONTINUITY_LIMIT_BYTES,
  restoreProgressionForSession,
} from '../../plugin/scripts/project-progression-session-start.mjs';
import { resolveProjectStore } from '../../plugin/scripts/project-store-resolver.mjs';
import { runSessionStart } from '../../plugin/scripts/session-start-core.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const NAMESPACE = 'project-progression';
const temporaryRoots = [];

function temporaryProject() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'progression-session-start-')));
  temporaryRoots.push(root);
  fs.mkdirSync(path.join(root, '.swarm'), { recursive: true });
  fs.writeFileSync(path.join(root, '.swarm', 'memory.db'), 'fixture-only');
  return root;
}

function completeState(overrides = {}) {
  return {
    currentGoal: 'Resume the exact project plan',
    acceptanceContract: { required: ['both hosts restore all heads'] },
    plan: [{ id: 'f', status: 'in-progress' }],
    activeProcess: 'ProjectContinuity',
    activeStep: 'host-injection',
    completed: ['A', 'B', 'C', 'D', 'E'],
    inProgress: ['F'],
    blockers: [],
    failures: [],
    decisions: [],
    changedFiles: [],
    commands: [],
    proofArtifacts: [],
    untested: ['killed-process proof'],
    nextAction: 'Finish Slice F',
    resumeConflicts: [],
    ...overrides,
  };
}

function snapshot(project, { host, dedupId, nextAction }) {
  const resolution = resolveProjectStore({ projectDir: project });
  return createProgressionSnapshot({
    projectIdentity: resolution.projectIdentity,
    sourceIdentity: {
      checkoutPath: resolution.checkoutRoot,
      worktreeId: 'primary',
      branch: 'main',
      head: 'a'.repeat(40),
      trackedDigest: 'b'.repeat(64),
      untrackedDigest: 'c'.repeat(64),
      dirtyTreeDigest: 'd'.repeat(64),
    },
    hostIdentity: { host, adapterVersion: '4.2.3-dev' },
    sessionIdentity: `${host}-session`,
    sequence: 1,
    occurredAt: host === 'claude' ? '2026-08-22T20:00:00.000Z' : '2026-08-22T20:00:01.000Z',
    trigger: 'SessionEnd',
    parentEventKeys: [],
    dedupId,
    completeProjectState: completeState({ currentGoal: `${host} goal`, nextAction }),
  });
}

function flag(args, name) {
  return args[args.indexOf(name) + 1];
}

function fakeRunner(rows, { listResult } = {}) {
  const entries = new Map(rows.map((row) => [row.eventKey, row]));
  const keys = [...entries.keys()];
  const calls = [];
  const invocations = [];
  const runner = (_binary, args, options) => {
    calls.push(args);
    invocations.push({ args, options });
    if (args[0] !== 'memory') throw new Error(`unexpected command: ${args.join(' ')}`);
    if (args[1] === 'list') {
      if (listResult) return listResult;
      const offset = Number(flag(args, '--offset'));
      const limit = Number(flag(args, '--limit'));
      const pageKeys = keys.slice(offset, offset + limit);
      const next = offset + pageKeys.length;
      return {
        status: 0,
        stdout: JSON.stringify({
          entries: pageKeys.map((key) => ({ key, namespace: NAMESPACE })),
          total: keys.length,
          limit,
          offset,
          nextOffset: next < keys.length ? next : null,
          hasMore: next < keys.length,
        }),
        stderr: '',
      };
    }
    if (args[1] === 'retrieve') {
      return { status: 0, stdout: JSON.stringify(entries.get(flag(args, '--key'))), stderr: '' };
    }
    throw new Error(`forbidden command: ${args.join(' ')}`);
  };
  return { calls, invocations, runner };
}

function realStoreFactory(cli) {
  return (options) => new ProjectProgressionStore({
    ...options,
    rufloBinary: '/managed/global/ruflo',
    runner: cli.runner,
  });
}

function quietSessionEnv(project) {
  const home = path.join(project, 'fixture-home');
  const cache = path.join(home, '.cache', 'ruvnet-brain');
  fs.mkdirSync(path.join(cache, 'kb'), { recursive: true });
  fs.writeFileSync(path.join(cache, 'kb', 'public.big.rvf'), 'rvf');
  fs.writeFileSync(path.join(cache, 'kb', 'SOURCE.json'), JSON.stringify({ releaseTag: 'test' }));
  for (const marker of [
    '.console-offered', '.router-profile-nudged', '.last-major-milestone',
    '.last-announced-version', '.star-ask-shown', '.seed-attempted', '.auto-update-pref',
  ]) fs.writeFileSync(path.join(cache, marker), marker === '.auto-update-pref' ? 'no' : '1');
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: path.join(home, '.cache'),
    RUVNET_BRAIN_HOME: cache,
    RUVNET_BRAIN_METER: '0',
    CLAUDE_PROJECT_DIR: project,
    CLAUDE_PLUGIN_ROOT: path.join(ROOT, 'plugin'),
    RUVNET_HOOK_HOST: 'claude',
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('ADR-073 Slice F SessionStart restore bridge', () => {
  it('surfaces unavailable and does not instantiate a store in a non-project directory', () => {
    const project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'progression-non-project-')));
    temporaryRoots.push(project);
    let constructed = 0;

    const result = restoreProgressionForSession({
      cwd: project,
      env: { ...process.env, CLAUDE_PROJECT_DIR: project },
      storeFactory: () => { constructed += 1; throw new Error('must not run'); },
    });

    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('non-project');
    expect(result.context).toContain('PROJECT CONTINUITY UNAVAILABLE');
    expect(constructed).toBe(0);
    expect(fs.existsSync(path.join(project, '.swarm', 'memory.db'))).toBe(false);
  });

  it('initializes a new writable project only through the canonical managed-store seam', () => {
    const project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'progression-new-project-')));
    temporaryRoots.push(project);
    fs.writeFileSync(path.join(project, 'package.json'), '{}');
    let options;
    const calls = [];
    let bootstrapValue = '';

    const result = restoreProgressionForSession({
      cwd: project,
      env: { ...process.env, CLAUDE_PROJECT_DIR: project },
      storeFactory: (received) => {
        options = received;
        return {
          run: (args) => {
            calls.push(args);
            if (args[1] === 'store') {
              bootstrapValue = flag(args, '--value');
              fs.writeFileSync(received.requestedStorePath, 'initialized by managed seam');
              return { status: 0, stdout: '', stderr: '' };
            }
            if (args[1] === 'retrieve') return { status: 0, stdout: bootstrapValue, stderr: '' };
            throw new Error(`unexpected command: ${args.join(' ')}`);
          },
          restoreLatest: () => {
          const error = new Error('no coherent progression state could be restored');
          error.rejectedCandidates = [];
          throw error;
          },
        };
      },
    });

    expect(result.status).toBe('initialized');
    expect(result.context).toContain('PROJECT CONTINUITY INITIALIZED');
    expect(options.requestedStorePath).toBe(resolveProjectStore({ projectDir: project }).canonicalAgentDbPath);
    expect(fs.existsSync(options.requestedStorePath)).toBe(true);
    expect(calls[0]).toEqual(expect.arrayContaining([
      'memory', 'store', '--key', 'project-continuity-bootstrap-v1', '--no-upsert',
      '--provenance', 'system_observation', '--path', options.requestedStorePath,
    ]));
    expect(calls[1]).toEqual(expect.arrayContaining([
      'memory', 'retrieve', '--key', 'project-continuity-bootstrap-v1',
      '--value-only', '--path', options.requestedStorePath,
    ]));
  });

  it('fails closed without leaking CLI output when managed initialization fails', () => {
    const project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'progression-init-fail-')));
    temporaryRoots.push(project);
    fs.writeFileSync(path.join(project, 'package.json'), '{}');
    const result = restoreProgressionForSession({
      cwd: project,
      env: { ...process.env, CLAUDE_PROJECT_DIR: project },
      storeFactory: () => ({
        run: () => ({ status: 1, stdout: '', stderr: 'private cli diagnostic' }),
        restoreLatest: () => { throw new Error('must not restore'); },
      }),
    });

    expect(result.status).toBe('unknown');
    expect(result.reason).toBe('initialization-failed');
    expect(result.context).toContain('PROJECT CONTINUITY UNKNOWN');
    expect(result.context).not.toContain('private cli diagnostic');
    expect(fs.existsSync(path.join(project, '.swarm', 'memory.db'))).toBe(false);
  });

  it('surfaces unavailable and performs no store call for a read-only project', () => {
    const project = temporaryProject();
    fs.rmSync(path.join(project, '.swarm', 'memory.db'));
    let constructed = 0;
    const result = restoreProgressionForSession({
      cwd: project,
      env: { ...process.env, CLAUDE_PROJECT_DIR: project },
      writable: () => false,
      storeFactory: () => { constructed += 1; throw new Error('must not run'); },
    });

    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('read-only');
    expect(result.context).toContain('PROJECT CONTINUITY UNAVAILABLE');
    expect(constructed).toBe(0);
    expect(fs.existsSync(path.join(project, '.swarm', 'memory.db'))).toBe(false);
  });

  it('surfaces an existing, structurally enumerated empty AgentDB without claiming restore', () => {
    const project = temporaryProject();
    const cli = fakeRunner([]);
    const result = restoreProgressionForSession({
      cwd: project,
      env: { ...process.env, CLAUDE_PROJECT_DIR: project },
      storeFactory: realStoreFactory(cli),
    });

    expect(result.status).toBe('empty');
    expect(result.context).toContain('PROJECT CONTINUITY EMPTY');
    expect(result.context).not.toContain('PROJECT CONTINUITY RESTORED');
    expect(cli.calls[0]).toEqual(expect.arrayContaining(['memory', 'list', '--page-info']));
  });

  it('structurally restores two concurrent host heads and retains every resume conflict', () => {
    const project = temporaryProject();
    const rows = [
      snapshot(project, { host: 'claude', dedupId: 'claude-head', nextAction: 'Claude proof' }),
      snapshot(project, { host: 'codex', dedupId: 'codex-head', nextAction: 'Codex proof' }),
    ];
    const cli = fakeRunner(rows);

    const result = restoreProgressionForSession({
      cwd: project,
      env: { ...process.env, CLAUDE_PROJECT_DIR: project },
      storeFactory: realStoreFactory(cli),
    });

    expect(result.status).toBe('restored');
    expect(result.context).toContain('PROJECT CONTINUITY RESTORED');
    const resume = JSON.parse(result.context.slice(result.context.indexOf('{')));
    expect(resume.heads).toEqual(rows.map((row) => row.eventKey).sort());
    expect(resume.state.resumeConflicts.length).toBeGreaterThan(1);
    expect(resume.state.resumeConflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'nextAction' }),
      expect.objectContaining({ field: 'currentGoal' }),
    ]));
    expect(Buffer.byteLength(result.context, 'utf8')).toBeLessThanOrEqual(SESSION_CONTINUITY_LIMIT_BYTES);

    const list = cli.calls.find((args) => args[1] === 'list');
    expect(list).toEqual(expect.arrayContaining(['--page-info', '--offset', '0', '--format', 'json']));
    expect(flag(list, '--path')).toBe(resolveProjectStore({ projectDir: project }).canonicalAgentDbPath);
    expect(cli.calls.filter((args) => args[1] === 'retrieve')).toHaveLength(2);
    expect(cli.calls.some((args) => args[1] === 'search')).toBe(false);
    expect(cli.invocations.every(({ options }) => options.cwd === path.join(project, '.swarm'))).toBe(true);
  });

  it.each([
    ['installed Ruflo has no structural pagination', { status: 1, stdout: '', stderr: 'unknown option --page-info' }, 'pagination-unavailable'],
    ['AgentDB list output is malformed', { status: 0, stdout: '{"entries":"not-an-array"}', stderr: '' }, 'malformed-store'],
  ])('surfaces UNKNOWN, never RESTORED, when %s', (_label, listResult, reason) => {
    const project = temporaryProject();
    const cli = fakeRunner([], { listResult });

    const result = restoreProgressionForSession({
      cwd: project,
      env: { ...process.env, CLAUDE_PROJECT_DIR: project },
      storeFactory: realStoreFactory(cli),
    });

    expect(result.status).toBe('unknown');
    expect(result.reason).toBe(reason);
    expect(result.context).toContain('PROJECT CONTINUITY UNKNOWN');
    expect(result.context).toContain('Do not claim project state was restored');
    expect(result.context).not.toContain('PROJECT CONTINUITY RESTORED');
    if (listResult.stderr) expect(result.context).not.toContain(listResult.stderr);
  });

  it('fails closed and bounds the host payload if a restore adapter returns oversized content', () => {
    const project = temporaryProject();
    const result = restoreProgressionForSession({
      cwd: project,
      env: { ...process.env, CLAUDE_PROJECT_DIR: project },
      storeFactory: () => ({ restoreLatest: () => {
        const payload = {
          schema: 'ruvnet-brain.project-resume', schemaVersion: 1, heads: ['head'],
          state: { resumeConflicts: [], value: 'x'.repeat(20_000) },
        };
        return { payload, rendered: JSON.stringify(payload) };
      } }),
    });

    expect(result.status).toBe('unknown');
    expect(result.reason).toBe('output-bound');
    expect(Buffer.byteLength(result.context, 'utf8')).toBeLessThanOrEqual(SESSION_CONTINUITY_LIMIT_BYTES);
  });

  it('injects the restore result through the real shared SessionStart production caller', async () => {
    const project = temporaryProject();
    let stdout = '';
    const context = '[RuvNet Brain — PROJECT CONTINUITY RESTORED]\n{"heads":["a","b"]}';

    const result = await runSessionStart({
      env: quietSessionEnv(project),
      cwd: project,
      stdout: { write: (chunk) => { stdout += String(chunk); return true; } },
      stderr: { write: () => true },
      restoreContinuity: () => ({ status: 'restored', context }),
    });

    expect(result.ok).toBe(true);
    expect(stdout).toContain(context);
    expect(stdout.match(/PROJECT CONTINUITY RESTORED/g)).toHaveLength(1);
  });

  it('uses each host exact SessionStart output contract for the same host-neutral payload', () => {
    const context = '[RuvNet Brain — PROJECT CONTINUITY RESTORED]\n{"heads":["claude","codex"]}';
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'progression-host-adapter-')));
    temporaryRoots.push(dir);
    fs.copyFileSync(
      path.join(ROOT, 'plugin/scripts/codex-hook-adapter.mjs'),
      path.join(dir, 'codex-hook-adapter.mjs'),
    );
    fs.writeFileSync(path.join(dir, 'hook-shim.mjs'), `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(context)}));`);

    const codex = spawnSync(process.execPath, [path.join(dir, 'codex-hook-adapter.mjs'), 'session-start'], {
      cwd: dir,
      input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'resume', cwd: dir }),
      encoding: 'utf8',
    });

    expect(codex.status, codex.stderr).toBe(0);
    expect(JSON.parse(codex.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
    });
    expect(context.startsWith('[RuvNet Brain')).toBe(true); // Claude SessionStart accepts plain stdout as context.
  });

  it('registers every current SessionStart source on both hosts and ships the full import chain', () => {
    const claude = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin/hooks/hooks.json'), 'utf8'));
    const codex = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin/hooks/codex-hooks.json'), 'utf8'));
    const sources = ['startup', 'resume', 'clear', 'compact', 'fork'];
    const claudeMatchers = claude.hooks.SessionStart.map((group) => group.matcher);
    const codexMatchers = codex.hooks.SessionStart.map((group) => group.matcher);
    for (const source of sources) {
      expect(claudeMatchers.some((matcher) => new RegExp(`^(?:${matcher})$`).test(source)), `Claude misses ${source}`).toBe(true);
      expect(codexMatchers.some((matcher) => new RegExp(`^(?:${matcher})$`).test(source)), `Codex misses ${source}`).toBe(true);
    }
    expect(claude.hooks.SessionStart.flatMap((group) => group.hooks).every((hook) => hook.command.includes('session-start'))).toBe(true);
    expect(codex.hooks.SessionStart.flatMap((group) => group.hooks).every((hook) => hook.command.includes('session-start'))).toBe(true);

    const packed = JSON.parse(spawnSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: ROOT, encoding: 'utf8', timeout: 120_000,
    }).stdout)[0].files.map(({ path: packedPath }) => packedPath);
    for (const required of [
      'plugin/scripts/session-start-core.mjs',
      'plugin/scripts/project-progression-session-start.mjs',
      'plugin/scripts/project-progression-store.mjs',
      'plugin/scripts/project-progression-contract.mjs',
      'plugin/scripts/project-progression-outbox.mjs',
      'plugin/scripts/project-store-resolver.mjs',
      'plugin/scripts/ruflo-bin.mjs',
    ]) expect(packed, `packed plugin is missing ${required}`).toContain(required);
  }, 120_000);

  it('has no raw SQL, semantic-search fallback, shell command, or generic AgentDB MCP path', () => {
    const sources = [
      fs.readFileSync(path.join(ROOT, 'plugin/scripts/project-progression-session-start.mjs'), 'utf8'),
      fs.readFileSync(path.join(ROOT, 'plugin/scripts/project-progression-store.mjs'), 'utf8'),
    ].join('\n');
    expect(sources).not.toMatch(/memory\s+search|SELECT\s|sqlite3|agentdb_hierarchical|execSync|shell\s*:\s*true/i);
    expect(sources).toContain("'memory', 'list'");
    expect(sources).toContain("'memory', 'retrieve'");
    expect(sources).toContain("'--path'");
  });
});
