// brain-profile.mjs — enforce the user's installed knowledge profile by artifact family.
//
// Each repository is already one independent RVF + sidecar family. "RuVector only" therefore means
// keeping the shared reader plus the ruvector family, not rebuilding or copying a second brain.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PROFILE_COMPLETE = 'complete';
export const PROFILE_RUVECTOR = 'ruvector';
export const BRAIN_PROFILES = Object.freeze([PROFILE_COMPLETE, PROFILE_RUVECTOR]);

export function settingsPath(env = process.env) {
  return env.RUVNET_SETTINGS_FILE
    || path.join(os.homedir(), '.config', 'ruvnet-brain', 'settings.json');
}

export function readBrainProfile({ env = process.env } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(env), 'utf8'));
    const value = parsed?.settings?.brainProfile;
    return BRAIN_PROFILES.includes(value) ? value : PROFILE_COMPLETE;
  } catch {
    return PROFILE_COMPLETE;
  }
}

export function discoverStoreFamilies(dir) {
  const names = new Set();
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  for (const entry of entries) {
    const match = entry.match(/^(.+?)(?:\.big)?\.rvf$/);
    if (match && !/\.(?:idmap|embed)\b/.test(entry)) names.add(match[1]);
  }
  return [...names].sort();
}

function familyEntries(dir, store) {
  return fs.readdirSync(dir).filter((entry) =>
    entry === `${store}-primer.md` || entry === store || entry.startsWith(`${store}.`));
}

// SOURCE is the existing update-ownership policy; PRIVATE-STORES is the existing
// case-insensitive publication fence. Neither discovery nor a filename prefix grants ownership.
function profileOwnership(dir) {
  const read = (name) => {
    const file = path.join(dir, name);
    if (!fs.lstatSync(file).isFile()) throw new Error(`profile ownership requires regular ${name}`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };
  const source = read('SOURCE.json');
  const fence = read('PRIVATE-STORES.json');
  if (!Array.isArray(fence.privateStores) || fence.privateStores.some((s) => typeof s !== 'string' || !s)) {
    throw new Error('invalid PRIVATE-STORES ownership policy');
  }
  const entries = Array.isArray(source.stores)
    ? source.stores.map((s) => [s?.kbName, s])
    : source.stores && typeof source.stores === 'object'
      ? Object.entries(source.stores) : null;
  if (!entries) throw new Error('invalid SOURCE ownership policy');
  const privateNames = new Set(fence.privateStores.map((s) => s.toLowerCase()));
  const managed = new Set();
  const seen = new Set();
  for (const [name, value] of entries) {
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/i.test(name)
      || !value || typeof value !== 'object' || Array.isArray(value)
      || (value.kbName != null && value.kbName !== name)
      || (value.updateManaged != null && typeof value.updateManaged !== 'boolean')
      || seen.has(name.toLowerCase())) throw new Error('invalid SOURCE store ownership');
    seen.add(name.toLowerCase());
    if (value.updateManaged !== false && !privateNames.has(name.toLowerCase())) managed.add(name);
  }
  return { managed, read };
}

// Only published artifact spellings, never arbitrary store.* siblings or directories.
function managedEntries(dir, store) {
  const names = new Set([`${store}-primer.md`, ...[
    '.rvf', '.big.rvf', '.idmap.json', '.rvf.idmap.json', '.rvf.embed.json',
    '.big.rvf.idmap.json', '.big.rvf.embed.json', '.passages.jsonl',
    '.big.passages.jsonl', '.meta.json', '.big.meta.json', '.symbols.json',
  ].map((suffix) => `${store}${suffix}`)]);
  return fs.readdirSync(dir).filter((entry) => names.has(entry));
}

function requireRegular(dir, entries) {
  for (const entry of entries) {
    if (!fs.lstatSync(path.join(dir, entry)).isFile()) {
      throw new Error(`profile requires regular artifact, not directory or symbolic link: ${entry}`);
    }
  }
}

function cardParts(text) {
  return text.split(/(?=^## )/m);
}

function cardName(part) {
  return part.match(/^## ([^\n]+)\s*$/m)?.[1]?.trim();
}

function filterCapabilityCards(dir, managed, { validateOnly = false } = {}) {
  const file = path.join(dir, 'capability-cards.md');
  if (!fs.existsSync(file)) return;
  const backup = path.join(dir, 'capability-cards.complete.md');
  const current = fs.readFileSync(file, 'utf8');
  if (!/^## ruvector\s*$/m.test(current)) throw new Error('could not isolate the RuVector capability card');
  const keep = (part) => !managed.has(cardName(part)) || cardName(part) === PROFILE_RUVECTOR;
  if (validateOnly) return;
  if (!fs.existsSync(backup) || cardParts(current).some((part) => !keep(part))) fs.copyFileSync(file, backup);
  fs.writeFileSync(file, cardParts(current).filter(keep).join(''));
}

function restoreCapabilityCards(dir) {
  const backup = path.join(dir, 'capability-cards.complete.md');
  if (fs.existsSync(backup)) {
    const { managed } = profileOwnership(dir);
    requireRegular(dir, ['capability-cards.complete.md', 'capability-cards.md']);
    mergeCapabilityCards(dir, fs.readFileSync(backup, 'utf8'), managed);
  }
}

function mergeCapabilityCards(dir, incoming, managed) {
  const file = path.join(dir, 'capability-cards.md');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const preserved = cardParts(current).filter((part) => cardName(part) && !managed.has(cardName(part)));
  const next = cardParts(incoming).filter((part) => !cardName(part) || managed.has(cardName(part)));
  fs.writeFileSync(file, [...next, ...preserved].join(''));
}

export function applyBrainProfile(dir, profile) {
  if (!BRAIN_PROFILES.includes(profile)) throw new Error(`unknown brain profile: ${profile}`);
  if (profile === PROFILE_COMPLETE) {
    restoreCapabilityCards(dir);
    return { profile, removed: [], bytesFreed: 0, stores: discoverStoreFamilies(dir) };
  }

  const allowed = new Set([PROFILE_RUVECTOR]);
  const ownership = profileOwnership(dir);
  const ledger = ownership.read('RVF-GENERATIONS.json');
  if (!ledger.stores || typeof ledger.stores !== 'object' || Array.isArray(ledger.stores)) {
    throw new Error('invalid RVF-GENERATIONS ownership metadata');
  }
  const plan = discoverStoreFamilies(dir)
    .filter((store) => !allowed.has(store) && ownership.managed.has(store))
    .map((store) => ({ store, entries: managedEntries(dir, store) }));
  for (const { entries } of plan) requireRegular(dir, entries);
  requireRegular(dir, ['capability-cards.md', 'capability-cards.complete.md']
    .filter((name) => fs.readdirSync(dir).includes(name)));
  filterCapabilityCards(dir, ownership.managed, { validateOnly: true });
  const removed = [];
  const removedStores = [];
  let bytesFreed = 0;
  for (const { store, entries } of plan) {
    removedStores.push(store);
    for (const entry of entries) {
      const target = path.join(dir, entry);
      try { bytesFreed += fs.statSync(target).size; } catch { /* report only measured bytes */ }
      fs.unlinkSync(target);
      removed.push(entry);
    }
  }
  filterCapabilityCards(dir, ownership.managed);
  for (const store of removedStores) delete ledger.stores[store];
  fs.writeFileSync(path.join(dir, 'RVF-GENERATIONS.json'), `${JSON.stringify(ledger, null, 2)}\n`);
  return { profile, removed, removedStores, bytesFreed, stores: discoverStoreFamilies(dir) };
}

export function restoreCompleteProfile(targetDir, sourceDir) {
  if (!discoverStoreFamilies(sourceDir).includes(PROFILE_RUVECTOR)) {
    throw new Error(`complete bundle source is unavailable at ${sourceDir}`);
  }
  const sourceOwnership = profileOwnership(sourceDir);
  const targetOwnership = profileOwnership(targetDir);
  const sourceLedger = sourceOwnership.read('RVF-GENERATIONS.json');
  const targetLedger = targetOwnership.read('RVF-GENERATIONS.json');
  for (const ledger of [sourceLedger, targetLedger]) {
    if (!ledger.stores || typeof ledger.stores !== 'object' || Array.isArray(ledger.stores)) {
      throw new Error('invalid RVF-GENERATIONS ownership metadata');
    }
  }
  const stores = discoverStoreFamilies(sourceDir).filter((store) => sourceOwnership.managed.has(store));
  for (const store of stores) {
    if (!targetOwnership.managed.has(store)) throw new Error(`private or unknown restoration ownership: ${store}`);
    requireRegular(sourceDir, managedEntries(sourceDir, store));
    requireRegular(targetDir, managedEntries(targetDir, store));
  }
  requireRegular(sourceDir, ['capability-cards.md']);
  requireRegular(targetDir, ['capability-cards.md', 'capability-cards.complete.md']
    .filter((name) => fs.readdirSync(targetDir).includes(name)));
  for (const store of stores) {
    for (const entry of managedEntries(sourceDir, store)) {
      fs.cpSync(path.join(sourceDir, entry), path.join(targetDir, entry), {
        recursive: true,
        force: true,
      });
    }
    if (sourceLedger.stores[store]) targetLedger.stores[store] = sourceLedger.stores[store];
  }
  targetLedger.stores = Object.fromEntries(Object.entries(targetLedger.stores).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(path.join(targetDir, 'RVF-GENERATIONS.json'), `${JSON.stringify(targetLedger, null, 2)}\n`);
  const cards = path.join(sourceDir, 'capability-cards.md');
  if (fs.existsSync(cards)) {
    mergeCapabilityCards(targetDir, fs.readFileSync(cards, 'utf8'), new Set(stores));
    fs.copyFileSync(path.join(targetDir, 'capability-cards.md'), path.join(targetDir, 'capability-cards.complete.md'));
  }
  return { profile: PROFILE_COMPLETE, stores: discoverStoreFamilies(targetDir) };
}

export function measureBrainProfile(dir) {
  const stores = discoverStoreFamilies(dir);
  const byStore = {};
  let bytes = 0;
  for (const store of stores) {
    let storeBytes = 0;
    for (const entry of familyEntries(dir, store)) {
      const target = path.join(dir, entry);
      const walk = (p) => {
        const stat = fs.statSync(p);
        if (!stat.isDirectory()) { storeBytes += stat.size; return; }
        for (const child of fs.readdirSync(p)) walk(path.join(p, child));
      };
      try { walk(target); } catch { /* a changing file is omitted from the measurement */ }
    }
    byStore[store] = storeBytes;
    bytes += storeBytes;
  }
  return { stores, storeCount: stores.length, bytes, byStore };
}
