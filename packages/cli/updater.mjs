// The updater's one entry point. The auto-update off-switch is read here and only here.
// Skeleton slice: the automatic path checks the signed manifest's release number and records
// whether a newer release exists; applying it is `ruvnet-brain update --from` (WP 4 joins them).
import { paths, readConfig, readPointer, writeJsonAtomic } from '../contract/home.mjs';

export async function checkForUpdate({ home, fetchImpl = globalThis.fetch }) {
  const cfg = readConfig(home);
  if (cfg.autoUpdate === false) return { checked: false, reason: 'auto-update is off' };
  if (!cfg.updateUrl) return { checked: false, reason: 'no update source is configured' };
  const res = await fetchImpl(new URL('release.json', cfg.updateUrl), { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`update check failed: HTTP ${res.status}`);
  const offered = await res.json();
  const installed = readPointer(home)?.releaseNumber ?? 0;
  const result = { checked: true, at: Date.now(), offered: offered?.releaseNumber ?? null, installed, available: Number(offered?.releaseNumber) > installed };
  writeJsonAtomic(paths(home).updateCheck, result);
  return result;
}
