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
export function pickTargetTag(tags, want = 'latest', defaultTag = 'latest') {
  const candidates = [...new Set([want, defaultTag])].filter(tag => typeof tags?.[tag] === 'string');
  candidates.sort((a, b) => cmpVersion(tags[b], tags[a]));
  return { tag: candidates[0] || null, target: tags?.[candidates[0]] || null };
}
export function selectTag(name, current, tags, channel = 'latest') {
  if (!['latest', 'alpha'].includes(channel)) throw Error('unsupported update channel');
  // Kit's installed release contract uses next; never convert it to an npm alpha alias.
  const wanted = name === '@pacphi/agentic-kit' ? 'next' : FAMILY.test(name) && channel === 'alpha' ? 'alpha' : 'latest';
  const { tag, target: version } = pickTargetTag(tags, wanted);
  if (!tag) throw Error(`no allowed release tag: ${name}`);
  return { tag, version, upgrade: cmpVersion(version, current) > 0, ahead: cmpVersion(version, current) < 0 };
}
