// One separate process for the determinism tests: opens the engine at <engineDir> on <packDir>, asks
// every question in <questions.json> (an array of strings) and prints, as JSON, the first five FILES
// of each answer.   node wp1-run-engine.mjs <engineDir> <packDir> <questions.json>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [engineDir, packDir, qFile] = process.argv.slice(2);
const engine = await import(pathToFileURL(path.join(engineDir, 'index.mjs')).href);
const h = engine.open(packDir);
const out = JSON.parse(fs.readFileSync(qFile, 'utf8')).map((q) => {
  const files = engine.search(h, q, { detail: 'full' }).sections.find((s) => s.name === 'FILES').items;
  return files.slice(0, 5).map((i) => `${i.repo}/${i.path}`);
});
engine.close(h);
process.stdout.write(JSON.stringify(out));
