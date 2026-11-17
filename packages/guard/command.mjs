// `ruvnet-brain guard on|off|status`: the one switch of the optional write guard. Off unless turned on
// here; the installer never turns it on. Writes one field (guard) in state/config.json.
import { paths, readConfig, readJson, writeJsonAtomic } from '../contract/home.mjs';

export const USAGE = `usage:
  ruvnet-brain guard on        before a file that names a rUv product is written, ask for a search first
                               (advisory only while search is not ok; an in-file line lets a write through)
  ruvnet-brain guard off       the default
  ruvnet-brain guard status`;

export async function main(home, args, { log = console.log, err = console.error } = {}) {
  const [what] = args;
  if (what === 'on' || what === 'off') {
    writeJsonAtomic(paths(home).config, { ...readJson(paths(home).config, {}), guard: what === 'on' });
    log(`guard ${what}`);
    return 0;
  }
  if (what === 'status') {
    log(`guard ${readConfig(home).guard === true ? 'on' : 'off'}`);
    return 0;
  }
  if (what === '--help') {
    log(USAGE);
    return 0;
  }
  err(USAGE);
  return 2;
}
