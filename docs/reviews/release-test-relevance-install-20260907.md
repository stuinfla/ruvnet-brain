Updated: 2026-09-07 11:07:28 EDT | Version 1.0.0
Created: 2026-09-07 11:07:28 EDT

# Install/update release-test relevance audit

Read-only review, 2026-09-07. Source: recovery checkout at HEAD 4823f1aa plus current working bytes; complete text of the eight assigned files was read, including fixture construction and assertions. No full-suite execution or native scheduler invocation. Counts below are registered cases after expanding literal it.each/for tables, not assertion counts. Historical issue narratives were not treated as authority.

| File (tests/unit/*.test.mjs) | Cases | Disposition | Reason |
|---|---:|---|---|
| install-activation-rollback | 9 | Retain | 4 prior-content variants and 5 rename/validation/foreign-replacement failures exercise real installer swaps and byte preservation. |
| forge-update-apply-rollback | 15 | Retain with explicit zip prerequisite | Actual copied updater, local HTTP release, genuine signature, zip extraction, filesystem activation and result receipts. Entire suite skips when zip absent; cannot count that as qualification. |
| installer-sibling-imports-packaged | 4 | Historical/diagnostic, not sufficient release authority | Real npm dry-run inventory useful, but regex sees only new URL sibling import form and one additional ./ static level; current staged package execution is stronger. Two identical npm dry-runs duplicate work. |
| install-verify-bundle-parity | 5 | Exclude from release authority | All five tests invoke a handwritten verifier replica, not bin/install.mjs verifier. A change in actual installer would not change test verdict. Header's unsafe-import rationale is obsolete. |
| nightly-scheduler | 22 | Retain | Receipt health, executable ownership, environment isolation and symmetric scheduler operations; adapters are fakes, not native execution proof. |
| nightly-refresh-launcher | 8 | Retain | 3 platform invocations and 5 unsafe npm-entry mutations exercise the actual copied launcher. |
| nightly-two-run-proof | 44 | Retain | Validator/trigger contract tests; structural synthetic evidence explicitly separated from postpublication native proof. |
| assembled-release-projection | 4 | Retain | Actual projection validation and mutation failures preserve immutable signed/public evidence. |

## Assertion review by file

### install-activation-rollback (9)
All cases retain/recover private bytes, verify valid landed coverage or failure, and preserve foreign replacements. Counts of one/two preserved directories are derived from one/two fixture swaps, not frozen product corpus counts. Stage-prefix counts and exact diagnostic phrases are implementation-coupled; a legitimate rename/narrative change would require test maintenance, but the underlying byte-preservation invariant is essential. The `managed-only` test intentionally preserves an unclassified prior tree: it does not contradict zero *additional* copies on a subsequent verified nightly no-op. Symlink case assumes privilege; explicit CI prerequisite is needed for zero-skip cross-platform qualification. No automatic host-hook dependency.

### forge-update-apply-rollback (15)
Cases: missing/tampered signature (2), invalid staged coverage, byte-identical noop, one unchanged store amid update, restore-complete same bundle, suspect candidate, zero duplicate-snapshot budget, unresolved private RVF/text (2), bounded private retention applied/noop (2), unsafe backup symlink, already-current check, behind check. Real live and retained bytes, exit codes, imported provenance and measured storage deltas are meaningful. Old fixture versions are synthetic transition inputs, not required current release numbers. StoreCount=2 and zip/sig hit counts=1 are fixture-specific; network-count assertions would reject legitimate retry policy changes and should not be treated as independent publication truth. Many human-output regexes duplicate stronger receipt/filesystem assertions; retain semantic checks but wording alone should not require a release redesign.

The `suspect candidate` case rejects removal of an existing store. That is current behavior, but a future authorized public-store retirement would need this contract revised; it is not proof every corpus must grow forever. `newer` case only checks differing tags; product isBehind still treats any different tag as behind, so this test does not prove downgrade prevention. Signing fixture rewrites an exact source regex without asserting a replacement occurred; a harmless production constant-format refactor could make fixture signatures fail. `describe.skipIf(!CAN_ZIP)` is a real no-proof path. Safe CI must install/verify zip before counting these cases. No retired automatic-hook assumption.

### installer-sibling-imports-packaged (4)
Nonempty import census, on-disk imports, npm inventory membership, and one-depth dependency membership are sensible diagnostic checks. Nonempty regex census can reject a legitimate all-static-import refactor; it is intentionally a detector-blindness alarm, not evidence of a broken package. Regex misses arbitrary relative import forms and deeper dependencies. Must not label it comprehensive packaged-module proof. Parent confirmed exclusion from authoritative qualifier in favor of actual sealed-package execution.

### install-verify-bundle-parity (5)
Valid signature, tampered bundle, wrong key, absent signature, absent bundle are valuable scenarios but the installer half is fabricated by a local replica. The tests can all pass while bin/install.mjs verification is broken. Parent confirmed exclusion from authoritative qualifier. Future replacement must invoke actual installer verification or actual signed candidate install, with negative tamper/missing-signature behavior.

### nightly-scheduler (22)
Cases cover producer-envelope order/status mutations; never-ran/failed/stale/current health; exact package/bundle hashes and proof isolation; rejection of unregistered proof selection; runner digest; execution identity; live/dead/unknown owner; common scheduler executable; darwin/linux/windows create/status/remove; unsupported OS; test-mode isolation (3); cron permission denial; exact cron ownership; allowlisted env; unsuccessful bootout; fixed dated proof schedule; wrong registration/extra argv (2). All underlying safety assertions remain relevant to explicit scheduled updates after host-hook retirement. Exact command strings/XML/cron schedule encode real adapter interfaces, not gratuitous prose. Fixed 2030 proof date will expire eventually if implementation requires future time; use clock-relative/injected time when maintaining. Symlink creation has platform privilege dependency. No native scheduler execution is claimed by fake run adapters.

### nightly-refresh-launcher (8)
Actual launcher executes fixture npm JS entry with literal special-character package path, preserves registered custom paths and exit=7. Five negative entry cases: foreign package, traversal, missing entry, missing shim, symlink escape. Exact argv assertion enforces explicit update invocation; helper uses injected spawn only to make unsupported platform paths testable on each host. `managed npm` diagnostic regex is secondary to rejection/empty output. Symlink mutation assumes privilege. Native OS execution remains separately required. No host lifecycle hook registration dependency.

### nightly-two-run-proof (44)
Every assertion inspected: native trigger selection/cleanup timing, unique absent proof identity, bounded start timeout, cleanup failure, duplicate runs; raw hash and candidate/source/run binding; actual Windows-path validation; installed-update scope and imported-vs-executed evidence; signature/projection/executable/trigger mutations; observed retained-copy rejection; strict corpus validator rejection of imported/legacy and wrong-run/old-time/missing evidence; exact staged bytes; symlink/nonzip rejection; distinct runs/noop/storage/retention mutations. No obsolete requirement that installed updates freshly execute corpus production. Strict corpus tests remain separately relevant to preventing that false claim. `staged.bytes=21` is exactly the fixture string length, not product size; derive Buffer.byteLength to avoid gratuitous fixture editing friction. Fake native command invocation is explicitly labeled and must never substitute for public native receipts. No skips declared, but symlink privilege is an environment prerequisite.

### assembled-release-projection (4)
Missing runtime release identity repaired while public bytes unchanged; wrong source rejected before write; tampered RVF rejected; changed coverage rejected. Exact error strings are wording-coupled but accompany proper real validation. Version derives getVersion. No stale release literals, host hooks, or fixed corpus counts.

## Recommended dedicated zero-skip retirement qualifier

Create `tests/unit/automatic-hook-retirement.test.mjs` using scratch ordinary files, with no symlinks, zip, native hosts, scheduler, or machine-state dependence:
1. Actual automaticHookRetirementStatus(ROOT): empty registries/contracts and canonical adapter pointers.
2. Each temporary registry gets one registration: actual checker rejects; also malformed hooks object/group and redirected adapter pointer reject.
3. Actual wireCodexHost against isolated home with owned wrapper/settings registrations plus foreign command and unrelated settings: installer removes owned entries, keeps foreign entries and MCP server/config.
4. Repeat actual installation: no new wrapper or registrations and unchanged foreign settings bytes.
5. Actual selfCheck against scratch installed plugin containing a command that writes a sentinel: returns automatic-registration failure and sentinel never exists (inspection does not execute).
6. Malformed settings JSON throws instead of silently discarding unrelated user settings.

The existing integration hook-conformance-both-hosts.test.mjs already covers most of 1-4 with no skip clauses, including real offline wireCodexHost. Selfcheck-battery contains the no-firings assertion but also one unrelated skip; extract the retirement cases for a clean zero-skip qualifier rather than miscounting the whole legacy battery.
