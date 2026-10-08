import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluateManagedStoreWrite } from '../../plugin/scripts/managed-store-write-policy.mjs';
import { canonicalStoreWriteScope } from '../../plugin/scripts/project-store-resolver.mjs';

const fixtures = [];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function world() {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-write-policy-')));
  fixtures.push(cwd); fs.mkdirSync(path.join(cwd, '.swarm'));
  fs.writeFileSync(path.join(cwd, '.swarm/memory.db'), 'private resolver target; not executed SQL');
  const env = { ...process.env, HOME: cwd, RUVNET_BRAIN_STATE_DIR: path.join(cwd, 'state') };
  delete env.RUVNET_BRAIN_OFF;
  return { cwd, env, event(command) { return { cwd, tool_name: 'Bash', tool_input: { command } }; } };
}
afterEach(() => { for (const dir of fixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
describe('mandatory owned canonical managed-store writes', () => {
  it('refuses literal sqlite writes even with default advise', () => {
    const w = world(); const result = evaluateManagedStoreWrite(w.event("sqlite3 .swarm/memory.db 'INSERT INTO entries VALUES (1)'"), { env: w.env });
    expect(result.decision).toBe('deny'); expect(result.status).toBe('known-managed-write');
  });
  it('keeps read-only inspection, unrelated DBs and sanctioned prose outside mandatory refusal', () => {
    const w = world();
    for (const c of ["sqlite3 -readonly .swarm/memory.db 'SELECT 1'", "sqlite3 scratch.sqlite 'INSERT INTO entries VALUES (1)'", "ruflo memory search 'sqlite3 .swarm/memory.db INSERT'", "echo 'sqlite3 .swarm/memory.db INSERT'"])
      expect(evaluateManagedStoreWrite(w.event(c), { env: w.env }).decision, c).toBe('allow');
  });
  it('refuses supported literal Python and Node SQLite writes', () => {
    const w = world();
    for (const c of ["python3 -c \"import sqlite3; c=sqlite3.connect('.swarm/memory.db'); c.execute('DELETE FROM entries')\"", "node -e \"const {DatabaseSync}=require('node:sqlite'); const d=new DatabaseSync('.swarm/memory.db'); d.exec('DROP TABLE entries')\""])
      expect(evaluateManagedStoreWrite(w.event(c), { env: w.env }).decision, c).toBe('deny');
  });
  it('does not mistake a foreign same-basename store for current canonical ownership', () => {
    const w = world(), foreign = world();
    expect(evaluateManagedStoreWrite(w.event(`sqlite3 ${foreign.cwd}/.swarm/memory.db 'DELETE FROM entries'`), { env: w.env }).decision).toBe('allow');
  });
  it('trusted Brain OFF suppresses this policy, learning OFF does not', () => {
    const w = world(), ev = w.event("sqlite3 .swarm/memory.db 'DELETE FROM entries'");
    expect(evaluateManagedStoreWrite(ev, { env: { ...w.env, RUVNET_BRAIN_OFF: '1' } }).status).toBe('brain-off');
    expect(evaluateManagedStoreWrite(ev, { env: { ...w.env, RUVNET_LEARNING_SCOPE: 'off' } }).decision).toBe('deny');
  });
  it('known managed write cannot become allow after resolver failure or expired deadline', () => {
    const w = world(), ev = w.event("sqlite3 .swarm/memory.db 'DELETE FROM entries'");
    expect(evaluateManagedStoreWrite(ev, { env: w.env, resolveStore() { throw Error('unavailable'); } }).decision).toBe('deny');
    expect(evaluateManagedStoreWrite(ev, { env: w.env, deadlineAt: Date.now() - 1 }).decision).toBe('deny');
  });
  it('preserves command-local targets before later cd and leaves unadopted stores alone', () => {
    const w = world();
    expect(evaluateManagedStoreWrite(w.event("sqlite3 .swarm/memory.db 'DELETE FROM entries'; cd /tmp"), { env: w.env }).decision).toBe('deny');
    fs.unlinkSync(path.join(w.cwd, '.swarm/memory.db'));
    expect(evaluateManagedStoreWrite(w.event("sqlite3 .swarm/memory.db 'DELETE FROM entries'"), { env: w.env }).status).toBe('unadopted');
  });
  it('refuses sqlite -cmd SQL but not inline programs merely printing SQL examples', () => {
    const w = world(), target = path.join(w.cwd, '.swarm/memory.db');
    expect(evaluateManagedStoreWrite(w.event(`sqlite3 -cmd 'DELETE FROM entries' '${target}' 'SELECT 1'`), { env: w.env }).decision).toBe('deny');
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    for (const [exe, flag, code] of [['python3', '-c', `print("sqlite3.connect('${target}').execute('DELETE FROM entries')")`],
      ['node', '-e', `console.log("require('node:sqlite'); new DatabaseSync('${target}').exec('DELETE FROM entries')")`]])
      expect(evaluateManagedStoreWrite(w.event(`${exe} ${flag} ${quote(code)}`), { env: w.env }).decision).toBe('allow');
  });
  it('refuses expired linked-worktree canonical writes without using checkout-local fallback identity', () => {
    const w = world(), linked = path.join(w.cwd, 'linked');
    const git = (...args) => execFileSync('git', args, { cwd: w.cwd, stdio: 'ignore' });
    git('init'); git('config', 'user.name', 'Private fixture'); git('config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(w.cwd, 'tracked'), 'fixture'); git('add', 'tracked'); git('commit', '-m', 'private fixture');
    git('worktree', 'add', '-b', 'linked', linked);
    const event = { cwd: linked, tool_name: 'Bash', tool_input: { command: `sqlite3 '${path.join(w.cwd, '.swarm/memory.db')}' 'DELETE FROM entries'` } };
    const r = spawnSync(process.execPath, [path.join(ROOT, 'plugin/scripts/hook-shim.mjs'), 'decision-gate', 'managed-store'], {
      input: JSON.stringify(event), encoding: 'utf8', timeout: 5000, env: { ...w.env, RUVNET_DECISION_DEADLINE: String(Date.now() - 1) } });
    expect(r.status).toBe(2); expect(r.stdout).toBe(''); expect(r.stderr).toContain('Raw writes');
  });
  it('ignores Python and JavaScript comments containing managed-write examples', () => {
    const w = world(), target = path.join(w.cwd, '.swarm/memory.db'), quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    for (const [exe, flag, code] of [['python3', '-c', `# sqlite3.connect('${target}').execute('DELETE FROM entries')\nprint('hello')`],
      ['node', '-e', `// require('node:sqlite'); new DatabaseSync('${target}').exec('DELETE FROM entries')\nconsole.log('hello')`],
      ['node', '-e', `/* require('node:sqlite'); new DatabaseSync('${target}').exec('DELETE FROM entries') */ console.log('hello')`]])
      expect(evaluateManagedStoreWrite(w.event(`${exe} ${flag} ${quote(code)}`), { env: w.env }).decision).toBe('allow');
  });
  it('rejects escaped and hard-linked identities instead of labeling them current canonical scope', () => {
    const w = world(), foreign = world(), logical = path.join(w.cwd, '.swarm/memory.db');
    const scope = () => canonicalStoreWriteScope({ projectDir: w.cwd, targets: [logical], env: w.env });
    fs.unlinkSync(logical); fs.symlinkSync(path.join(foreign.cwd, '.swarm/memory.db'), logical);
    expect(scope).toThrow('store symlink escape rejected');
    fs.unlinkSync(logical); fs.linkSync(path.join(foreign.cwd, '.swarm/memory.db'), logical);
    expect(scope).toThrow('store hard link rejected');
  });
  it('executes both registered host chains: deny before sentinel, no stdout pollution, aliases and trusted OFF', () => {
    const w = world(), version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'))).version;
    const brain = path.join(w.cwd, 'brain'), generation = path.join(brain, 'versions', version);
    fs.mkdirSync(generation, { recursive: true });
    fs.cpSync(path.join(ROOT, 'plugin/scripts'), path.join(generation, 'scripts'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'plugin/hooks'), path.join(generation, 'hooks'), { recursive: true });
    for (const name of ['codex-hook-wrapper.mjs', 'development-maintenance.mjs'])
      fs.copyFileSync(path.join(ROOT, 'plugin/scripts', name), path.join(brain, name === 'codex-hook-wrapper.mjs' ? 'codex-hook.mjs' : name));
    fs.writeFileSync(path.join(brain, 'active.json'), JSON.stringify({ generation: version, version, codeRoot: `versions/${version}` }));
    const env = { ...w.env, RUVNET_BRAIN_HOME: brain, CODEX_HOME: path.join(w.cwd, 'codex'), CLAUDE_PLUGIN_ROOT: generation };
    const command = "sqlite3 .swarm/memory.db 'DELETE FROM entries'", before = fs.readFileSync(path.join(w.cwd, '.swarm/memory.db'));
    for (const [host, name] of [['claude', 'Bash'], ['codex', 'exec_command'], ['codex', 'functions.exec_command'], ['codex', 'functions__exec_command']]) {
      const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin/hooks', host === 'claude' ? 'hooks.json' : 'codex-hooks.json')));
      const matching = hooks.hooks.PreToolUse.filter(row => row.matcher === '*' || new RegExp(row.matcher).test(name));
      const policy = matching.flatMap(row => row.hooks).filter(row => row.command.includes('decision-gate'));
      expect(policy).toHaveLength(1); expect(policy[0].command).toContain('decision-gate managed-store');
      const event = { cwd: w.cwd, hook_event_name: 'PreToolUse', tool_name: name, tool_input: host === 'claude' ? { command } : { cmd: command } };
      const fire = extra => spawnSync('bash', ['-c', policy[0].command], { input: JSON.stringify(event), encoding: 'utf8', timeout: 9500, env: { ...env, ...extra } });
      const result = fire({}); const sentinel = path.join(w.cwd, `effect-${name}`);
      if (result.status === 0) fs.writeFileSync(sentinel, 'effect would have been admitted');
      expect(result.error).toBeUndefined(); expect(result.status).toBe(2); expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Raw writes'); expect(fs.existsSync(sentinel)).toBe(false);
      const exhausted = fire({ RUVNET_DECISION_DEADLINE: String(Date.now() - 1) });
      expect(exhausted.status).toBe(2); expect(exhausted.stdout).toBe('');
      const off = fire({ RUVNET_BRAIN_OFF: '1' }); expect(off.status).toBe(0); expect(off.stdout).toBe(''); expect(off.stderr).toBe('');
    }
    expect(fs.readFileSync(path.join(w.cwd, '.swarm/memory.db'))).toEqual(before);
    const helper = path.join(generation, 'scripts/managed-store-write-policy.mjs');
    const original = fs.readFileSync(helper);
    for (const fault of ['missing', 'throw', 'timeout']) {
      if (fault === 'missing') fs.unlinkSync(helper);
      else fs.writeFileSync(helper, fault === 'throw' ? "throw Error('private helper fault');" : 'await new Promise(() => {});');
      for (const host of ['claude', 'codex']) {
        const rows = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin/hooks', host === 'claude' ? 'hooks.json' : 'codex-hooks.json'))).hooks.PreToolUse;
        const hook = rows.flatMap(row => row.hooks).find(row => row.command.includes('decision-gate managed-store'));
        const fire = command => spawnSync('bash', ['-c', hook.command], { input: JSON.stringify({ cwd: w.cwd, hook_event_name: 'PreToolUse', tool_name: host === 'claude' ? 'Bash' : 'exec_command', tool_input: host === 'claude' ? { command } : { cmd: command } }), encoding: 'utf8', timeout: 6000, env: { ...env, RUVNET_DECISION_BUDGET_MS: '400' } });
        const failed = fire(command); expect(failed.error).toBeUndefined(); expect(failed.status, `${host}/${fault}`).toBe(2); expect(failed.stdout).toBe('');
        expect(failed.stderr).toContain('policy unavailable');
        const read = fire("sqlite3 -readonly .swarm/memory.db 'SELECT 1'"); expect(read.status).toBe(0); expect(read.stdout).toBe(''); expect(read.stderr).toBe('');
      }
      fs.writeFileSync(helper, original);
    }
    const codexHooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin/hooks/codex-hooks.json')));
    const hook = codexHooks.hooks.PreToolUse.flatMap(row => row.hooks).find(row => row.command.includes('decision-gate managed-store'));
    const body = JSON.stringify({ cwd: w.cwd, hook_event_name: 'PreToolUse', tool_name: 'functions.exec_command', tool_input: { cmd: command } });
    for (const stage of ['wrapper', 'adapter', 'shim']) {
      const file = stage === 'wrapper' ? path.join(brain, 'codex-hook.mjs') : path.join(generation, 'scripts', stage === 'adapter' ? 'codex-hook-adapter.mjs' : 'hook-shim.mjs');
      const original = fs.readFileSync(file);
      for (const fault of ['missing', 'non2', 'silent0', 'signal', 'timeout']) {
        if (fault === 'missing') fs.unlinkSync(file);
        else fs.writeFileSync(file, { non2: 'process.exit(1);', silent0: 'process.exit(0);', signal: "process.kill(process.pid,'SIGTERM');", timeout: 'setInterval(()=>{},1000);' }[fault]);
        const r = spawnSync('bash', ['-c', hook.command], { input: body, encoding: 'utf8', timeout: 6000, env: { ...env, RUVNET_CODEX_HOOK_TIMEOUT_MS: '300', RUVNET_CODEX_BUDGET_MS: '300', RUVNET_DECISION_DEADLINE: String(Date.now() + 700) } });
        expect(r.error, `${stage}/${fault}`).toBeUndefined(); expect(r.status, `${stage}/${fault}`).toBe(2); expect(r.stdout).toBe(''); expect(r.stderr).toContain('Raw writes');
        if (fault === 'non2') {
          const readBody = JSON.stringify({ cwd: w.cwd, hook_event_name: 'PreToolUse', tool_name: 'exec_command', tool_input: { cmd: "sqlite3 -readonly .swarm/memory.db 'SELECT 1'" } });
          for (const [input, extra] of [[readBody, {}], [body, { RUVNET_BRAIN_OFF: '1' }]]) {
            const ordinary = spawnSync('bash', ['-c', hook.command], { input, encoding: 'utf8', timeout: 6000,
              env: { ...env, ...extra, RUVNET_DECISION_DEADLINE: String(Date.now() + 700) } });
            expect(ordinary.status).toBe(0); expect(ordinary.stdout).toBe(''); expect(ordinary.stderr).toBe('');
          }
        }
        fs.writeFileSync(file, original);
      }
    }
    const logical = path.join(w.cwd, '.swarm/memory.db'), physical = path.join(w.cwd, '.swarm/physical.db');
    const shim = path.join(generation, 'scripts/hook-shim.mjs'), originalShim = fs.readFileSync(shim);
    fs.renameSync(logical, physical); fs.symlinkSync('physical.db', logical);
    for (const alias of ['file', 'directory']) {
      if (alias === 'directory') {
        fs.unlinkSync(logical); fs.renameSync(physical, logical);
        fs.renameSync(path.join(w.cwd, '.swarm'), path.join(w.cwd, 'private-store'));
        fs.symlinkSync('private-store', path.join(w.cwd, '.swarm'));
      }
      expect(canonicalStoreWriteScope({ projectDir: w.cwd, targets: [logical], env: w.env }), alias).toBe(true);
      fs.writeFileSync(shim, 'process.exit(1);');
      const result = spawnSync('bash', ['-c', hook.command], { input: body, encoding: 'utf8', timeout: 6000, env });
      expect(result.status, alias).toBe(2); expect(result.stdout).toBe(''); expect(result.stderr).toContain('Raw writes');
      fs.writeFileSync(shim, originalShim);
    }
    expect(fs.readFileSync(logical)).toEqual(before);
  }, 30000);
});
