Updated: 2026-11-17 21:35:48 EST | Version 1.1.0
Created: 2026-11-17 19:30:00 EST

# F04: decisions the lead must make before a version 5 user release

F04 is the Codex review's fourth blocker: version 5 is not yet a releasable distribution. The review
fixes (`docs/REVIEW-FIXES.md`) and the integration (`docs/INTEGRATION-NOTES.md`) do not decide any of
the questions below. Each question lists the options, what each one costs, and what is already true in
the tree. Nothing here has been generated, published, scheduled or unregistered.

What is true on `v5/integration` today:
- `packages/contract/keys/release-public.pem` does not exist. `trustedPublicKey()` throws, so nothing
  can be sealed, promoted or installed outside the tests, which sign with keys made at test time.
- `packages/release/rail.json` names the signing secret `RUVNET_BRAIN5_SIGNING_KEY` and leaves
  `answerGate.questionSetSha256` empty, so the answer gate measures but never passes.
- The root `package.json` is `ruvnet-brain` 4.7.28. Its `bin` is the 4.7 installer, its
  `prepublishOnly` runs the 4.7 protected-release check, and `scripts/release-authority.mjs` scans
  `packages/` and allows no publisher there.
- The release schema already has an optional, signed `migrate` boolean. Nothing reads it yet.
- The four v5 workflows run only on `workflow_dispatch`, a `workflow_call` from the candidate, or a push
  to `release/5.*`.

## Q1. The production signing key

The public key goes in `packages/contract/keys/release-public.pem`. Every installed shim trusts that
one key, so changing it later needs a release signed with the old key that ships the new one.

| Option | How | For | Against |
|---|---|---|---|
| A. Ed25519 key made offline on the owner's Mac | `openssl genpkey -algorithm ed25519`. The private key goes only into the GitHub environment secret `v5-release` (`RUVNET_BRAIN5_SIGNING_KEY`), plus one offline backup. The public key is committed. | It is what the rail already expects. No new service, and it works today. | Anyone who can change the `v5-release` environment or its workflow can sign. The F01 remainder (receipts are not signed) has the same trust root. A lost key means a re-key release. |
| B. Cloud KMS or HSM key (GCP KMS, AWS KMS, YubiHSM) | `seal.mjs` calls the KMS to sign. The private key never leaves the service. | The key cannot be copied out. Access is logged. | It is new code in the one signing step, needs a cloud account and credentials in CI, and adds an outside service to every release. |
| C. Sigstore keyless (OIDC identity of the workflow) | Sign with the workflow's identity and verify against the Fulcio certificate and Rekor log. | No long-lived key to lose. There is a public transparency log. | Installs would need network access to verify, or a bundled trust root. The offline install path and the shim's single-key check would both change. It is the largest change. |

**Recommendation for the lead to weigh:** A now, with the backup and a written re-key procedure. B is
the upgrade if release volume or the threat model grows.

## Q2. Switching the npm package to version 5

| Option | How | For | Against |
|---|---|---|---|
| A. Same name, major version | `ruvnet-brain@5.0.0`. `bin` points to `packages/cli/ruvnet-brain.mjs` and keeps `ruvnet-brain` and `ruvnet-brain-update` as entries. `files` covers only the v5 app. | One name, and `npx ruvnet-brain` keeps working. Semver signals the break. | It retires the 4.7 `prepublishOnly` and `version:set` rails on that line. A 4.7 hotfix then needs a `maint-4.7` branch that publishes `4.7.x` under a `legacy` dist-tag. |
| B. Same name, `next` dist-tag first | Publish 5.0.0 under `next` and keep `latest` on 4.7 through the soak, then move `latest`. | Users opt in during the seven-day soak. Rollback is a tag move. | Two dist-tags to keep honest, and the tag move is itself a publish operation the gate must name. |
| C. New package name (`ruvnet-brain5` or `@ruvnet-brain/cli`) | A separate package, with the old one left on 4.7 and printing a pointer. | No risk to 4.7 users at all. | Every doc, skill, hook and the `--update` path must learn a new name. Users must act to move, which works against the unattended migration in Q4. |

**Coupled decision: the publisher.** `scripts/release-authority.mjs` allows publishing only from
`scripts/release.mjs` and the transaction provider, and allows none in `packages/`. Version 5 needs one
named publisher. Either `packages/release/promote.mjs` is added to `CANONICAL_PUBLISHERS` (the v5 rail
publishes), or the 4.7 `scripts/release.mjs` publishes the sealed v5 tree (one publisher for both
lines). npm trusted publishing (OIDC) avoids a long-lived npm token in either case.

## Q3. The default update address and the signed `migrate` field

Today `--update` with no source prints that nothing was changed and exits 0. That is the brake-off
behaviour: 4.7 stays exactly as it is.

| Option | For | Against |
|---|---|---|
| A. A GitHub Releases address (`…/releases/download/brain5-<n>/`) as the default, with `migrate: false` until the soak passes, then `true` in a later signed release | Turning migration on is a signed release decision, and it can be turned off again by the next release. It uses the existing tag prefix. | It depends on GitHub availability, and it needs the Q1 key first. |
| B. The npm tarball as the update source | One channel for install and update. | The pack is about 2.1 GB (`docs/PORT-NOTES.md`), far over what npm accepts for a tarball. The pack would still need a second channel. |
| C. No default address. Users opt in with `ruvnet-brain config update-url` | Nothing changes for anyone who does not act. | No unattended migration, so the 4.7 nightly rail has to be kept alive indefinitely. |

## Q4. Migration steps still missing

1. **Private stores.** 4.7 private overlay stores (`kb/` private files written by
   `scripts/private-overlay.mjs`) have no v5 form yet.
   - A. Convert at migration: rebuild each private store into a v5 private pack (`access: "private"`,
     `projects` list) from its recorded sources. This needs the sources to still exist on the machine.
   - B. Rebuild from source on demand (`ruvnet-brain private add <dir>`), with migration listing what it
     could not carry.
   - C. Leave them in the 4.7 home, served only by 4.7 until removed.

   A is the most seamless and the most code. B is honest and smaller. C keeps two homes alive.
2. **The 03:30 job.** Unregistering 4.7's nightly job is a launchd, cron or schtasks change on the
   user's machine.
   - A. Migration unregisters it after the brake passes and records how to put it back
     (`rollback-to-4` re-registers it).
   - B. Leave it registered and make the 4.7 job exit at once when a v5 home exists.
   - C. Tell the user and do nothing.

   A is the clean end state, but it changes the user's scheduler unattended, which needs the owner's
   explicit approval as policy. B changes nothing outside the brain's own files, but leaves a dead
   entry.
3. **The brake (F07 remainder).** Today the brake checks the 4.7 home structurally. A real 4.7 search
   before v5 unregisters itself is safer, but runs the 4.7 code during migration. Decide whether that is
   acceptable, or whether the structural check stands.

## Q5. Rehearsals, soak and the 4.7 line (ROADMAP Part B)

These need owner time and machines, not code:
- rehearsals on three real machine images: a clean macOS, Linux and Windows user;
- the seven-day soak;
- keeping the 4.7 line releasable while v5 soaks (see Q2 A on `maint-4.7`).

The first `windows-latest` candidate leg is also the first time `rb5.cmd` runs (F05 is static-only).

## G1. Where CI gets the gists (from the port's workflow notes)

`kb/ruv-gists.passages.jsonl` is gitignored (`kb/*.passages.jsonl`), so CI has no copy.
`v5-pack-build.yml` with `corpus: pinned` and `gists: required` (the default) stops at the fetch step
until this is decided. `gists: omit` builds without the gists, and the prototype's 596 gist files and
10,229 extract rows are then missing from the pack.

| Option | For | Against |
|---|---|---|
| A. Commit the passage file under a tracked name (for example `recipe/gists.passages.jsonl`) and pin its sha256 in `recipe/CORPUS.json` | It is reproducible, reviewable and needs no secret. | The repository grows by the file's size on every refresh. The gists' content becomes part of the public repository, so check that each gist is public and licensed for redistribution. |
| B. Publish it as a release asset of a corpus tag and fetch it by URL plus sha256 | It is reproducible and keeps the repository small. | It needs a corpus-publishing step. The 4.7 rail forbids `corpus-sha256-*` tags for v5 (`forbiddenTags`), so it needs its own tag name. |
| C. Regenerate it in CI from the GitHub gists API | It is always current. | It needs a token, it is not reproducible (gists change), and it adds network and rate limits to every build. |
| D. Leave gists out of the release pack | Nothing to build. | It loses the gist coverage the prototype measured. |

## Not F04, but also waiting on the lead

- The answer gate's frozen question set (`rail.json answerGate.questionSetSha256`) and the F16 owner
  items:
  - proof that the judge is an independent model;
  - the polarity of the false-claim substring cap.
- The `gate-result` schema tightening (making `questionSet`, `layers`, `reasons` and `resultSha256`
  required) was not applied. It is not additive. The one producer already writes all four, and
  `evidence.mjs` already refuses a result without them, so the tightening is safe whenever the lead
  wants it.

---

# DECISIONS (programme lead, 2026-11-17, 9:36 p.m. ET)

Each decision is final for the build unless the owner overrules it. None of them has been executed:
no key was generated, nothing was published, scheduled, unregistered or dispatched. Items marked
OWNER ACT need one action or one sentence of authority from the owner; everything else is code or
configuration the builders can do.

## D-Q1. Signing key: option A, with a second, offline recovery key trusted from the first release

- **Decision.** Two Ed25519 keys. The RELEASE key signs every release; its private half lives only in
  the GitHub environment secret `RUVNET_BRAIN5_SIGNING_KEY` of the environment `v5-release`, which is
  restricted to branches `release/5.*`. The RECOVERY key's private half never enters CI or any
  service; it exists only as an encrypted offline backup. Both PUBLIC keys are committed
  (`packages/contract/keys/release-public.pem`, `recovery-public.pem`), and the shim trusts a release
  signed by either. A release signed by the recovery key may replace the release key.
- **Why.** A is what the rail already expects and adds no service to the signing step. Its one real
  weakness is that a lost or leaked CI key can only be replaced by a release signed with that same
  key; a recovery key that was trusted from day one removes that trap for the cost of one small
  change (a list of two trusted keys instead of one, with a test and a break for each: a
  recovery-signed release is accepted; any third key is refused). KMS (B) and keyless signing (C)
  both change the offline install path or add an outside dependency to every release; neither is
  justified at this volume.
- **Code.** `trustedPublicKey()` becomes `trustedPublicKeys()`; verification passes when either key
  verifies; the release record says which key signed. The written re-key procedure goes into
  CONTRIBUTING.md (the only rulebook), not into a second document.
- **OWNER ACT (one sentence of authority).** Key generation is a security decision on the owner's
  machine and falls under his standing rule that nothing touching keys or secrets happens without his
  explicit approval in the session. On his word, the release owner generates both keys with
  `openssl genpkey -algorithm ed25519`, pipes the release private key straight into
  `gh secret set RUVNET_BRAIN5_SIGNING_KEY --env v5-release` from standard input (never echoed, never
  left on disk unencrypted), stores both private keys encrypted with SOPS + age in the owner's
  secrets store (his standard), commits the two public keys, and proves it with a seal and verify
  round trip in CI. The macOS Keychain is not used.

## D-Q2. npm: same name, `next` first (option B), then `latest` (option A's end state); one publisher per line

- **Decision.** Version 5 is `ruvnet-brain@5.0.0` under the dist-tag `next` for the whole soak;
  `latest` stays on 4.7.x. After the soak passes, `latest` moves to 5.x and 4.7 hotfixes continue from
  a branch `maint-4.7` under the dist-tag `legacy`. No new package name.
- **Why.** One name keeps every document, skill, hook and `npx ruvnet-brain` working, and the tag
  gives a rollback that is a tag move, not a new release. A new name (C) would require every user to
  act, which defeats the unattended migration.
- **What the npm tarball contains.** The app only. The pack (2.09 GB raw, about 0.5 GB compressed)
  is far over what npm accepts, so it is always fetched from the release channel of D-Q3 and
  verified against the signed release file.
- **Publisher.** `packages/release/promote.mjs` is the one publisher of the version 5 line;
  `scripts/release.mjs` stays the one publisher of the 4.7 line. `scripts/release-authority.mjs`
  learns "exactly one canonical publisher per line, and a publisher may publish only its own line"
  (4.7: versions below 5 from `main` or `maint-4.7`; v5: versions 5 and above from `release/5.*`),
  with a unit test and a break. The dist-tag move at the end of the soak is a named operation of that
  same publisher, gated like a release. Reason for not routing v5 through `scripts/release.mjs`: that
  script embodies the 4.7 gates and would have to import the v5 rail to seal a v5 tree, which makes
  the two rails depend on each other.
- **Credentials.** npm trusted publishing (the workflow's OIDC identity); no long-lived npm token is
  created or stored.

## D-Q3. Update address: GitHub Releases, with `migrate: false` until the soak passes (option A)

- **Decision.** The default update address is the repository's GitHub Releases under the tag prefix
  `brain5-`. Every release file carries the signed `migrate` field; it is `false` in every release
  until the soak has passed and is then set to `true` by an ordinary signed release. It can be set
  back to `false` by the next release.
- **Why.** Turning unattended migration on for every 4.7 user is the single most consequential act of
  the cutover; making it a signed field means it goes through the same gates as code and has a brake.
  npm cannot carry the pack (B), and "no default" (C) means the 4.7 nightly rail must live for ever.
- **Code still needed.** Something must READ the field: the 4.7 side needs one bridge release
  (4.7.x, through the 4.7 rail) whose `--update` looks at the newest `brain5-` release, verifies its
  signature with the committed public keys, and migrates only when `migrate` is true; otherwise it
  behaves exactly as today.

## D-Q4. Migration

1. **Private stores: B, with C during the soak.** Migration never converts, copies or deletes a
   private store. It lists every private store it found (by neutral label and location) and leaves
   it in the 4.7 home, where 4.7 keeps serving it while both versions are installed. A v5 private
   pack is made only by an explicit command, `ruvnet-brain private add <source folder>
   --project <folder>`, which builds an `access: "private"` pack from sources the user points at.
   Why: conversion at migration (A) needs the original sources to be present and would move private
   text unattended; the standing rule for this project is that private stores are never deleted or
   overwritten, and an explicit rebuild is the only form that cannot put private text somewhere the
   user did not choose. Consequence, stated to the user by `doctor`: until a private pack is added,
   private knowledge is searchable only through 4.7.
2. **The 03:30 job: B on the unattended path, A only on an explicit command.** The 4.7 bridge release
   of D-Q3 makes the 4.7 nightly job exit at once, with one log line, when an active v5 home exists
   and the brake is on v5. That changes nothing outside the product's own files. Unregistering the
   scheduler entry happens only when the user runs it: `ruvnet-brain migrate --apply
   --remove-4-job`, or later `ruvnet-brain cleanup-4`, and only for an entry that is byte-identical
   to what the 4.7 installer wrote (otherwise it is left and reported). `rollback-to-4` re-registers
   it. Why: changing a user's launchd, cron or Task Scheduler entries without their command is
   exactly the kind of unattended system change the owner's own rules forbid on his machine, and
   other users deserve the same.
3. **The brake: a real 4.7 search.** `rollback-to-4` first runs the structural check, then asks the
   installed 4.7 one probe question in a child process with a 180-second limit, read-only, and
   switches the host entries back only if 4.7 returned a result. If 4.7 cannot answer, the brake
   refuses, says why, and leaves v5 serving. Why: the brake exists for the moment v5 is failing; a
   structural check can pass on a 4.7 that no longer starts (the stale-runtime defect did exactly
   that), and then the user has neither. Running 4.7 code during a rollback is acceptable because
   running 4.7 is the purpose of a rollback.

## D-Q5. Rehearsals, soak, the 4.7 line

- Rehearsals are the three legs of `v5-release-candidate.yml` (clean macOS, Linux, Windows runners)
  plus one install by hand on the owner's Mac from the `next` tag. The first Windows leg is also the
  first execution of `rb5.cmd`; a failure there blocks the candidate, it is not waived.
- Soak: seven days on the owner's Mac, both versions installed, v5 registered under its own server
  name, with the health line and the push-in behaviour observed daily. Exit criteria are the
  roadmap's, plus: zero results rejected by the host for size, zero writes outside the v5 home, the
  brake exercised once in each direction.
- `maint-4.7` is created from the 4.7.30 tag before the first `release/5.*` push, and the 4.7
  preflight workflow is changed to ignore `release/5.*` (it currently matches `release/**`).

## D-G1. Gists for CI: option B, a pinned release asset under its own tag

- **Decision.** The gist passage file is published as an asset of a tag `brain5-corpus-<date>`
  (not the forbidden `corpus-sha256-*` form) and `recipe/CORPUS.json` pins its URL and sha256.
  `v5-pack-build.yml` fetches it and refuses a mismatch. The asset is produced by a maintainer
  command from the public gists API and then frozen; refreshing it is a new tag and a recipe change
  that goes through review like any other source bump.
- **Why.** Reproducible and reviewable like A, without growing the repository on every refresh and
  without the product indexing a second copy of the gists from its own repository (this repository
  is itself in the corpus). C is not reproducible. D throws away the 596 gist files the measured
  prototype used.
- **Check owed before the first asset is published.** Every gist in the file is public and authored
  by the corpus owner; anything else is dropped by the generator, with a count in the manifest. The
  4.7 product already distributes the same gists in its corpus, so this is not a new disclosure.

## Also decided

- The `gate-result` schema tightening is applied now (the four fields become required); it is safe
  for the reasons given above and removes a silent path.
- The false-claim cap keeps its present polarity (a matched forbidden claim caps the score) until the
  frozen question set exists. The judge-independence proof is produced with the first frozen set:
  the answering model and the judging model must be from different vendors, both named in the
  result file, and the judge must pass the seeded calibration (the held-out runs used a Codex judge
  that passed 19 of 20; that is the configuration to pin).

## What remains before version 5 can ship (in order; nothing below is done)

1. OWNER ACT: authority for key generation (D-Q1). Without it nothing can be sealed or installed.
2. Code from these decisions: two-key trust; the line-scoped publisher rule and `promote.mjs` as the
   v5 publisher with trusted publishing; `private add`; `--remove-4-job` and `cleanup-4`; the
   real-search brake; the corpus asset fetch; the schema tightening. Each with a test and a break.
3. The 4.7 bridge release (through the 4.7 rail, after 4.7.30): migrate-aware `--update`, a nightly
   job that stands down when v5 is active, the preflight ignoring `release/5.*`, the `maint-4.7`
   branch.
4. Remote CI green on macOS, Linux and Windows for `v5/integration` (never yet run on Linux or
   Windows; `rb5.cmd` never executed).
5. The answer gate's frozen question set pinned in `rail.json`, with thresholds in its manifest.
   OWNER DECISION: the bar for the first release. Reported from today's held-out runs with a
   calibrated judge (the lead read the result files' summaries, not every answer): the L+ recipe
   answers 42% and 33% of questions at 8 of 10 or better on two held-out sets and beats the earlier
   candidate by +14.0 [+5.6, +22.4]; guidance plans pass 3 of 100 under the strict rule and about
   half when minor errors are ignored. Nothing measured meets 93%. The gate can honestly be set as
   "not worse than 4.7.28 and not worse than the previous release" for 5.0.0, or the release can wait
   for the plan-first product the owner has now made primary. The lead's recommendation: ship 5.0.0
   to `next` under the first rule, because 4.7.28 is worse on every figure measured and loses 28% of
   its results to the host's size limit, and state the measured figures in the release notes.
6. The primary job as the owner now defines it (a newcomer's goal becomes the author's plan: pieces,
   order, first step, pitfalls; and the product speaks up unprompted): not met by any measured arm.
   It needs its own registered design, instrument and gate. It does not block 5.0.0 on `next`; it
   does block calling version 5 finished.
7. Independent review: the Codex review's findings are fixed or decided (this file). The second
   independent review, by a Claude model, stopped at the weekly limit with its work saved; it is to
   be resumed, not restarted.
8. Rehearsals and the seven-day soak (D-Q5), then the signed release with `migrate: true`, then the
   `latest` tag move. A release is dispatched by the release owner through the gates in
   CONTRIBUTING.md. None has been dispatched.
