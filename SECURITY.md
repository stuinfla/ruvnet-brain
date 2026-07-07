# Security Policy

RuvNet Brain runs on your machine, downloads a knowledge bundle, and (with your consent) can update
itself — so we take reports seriously and fix them in the open. This policy exists because the project's
first security review was a private, responsible disclosure; the next reporter should have a clear path.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.** Instead:

- Use GitHub's **[private vulnerability reporting](https://github.com/stuinfla/ruvnet-brain/security/advisories/new)**
  (Security tab → "Report a vulnerability"), or
- Email the maintainer at the address on the [GitHub profile](https://github.com/stuinfla).

Include: what you found, a `file:line` or reproduction, the impact, and (if you have one) a suggested fix.
"Confirmed" reports — where you ran the exact command or read the exact line — are the most actionable.

## What to expect

- We verify every report against the real code before acting (we do not dismiss, and we do not
  rubber-stamp). Fixes are proven with a real command before they're called done.
- Each finding is tracked with a `file:line` root cause, the exact fix, and its verification — see
  [`docs/adr/0010-security-hardening-sec-0010.md`](docs/adr/0010-security-hardening-sec-0010.md) for the
  format (that ADR is the record of the first review).
- We credit reporters unless you ask us not to.

## Known, tracked security posture (honest disclosure)

- **The downloadable knowledge bundle is not yet cryptographically signed.** The installer verifies TLS
  transport but does not yet verify an Ed25519/cosign signature before extracting. The *unattended*
  code-overwrite path has been disabled (updates detect-and-notify, they do not auto-apply executable
  files); signed verify-before-extract is tracked as the next hardening step.
- **Model weights** download from HuggingFace by name on first run; a `revision`/hash pin is on the
  roadmap.
- The grounding **hooks are POSIX shell** — on native Windows without WSL/Git-Bash they don't fire (the
  `search_ruvnet` tool still works).

## Supported versions

Active development is on `main`; fixes land there first and flow to users via the plugin's update path.
The exact current version is on the badge at the top of the [README](README.md).
