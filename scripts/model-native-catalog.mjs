#!/usr/bin/env node
// DISTINCT-FROM: model-router-catalog.mjs — fresh native subscription metadata, never model execution or policy promotion.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const HOSTS = { codex: 'openai', 'claude-code': 'anthropic' };
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const read = (file, optional = false) => {
  try { const bytes = fs.readFileSync(file); if (bytes.length > 1048576) throw new Error('Native catalog input exceeds limit'); return bytes; }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
};
function stage(file, bytes) {
  const temporary = `${file}.${randomUUID()}.tmp`; const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } catch (error) { fs.closeSync(fd); fs.unlinkSync(temporary); throw error; }
  fs.closeSync(fd);
  return temporary;
}
const equal = (a, b) => a === null ? b === null : b !== null && a.equals(b);
export async function refreshNativeCatalog({ routerDir = path.join(os.homedir(), '.claude', 'model-router'),
  deadline = Date.now() + 60000, inspect, now = Date.now() } = {}) {
  const checkedAt = new Date(now).toISOString();
  const failed = reason => ({ status: 'failed', checkedAt, newNativeModelIds: [], policyApplied: false, reason });
  const paths = { profile: path.join(routerDir, 'profile.json'), catalog: path.join(routerDir, 'catalog.json'),
    availability: path.join(routerDir, 'native-availability.json') };
  let guard; let acquired = false; const temporary = [];
  try {
    if (!path.isAbsolute(routerDir) || !Number.isFinite(deadline) || deadline <= Date.now()) return failed('Invalid native metadata directory or deadline');
    const before = Object.fromEntries(Object.entries(paths).map(([key, file]) => [key, read(file, key === 'availability')]));
    const profile = JSON.parse(before.profile); const catalog = JSON.parse(before.catalog);
    if (profile.automaticModelRoutingUpdates !== true) return failed('Automatic native model registration is not authorized by this profile');
    if (!Array.isArray(catalog.candidates) || catalog.candidates.some(c => typeof c.id !== 'string')
      || new Set(catalog.candidates.map(c => c.id)).size !== catalog.candidates.length) return failed('Existing model catalog is malformed');
    const hosts = Object.keys(HOSTS).filter(host => profile.harnesses?.[host]?.available === true
      && profile.harnesses[host].subscription === true && profile.harnesses[host].enabled !== false);
    if (!hosts.length) return failed('No enabled native subscription host in this profile');
    inspect ??= (await import('./model-native-qualification.mjs')).inspectNativeQualificationHost;
    const observations = []; const eligibleIds = []; const nativeIds = []; const unknownEffortIds = []; const withheldIds = [];
    const candidates = [...catalog.candidates];
    for (const host of hosts) {
      if (Date.now() >= deadline) return failed('Native metadata deadline expired');
      const result = await inspect({ host, deadline });
      if (result?.failure || result?.available !== true || result.nativeSubscription !== true || result.sourceReceipt?.host !== host
        || result.sourceReceipt.allowance?.verified !== true || result.catalogStatus !== 'verified'
        || !Array.isArray(result.models) || !result.models.length) return failed(`Verified native model list unavailable for ${host}`);
      const models = [];
      for (const model of result.models) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]+$/.test(model.id ?? '')) return failed(`Exact native model identity unavailable for ${host}`);
        const id = `${HOSTS[host]}/${model.id}`; nativeIds.push(id);
        const nativeEfforts = Array.isArray(model.efforts) ? model.efforts.filter(e => typeof e === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(e)) : [];
        const efforts = [...new Set(nativeEfforts.filter(e => EFFORTS.has(e)))].sort();
        const unrecognizedEfforts = [...new Set(nativeEfforts.filter(e => !EFFORTS.has(e)))].sort();
        const knownEfforts = efforts.length > 0;
        models.push({ id: model.id, efforts, effortSupport: knownEfforts ? 'verified' : 'unknown',
          ...(unrecognizedEfforts.length ? { unrecognizedEfforts } : {}) });
        if (!knownEfforts) { unknownEffortIds.push(id); continue; }
        const existing = candidates.find(c => c.id === model.id);
        if (existing) {
          if (existing.provider !== HOSTS[host] || existing.disabled === true || existing.enabled === false
            || !existing.harness?.includes(host) || !existing.subscription?.includes(host)) { withheldIds.push(id); continue; }
        } else candidates.push({ id: model.id, provider: HOSTS[host], harness: [host], subscription: [host],
          supportedEfforts: efforts, costPerMTok: null, verified: `${checkedAt} native subscription metadata; execution not tested`,
          note: 'Native catalog availability is not role-quality qualification or active routing approval.' });
        eligibleIds.push(id);
      }
      if (new Set(models.map(m => m.id)).size !== models.length) return failed(`Duplicate native model identity for ${host}`);
      observations.push({ host, provider: HOSTS[host], checkedAt: result.checkedAt, harnessVersion: result.harnessVersion, allowanceVerified: true, models: models.sort((a, b) => a.id.localeCompare(b.id)) });
    }
    if (Date.now() >= deadline) return failed('Native metadata deadline expired');
    const previous = before.availability ? JSON.parse(before.availability) : null;
    if (previous && (previous.schemaVersion !== 1 || !Array.isArray(previous.nativeModelIds)
      || previous.nativeModelIds.some(id => typeof id !== 'string'))) return failed('Previous native availability baseline is malformed');
    const ids = [...new Set(eligibleIds)].sort(); const nativeModelIds = [...new Set(nativeIds)].sort();
    const newNativeModelIds = previous ? nativeModelIds.filter(id => !previous.nativeModelIds.includes(id)) : [];
    const snapshot = { schemaVersion: 1, status: 'current', checkedAt, hosts: observations,
      nativeModelIds, eligibleModelIds: ids, unknownEffortModelIds: unknownEffortIds.sort(), withheldExistingModelIds: [...new Set(withheldIds)].sort(), inferenceRequests: 0, policyApplied: false };
    const changedCatalog = candidates.length !== catalog.candidates.length;
    const catalogBytes = changedCatalog ? Buffer.from(JSON.stringify({ ...catalog, candidates }, null, 2) + '\n') : before.catalog;
    const snapshotBytes = Buffer.from(JSON.stringify(snapshot, null, 2) + '\n');
    guard = path.join(routerDir, 'native-catalog-mutation.lock'); fs.mkdirSync(guard, { mode: 0o700 }); acquired = true;
    for (const [key, file] of Object.entries(paths)) if (!equal(before[key], read(file, key === 'availability'))) throw new Error('Native catalog inputs changed');
    const history = path.join(routerDir, 'native-catalog-history', `${now}-${randomUUID()}`); fs.mkdirSync(history, { recursive: true, mode: 0o700 });
    for (const [name, bytes] of [['catalog.json', before.catalog], ['native-availability.json', before.availability]]) {
      if (!bytes) continue; const target = path.join(history, name); const temp = stage(target, bytes); temporary.push(temp); fs.renameSync(temp, target);
    }
    const catalogTemp = changedCatalog ? stage(paths.catalog, catalogBytes) : null;
    if (catalogTemp) temporary.push(catalogTemp);
    const snapshotTemp = stage(paths.availability, snapshotBytes); temporary.push(snapshotTemp);
    if (catalogTemp) fs.renameSync(catalogTemp, paths.catalog);
    try { fs.renameSync(snapshotTemp, paths.availability); }
    catch (error) {
      if (catalogTemp && equal(catalogBytes, read(paths.catalog))) {
        const restore = stage(paths.catalog, before.catalog); temporary.push(restore); fs.renameSync(restore, paths.catalog);
      }
      throw error;
    }
    return { status: 'current', checkedAt, newNativeModelIds, baseline: previous === null,
      catalogAdded: candidates.length - catalog.candidates.length, unknownEffortModelIds: snapshot.unknownEffortModelIds, withheldExistingModelIds: snapshot.withheldExistingModelIds,
      inferenceRequests: 0, policyApplied: false };
  } catch { return failed('Native catalog refresh refused; previous availability and owner catalog retained where unchanged'); }
  finally {
    for (const file of temporary) { try { fs.unlinkSync(file); } catch { /* renamed */ } }
    if (acquired) { try { fs.rmdirSync(guard); } catch { /* not acquired */ } }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = name => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
  refreshNativeCatalog({ routerDir: option('--router-dir'), deadline: option('--deadline') === undefined ? undefined : Number(option('--deadline')) })
    .then(result => { console.log(JSON.stringify(result)); if (result.status !== 'current') process.exitCode = 1; });
}
