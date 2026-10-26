#!/usr/bin/env node
// Build the inspectable novice→expert corpus without modifying the frozen 120-question eval.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { semanticAssertionsFor } from './top100-semantic-assertions.mjs';
import { isDirectInvocation } from '../plugin/scripts/entrypoint.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELD_OUT = path.join(ROOT, 'evals', 'held-out.json');
const OUT = path.join(ROOT, 'evals', 'top-100.json');
const PRODUCT_FILES = {
  agentdb: path.join(ROOT, 'kb', 'questions.agentdb.json'),
  ruflo: path.join(ROOT, 'kb', 'questions.ruflo.json'),
  rulake: path.join(ROOT, 'kb', 'questions.rulake.json'),
  ruvector: path.join(ROOT, 'kb', 'questions.ruvector.json'),
  ruview: path.join(ROOT, 'kb', 'questions.ruview.json'),
};

const load = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function held(q, level, axis, specificity) {
  // The frozen set intentionally stays untouched. Its ho-10 rationale names MetaHarness as the
  // owning implementation ("freeze the model, evolve the harness") but its expected-repo array
  // predates the metaharness store and omitted it. This benchmark evaluates the current 69-repo
  // brain, so preserve the frozen source while correcting the derived expectation explicitly.
  const expectRepo = q.id === 'ho-10' ? [...new Set([...(q.expectRepo || []), 'metaharness'])] : q.expectRepo;
  return {
    sourceId: q.id,
    level,
    axis,
    specificity,
    query: q.query,
    expectRepo,
    why: q.why,
  };
}

function product(repo, index, level) {
  const q = load(PRODUCT_FILES[repo])[index];
  // AgentDB's ADR-003 documents @ruvector/rvf's SDK boundary. Either that integration ADR or the
  // RuVector implementation is a valid grounded owner for this cross-project question.
  const expectRepo = repo === 'agentdb' && index === 8 ? [repo, 'ruvector', 'concepts'] : [repo, 'concepts'];
  return {
    sourceId: `${repo}-q${index + 1}`,
    level,
    axis: level === 'expert' ? 'implementation-evidence' : (index >= 6 ? 'how-to' : 'capability'),
    specificity: level === 'expert' ? 'surgical' : 'explicit',
    query: q.q,
    expectRepo,
    why: q.why,
  };
}

export function buildTop100() {
  const frozen = load(HELD_OUT).questions;
  const named = frozen.filter((q) => q.stratum === 'named');
  const described = frozen.filter((q) => q.stratum === 'described');
  const scenario = frozen.filter((q) => q.stratum === 'scenario');

  const basicProduct = [
    ['agentdb', 0], ['agentdb', 1], ['agentdb', 6],
    ['ruflo', 0], ['ruflo', 1], ['ruflo', 7],
    ['rulake', 0], ['rulake', 1],
    ['ruvector', 0], ['ruvector', 1],
    ['ruview', 0], ['ruview', 1],
  ].map(([repo, index]) => product(repo, index, 'beginner'));

  const expertProduct = [
    ['agentdb', 8], ['agentdb', 11],
    ['ruflo', 9], ['ruflo', 11],
    ['rulake', 8],
    ['ruvector', 9], ['ruvector', 11],
    ['ruview', 8],
  ].map(([repo, index]) => product(repo, index, 'expert'));

  const questions = [
    ...named.slice(0, 20).map((q) => held(q, 'naive', 'capability', 'explicit')),
    ...named.slice(20).map((q) => held(q, 'beginner', 'capability', 'explicit')),
    ...basicProduct,
    ...described.slice(0, 20).map((q) => held(q, 'intermediate', 'expectation', 'implicit')),
    ...described.slice(20).map((q) => held(q, 'advanced', 'architecture-choice', 'implicit')),
    ...scenario.slice(0, 8).map((q) => held(q, 'advanced', 'architecture-choice', 'contextual')),
    ...scenario.slice(8).map((q) => held(q, 'expert', 'tradeoff-expectation', 'contextual')),
    ...expertProduct,
  ].map((q, i) => ({
    id: `top-${String(i + 1).padStart(3, '0')}`,
    ...q,
    requiredEvidence: semanticAssertionsFor(q.sourceId),
  }));

  return {
    version: 2,
    purpose: '100-question RuvNet Brain recall, latency, and experience benchmark across five user levels.',
    composition: {
      frozenHeldOut: 80,
      deepProductQuestions: 20,
      levels: ['naive', 'beginner', 'intermediate', 'advanced', 'expert'],
    },
    questions,
  };
}

export function corpusHash(corpus) {
  return createHash('sha256').update(JSON.stringify(corpus.questions)).digest('hex');
}

if (isDirectInvocation(import.meta.url)) {
  const corpus = buildTop100();
  fs.writeFileSync(OUT, JSON.stringify({ ...corpus, sha256: corpusHash(corpus) }, null, 2) + '\n');
  console.log(`${OUT}: ${corpus.questions.length} questions, sha256=${corpusHash(corpus)}`);
}
