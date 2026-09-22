// identifier-lane.mjs — WHEN A QUESTION NAMES AN EXACT THING, FIND THE EXACT THING.
//
// THE FAILURE (measured 2026-09-11, ~/.cache/ruvnet-brain/kb builtUtc 2026-08-20T07:16:20.675Z,
// worktree HEAD 2eef2024). Asked "Which is canonical: .swarm/memory.db or .swarm/agentdb-memory.db?"
// the brain answered from agentdb/ui/.claude/agents/hive-mind/swarm-memory-manager.md — a file that
// has nothing to say about it. The corpus CONTAINS the defining answer: ruflo's changelog entry
// #2786 ("Added getAgentDbPath() ... basename agentdb-memory.db ... sql.js CRUD writer's memory.db")
// and v3/@claude-flow/cli/src/memory/memory-bridge.ts. Six targeted queries, including exact quoted
// text, never surfaced either.
//
// WHY IT LOST, and it is not the reranker's fault: the capability-card router read the substring
// "agentdb" inside the identifier `agentdb-memory.db`, concluded the question NAMED the agentdb
// repo, and never searched ruflo at all. A cross-encoder cannot promote a document from a store
// that was never opened.
//
// THE SIGNAL NOBODY WAS USING. A literal scan of all 184 passage sidecars (466 MB) for
// `agentdb-memory.db` and `getAgentDbPath` costs **4.17 s** and returns {ruflo, ruv-gists} for both
// — decisive, exact, and cheap enough to pay for the question class that needs it. Dense retrieval
// is the wrong instrument for an identifier: embeddings are built to generalise, and an identifier's
// entire value is that it does NOT generalise.
//
// WHAT KEEPS THIS HONEST:
//   • It fires ONLY on rare-shaped tokens — a dotted filename, a camelCase symbol, an issue ref, a
//     scoped package. Ordinary prose scans nothing and pays nothing.
//   • It WIDENS the routed set; it never narrows it. A repo the router chose is still searched.
//   • The boost rewards a DEFINING occurrence, not a repetition. A chunk that merely echoes the
//     question's words carries the identifiers too — so mention alone earns the smallest possible
//     lift, and the rank is decided by definition-shaped context and by the document's own path.

import fs from 'node:fs';
import path from 'node:path';

// English words that happen to be camelCase-ish or dotted in prose. Kept tiny on purpose: the
// shape tests below already exclude almost everything, and a long list would be its own bug.
const NOT_AN_IDENTIFIER = new Set([
  'e.g', 'i.e', 'etc', 'vs', 'v1', 'v2', 'v3', 'node.js', 'next.js', 'readme', 'readme.md',
]);

const FILE_LIKE = /^[a-z0-9][a-z0-9._-]*\.[a-z0-9]{1,8}$/i;      // agentdb-memory.db, memory-bridge.ts
const CAMEL = /^[a-z]+(?:[A-Z][a-z0-9]+){1,}$/;                   // getAgentDbPath
const PASCAL = /^(?:[A-Z][a-z0-9]+){2,}$/;                        // RvfDatabase
const SNAKE = /^[a-z0-9]+(?:_[a-z0-9]+){1,}$/;                    // memory_entries
const ISSUE = /^#\d{2,6}$/;                                       // #2786
const SCOPED = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i;  // @claude-flow/aidefence

/**
 * The exact, rare tokens a question contains. Deliberately conservative: every token returned here
 * causes a corpus scan, so a false positive costs seconds and a false negative costs only the
 * behaviour this module adds.
 */
export function exactIdentifiers(query) {
  const out = new Set();
  const raw = String(query || '');
  // Path-shaped runs first, so ".swarm/memory.db" contributes its basename rather than being split.
  for (const m of raw.matchAll(/[A-Za-z0-9_@./#-]*[/.][A-Za-z0-9_@./#-]+/g)) {
    const token = m[0].replace(/[.,;:?!)\]}'"]+$/, '');
    if (SCOPED.test(token)) { out.add(token.toLowerCase()); continue; }
    const base = token.split('/').pop();
    if (base && FILE_LIKE.test(base) && !NOT_AN_IDENTIFIER.has(base.toLowerCase()) && base.length >= 6) {
      out.add(base.toLowerCase());
    }
  }
  for (const m of raw.matchAll(/#\d{2,6}|[A-Za-z_][A-Za-z0-9_]{3,}/g)) {
    const token = m[0];
    if (NOT_AN_IDENTIFIER.has(token.toLowerCase())) continue;
    if (ISSUE.test(token) || CAMEL.test(token) || PASCAL.test(token) || SNAKE.test(token)) {
      out.add(token.toLowerCase());
    }
  }
  return [...out];
}

/**
 * The identifiers that are worth a CORPUS SCAN, as opposed to merely worth a boost.
 *
 * Scoped package names are excluded deliberately: they already have two cheaper routes — the
 * package-ownership registry (kb/package-owners.json) resolves them to a repo with no I/O, and
 * exactPackageCandidates() rescues the manifest inside a routed repo. Paying a 4-second corpus read
 * to rediscover what a 37-byte registry already knows is the wrong bargain, and it would put the
 * whole version-question class within a second or two of the query deadline.
 */
export function scannableIdentifiers(query) {
  return exactIdentifiers(query).filter((token) => !SCOPED.test(token));
}

/** Check whether an exact owner.member call token is present in the routed stores' indexed text. */
export function exactMemberIndexPresence(dir, repos, member) {
  const escaped = String(member || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped || !Array.isArray(repos) || !repos.length) return { present: false, scannedRepos: [] };
  const token = new RegExp(`(^|[^a-zA-Z0-9_$])${escaped}($|[^a-zA-Z0-9_$])`);
  const scannedRepos = [];
  for (const repo of [...new Set(repos)]) {
    const file = path.join(dir, `${repo}.passages.jsonl`);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    scannedRepos.push(repo);
    if (token.test(text)) return { present: true, scannedRepos };
  }
  return { present: false, scannedRepos };
}

// One scan per (dir, identifier set) per process. The MCP worker is warm and long-lived, so a
// repeated question costs nothing after the first.
const _scans = new Map();

/**
 * Which stores literally contain these identifiers, and the matching passages from each.
 *
 * Reads each sidecar as a Buffer and tests membership WITHOUT decoding — only lines in a file that
 * already matched are parsed, so the cost is dominated by sequential reads (measured 4.17 s for
 * 466 MB), not by JSON.
 */
export function identifierScan(dir, identifiers, { perRepo = 8, maxRepos = 6 } = {}) {
  const key = `${dir}|${[...identifiers].sort().join(' ')}|${perRepo}|${maxRepos}`;
  const cached = _scans.get(key);
  if (cached) return cached;
  const needles = identifiers.filter((t) => typeof t === 'string' && t.length >= 3);
  const empty = { repos: [], byRepo: new Map(), scannedMs: 0 };
  if (!needles.length) { _scans.set(key, empty); return empty; }

  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.passages.jsonl')); }
  catch { _scans.set(key, empty); return empty; }

  const t0 = Date.now();
  const scored = [];
  for (const file of files) {
    const repo = file.replace(/\.big\.passages\.jsonl$|\.passages\.jsonl$/, '');
    let buf;
    try { buf = fs.readFileSync(path.join(dir, file)); } catch { continue; }
    // Identifiers are normalized to lowercase before the scan, while source symbols are usually
    // PascalCase or camelCase. Decode once for the case-folded membership check; reuse that same
    // text below when parsing matching JSONL rows.
    const decoded = buf.toString('utf8');
    const folded = decoded.toLowerCase();
    const present = needles.filter((n) => folded.includes(n.toLowerCase()));
    if (!present.length) continue;
    const rows = [];
    for (const line of decoded.split('\n')) {
      if (!line) continue;
      const lower = line.toLowerCase();
      const hitTokens = present.filter((n) => lower.includes(n));
      if (!hitTokens.length) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      rows.push({ record, hitTokens });
      if (rows.length >= perRepo * 6) break;   // a bounded read of one store, not a full parse
    }
    if (rows.length) scored.push({ repo, present: present.length, rows });
  }
  // Most identifiers matched wins; a store that carries every identifier the question named is the
  // one that defines them. Ties break on how many passages matched, then by name for determinism.
  scored.sort((a, b) => b.present - a.present || b.rows.length - a.rows.length || a.repo.localeCompare(b.repo));
  const top = scored.slice(0, maxRepos);
  const byRepo = new Map();
  for (const { repo, rows } of top) byRepo.set(repo, rows.slice(0, perRepo * 6));
  const result = { repos: top.map((s) => s.repo), byRepo, scannedMs: Date.now() - t0 };
  _scans.set(key, result);
  return result;
}

/**
 * How strongly a passage EARNS an identifier. Mention is the floor; the rank is decided by
 * definition-shaped context and by the document's own path, because the adversarial case is a
 * chunk that merely repeats the question.
 *
 * `opts.repo` / `opts.knownRepos` guard the PATH-NAMED signal against a second, distinct false
 * positive from the same root cause (issue #286 RC3): an identifier that is ITSELF the name of a
 * different, independently-indexed repository in the corpus (e.g. `photonlayer`) must not credit
 * "this document is named after the identifier" to a candidate from a DIFFERENT repo just because
 * that repo also happens to have a subtree literally called `photonlayer` — ruvector's own
 * `docs/research/photonlayer/ASSESSMENT.md` genuinely discusses PhotonLayer (it is not a vendored
 * copy of anything, so no near-duplicate/content-similarity check would ever catch it), but
 * "photonlayer" the identifier already has an authoritative, independently-indexed home — the
 * `photonlayer` store itself — and crediting a directory-name coincidence in an unrelated repo the
 * same "authoritatively named after this" signal is a plain attribution bug. Both params are
 * OPTIONAL and default to a no-op so every existing call site (including the identifier-lane's own
 * founding case, where the identifiers are filenames like `memory.db` that are not themselves repo
 * names) is byte-for-byte unaffected.
 */
export function identifierEvidence(record, identifiers, { repo = null, knownRepos = null } = {}) {
  const text = String(record?.text || record?.fullText || '');
  const lower = text.toLowerCase();
  const docPath = String(record?.path || '').toLowerCase();
  const segments = docPath.split('/');
  const base = segments[segments.length - 1] || '';
  const ownRepo = repo ? String(repo).toLowerCase() : null;
  let distinct = 0;
  let defining = 0;
  let pathNamed = 0;
  for (const id of identifiers) {
    // The document's own NAME counts as carrying the identifier. A binary or a fixture called
    // `memory.db` may say nothing about itself in its text, and it is still the thing being asked
    // about — requiring a body mention made the strongest possible evidence score zero.
    //
    // MUST be a whole PATH SEGMENT, not merely a substring of one (issue #286 root cause 3, found
    // live 2026-09-13 against the real release-candidate bundle). The prior check was
    // `docPath.includes('/' + id)`, which matches ANY directory that merely STARTS WITH the
    // identifier: `crates/photonlayer-bench/src/bin/bench.rs` contains the literal substring
    // `/photonlayer` (the start of the sibling directory name `photonlayer-bench`), so a query
    // naming the `photonlayer` repo gave every file under ruvector's OWN, unrelated
    // `photonlayer-bench`/`photonlayer-core` vendored subtree the same "this document is named
    // after the identifier" credit (+3.0 pathNamed, on top of the +1.0 mention floor) as the real
    // `photonlayer` repository's own files — none of which is a duplicate-content problem
    // (`selectResults`'s repo-name-affinity boost already handles that): it is a plain path-prefix
    // false positive that fires identically regardless of which repo the file actually belongs to.
    // Measured effect on the retrieval-canary oracle ("In the photonlayer repository, what is
    // PhotonLayer..."): this false credit alone lifted 3 candidates (one from `ruvector`, two from
    // `photonlayer`'s own noisier files) above the oracle's designated passage
    // (`crates/photonlayer-core/README.md`), which otherwise ranks in the top 10.
    //
    // A second, independent false positive survives the segment fix alone: an identifier that IS a
    // real repo name (`knownRepos` has it) belongs to that repo, not to whichever OTHER repo also
    // happens to have an exactly-named subdirectory. Gate pathNamed on repo attribution only in that
    // specific case — an identifier that is not a known repo name (the founding `memory.db` case)
    // is completely unaffected.
    const pathSegmentNamed = segments.includes(id);
    const identifierIsForeignRepoName = pathSegmentNamed && knownRepos && ownRepo
      && knownRepos.has(id) && id !== ownRepo;
    const named = pathSegmentNamed && !identifierIsForeignRepoName;
    if (!lower.includes(id) && !named) continue;
    distinct++;
    if (named) pathNamed++;
    // A DEFINITION, NOT A MENTION — and the discriminator has to survive the adversarial case, which
    // is a chunk that repeats the QUESTION. An earlier version accepted any of
    // added|fixed|canonical|basename within 120 characters of the identifier; the question itself
    // says "Which is canonical: .swarm/memory.db", so an echo of the question scored as a
    // definition and the whole separation collapsed (measured: echo 12.0 vs definition 12.0).
    //
    // So the changelog clause now needs BOTH a change verb and the identifier written as code
    // (backticks or quotes) — how a release note actually names an artifact, and what a person
    // restating a question does not do. The other three clauses are structural by construction:
    // a declaration keyword, a call/assignment/type site, or a manifest key.
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const declared = new RegExp(
      `(?:function|const|let|var|class|export|def|fn|interface|type|async)\\s+${esc}\\b`
      + `|\\b${esc}\\s*[=(]`
      + `|["'\`]${esc}["'\`]\\s*:`
      + `|\\b(?:added|fixed|introduce[sd]?|renamed|deprecated|replaced)\\b[\\s\\S]{0,220}[\`"']${esc}[\`"']`,
      'i',
    );
    if (declared.test(text)) defining++;
  }
  return { distinct, defining, pathNamed, matched: distinct > 0 };
}

/**
 * The additive cross-encoder boost an identifier-bearing candidate has earned.
 *
 * THE MAGNITUDES ARE CALIBRATED TO A MEASUREMENT, NOT CHOSEN TO WIN. The decisive source for
 * "Which is canonical: .swarm/memory.db or .swarm/agentdb-memory.db?" is ruflo/CHANGELOG.md's #2786
 * entry, which literally defines getAgentDbPath() and the basename agentdb-memory.db. The
 * cross-encoder scores that passage **-9.874** whole and **-6.323** excerpted around the
 * identifier: it is a list of release entries, and the model is right that, as prose, it is not
 * "about" the question. It is nevertheless the only document in the corpus that ANSWERS the
 * question. A definition beat a semantic judgement, so the boost has to be able to say so.
 *
 * 5.0 per defining occurrence puts this in the same class as the lanes this file already treats as
 * decisive — `_quotedClaims`, `_exactAdr` and `_sourceDetail` each add 10.0 on the same signal
 * shape ("the document literally contains the exact thing that was asked for"). Mention alone stays
 * at 1.0, which is the ceiling for a chunk that merely echoes the question's words: the measured
 * separation is 12.0 for the defining source against 2.0 for an echo carrying both identifiers.
 */
export function identifierBoost(evidence) {
  if (!evidence?.matched) return 0;
  return 1.0
    + 1.0 * Math.max(0, evidence.distinct - 1)
    + 5.0 * evidence.defining
    + 3.0 * evidence.pathNamed;
}

/**
 * The window of a passage the RERANKER should judge, centred on the identifier.
 *
 * MEASURED, not assumed. `ruflo/CHANGELOG.md` reaches the pool as a 4,000-character chunk holding
 * dozens of unrelated release entries; the three lines that answer
 * "Which is canonical: .swarm/memory.db or .swarm/agentdb-memory.db?" (#2786, getAgentDbPath) sit
 * somewhere in the middle. Scored whole, the cross-encoder returned **-9.874** — correctly, because
 * as a whole that chunk is not about the question. The model reads at most 512 tokens of any
 * passage anyway, and for a chunk like this those tokens are whatever happened to be at the top.
 * Handing it the window around the identifier asks the question the pool actually intends.
 *
 * This is the RANKER'S copy only (`_ceText`). The rendered answer, the structured retrieval record
 * and every receipt still carry the full passage — narrowing what the ranker reads must never
 * narrow what the reader is shown.
 */
export function identifierExcerpt(text, identifiers, { before = 600, after = 2_400 } = {}) {
  const body = String(text || '');
  if (body.length <= before + after) return body;
  const lowered = body.toLowerCase();
  const positions = identifiers
    .map((id) => lowered.indexOf(String(id).toLowerCase()))
    .filter((i) => i >= 0);
  if (!positions.length) return body.slice(0, before + after);
  const center = Math.min(...positions);
  return body.slice(Math.max(0, center - before), Math.min(body.length, center + after));
}

/** Scanned passages for one repo, shaped as searchAll candidates on the exempt `rescue` lane. */
export function identifierCandidates(scan, repo, identifiers, topN = 8, knownRepos = null) {
  const rows = scan?.byRepo?.get(repo);
  if (!rows?.length) return [];
  const ranked = rows
    .map(({ record }) => ({ record, evidence: identifierEvidence(record, identifiers, { repo, knownRepos }) }))
    .filter(({ evidence }) => evidence.matched)
    .sort((a, b) => identifierBoost(b.evidence) - identifierBoost(a.evidence)
      || String(a.record.path).localeCompare(String(b.record.path)));
  const seen = new Set();
  const out = [];
  for (const { record, evidence } of ranked) {
    if (seen.has(record.path)) continue;
    seen.add(record.path);
    out.push({
      path: record.path,
      title: record.title,
      fullText: record.text,
      text: record.text,
      bestDistance: 1.0,
      distance: 1.0,
      _lane: 'rescue',
      _exactIdentifier: evidence,
      _ceText: identifierExcerpt(record.text, identifiers),
    });
    if (out.length >= topN) break;
  }
  return out;
}
