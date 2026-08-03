import fs from 'node:fs';
import path from 'node:path';

export const SNAPSHOT_SCHEMA = 'ruvnet-brain.session-snapshot';
export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const EVENTS = new Set(['PreCompact', 'PostCompact', 'SessionEnd']);

export function createSessionSnapshot({ event, capturedAt = new Date().toISOString() }) {
  if (!EVENTS.has(event)) throw new Error(`unsupported snapshot event: ${event}`);
  if (!Number.isFinite(Date.parse(capturedAt))) throw new Error('capturedAt must be an ISO-8601 timestamp');
  return {
    schema: SNAPSHOT_SCHEMA,
    version: SNAPSHOT_VERSION,
    capturedAt,
    boundary: { event },
    privacy: { rawTranscriptStored: false, credentialValuesStored: false },
  };
}

export function validateSessionSnapshot(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.schema === SNAPSHOT_SCHEMA
    && value.version === SNAPSHOT_VERSION
    && EVENTS.has(value.boundary?.event)
    && Number.isFinite(Date.parse(value.capturedAt))
    && value.privacy?.rawTranscriptStored === false
    && value.privacy?.credentialValuesStored === false;
}

function freshness(capturedAt, now) {
  const age = now - Date.parse(capturedAt);
  return age >= 0 && age <= SNAPSHOT_MAX_AGE_MS;
}

function canonical(projectDir, now) {
  const file = path.join(projectDir, '.swarm', 'agentdb-sessions.jsonl');
  if (!fs.existsSync(file)) return { values: [], malformed: false };
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) {
      return { values: [], malformed: true };
    }
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).slice(-128);
    const values = [];
    let malformed = false;
    for (const line of lines) {
      try {
        const value = JSON.parse(line);
        if (validateSessionSnapshot(value)) values.push({ kind: 'canonical', fresh: freshness(value.capturedAt, now), capturedAt: value.capturedAt });
        else malformed = true;
      } catch { malformed = true; }
    }
    return { values, malformed };
  } catch { return { values: [], malformed: true }; }
}

function legacy(projectDir, now) {
  const values = [];
  let malformed = false;
  for (const root of ['.claude', '.claude-flow']) {
    const directory = path.join(projectDir, root, 'sessions');
    if (!fs.existsSync(directory)) continue;
    let names;
    try {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return { values: [], malformed: true };
      names = fs.readdirSync(directory).filter((name) => /^session-.*\.json$/.test(name)).slice(-64);
    } catch { malformed = true; continue; }
    for (const name of names) {
      try {
        const file = path.join(directory, name);
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) { malformed = true; continue; }
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        const capturedAt = value.endedAt || value.startedAt;
        if (typeof value.id !== 'string' || !value.id || !value.context || !value.metrics || !Number.isFinite(Date.parse(capturedAt))) {
          malformed = true;
          continue;
        }
        values.push({ kind: 'legacy', fresh: freshness(capturedAt, now), capturedAt });
      } catch { malformed = true; }
    }
  }
  return { values, malformed };
}

export function inspectSessionSnapshots(projectDir, { now = Date.now() } = {}) {
  const results = [canonical(projectDir, now), legacy(projectDir, now)];
  const values = results.flatMap((result) => result.values);
  const priority = { canonical: 0, legacy: 1 };
  const fresh = values.filter((value) => value.fresh).sort((a, b) => priority[a.kind] - priority[b.kind] || Date.parse(b.capturedAt) - Date.parse(a.capturedAt))[0];
  if (fresh) return fresh;
  if (values.length) return values.sort((a, b) => priority[a.kind] - priority[b.kind] || Date.parse(b.capturedAt) - Date.parse(a.capturedAt))[0];
  if (results.some((result) => result.malformed)) return { kind: 'malformed', fresh: false };
  return { kind: 'absent', fresh: false };
}
