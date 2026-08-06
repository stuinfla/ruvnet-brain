/**
 * verifyLanded() — what a genuinely-successful update looks like on disk, versus a genuine no-op.
 *
 * Two user reports pull this function in opposite directions, and both are right:
 *
 *   #106 — `--update` exited 0 while the corpus was unchanged. Nothing landed, and a cron job read
 *          it as success. So an update that does not move must be REFUSED.
 *   #108 — the same guard aborted the whole run on a store that was legitimately unchanged (8 of 15
 *          shared one forge stamp), three weeks of "failed" nightly updates that had actually
 *          succeeded, and ~1.6 GB of rollback copies stranded per run because the abort jumped over
 *          the release step. So an unchanged STORE must NOT be a failure.
 *
 * Tightening the per-store assertion satisfies #106 and worsens #108; loosening it satisfies #108
 * and reopens #106. The way out is that the two reports are asking about different objects. Stores
 * are forged INDEPENDENTLY and are re-shipped byte-identical inside a genuinely new bundle, so
 * per-store equality is ordinary. What #35/#106 actually asked is whether ANYTHING landed — a
 * property of the BUNDLE, which advances every time one is published. So:
 *
 *   bundle moved, store unchanged   -> SUCCESS  (the #108 case that used to abort)
 *   bundle unchanged, store unchanged -> FAILURE (the #106/#35 case that used to exit 0)
 *
 * `kind` then says what the caller may do with the rollback copy: a no-op leaves the KB intact, so
 * the copy is redundant and gets released; anything else leaves it suspect, so the copy is kept.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { bundleIdentity, verifyLanded } from '../../kb/forge-update.mjs';

let kbDir;
beforeEach(() => { kbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'landed-verdict-')); });
afterEach(() => { fs.rmSync(kbDir, { recursive: true, force: true }); });

const ALPHA_OLD = { kbName: 'alpha', builtUtc: '2026-07-28T15:04:51.856Z', sourceCommit: 'aaa111', sourceDescribe: 'v2.0.0' };
const ALPHA_NEW = { kbName: 'alpha', builtUtc: '2026-08-01T09:00:00.000Z', sourceCommit: 'bbb222', sourceDescribe: 'v2.1.0' };

/** A whole SOURCE.json, the shape this project actually publishes. */
const bundle = ({ releaseTag, brainVersion, builtUtc, stores }) => {
  const out = { builder: 'rvf-kb-forge', stores: {} };
  if (builtUtc) out.builtUtc = builtUtc;
  if (brainVersion) out.brainVersion = brainVersion;
  if (releaseTag) out.releaseTag = releaseTag;
  for (const s of stores) out.stores[s.kbName] = s;
  return out;
};
const write = (src) => fs.writeFileSync(path.join(kbDir, 'SOURCE.json'), JSON.stringify(src, null, 2));

describe('bundleIdentity', () => {
  it('is null when a SOURCE.json carries no bundle identity at all, so callers can tell "identical" from "nothing to compare"', () => {
    expect(bundleIdentity({ builder: 'rvf-kb-forge', stores: {} })).toBeNull();
    expect(bundleIdentity(null)).toBeNull();
  });

  it('changes when the release advances, even if nothing else does', () => {
    const a = bundleIdentity({ releaseTag: 'v4.0.7', brainVersion: '4.0.7', builtUtc: 'x' });
    const b = bundleIdentity({ releaseTag: 'v4.0.8', brainVersion: '4.0.8', builtUtc: 'x' });
    expect(a).not.toBe(b);
  });
});

describe('verifyLanded — issue #108: an unchanged STORE inside a moved bundle is a success', () => {
  it('SUCCEEDS when the bundle advanced and this store did not, and names the store as unchanged', () => {
    // The reporter's exact shape: the release moved, `alpha`'s upstream repo did not, so the same
    // bytes ship again. The old guard called this "UPDATE MISMATCH … nothing actually changed" and
    // killed the run at the first such store — whitelisting one would only promote the next.
    const before = bundle({ releaseTag: 'v4.0.7', brainVersion: '4.0.7', builtUtc: '2026-07-31T04:39:28.414Z', stores: [ALPHA_OLD] });
    write(bundle({ releaseTag: 'v4.0.8', brainVersion: '4.0.8', builtUtc: '2026-08-03T04:39:28.414Z', stores: [ALPHA_OLD] }));

    const r = verifyLanded({ kbDir, kbName: 'alpha', before: ALPHA_OLD, beforeBundle: before });

    expect(r.ok, r.reason || '').toBe(true);
    expect(r.kind).toBeNull();
    expect(r.storeUnchanged, 'unchanged is a fact worth reporting, not a failure').toBe(true);
    expect(r.bundleChanged).toBe(true);
  });

  it('SUCCEEDS when both the bundle and the store advanced', () => {
    const before = bundle({ releaseTag: 'v4.0.7', brainVersion: '4.0.7', builtUtc: 'a', stores: [ALPHA_OLD] });
    write(bundle({ releaseTag: 'v4.0.8', brainVersion: '4.0.8', builtUtc: 'b', stores: [ALPHA_NEW] }));

    const r = verifyLanded({ kbDir, kbName: 'alpha', before: ALPHA_OLD, beforeBundle: before });

    expect(r.ok).toBe(true);
    expect(r.storeUnchanged).toBe(false);
  });
});

describe('verifyLanded — issue #106: a bundle that did not move is still refused', () => {
  it('FAILS as kind "noop" when neither the bundle nor the store moved', () => {
    const same = () => bundle({ releaseTag: 'v4.0.7', brainVersion: '4.0.7', builtUtc: '2026-07-31T04:39:28.414Z', stores: [ALPHA_OLD] });
    const before = same();
    write(same());

    const r = verifyLanded({ kbDir, kbName: 'alpha', before: ALPHA_OLD, beforeBundle: before });

    expect(r.ok, 'identical bytes over an identical copy is not an update').toBe(false);
    expect(r.kind).toBe('noop');
    expect(r.reason).toMatch(/BUNDLE on disk is IDENTICAL/);
  });

  it('still falls back to the per-store fingerprint when NEITHER side carries a bundle identity', () => {
    // Pre-releaseTag bundles and plain forge manifests have no top-level identity. There is then
    // nothing to compare at the bundle level, so the only available signal must keep working —
    // the loosening must not become a hole for the copies that need the guard most.
    const before = bundle({ stores: [ALPHA_OLD] });
    write(bundle({ stores: [ALPHA_OLD] }));

    const r = verifyLanded({ kbDir, kbName: 'alpha', before: ALPHA_OLD, beforeBundle: before });

    expect(r.ok).toBe(false);
    expect(r.kind).toBe('noop');
    expect(r.bundleChanged, 'no signal is not the same as "identical"').toBeNull();
    expect(r.reason).toMatch(/no top-level identity to cross-check/);
  });
});

describe('verifyLanded — a suspect copy is "damaged", never "noop"', () => {
  it('marks a digest mismatch as damaged, so the rollback copy is KEPT rather than released', () => {
    const before = bundle({ releaseTag: 'v4.0.7', builtUtc: 'a', stores: [ALPHA_OLD] });
    write(bundle({ releaseTag: 'v4.0.8', builtUtc: 'b', stores: [ALPHA_NEW] }));
    const buf = Buffer.from('not what the release declared');

    const r = verifyLanded({
      kbDir, kbName: 'alpha', before: ALPHA_OLD, beforeBundle: before,
      expectedDigest: `sha256:${createHash('sha256').update('something else').digest('hex')}`,
      downloadedBuffer: buf,
    });

    expect(r.ok).toBe(false);
    expect(r.kind, 'bad bytes must never be classified as a harmless no-op').toBe('damaged');
    expect(r.reason).toMatch(/digest/);
  });

  it('marks a missing SOURCE.json after extraction as damaged', () => {
    const r = verifyLanded({ kbDir, kbName: 'alpha', before: ALPHA_OLD, beforeBundle: bundle({ releaseTag: 'v1', stores: [ALPHA_OLD] }) });
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('damaged');
  });

  it('marks a landed bundle with no entry for the requested store as damaged', () => {
    const before = bundle({ releaseTag: 'v4.0.7', builtUtc: 'a', stores: [ALPHA_OLD] });
    write(bundle({ releaseTag: 'v4.0.8', builtUtc: 'b', stores: [{ kbName: 'beta', builtUtc: 'c' }, { kbName: 'gamma', builtUtc: 'd' }] }));

    const r = verifyLanded({ kbDir, kbName: 'alpha', before: ALPHA_OLD, beforeBundle: before });

    expect(r.ok).toBe(false);
    expect(r.kind).toBe('damaged');
    expect(r.reason).toMatch(/no entry for store "alpha"/);
  });
});
