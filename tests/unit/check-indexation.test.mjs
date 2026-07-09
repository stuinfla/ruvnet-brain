// tests/unit/check-indexation.test.mjs — scripts/check-indexation.mjs (108 lines, added
// 2026-07-07 commit c8ec5dd, AFTER the original coverage audit) has zero tests of any kind.
//
// PREREQUISITE (this file will NOT run until this lands — it's the reason this is a skeleton, not
// a finished test): unlike forge-guard.mjs (subprocess-testable because dir/name are CLI args),
// check-indexation.mjs's TARGETS are a hardcoded module-level const (line 23, 3 production URLs)
// AND the whole probe runs as a top-level IIFE (lines 89-108) that fires real network requests
// to those 3 production URLs the INSTANT the module is imported or run — there is no argv/env hook
// to point it at a local fixture server instead. So even after exporting serving()/siteQuery(), a
// plain `import` would still race 3 live HTTP calls to isovision.ai/github.com/vercel.app as an
// import side effect. Two small, additive changes make this testable with no behavior change to
// the real CLI:
//   1. `export function serving(url) {...}` and `export function siteQuery(engine, url) {...}`
//      (currently unexported plain functions, lines 35 and 51).
//   2. Guard the IIFE the same way scripts/verify-bundle.mjs already does (line 39 there):
//        if (import.meta.url === `file://${process.argv[1]}`) { (async () => { ...the existing IIFE body... })(); }
//      This is the established in-repo pattern for "CLI entrypoint vs. importable module" — copy
//      it verbatim rather than inventing a new convention.
// Flag both to Stuart before applying — small, but they touch a file whose whole job is an
// external-facing SEO probe, so confirm the guard doesn't change its cron/manual invocation.
//
// Once exported+guarded, this test spins up a local http server (no network, no flakiness) so
// `serving()`/`siteQuery()` can be driven with each of the real code paths.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';

describe.todo('check-indexation.mjs — serving() (requires export + IIFE guard, see file header)', () => {
  let server, base;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/noindex') {
        res.writeHead(200, { 'x-robots-tag': 'noindex' });
        res.end('<html><head><link rel="canonical" href="http://example.com/noindex"></head></html>');
      } else if (req.url === '/redirect') {
        res.writeHead(301, { Location: '/canonical-target' });
        res.end();
      } else if (req.url === '/clean') {
        res.writeHead(200, {});
        res.end(`<html><head><link rel="canonical" href="${base}/clean"></link></head></html>`);
      } else {
        res.writeHead(404); res.end();
      }
    });
    await new Promise((r) => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => server.close());

  it.todo('reports ok:false with a NOINDEX note when x-robots-tag: noindex is present');
  it.todo('reports ok:true with a redirect note on a 3xx with a Location header');
  it.todo('reports ok:true with "canon=self" when the canonical link matches the requested URL');
  it.todo('reports ok:false with the HTTP status when the response is not 200/3xx');
  it.todo('reports ok:false with "unreachable: <message>" when fetch throws (connection refused)');
});

describe.todo('check-indexation.mjs — siteQuery() (requires export + IIFE guard)', () => {
  it.todo('returns "inconclusive (bot-challenged)" when the response body matches the CHALLENGE regex (captcha/"verify you are"/etc.)');
  it.todo('returns "NOT indexed" when the body matches the "did not match any documents" family of no-results phrases');
  it.todo('returns "INDEXED" when the host+path needle appears more than once in the results body');
  it.todo('returns "NOT indexed" (not INDEXED) when the needle appears exactly once (current hits > 1 heuristic — confirm this threshold is intentional, not an off-by-one)');
  it.todo('returns "inconclusive (<message>)" when fetch throws');
});
