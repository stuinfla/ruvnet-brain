// Content privacy only: canonical project/store/source bindings are never rewritten here.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { redactText } from './continuity-events.mjs';
import { normalizeHostEvent } from './hook-input.mjs';

const normalized = (value) => String(value).replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  .replace(/\/$/, (match, offset, source) => source === '/' || /^[A-Za-z]:\/$/.test(source) ? match : '');
const escaped = (value) => value.replace(/[.+^${}()|[\]\\]/g, '\\$&');
const separator = '[/\\\\]';

/** Rooted prefixes or simple * / ** globs; no expansion or unbounded recipes. */
export function contentPathExcludes(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) throw new Error('contentPathExcludes must be an array of at most 16 rooted prefixes or globs');
  return value.map((raw) => {
    if (typeof raw !== 'string' || !raw || raw.length > 1024 || /[\x00-\x1f?\[\]{}!]/.test(raw)) throw new Error('invalid content path exclusion');
    const pattern = normalized(raw);
    if (!pattern.startsWith('/') && !/^[A-Za-z]:\//.test(pattern)) throw new Error('content path exclusions must be rooted');
    const parts = pattern.split('/');
    if (parts.length > 32 || parts.some((part) => part === '.' || part === '..'
      || (part !== '**' && (part.match(/\*/g) || []).length > 1))
      || parts.filter((part) => part === '**').length > 1) throw new Error('invalid or overly complex content path exclusion');
    return pattern;
  });
}

function globBody(pattern) {
  const parts = pattern.split('/');
  let body = '';
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (i && parts[i - 1] !== '**') body += separator;
    if (part === '**') {
      if (i === parts.length - 1) {
        if (body.endsWith(separator)) body = body.slice(0, -separator.length);
        body += `(?:${separator}[^\\n]*)?`;
      } else body += `(?:[^/\\\\\\n]+${separator})*`;
    } else body += part.split('*').map(escaped).join('[^/\\\\\\n]*');
  }
  return body;
}

export function pathIsExcluded(file, patterns = [], projectDir) {
  if (!patterns.length || typeof file !== 'string' || !file) return false;
  const rooted = normalized(path.isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file)
    ? file : `${projectDir || process.cwd()}/${file}`);
  const candidate = path.posix.normalize(rooted);
  const physical = (value) => {
    if (/^[A-Za-z]:\//.test(value) && process.platform !== 'win32') return value;
    let ancestor = value; const suffix = [];
    for (let depth = 0; depth < 128; depth += 1) {
      try { return path.posix.join(normalized(fs.realpathSync.native(ancestor)), ...suffix); }
      catch (error) {
        if (error.code !== 'ENOENT') throw new Error('content exclusion resource resolution unavailable');
        const parent = path.posix.dirname(ancestor);
        if (parent === ancestor) break;
        suffix.unshift(path.posix.basename(ancestor)); ancestor = /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent;
      }
    }
    throw new Error('content exclusion resource resolution unavailable');
  };
  const candidates = [...new Set([candidate, physical(rooted)])];
  return patterns.some((pattern) => {
    const flags = /^[A-Za-z]:\//.test(pattern) ? 'i' : '';
    return candidates.some((candidate) => {
      if (pattern.includes('*')) {
        const slash = pattern.lastIndexOf('/', pattern.indexOf('*')); const base = pattern.slice(0, slash) || '/';
        return [pattern, `${physical(base).replace(/\/$/, '')}${pattern.slice(slash)}`].some((variant) => new RegExp(`^${globBody(variant)}$`, flags).test(candidate));
      }
      return [...new Set([pattern, physical(pattern)])].some((prefix) => {
        const comparable = flags ? candidate.toLowerCase() : candidate;
        if (flags) prefix = prefix.toLowerCase();
        return comparable === prefix || comparable.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
      });
    });
  });
}

/** Conservative prose masking may remove the remainder of an unquoted path-bearing clause. */
export function maskExcludedPaths(text, patterns = [], projectDir) {
  let result = String(text || '');
  if (!patterns.length) return result;
  const excluded = (value) => (projectDir || /^[A-Za-z]:[\\/]|^\//.test(value)) && pathIsExcluded(value, patterns, projectDir);
  result = result.replace(/(["'\x60])([^"'\x60\n]+)\1/g, (match, quote, value) =>
    /[\\/]/.test(value) && excluded(value) ? `${quote}[REDACTED:excluded-path]${quote}` : match);
  result = result.replace(/[^\s"'\x60,;<>]+/g, (value) => /[\\/]/.test(value) && excluded(value) ? '[REDACTED:excluded-path]' : value);
  for (const pattern of patterns) {
    const body = globBody(pattern);
    const tail = pattern.includes('*') ? '' : pattern.endsWith('/') ? `[^\\n"'\x60,;<>]*` : `(?:${separator}[^\\n"'\x60,;<>]*)?`;
    const flags = /^[A-Za-z]:\//.test(pattern) ? 'gi' : 'g';
    result = result.replace(new RegExp(`${body}${tail}(?=$|[\\s"'\x60,;<>.])`, flags), '[REDACTED:excluded-path]');
  }
  return result;
}

export function turnReferencesExcludedResource(turn, patterns = [], projectDir) {
  return [...(turn.resources || []), ...(turn.files || [])].some((file) => pathIsExcluded(file, patterns, projectDir))
    || [...(turn.resourceTexts || []), ...(turn.actions || []), turn.finalText || ''].some((text) => maskExcludedPaths(text, patterns, projectDir) !== text);
}

export function privateTurn(turn, patterns, projectDir) {
  const excludedFiles = turn.files.filter((file) => pathIsExcluded(file, patterns, projectDir));
  const redact = (text) => {
    let result = maskExcludedPaths(text, patterns, projectDir);
    for (const file of excludedFiles) {
      for (const reference of [file, path.basename(file.replace(/\\/g, '/'))]) {
        if (reference) result = result.split(reference).join('[REDACTED:excluded-path]');
      }
    }
    return result;
  };
  const excludedResource = turnReferencesExcludedResource(turn, patterns, projectDir);
  return { excludedResource, finalText: excludedResource ? '[REDACTED:excluded-resource-outcome]' : redact(turn.finalText), files: turn.files.filter((file) => !excludedFiles.includes(file)),
    actions: excludedResource ? [] : turn.actions.map(redact) };
}

// Only derived content is filtered. IDs, provenance, project/source and evidence bindings survive.
function contentValue(value, patterns, projectDir) {
  if (typeof value === 'string') return maskExcludedPaths(value, patterns, projectDir) !== value ? '[REDACTED:excluded-content]' : value;
  if (Array.isArray(value)) return value.map((item) => contentValue(item, patterns, projectDir));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    ['id', 'key', 'source', 'provenance', 'authoritative', 'note', 'state', 'status', 'outcome', 'trigger', 'tool'].includes(key)
      ? item : contentValue(item, patterns, projectDir)]));
}

export function privateContinuityEvent(event, patterns = [], projectDir) {
  const files = Array.isArray(event.detail?.files) ? event.detail.files : [];
  const turn = privateTurn({ finalText: event.summary, files, actions: [] }, patterns, projectDir);
  const detail = contentValue(event.detail, patterns, projectDir);
  if (Array.isArray(event.detail?.files)) detail.files = turn.files;
  const privateCommand = ['command', 'description', 'task'].some((field) => typeof event.detail?.[field] === 'string' && maskExcludedPaths(event.detail[field], patterns, projectDir) !== event.detail[field]);
  if (privateCommand) for (const field of ['command', 'description', 'task']) if (typeof detail?.[field] === 'string') detail[field] = '[REDACTED:excluded-resource-detail]';
  return { ...event, summary: privateCommand || turn.excludedResource ? '[REDACTED:excluded-resource-summary]' : turn.finalText, ...(detail ? { detail } : {}) };
}

export function payloadReferencesExcludedResource(payload, patterns = [], projectDir) {
  const normalized = normalizeHostEvent(payload) || {}; const input = normalized.tool_input || {};
  return [input.file_path, input.notebook_path, input.path].some((file) => pathIsExcluded(file, patterns, projectDir))
    || [input.command, input.cmd, input.description, normalized.prompt, normalized.user_prompt].some((value) => typeof value === 'string' && maskExcludedPaths(value, patterns, projectDir) !== value);
}

export function privateTransitionObservation(observation, patterns = [], projectDir, payload = {}) {
  if (!patterns.length) return observation;
  const filtered = { ...observation }; const privateInput = payloadReferencesExcludedResource(payload, patterns, projectDir);
  if (typeof observation.selectedIntent?.text === 'string'
    && (privateInput || maskExcludedPaths(observation.selectedIntent.text, patterns, projectDir) !== observation.selectedIntent.text)) delete filtered.selectedIntent;
  for (const field of ['error', 'signal']) if (typeof observation[field] === 'string') filtered[field] = privateInput || maskExcludedPaths(observation[field], patterns, projectDir) !== observation[field]
    ? `[REDACTED:excluded-resource-${field}]` : observation[field];
  return filtered;
}

export function privateProgressionState(state, patterns = [], projectDir) {
  if (!patterns.length) return state;
  for (const binding of [...(state.plan || []).map((item) => item?.id), state.evidence?.transcript?.path, state.evidence?.workLedger?.file]) {
    if (typeof binding === 'string' && maskExcludedPaths(binding, patterns, projectDir) !== binding) throw new Error('content exclusion conflicts with immutable progression binding');
  }
  const result = { ...state };
  for (const field of ['currentGoal', 'nextAction', 'acceptanceContract', 'completed', 'inProgress', 'blockers', 'failures',
    'decisions', 'commands', 'untested', 'resumeConflicts']) {
    if (Object.hasOwn(state, field)) result[field] = contentValue(state[field], patterns, projectDir);
  }
  for (const field of ['commands', 'failures']) if (Array.isArray(state[field])) result[field] = state[field].map((observation) => {
    if (!observation || typeof observation !== 'object') return contentValue(observation, patterns, projectDir);
    const filtered = contentValue(observation, patterns, projectDir);
    if (pathIsExcluded(observation.filePath, patterns, projectDir) || String(observation.filePath || '').includes('[REDACTED:excluded-path]')
      || typeof observation.command === 'string' && maskExcludedPaths(observation.command, patterns, projectDir) !== observation.command) {
      if (observation.filePath) filtered.filePath = '[REDACTED:excluded-path]'; if (observation.command) filtered.command = '[REDACTED:excluded-resource-command]';
      for (const output of ['stdout', 'stderr', 'result', 'error', 'signal']) if (Object.hasOwn(observation, output)) filtered[output] = '[REDACTED:excluded-resource-output]';
    }
    return filtered;
  });
  if (Array.isArray(state.observations)) result.observations = state.observations.map((observation) => privateTransitionObservation(observation, patterns, projectDir));
  if (Array.isArray(state.changedFiles)) result.changedFiles = state.changedFiles.filter((file) =>
    typeof file !== 'string' || !pathIsExcluded(file, patterns, projectDir));
  return result;
}

export function captureFailureReason(result, status) {
  if (result.error?.message) return redactText(result.error.message).slice(0, 300);
  const lines = [result.stderr, result.stdout].filter((stream) => stream != null).join('\n').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const terminal = lines.findLast((line) => /(?:\[ERROR\]|\bfatal\b|\bError:|\bSQLITE_[A-Z_]+\b|refus(?:ing|ed))/i.test(line));
  return redactText(terminal || lines.at(-1) || `ruflo exited ${status}`).slice(0, 300);
}

/** One notice per eligible canonical store; this is a cache marker, never a consent writer. */
export function firstTurnCaptureNotice({ target, brainHome, policyFile, env }) {
  if (target.skipped || String(env.RUVNET_TURN_CAPTURE || '').toLowerCase() === 'off') return null;
  const dir = path.join(brainHome, 'turn-capture', 'notices');
  const file = path.join(dir, crypto.createHash('sha256').update(target.db).digest('hex'));
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(dir) !== dir) return null;
    fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
  } catch { return null; }
  return `Turn outcome capture is enabled for this project: redacted assistant outcomes, changed files and command descriptions go to its AgentDB store; never raw user prompts. `
    + `The breadcrumb contains hashes and lengths only. Project/path opt-out and contentPathExcludes are read live from ${policyFile}; `
    + `set projects[${JSON.stringify(target.projectRoot)}] to "off" to opt out. Content exclusions accept rooted prefixes or simple * / ** globs and do not purge historical records.`;
}
