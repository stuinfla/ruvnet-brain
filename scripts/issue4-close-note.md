## Fixed — and thank you

First: thank you for this report. It was precise, fully evidenced, and correct on every point — you quoted the exact claims, traced the exact files, and demonstrated the exact staleness on a clean install. Reports of this quality are rare and genuinely valuable; this one drove a same-day overhaul of the whole freshness pipeline. (Your PR #5 is under real review as well — separately, so it gets the attention it deserves.)

### What you reported, and what we changed

**1. "The nightly LaunchAgent is author-only, and even the upstream publish isn't nightly."**
Confirmed, with a root cause you couldn't have seen from outside: the author-side 3:15 AM job had been dying **every night** on `spawnSync gh ENOENT` — launchd's default `PATH` omits `/opt/homebrew/bin`, so the publish step never ran and `releases/latest` sat frozen while `main` advanced.
*Fixed in `2622c25`*: the LaunchAgent now exports its `PATH` explicitly; verified under the exact launchd environment before reload. **Proof this worked: `releases/latest` is now `__TAG__`, published `__PUB__` — by that nightly job, unattended.**

**2. "No end-user mechanism enables a per-user nightly."**
Correct — and the fix was closer than we realized: every bundle already ships a non-publishing updater (`forge-update.mjs --apply`: fetch canonical bundle → back up → extract → re-verify; loud failures, no partial clobber). What was missing was scheduling and honest wording. *Shipped in `158e888`*:
- `npx ruvnet-brain --update` — one-shot check + update of **your** install
- `npx ruvnet-brain --enable-nightly` — per-user LaunchAgent at 03:47, templated to **your** KB path, logging to `<kb>/update.log`; `--disable-nightly` reverts cleanly
- Linux/Windows: the cron pattern documented inside `forge-update.mjs` itself
- Off by default — nothing is ever scheduled on your machine unasked, and the installer now says exactly that instead of the old "auto-updating nightly? Just tell Claude" line, which promised something that never got scheduled. The README carries the same honest wording.

**3. "The deck's 'never goes stale / CURRENT · last rebuild · last night' doesn't match reality."**
You were right, and the deck itself was the problem — a stale deploy that should not have remained live. It hasn't been softened; it's been **retired**: `deck-six-liart.vercel.app` now permanently redirects (308) to the canonical explainer at https://isovision.ai/ruvnet-brain/, whose claims are the ones we deploy-verify.

### On your machine
```
npx ruvnet-brain --update            # pulls the fresh bundle now
npx ruvnet-brain --enable-nightly    # optional: 03:47 nightly, non-publishing, easy to disable
```

If your install still lags after `--update`, please reopen — that would be a new bug and we want it.

Thanks again. The grounding idea only works if the ground is current; you made that true for everyone downstream.
