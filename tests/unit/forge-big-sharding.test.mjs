// tests/unit/forge-big-sharding.test.mjs — kb/forge-big.mjs's shard math is the part of the
// large-repo ingest path most likely to silently drop or duplicate passages if edited carelessly:
// embedShard() (line 82) splits `rows` across N parallel shard processes via
// `rows.filter((_, i) => i % nShards === shardIdx)` (line 84), and ingestStore()'s reconciliation
// check depends on every row landing in exactly one shard. Neither this nor cosine() (line 79, used
// by downstream rerank/dedup) has ever been tested.
//
// PREREQUISITE: both are module-private, and the file runs MODE dispatch unconditionally at top
// level (line 165+: `if (MODE === 'embed') { await embedShard(...) }`), so importing it today would
// fire real embedding/ingest work as an import side effect. Two additive, no-behavior-change edits:
//   1. `export function cosine(a, b) {...}` (currently unexported, line 79).
//   2. Extract the inline filter into a named, exported `shardAssign(rows, shardIdx, nShards)`
//      (mirrors self-update.mjs's `planAction` extraction in that gap skeleton) and have
//      embedShard() call it instead of inlining the modulo — same math, just given a name and a
//      fixture-friendly signature.
// Flag both to Stuart before applying, per this repo's established pattern for these gap skeletons.
import { describe, it, expect } from 'vitest';

describe.todo('forge-big.mjs — cosine() (requires export, see file header)', () => {
  it.todo('returns 1 for two identical unit vectors');
  it.todo('returns 0 for two orthogonal vectors ([1,0], [0,1])');
});

describe.todo('forge-big.mjs — shardAssign() (requires extracting the inline modulo filter into a named export)', () => {
  it.todo('every row is assigned to EXACTLY ONE shard across shard 0..N-1 (no drops, no dupes)');
  it.todo('is deterministic — the same row always lands in the same shard for a given N');
  it.todo('with N=1, every row goes to shard 0 (the --smoke / single-process "both" mode)');
});
