export const EXECUTION_MODULES = Object.freeze(['developer-update.mjs', 'developer-update-policy.mjs', 'developer-update-lock.mjs', 'developer-update-maintenance.mjs', 'developer-update-cleanup.mjs', 'plugin-artifact-proof.mjs', 'entrypoint.mjs']);
// Members a coordinator generation may lack: each is required exactly when the staged developer-update.mjs imports it
// (plugin-artifact-proof since 4.6, entrypoint since the 4.7.21 entry-point sweep), so older registrations stay valid.
export const OPTIONAL_EXECUTION_MODULES = Object.freeze(['plugin-artifact-proof.mjs', 'entrypoint.mjs']);
// Shared stack classification and ordering: installations are selected, never manufactured.
export const FAMILY = /^(ruflo|ruvnet-brain|ruvector|ruvector-extensions|ruvi|ruvbot|qudag|flow-nexus|agent-browser|agent-browser-mcp|agentic-flow|agentic-qe|agentic-robotics|agentic-payments|agentdb|ruv-swarm|@pacphi\/agentic-kit$|@ruvector\/|@claude-flow\/|@metaharness\/|@agentic-robotics\/)/;
export const PLUGIN_MARKETPLACES = new Set(['ruflo', 'ruview', 'ruvnet-brain', 'cognitum']);
export const REVIEWED_INSTALL_SCRIPTS = Object.freeze(['ruflo', 'agentic-qe', '@claude-flow/cli', 'better-sqlite3', 'hnswlib-node', 'agentdb', 'agentic-flow', 'argon2', 'onnxruntime-node', 'sharp', 'protobufjs', '@google/genai', 'tldjs', 'vibium', 'agent-browser', '@anthropic-ai/claude-code', 'opencode-ai']);
export function cmpVersion(a, b) {
  const parse = value => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]+)?$/.exec(value);
    if (!m) throw Error(`uncomparable version: ${value}`);
    return [m.slice(1, 4).map(Number), m[4]?.split('.')];
  };
  const [ac, ap] = parse(a), [bc, bp] = parse(b);
  for (let i = 0; i < 3; i++) if (ac[i] !== bc[i]) return Math.sign(ac[i] - bc[i]);
  if (!ap || !bp) return ap ? -1 : bp ? 1 : 0;
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    if (ap[i] === undefined || bp[i] === undefined) return ap[i] === undefined ? -1 : 1;
    if (ap[i] === bp[i]) continue;
    const an = /^\d+$/.test(ap[i]), bn = /^\d+$/.test(bp[i]);
    return an && bn ? Math.sign(Number(ap[i]) - Number(bp[i])) : an !== bn ? an ? -1 : 1 : ap[i] < bp[i] ? -1 : 1;
  }
  return 0;
}
export function normalizeNpmDistTags(value) {
  // npm 11 emits an object for a queried field; npm 12 retains its singleton record array.
  if (Array.isArray(value)) {
    if (value.length !== 1) throw Error('npm dist-tags has ambiguous or empty records');
    [value] = value;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Object.keys(value).length || Object.values(value).some(version => typeof version !== 'string' || !version)) {
    throw Error('npm dist-tags record is unverified');
  }
  return value;
}
export function normalizeNpmTimes(value) {
  // `npm view <pkg> time --json`: an object of version -> ISO time (npm 12 wraps it in a one-record array).
  if (Array.isArray(value)) value = value.length === 1 ? value[0] : null;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
/**
 * The newer of {want, defaultTag} by version — EXCEPT a non-default tag whose version was published BEFORE the
 * default tag's version. That is an abandoned pre-release line, not a newer build: measured 2026-10-23, agentic-flow
 * `alpha` = 3.0.0-alpha.2 (published 2026-03-25) against `latest` = 2.1.4 (2026-10-09); by version alone the alpha
 * channel would install seven-month-old code. `published` is `npm view <pkg> time`; without it, ordering is unchanged.
 */
export function pickTargetTag(tags, want = 'latest', defaultTag = 'latest', { published = null } = {}) {
  const at = (version) => Date.parse(published?.[version] ?? '');
  // `published` null: the caller did not ask, ordering is by version. An object: times were REQUIRED, so a missing or
  // unreadable time makes the non-default tag unverifiable and it is skipped (cross-model review 2026-10-24: a failed
  // lookup must not let a seven-month-old pre-release through).
  const abandoned = (tag) => tag !== defaultTag && typeof tags?.[defaultTag] === 'string' && published !== null
    && (!Number.isFinite(at(tags[tag])) || !Number.isFinite(at(tags[defaultTag])) || at(tags[tag]) < at(tags[defaultTag]));
  const candidates = [...new Set([want, defaultTag])].filter(tag => typeof tags?.[tag] === 'string' && !abandoned(tag));
  candidates.sort((a, b) => cmpVersion(tags[b], tags[a]));
  return { tag: candidates[0] || null, target: tags?.[candidates[0]] || null };
}
/** Whether choosing between `want` and `latest` needs publish times: only when the two tags name different versions. */
export function needsPublishTimes(tags, want) {
  return want !== 'latest' && typeof tags?.[want] === 'string' && typeof tags?.latest === 'string' && tags[want] !== tags.latest;
}
/** The ONE answer to "which tag does this package track": shared by the updater and the stack-sync notice. */
export function wantedTag(name, channel = 'latest') {
  if (!['latest', 'alpha'].includes(channel)) throw Error('unsupported update channel');
  // Kit's installed release contract uses next; never convert it to an npm alpha alias.
  return name === '@pacphi/agentic-kit' ? 'next' : FAMILY.test(name) && channel === 'alpha' ? 'alpha' : 'latest';
}
export function selectTag(name, current, tags, channel = 'latest', { published = null } = {}) {
  const wanted = wantedTag(name, channel);
  tags = normalizeNpmDistTags(tags);
  const times = published === null || published === undefined ? null : (normalizeNpmTimes(published) || {});
  const { tag, target: version } = pickTargetTag(tags, wanted, 'latest', { published: times });
  if (!tag) throw Error(`no allowed release tag: ${name}`);
  return { tag, version, upgrade: cmpVersion(version, current) > 0, ahead: cmpVersion(version, current) < 0 };
}
