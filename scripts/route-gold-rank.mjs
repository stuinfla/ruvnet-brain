#!/usr/bin/env node
/**
 * scripts/route-gold-rank.mjs — where does the source router put the store that holds the answer?
 *
 * search_ruvnet first plans a bounded set of stores (kb/forge-ask-all.mjs planSourceRoute) and only
 * then retrieves and reranks inside them. A store the plan never opens cannot be cited, however good
 * the reranker is. This harness measures ONLY that first step: for each question it runs the exact
 * planner the search path runs (no model, no retrieval) and records the rank of the first planned
 * store that matches the question's gold repository. It reports, with 95% Wilson intervals:
 *
 *   goldAt1 / goldAt3 / goldAt5   gold store among the first 1 / 3 / 5 planned stores
 *   declined                      the planner opened nothing (bounded search refuses)
 *   reposOpened                   mean planned stores per question (cost: each is a retrieval + rerank)
 *
 * Question sets (any number, each optional):
 *   --needs <file>    novice need set (data/need-set/need-set-v1.json shape: questions[].need, .repo)
 *   --heldout <file>  evals/held-out.json shape (questions[].query, .stratum, .expectRepo); the
 *                     named/described/scenario strata are scored, adversarial is reported as declined
 *   --recall-fixture <file>  data/retrieval-query-evidence.json with each store's identity stripped
 *                     (unnameRecallQuery): one described need per store, 180+ stores
 *
 *   node scripts/route-gold-rank.mjs --kb <kbDir> [--impl <forge-ask-all.mjs>] [--needs f] [--heldout f]
 *     [--recall-fixture f] [--out f]
 *
 * --impl lets the SAME KB be routed by two code versions (a baseline checkout and this one).
 * Measurements only: it writes nothing but --out.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { wilson, repoMatchesExpected } from './eval-brain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Rank (1-based) of the first planned store matching any expected repo, or null. Case-insensitive. */
export function goldRank(plannedRepos, expected, aliases = {}) {
  const lowerAliases = Object.fromEntries(Object.entries(aliases || {})
    .map(([canonical, list]) => [canonical.toLowerCase(), (list || []).map((s) => String(s).toLowerCase())]));
  const want = (expected || []).map((e) => String(e).toLowerCase());
  const idx = (plannedRepos || []).findIndex((repo) => repoMatchesExpected(String(repo).toLowerCase(), want, lowerAliases));
  return idx < 0 ? null : idx + 1;
}

const rate = (rows, pred) => {
  const k = rows.filter(pred).length;
  const w = wilson(k, rows.length);
  return { k, n: rows.length, p: +w.p.toFixed(4), lo: +w.lo.toFixed(4), hi: +w.hi.toFixed(4) };
};

/** Summarize scored rows ({ rank, repos, group }) into the reported metrics, overall and per group. */
export function summarizeRoutes(rows) {
  const one = (rs) => ({
    goldAt1: rate(rs, (r) => r.rank != null && r.rank <= 1),
    goldAt3: rate(rs, (r) => r.rank != null && r.rank <= 3),
    goldAt5: rate(rs, (r) => r.rank != null && r.rank <= 5),
    declined: rate(rs, (r) => !r.repos.length),
    reposOpened: rs.length ? +(rs.reduce((s, r) => s + r.repos.length, 0) / rs.length).toFixed(3) : 0,
  });
  const groups = [...new Set(rows.map((r) => r.group))].sort();
  return { all: one(rows), byGroup: Object.fromEntries(groups.map((g) => [g, one(rows.filter((r) => r.group === g))])) };
}

/** Route every question through `planSourceRoute` and score it. Pure apart from the planner itself. */
export function measureRouteRanks({ kbDir, questions, planSourceRoute, discoverRepos, aliases = {} }) {
  const discovered = discoverRepos(kbDir);
  const rows = [];
  const t0 = performance.now();
  for (const q of questions) {
    const planned = planSourceRoute({ dir: kbDir, query: q.query, discovered }) || { repos: [] };
    const repos = Array.isArray(planned.repos) ? planned.repos : [];
    rows.push({ id: q.id, group: q.group, expected: q.expected, repos, reason: planned.reason || null,
      rank: q.expected?.length ? goldRank(repos, q.expected, aliases) : null });
  }
  return { rows, msPerQuestion: questions.length ? +((performance.now() - t0) / questions.length).toFixed(1) : 0 };
}

/**
 * The recall fixture asks one question per store and NAMES the store ("In the agentdb repository,
 * what is AgentDB ..."). With every spelling of the store key removed it becomes a described need
 * for 180+ stores, so routing can be checked on far more than three repositories. Honest limit: a
 * display name that is not the store key (e.g. "2 BoT Talk" for 2bottalk) can survive the strip.
 */
export function unnameRecallQuery(query, store) {
  const words = String(store).toLowerCase().match(/[a-z0-9]+/g) || [];
  const name = new RegExp(`(?<![a-z0-9])${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s._-]*')}(?![a-z0-9])`, 'gi');
  return String(query).replace(/^in the \S+ repository,\s*/i, '').replace(name, 'this project').replace(/\s+/g, ' ').trim();
}

export function loadQuestions({ needs, heldout, recallFixture }) {
  const out = { needs: [], heldout: [], offTopic: [], recallUnnamed: [] };
  if (recallFixture) {
    for (const [store, q] of Object.entries(JSON.parse(fs.readFileSync(recallFixture, 'utf8')).queries)) {
      out.recallUnnamed.push({ id: store, group: 'recall', query: unnameRecallQuery(q.query, store), expected: [store] });
    }
  }
  if (needs) {
    for (const q of JSON.parse(fs.readFileSync(needs, 'utf8')).questions) {
      out.needs.push({ id: q.id, group: q.repo, query: q.need, expected: [q.repo] });
    }
  }
  if (heldout) {
    for (const q of JSON.parse(fs.readFileSync(heldout, 'utf8')).questions) {
      if (q.stratum === 'adversarial') out.offTopic.push({ id: q.id, group: 'adversarial', query: q.query, expected: [] });
      else if (['named', 'described', 'scenario'].includes(q.stratum)) {
        out.heldout.push({ id: q.id, group: q.stratum, query: q.query, expected: q.expectRepo || [] });
      }
    }
  }
  return out;
}

/**
 * What a committed report says about its inputs. Never a local absolute path: the KB is named by its
 * build stamp, and the implementation by its repo-relative path (or `<impl>` when it lives outside
 * this checkout). The code's identity is the commit the report is filed with.
 */
export function reportIdentity({ impl, kbDir }) {
  let kbBuild = null;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(kbDir, 'manifest.json'), 'utf8'));
    kbBuild = { brainVersion: m.brainVersion ?? null, generated: m.generated ?? null };
  } catch { /* no manifest */ }
  const rel = path.relative(ROOT, path.resolve(impl));
  return { impl: rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : '<impl>', kbDir: '<kb>', kbBuild };
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const kbDir = arg('--kb');
  if (!kbDir || !fs.existsSync(kbDir)) throw new Error('--kb <dir> is required and must exist');
  const impl = path.resolve(arg('--impl') || path.join(ROOT, 'kb/forge-ask-all.mjs'));
  const mod = await import(pathToFileURL(impl).href);
  if (typeof mod.planSourceRoute !== 'function') throw new Error(`${impl} does not export planSourceRoute`);
  let aliases = {};
  try { aliases = JSON.parse(fs.readFileSync(path.join(kbDir, 'repo-aliases.json'), 'utf8')); } catch { /* none */ }
  const sets = loadQuestions({ needs: arg('--needs'), heldout: arg('--heldout'), recallFixture: arg('--recall-fixture') });
  const report = { kind: 'ruvnet-brain-route-gold-rank', ...reportIdentity({ impl, kbDir }), measuredAt: new Date().toISOString(), sets: {} };
  for (const [name, questions] of Object.entries(sets)) {
    if (!questions.length) continue;
    const { rows, msPerQuestion } = measureRouteRanks({ kbDir, questions, planSourceRoute: mod.planSourceRoute,
      discoverRepos: mod.discoverRepos, aliases });
    report.sets[name] = { ...summarizeRoutes(rows), msPerQuestion, rows };
  }
  const outFile = arg('--out');
  if (outFile) fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  const brief = Object.fromEntries(Object.entries(report.sets).map(([k, v]) => [k, { ...v.all, msPerQuestion: v.msPerQuestion }]));
  console.log(JSON.stringify(brief, null, 1));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
