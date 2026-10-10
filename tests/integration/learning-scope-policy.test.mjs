import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { learningFixture } from '../helpers/learning-fixture.mjs';
import { learningContext } from '../../plugin/scripts/runtime-preferences.mjs';
import { takeQueueLock, releaseQueueLock } from '../../plugin/scripts/learning-queue.mjs';
import { loadNodeSqlite } from '../../plugin/scripts/node-sqlite.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CAPTURE = path.join(ROOT, 'plugin', 'scripts', 'learn-capture.mjs');
const fixtures = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.cleanup(); });
const payload = JSON.stringify({ session_id: 'scope-test', hook_event_name: 'PostToolUse',
  tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { success: true } });
function capture(f, scope) {
  return spawnSync(process.execPath, [CAPTURE], { cwd: f.project,
    env: { ...f.env, RUVNET_LEARNING_SCOPE: scope }, input: payload, encoding: 'utf8', timeout: 10_000 });
}

function observed(scope) {
  const f = learningFixture(scope); fixtures.push(f);
  f.env.RUVNET_RUFLO_CWD_ROOT = path.join(f.home, '.cache/ruvnet-brain/learning-ruflo');
  const context = learningContext({ env: f.env, cwd: f.project });
  // A legitimate existing queue owner suppresses detached recovery while the fixture inspects capture.
  // Release through the actual ownership API before driving the same bounded --sync door.
  const token = takeQueueLock(context);
  try { expect(capture(f, scope).status).toBe(0); }
  finally { releaseQueueLock(context, token); }
  const files = fs.readdirSync(f.queue).filter(name => /^session-[a-f0-9]{24}-[\w-]+\.jsonl$/.test(name));
  expect(files).toHaveLength(1);
  const queue = path.join(f.queue, files[0]), original = fs.readFileSync(queue);
  const flush = f.run(); expect(flush.status, flush.stderr).toBe(0);
  expect(f.depth()).toBe(0); expect(fs.readFileSync(queue)).toEqual(original);
  expect(JSON.parse(fs.readFileSync(queue + '.ack.json', 'utf8'))).not.toEqual({});
  return f;
}

describe('learningScope drives the real capture and canonical observation paths', () => {
  it('off writes zero bytes and creates no project adoption', () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-learning-off-')));
    const home = path.join(root, 'home'), project = path.join(root, 'project'); fs.mkdirSync(home); fs.mkdirSync(project);
    fixtures.push({ cleanup: () => fs.rmSync(root, { recursive: true }) });
    const f = { home, project, env: { ...process.env, HOME: home, USERPROFILE: home, RUVNET_BRAIN_PROJECT_DIR: project } };
    expect(capture(f, 'off').status).toBe(0);
    expect(fs.existsSync(path.join(project, '.swarm'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.cache/ruvnet-brain/learn'))).toBe(false);
  });

  it.each(['project', 'user'])('%s commits only to its authorized canonical AgentDB and retains capture bytes', scope => {
    const f = observed(scope);
    const db = scope === 'project' ? path.join(f.project, '.swarm/memory.db') : path.join(f.home, '.claude/global-memory/.swarm/memory.db');
    const stores = f.readCalls(); expect(stores).toHaveLength(1);
    const call = stores[0]; expect(call.args.slice(0, 2)).toEqual(['memory', 'store']);
    expect(call.args[call.args.indexOf('--path') + 1]).toBe(db);
    expect(call.cwd.startsWith(path.join(f.home, '.cache/ruvnet-brain/learning-ruflo') + path.sep)).toBe(true);
    expect(call.daemon).toBe('0');
    const connection = new (loadNodeSqlite().DatabaseSync)(db, { readOnly: true });
    try { const rows = connection.prepare('SELECT content FROM memory_entries WHERE namespace=?').all('learning-observations');
      expect(rows).toHaveLength(1); expect(JSON.parse(rows[0].content).scope).toBe(scope); }
    finally { connection.close(); }
    const other = scope === 'project' ? path.join(f.home, '.claude/global-memory/.swarm/memory.db') : path.join(f.project, '.swarm/memory.db');
    expect(fs.existsSync(other)).toBe(false);
  });

  it('a user-scope environment hint without persisted consent cannot create user queue or memory', () => {
    const f = learningFixture('project'); fixtures.push(f);
    expect(capture(f, 'user').status).toBe(0);
    expect(fs.existsSync(path.join(f.home, '.cache/ruvnet-brain/learn'))).toBe(false);
    expect(fs.existsSync(path.join(f.home, '.claude/global-memory/.swarm/memory.db'))).toBe(false);
  });
});
