// tests/unit/build-symbols-extraction.test.mjs — scripts/build-symbols.mjs (68 lines, ADR-0003
// "point-deeper symbol index" — the map from code symbol/file-stem/package name -> source paths that
// lets retrieval hard-route an implementation question to the real defining file) has zero tests and
// was never mentioned in any prior coverage-gap audit. Found during the 2026-07-08 pass.
//
// WHY THIS MATTERS: this is retrieval-QUALITY logic, not just plumbing — a wrong regex here means a
// query like "what defines swarm_init?" silently fails to hard-route even though the symbol exists in
// the corpus, and nothing would ever notice because there's no ground truth check anywhere in the repo
// for this file's output. It also has a subtle safety property worth locking down: `bySymbol`/`byStem`/
// `byPackage` are built with `Object.create(null)` (line 39) specifically to avoid a `__proto__` or
// `constructor` key colliding with the prototype chain — a real risk given TOOL_RES's broad
// `['"']([a-z]+_[a-z0-9_]+)['"']\s*:/g` pattern (line 36) can match almost any snake_case object key in
// scanned source, including ones an attacker-controlled file might contain.
//
// PREREQUISITE (why this is a skeleton): everything useful here (isSourcePath, DEF_RES, TOOL_RES, add,
// freeze) is ALREADY a plain top-level function/const — no refactor needed for those. The only blocker
// is the unconditional top-level loop (line 45: `for (const line of fs.readFileSync(PASSAGES, 'utf8')...`)
// that runs on import and throws if the passages file for --name doesn't exist yet. Same guard already
// used elsewhere in this repo:
//
//   export { isSourcePath, DEF_RES, TOOL_RES, add, freeze };  // add near their existing definitions
//   if (import.meta.url === `file://${process.argv[1]}`) { /* existing lines 44-68 unchanged */ }
import { describe, it, expect } from 'vitest';

describe.todo('build-symbols.mjs — isSourcePath(p) (requires export, see file header)', () => {
  it.todo('accepts .ts/.tsx/.js/.jsx/.mjs/.cjs/.rs/.py/.go paths');
  it.todo('rejects a .test.ts / .spec.js / .d.ts path even though the base extension matches');
  it.todo('rejects any path containing a /tests/, /__tests__/, /testing/, /fixtures/, /.claude/, or /examples/ segment anywhere in it, not just at the start');
  it.todo('rejects a non-code extension (.md, .json, .toml)');
});

describe.todo('build-symbols.mjs — DEF_RES symbol-definition regexes (requires export, see file header)', () => {
  it.todo('extracts the name from "export function searchKb(...)" and "export default async function foo(...)"');
  it.todo('extracts the name from "export class Foo" and "export abstract class Foo"');
  it.todo('extracts the name from "export interface Foo", "export type Foo", "export enum Foo"');
  it.todo('extracts the name from "export const FOO ="  and "export const foo: Bar ="');
  it.todo('extracts a Rust "pub fn snake_case_name(...)" and "pub async fn foo(...)"');
  it.todo('extracts a Rust "pub struct Foo", "pub enum Foo", "pub trait Foo"');
  it.todo('extracts a bare (non-exported) "class Foo" as a fallback');
});

describe.todo('build-symbols.mjs — TOOL_RES tool/handler-name regexes + its false-positive risk (requires export, see file header)', () => {
  it.todo('extracts a tool name from `name: \'swarm_init\'`');
  it.todo('extracts a tool name from `registerTool(\'guidance_recommend\')` / `addTool(...)` / `defineTool(...)`');
  it.todo('extracts a snake_case object key from a generic `\'foo_bar\': handler` shape — and DOCUMENTS that this is deliberately broad: given a plain data object like `{ \'user_id\': 123 }` in scanned source, this same regex captures "user_id" as if it were a registered tool name (a known false-positive the length>=4 + Set-dedup partially mitigates but does not eliminate)');
});

describe.todo('build-symbols.mjs — add(map, key, path) (requires export, see file header)', () => {
  it.todo('lowercases the key before storing, so "SwarmInit" and "swarminit" collapse into the same entry');
  it.todo('is a no-op (does not create a key) when key is falsy — guards the `if (!key) return` short-circuit');
  it.todo('does not throw or leak onto Object.prototype when key is literally "__proto__" or "constructor" — proves the Object.create(null) choice actually matters, not just defensive style');
  it.todo('dedups the same path added twice under the same key (Set semantics) rather than storing a duplicate');
});

describe.todo('build-symbols.mjs — freeze(map, cap) (requires export, see file header)', () => {
  it.todo('converts a Map of Sets into a plain object of arrays');
  it.todo('caps each entry to the first `cap` paths (default 8) even when a symbol is defined/referenced in far more files, discarding the rest rather than truncating silently mid-array');
});
