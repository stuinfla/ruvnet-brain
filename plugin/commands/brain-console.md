---
description: "Brain Console — RuvNet Brain Console (same console as /rvbc, /brain-console, and /ruvnet-brain:configure — every spelling works). Opens the live console page: your whole RuvNet stack on one page. Read-only until you click."
updated: 2026-07-20
---

Launch the **RuvNet Brain Console** for the user. Same console as `/ruvnet-brain:configure`,
`/rvcb`, and `/brain-console` — every spelling lands here, so never tell the user they typed it wrong.

## The contract you are keeping

The page **opens immediately and scans itself while they watch.** The server never blocks: a cold or
new-project read is answered in milliseconds with "measuring…", the page keeps its skeletons and
narrates the wait, and each card fills in as its own measurement lands. A chip in the header says how
old the picture is and re-measures when clicked.

So there is nothing to wait for and nothing to warn them about. **Your entire job is: say one
sentence, start the server in the background, hand over the URL, and get out of the way.**

## 1. SPEAK FIRST — one short sentence, before any tool call

Your FIRST output — before any tool call, any file read, any search — is one warm line saying you are
opening it now and it will scan itself live in their browser. Something in the spirit of:

> "Opening your console now — it'll come up right away and scan your setup live while you watch."

Say it like a person, not a status bar. **Do not** promise 20 seconds, a minute, or any duration: the
page carries its own timing now, and a number invented here is a number the page will contradict.

## 2. Find the installed runtime

Use `${RUVNET_BRAIN_KB:-$HOME/.cache/ruvnet-brain/kb}/.console-runtime/scripts/onboarding-console.mjs`.
A current-repository copy is allowed only in an explicit developer checkout. Never guess a
`~/Code/ruvnet-brain` path: the installer persists this runtime for clean users.

## 3. Start it in the BACKGROUND and open the browser

```
node <repo>/scripts/onboarding-console.mjs --serve --open
```

**`run_in_background: true`, ALWAYS — never in the foreground.** This is a server: it does not exit,
so a foreground run hangs the tool call until the 120-second timeout and turns an instant page into
two minutes of dead air. It binds `127.0.0.1` only and prints `http://127.0.0.1:7411/` within about a
third of a second.

**Then post the URL immediately.** Do not poll the log, do not wait for a scan, do not check whether
the data has landed — the page reports its own progress and none of it is visible from here.

**If it reports it is already running**, that is a success, not an error: open the URL yourself with
`open "http://127.0.0.1:<port>/"`. One honest caveat, worth half a sentence if it comes up — a
console that is already running is serving the project it was *launched* from, so if they want this
project's view they can stop that one (`^C` in its terminal) and run this again.

## 4. Hand it over and stop

Give them the URL as a clickable line, and one warm sentence: the page is **read-only until you
click**, every machine change is **explained first and reversible**, and Settings save at the user
level only. Worth naming once: the brain's on/off switch is the first card on the page, and the
header chip says how fresh the reading is and re-measures if they click it.

## 5. If it errors

Report it plainly — the real error, not a guess — and offer to fix it. Never leave them staring at
a dead tab wondering whether it is still loading.

---

## Things NOT to do before the page is open

Each of these has cost a real user real minutes of silence, and not one of them is needed to open a
local web page:

- **No knowledge search, no memory recall, no source grounding, no repo exploration.** A cold
  embedding-model load alone is allowed up to 180 seconds.
- **No model selection or routing work.**
- **No reading this repo to "check" anything first.** Find the script, run it.

Do **not** narrate the machine yourself afterwards; the page is the mirror. Your job is to open it,
say one sentence, and get out of the way.
