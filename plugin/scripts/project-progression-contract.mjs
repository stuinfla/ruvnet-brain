import crypto from 'node:crypto';

export const PROJECT_PROGRESSION_SCHEMA = 'ruvnet-brain.project-progression';
export const PROJECT_PROGRESSION_VERSION = 1;

function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  throw new TypeError('progression values must be JSON-compatible');
}

export function digestCanonical(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
}

function keyPart(value) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'unknown';
}

const SOURCE_FIELDS = Object.freeze([
  'checkoutPath', 'worktreeId', 'branch', 'head', 'trackedDigest', 'untrackedDigest', 'dirtyTreeDigest',
]);
const STATE_ARRAY_FIELDS = Object.freeze([
  'plan', 'completed', 'inProgress', 'blockers', 'failures', 'decisions', 'changedFiles', 'commands',
  'proofArtifacts', 'untested', 'resumeConflicts',
]);
const STATE_VALUE_FIELDS = Object.freeze([
  'currentGoal', 'acceptanceContract', 'activeProcess', 'activeStep', 'nextAction',
]);

function eventKeyFor(value) {
  const identityDigest = digestCanonical({
    projectId: value.projectIdentity.id,
    host: value.hostIdentity.host,
    session: value.sessionIdentity,
    sequence: value.sequence,
    dedupId: value.dedupId,
  });
  return [
    'project-progress-v1',
    keyPart(value.projectIdentity.id),
    keyPart(value.hostIdentity.host),
    keyPart(value.sessionIdentity),
    String(value.sequence).padStart(12, '0'),
    identityDigest,
  ].join('-');
}

function secretKind(key) {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (normalized.includes('privatekey')) return 'private-key';
  if (normalized.includes('apikey')) return 'api-key';
  if (normalized.includes('authorization')) return 'authorization';
  if (normalized.includes('password') || normalized.includes('passwd')) return 'password';
  if (normalized.includes('token')) return 'token';
  if (normalized.includes('secret')) return 'secret';
  if (normalized.includes('credential')) return 'credential';
  return null;
}

const INLINE_SECRETS = Object.freeze([
  {
    kind: 'private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: '[REDACTED:private-key]',
  },
  {
    kind: 'bearer-token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: 'Bearer [REDACTED:bearer-token]',
  },
  {
    kind: 'api-key',
    pattern: /\b(?:sk|api-key|ghp|github_pat)[-_][A-Za-z0-9._-]{8,}/gi,
    replace: '[REDACTED:api-key]',
  },
  {
    kind: 'password',
    pattern: /\b(password|passwd)\s*[:=]\s*[^\s;,]+/gi,
    replace: '$1=[REDACTED:password]',
  },
  {
    kind: 'token',
    pattern: /\b(token|secret|credential)\s*[:=]\s*[^\s;,]+/gi,
    replace: '$1=[REDACTED:token]',
  },
]);

export function redactProgression(value) {
  const redactions = [];
  const mark = (path, kind) => {
    if (!redactions.some((row) => row.path === path && row.kind === kind)) redactions.push({ path, kind });
  };
  const walk = (current, currentPath) => {
    if (typeof current === 'string') {
      let output = current;
      for (const rule of INLINE_SECRETS) {
        rule.pattern.lastIndex = 0;
        if (rule.pattern.test(output)) {
          mark(currentPath, rule.kind);
          rule.pattern.lastIndex = 0;
          output = output.replace(rule.pattern, rule.replace);
        }
      }
      return output;
    }
    if (Array.isArray(current)) return current.map((item, index) => walk(item, `${currentPath}[${index}]`));
    if (current && typeof current === 'object' && Object.getPrototypeOf(current) === Object.prototype) {
      return Object.fromEntries(Object.keys(current).sort().map((key) => {
        const path = `${currentPath}.${key}`;
        const kind = secretKind(key);
        if (kind && current[key] !== null && current[key] !== undefined) {
          mark(path, kind);
          return [key, `[REDACTED:${kind}]`];
        }
        return [key, walk(current[key], path)];
      }));
    }
    return canonicalize(current);
  };
  const redacted = walk(value, '$');
  redactions.sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind));
  return { value: redacted, redactions };
}

export function createProgressionSnapshot(input) {
  requireRecord(input, 'snapshot input');
  requireRecord(input.projectIdentity, 'projectIdentity');
  requireString(input.projectIdentity.id, 'projectIdentity.id');
  requireString(input.projectIdentity.canonicalAgentDbPath, 'projectIdentity.canonicalAgentDbPath');
  requireRecord(input.sourceIdentity, 'sourceIdentity');
  for (const field of SOURCE_FIELDS) requireString(input.sourceIdentity[field], `sourceIdentity.${field}`);
  requireRecord(input.hostIdentity, 'hostIdentity');
  requireString(input.hostIdentity.host, 'hostIdentity.host');
  requireString(input.hostIdentity.adapterVersion, 'hostIdentity.adapterVersion');
  requireString(input.sessionIdentity, 'sessionIdentity');
  requireString(input.dedupId, 'dedupId');
  requireString(input.trigger, 'trigger');
  requireRecord(input.completeProjectState, 'completeProjectState');
  for (const field of STATE_ARRAY_FIELDS) {
    if (!Array.isArray(input.completeProjectState[field])) throw new TypeError(`completeProjectState.${field} must be an array`);
  }
  for (const field of STATE_VALUE_FIELDS) {
    if (!(field in input.completeProjectState)) throw new TypeError(`completeProjectState.${field} is required`);
  }
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) throw new TypeError('sequence must be a non-negative safe integer');
  if (!Number.isFinite(Date.parse(input.occurredAt))) throw new TypeError('occurredAt must be an ISO-8601 timestamp');
  if (!Array.isArray(input.parentEventKeys)) throw new TypeError('parentEventKeys must be an array');

  const draft = canonicalize({
    schema: PROJECT_PROGRESSION_SCHEMA,
    schemaVersion: PROJECT_PROGRESSION_VERSION,
    dedupId: input.dedupId,
    projectIdentity: input.projectIdentity,
    hostIdentity: input.hostIdentity,
    sessionIdentity: input.sessionIdentity,
    sequence: input.sequence,
    occurredAt: input.occurredAt,
    trigger: input.trigger,
    parentEventKeys: [...input.parentEventKeys].sort(),
    completeProjectState: input.completeProjectState,
    sourceIdentity: input.sourceIdentity,
  });
  const { value: redacted, redactions } = redactProgression(draft);
  const snapshot = canonicalize({ ...redacted, eventKey: eventKeyFor(redacted), redactions });
  return Object.freeze({ ...snapshot, payloadDigest: digestCanonical(snapshot) });
}

export function validateProgressionSnapshot(snapshot, { expectedProjectIdentity } = {}) {
  const errors = [];
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return { ok: false, errors: ['snapshot must be an object'] };
  }
  if (snapshot.schema !== PROJECT_PROGRESSION_SCHEMA) errors.push('unsupported snapshot schema');
  if (snapshot.schemaVersion !== PROJECT_PROGRESSION_VERSION) errors.push('unsupported snapshot version');
  if (!snapshot.projectIdentity || typeof snapshot.projectIdentity !== 'object') errors.push('missing project identity');
  if (!snapshot.hostIdentity || typeof snapshot.hostIdentity !== 'object') errors.push('missing host identity');
  if (!snapshot.sourceIdentity || typeof snapshot.sourceIdentity !== 'object') errors.push('missing source identity');
  if (!snapshot.completeProjectState || typeof snapshot.completeProjectState !== 'object') errors.push('missing complete project state');
  if (!Array.isArray(snapshot.parentEventKeys)) errors.push('parentEventKeys must be an array');
  if (!Array.isArray(snapshot.redactions)) errors.push('redactions must be an array');
  if (!Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0) errors.push('invalid sequence');
  if (!Number.isFinite(Date.parse(snapshot.occurredAt))) errors.push('invalid occurredAt');

  if (snapshot.sourceIdentity) {
    for (const field of SOURCE_FIELDS) {
      if (typeof snapshot.sourceIdentity[field] !== 'string' || !snapshot.sourceIdentity[field]) {
        errors.push(`missing sourceIdentity.${field}`);
      }
    }
  }
  if (snapshot.completeProjectState) {
    for (const field of STATE_ARRAY_FIELDS) {
      if (!Array.isArray(snapshot.completeProjectState[field])) errors.push(`invalid completeProjectState.${field}`);
    }
    for (const field of STATE_VALUE_FIELDS) {
      if (!(field in snapshot.completeProjectState)) errors.push(`missing completeProjectState.${field}`);
    }
  }
  if (expectedProjectIdentity && snapshot.projectIdentity) {
    if (snapshot.projectIdentity.id !== expectedProjectIdentity.id) errors.push('foreign project id');
    if (snapshot.projectIdentity.canonicalAgentDbPath !== expectedProjectIdentity.canonicalAgentDbPath) {
      errors.push('foreign canonical AgentDB path');
    }
  }
  if (snapshot.projectIdentity && snapshot.hostIdentity && typeof snapshot.sessionIdentity === 'string'
    && Number.isSafeInteger(snapshot.sequence) && typeof snapshot.dedupId === 'string') {
    try {
      if (snapshot.eventKey !== eventKeyFor(snapshot)) errors.push('event key mismatch');
    } catch { errors.push('event key is unverifiable'); }
  }
  try {
    const body = canonicalize(snapshot);
    delete body.payloadDigest;
    if (snapshot.payloadDigest !== digestCanonical(body)) errors.push('payload digest mismatch');
  } catch { errors.push('payload is not canonical JSON'); }
  if (Array.isArray(snapshot.redactions)
    && snapshot.redactions.some((row) => !row || typeof row.path !== 'string' || typeof row.kind !== 'string'
      || Object.keys(row).sort().join(',') !== 'kind,path')) errors.push('invalid redaction marker');
  try {
    if (redactProgression(snapshot).redactions.length > 0) errors.push('unredacted secret material');
  } catch { /* canonical validation already reports the malformed payload */ }

  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

function rejectedRow(snapshot, reasons) {
  return { eventKey: typeof snapshot?.eventKey === 'string' ? snapshot.eventKey : null, reasons: [...new Set(reasons)].sort() };
}

function sortRejected(rows) {
  return rows.sort((left, right) => String(left.eventKey).localeCompare(String(right.eventKey))
    || left.reasons.join('|').localeCompare(right.reasons.join('|')));
}

function cyclicKeys(entries) {
  const state = new Map();
  const stack = [];
  const cyclic = new Set();
  const visit = (key) => {
    if (state.get(key) === 2) return;
    if (state.get(key) === 1) {
      const start = stack.indexOf(key);
      for (const member of stack.slice(start)) cyclic.add(member);
      return;
    }
    state.set(key, 1);
    stack.push(key);
    for (const parent of entries.get(key)?.parentEventKeys ?? []) if (entries.has(parent)) visit(parent);
    stack.pop();
    state.set(key, 2);
  };
  for (const key of [...entries.keys()].sort()) visit(key);
  return cyclic;
}

function uniqueSorted(values) {
  const byDigest = new Map();
  for (const value of values) byDigest.set(digestCanonical(value), canonicalize(value));
  return [...byDigest.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value);
}

function conflict(field, heads, valueFor) {
  const values = heads.map((head) => ({ head: head.eventKey, value: canonicalize(valueFor(head)) }));
  return { field, values };
}

function planItemId(item) {
  return typeof item?.id === 'string' && item.id ? item.id : digestCanonical(item);
}

function mergeHeads(heads) {
  if (heads.length === 1) {
    return canonicalize({
      ...heads[0].completeProjectState,
      sourceIdentity: heads[0].sourceIdentity,
      journalHeads: [heads[0].eventKey],
      resumeConflicts: [],
    });
  }

  const conflicts = [];
  const state = {};
  for (const field of STATE_ARRAY_FIELDS.filter((field) => !['plan', 'resumeConflicts'].includes(field))) {
    state[field] = uniqueSorted(heads.flatMap((head) => head.completeProjectState[field]));
  }
  for (const field of STATE_VALUE_FIELDS) {
    const values = uniqueSorted(heads.map((head) => head.completeProjectState[field]));
    if (values.length === 1) state[field] = values[0];
    else {
      state[field] = null;
      conflicts.push(conflict(field, heads, (head) => head.completeProjectState[field]));
    }
  }

  const planById = new Map();
  for (const head of heads) {
    for (const item of head.completeProjectState.plan) {
      planById.set(planItemId(item), true);
    }
  }
  state.plan = [];
  for (const id of [...planById.keys()].sort()) {
    const rows = heads.map((head) => ({
      head: head.eventKey,
      value: head.completeProjectState.plan.find((item) => planItemId(item) === id) ?? null,
    }));
    const variants = uniqueSorted(rows.map((row) => row.value));
    state.plan.push(...variants.filter((value) => value !== null));
    if (variants.length > 1) {
      conflicts.push({
        field: `plan.${id}`,
        values: rows.map((row) => ({ head: row.head, value: canonicalize(row.value) }))
          .sort((left, right) => left.head.localeCompare(right.head)),
      });
    }
  }

  const sources = uniqueSorted(heads.map((head) => head.sourceIdentity));
  if (sources.length === 1) state.sourceIdentity = sources[0];
  else {
    state.sourceIdentity = null;
    conflicts.push(conflict('sourceIdentity', heads, (head) => head.sourceIdentity));
  }
  const carried = heads.flatMap((head) => head.completeProjectState.resumeConflicts);
  state.resumeConflicts = uniqueSorted([...carried, ...conflicts]);
  state.journalHeads = heads.map((head) => head.eventKey);
  return canonicalize(state);
}

export function restoreProjectProgression(snapshots, { expectedProjectIdentity } = {}) {
  if (!Array.isArray(snapshots)) throw new TypeError('snapshots must be an array');
  const rejected = [];
  const candidates = new Map();
  const candidateGroups = new Map();
  const ordered = [...snapshots].sort((left, right) => String(left?.eventKey).localeCompare(String(right?.eventKey))
    || String(left?.payloadDigest).localeCompare(String(right?.payloadDigest)));

  for (const snapshot of ordered) {
    const verdict = validateProgressionSnapshot(snapshot, { expectedProjectIdentity });
    if (!verdict.ok) {
      rejected.push(rejectedRow(snapshot, verdict.errors));
      continue;
    }
    if (!candidateGroups.has(snapshot.eventKey)) candidateGroups.set(snapshot.eventKey, []);
    candidateGroups.get(snapshot.eventKey).push(snapshot);
  }
  for (const [eventKey, group] of candidateGroups) {
    if (new Set(group.map((snapshot) => snapshot.payloadDigest)).size > 1) {
      rejected.push(...group.map((snapshot) => rejectedRow(snapshot, ['event key collision'])));
    } else {
      candidates.set(eventKey, group[0]);
    }
  }

  const rejectBrokenEdges = () => {
    const removals = [];
    for (const snapshot of candidates.values()) {
      if (snapshot.parentEventKeys.some((parent) => !candidates.has(parent))) {
        removals.push([snapshot, 'missing parent']);
        continue;
      }
      if (snapshot.parentEventKeys.some((parent) => {
        const ancestor = candidates.get(parent);
        return ancestor.sessionIdentity === snapshot.sessionIdentity && ancestor.sequence >= snapshot.sequence;
      })) removals.push([snapshot, 'non-monotonic session sequence']);
    }
    for (const [snapshot, reason] of removals) {
      candidates.delete(snapshot.eventKey);
      rejected.push(rejectedRow(snapshot, [reason]));
    }
    return removals.length > 0;
  };
  while (rejectBrokenEdges()) { /* reject descendants of rejected evidence */ }

  const cycles = cyclicKeys(candidates);
  for (const key of [...cycles].sort()) {
    const snapshot = candidates.get(key);
    candidates.delete(key);
    rejected.push(rejectedRow(snapshot, ['causal cycle']));
  }
  while (rejectBrokenEdges()) { /* reject descendants of cycles */ }

  const consumed = new Set([...candidates.values()].flatMap((snapshot) => snapshot.parentEventKeys));
  const heads = [...candidates.values()].filter((snapshot) => !consumed.has(snapshot.eventKey))
    .sort((left, right) => left.eventKey.localeCompare(right.eventKey));
  const headKeys = heads.map((snapshot) => snapshot.eventKey);
  const causallyStale = [...candidates.keys()].filter((key) => !headKeys.includes(key)).sort();
  rejected.push(...causallyStale.map((key) => rejectedRow(candidates.get(key), ['causally stale'])));
  return {
    ok: heads.length > 0,
    heads: headKeys,
    causallyStale,
    rejected: sortRejected(rejected),
    state: heads.length ? mergeHeads(heads) : null,
  };
}
