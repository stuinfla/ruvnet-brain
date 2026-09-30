// Metric: number of turn-capture write targets that resolve into a FOREIGN directory, per Stop.
// Targets: (1) the ruflo `memory store --path` db (realpath-resolved, as ruflo/sqlite would open it)
//          (2) the agentdb-turns.jsonl breadcrumb actually appended by the hook process.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const repo = process.argv[2];
const { captureTurnOutcome } = await import(path.join(repo, 'plugin/scripts/turn-outcome-capture.mjs'));
const OUT = 'x'.repeat(300);
const mk = (p) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const shapes = {
  'db-file-symlink': (proj, f) => { fs.mkdirSync(path.join(proj, '.swarm')); fs.symlinkSync(path.join(f, 'memory.db'), path.join(proj, '.swarm', 'memory.db')); },
  'swarm-dir-symlink': (proj, f) => fs.symlinkSync(f, path.join(proj, '.swarm'), 'dir'),
  'in-root-regular (control)': (proj) => { fs.mkdirSync(path.join(proj, '.swarm')); fs.writeFileSync(path.join(proj, '.swarm', 'memory.db'), ''); },
  'no-swarm (control)': () => {},
};
let total = 0;
for (const [name, plant] of Object.entries(shapes)) {
  const home = mk('m-home-'), proj = mk('m-proj-'), foreign = mk('m-foreign-');
  fs.writeFileSync(path.join(foreign, 'memory.db'), 'foreign');
  plant(proj, foreign);
  let steps = [];
  const r = captureTurnOutcome({ projectDir: proj, event: 'Stop', payload: { session_id: 's', last_assistant_message: OUT },
    env: {}, home, brainHome: path.join(home, 'brain'), ruflo: '/fake/ruflo', launch: (s) => { steps = s; return { launched: true }; } });
  const db = steps[0]?.args[steps[0].args.indexOf('--path') + 1];
  let dbReal; try { dbReal = fs.realpathSync.native(db); } catch { dbReal = path.join(fs.realpathSync.native(path.dirname(db)), path.basename(db)); }
  const foreignWrites = (dbReal.startsWith(foreign + path.sep) ? 1 : 0) + (fs.existsSync(path.join(foreign, 'agentdb-turns.jsonl')) ? 1 : 0);
  total += foreignWrites;
  console.log(JSON.stringify({ shape: name, scope: r.scope, recorded: r.recorded, db: db.startsWith(home) ? 'HOME/' + path.relative(home, db) : 'PROJECT/' + path.relative(proj, db), foreignWrites }));
  for (const d of [home, proj, foreign]) fs.rmSync(d, { recursive: true, force: true });
}
console.log('TOTAL_FOREIGN_WRITES', total);
