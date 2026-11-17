Updated: 2026-11-17 19:30:00 EST | Version 1.0.0
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
