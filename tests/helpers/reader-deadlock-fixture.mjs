import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function createReaderDeadlockFixture({ kbDir, modelCache }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reader-deadlock-')));
  const kb = path.join(root, 'kb');
  const cache = path.join(root, 'models');
  try {
    fs.mkdirSync(kb);
    fs.mkdirSync(cache);
    fs.mkdirSync(path.join(root, 'home'));
    // Copy executable inputs, not the corpus or any ambient model/cache directory.
    for (const entry of fs.readdirSync(kbDir, { withFileTypes: true })) {
      if (entry.isFile() && (entry.name.endsWith('.mjs') || entry.name === 'package.json')) {
        fs.copyFileSync(path.join(kbDir, entry.name), path.join(kb, entry.name));
      }
    }
    for (const [source, target] of [
      [path.join(kbDir, 'node_modules'), path.join(kb, 'node_modules')],
      [path.join(kbDir, '..', 'node_modules'), path.join(root, 'node_modules')],
    ]) {
      if (fs.existsSync(source)) fs.symlinkSync(fs.realpathSync(source), target, process.platform === 'win32' ? 'junction' : 'dir');
    }
    const model = 'Xenova/ms-marco-MiniLM-L-6-v2';
    if (modelCache && fs.existsSync(path.join(modelCache, model))) {
      // dereference creates independent regular bytes even if the source cache uses symlinks.
      fs.cpSync(path.join(modelCache, model), path.join(cache, model), { recursive: true, dereference: true });
    }
    fs.writeFileSync(path.join(root, '.reader-deadlock-fixture'), 'disposable\n');
    return { root, kb, cache, env: { ...process.env, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), KB_MODEL_CACHE: cache } };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
