// The one checker for the four contract files (recipe, pack, release, result). It supports the
// subset of JSON Schema the schemas in ./schemas use, so no third-party validator ships.
import fs from 'node:fs';

const cache = new Map();
function load(name) {
  if (!cache.has(name)) {
    cache.set(name, JSON.parse(fs.readFileSync(new URL(`./schemas/${name}.schema.json`, import.meta.url), 'utf8')));
  }
  return cache.get(name);
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function walk(root, s, v, at, errs) {
  if (errs.length) return;
  if (s.$ref) {
    const anchor = s.$ref.slice(1);
    const def = Object.values(root.$defs || {}).find((d) => d.$anchor === anchor);
    return walk(root, def, v, at, errs);
  }
  const t = typeOf(v);
  if (s.type) {
    const want = [].concat(s.type);
    if (!want.includes(t) && !(t === 'integer' && want.includes('number'))) return errs.push(`${at} should be ${want.join(' or ')}`);
  }
  if ('const' in s && v !== s.const) return errs.push(`${at} should be ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.includes(v)) return errs.push(`${at} should be one of ${s.enum.join(', ')}`);
  if (t === 'string') {
    if (s.minLength && v.length < s.minLength) return errs.push(`${at} is too short`);
    if (s.pattern && !new RegExp(s.pattern).test(v)) return errs.push(`${at} has an unexpected form`);
  }
  if ((t === 'integer' || t === 'number')) {
    if ('minimum' in s && v < s.minimum) return errs.push(`${at} is below ${s.minimum}`);
    if ('maximum' in s && v > s.maximum) return errs.push(`${at} is above ${s.maximum}`);
  }
  if (t === 'array') {
    if (s.minItems && v.length < s.minItems) return errs.push(`${at} needs at least ${s.minItems} entries`);
    if (s.items) v.forEach((x, i) => walk(root, s.items, x, `${at}[${i}]`, errs));
  }
  if (t === 'object') {
    for (const k of s.required || []) if (!(k in v)) return errs.push(`${at}.${k} is missing`);
    for (const [k, sub] of Object.entries(s.properties || {})) if (k in v) walk(root, sub, v[k], `${at}.${k}`, errs);
  }
}

/** Returns the list of problems (empty when the value is a valid `name`). */
export function problems(name, value) {
  const root = load(name);
  const errs = [];
  walk(root, root, value, name, errs);
  return errs;
}

/** Throws one plain sentence when `value` is not a valid `name` file. */
export function check(name, value, what = name) {
  const errs = problems(name, value);
  if (errs.length) throw new Error(`${what} is not a ${name} file this version understands: ${errs[0]}.`);
  return value;
}
