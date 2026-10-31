/* receipts.js — "What your clicks did": every change made from this page, with the state read back
   from the machine BEFORE and AFTER the click (2026-10-30).

   WHY THIS EXISTS. The owner clicked the Console's buttons and saw no evidence that they worked —
   "even if they work, they're not showing me that they've worked". Measured on an isolated Console:
   success notes were written into a slot and the very next repaint rebuilt that slot empty (Brain
   power, Brain profile, the lesson switches), an applied recommendation's panel — log AND Undo button
   — was deleted when the re-measure landed, and Settings said "Saved." over a field still reading
   "Not chosen yet".

   TWO RULES make a receipt survive anything the rest of the page does:
     1. The receipt comes from the SERVER (scripts/console-receipts.mjs): before/after are re-reads of
        the real files, never an echo of the request. GET /api/receipts serves the history, so a
        reload or a repaint cannot lose it.
     2. Inline copies are re-attached by a MutationObserver to any element marked
        `data-receipt-slot="<key>"` — so a card that rebuilds itself gets its receipt back without each
        renderer having to remember to do it.

   Loaded after app.js and uses its globals (el, postJSON, announce, TOKEN_MSG, loadState,
   recheckMachine). Nothing here asserts a state; it only displays what the server measured. */
(function () {
  'use strict';
  const KEEP_INLINE_MS = 15 * 60 * 1000;
  const kept = new Map();              // slot key -> { receipt, until }
  const keyOf = new Map();             // receipt id -> slot key it was attached to
  const revealed = new Set();          // receipt ids whose folds were opened once already
  const VERDICT = {
    changed: { chip: 'done — changed', tone: 'green' },
    'no-change': { chip: 'done — already so', tone: 'cyan' },
    unverified: { chip: 'NOT confirmed', tone: 'warn' },
    failed: { chip: 'did not complete', tone: 'warn' },
  };

  function when(at) {
    const d = new Date(at);
    if (!Number.isFinite(d.getTime())) return 'at an unknown time';
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
  }

  function render(r, { compact = false, noUndo = false } = {}) {
    const v = VERDICT[r.verdict] || { chip: r.verdict || 'unknown', tone: 'grey' };
    const rows = Array.isArray(r.facts) ? r.facts : [];
    const shown = compact ? rows.filter((f) => f.changed) : rows;
    const table = shown.length
      ? el('table', { class: 'rc-facts' },
        el('thead', {}, el('tr', {}, el('th', {}, 'What we read on your machine'), el('th', {}, 'Before'), el('th', {}, 'After'))),
        el('tbody', {}, shown.map((f) => el('tr', { class: f.changed ? 'rc-changed' : 'rc-same' },
          el('td', {}, f.fact), el('td', {}, f.before), el('td', {}, f.changed ? el('b', {}, f.after) : f.after)))))
      : el('p', { class: 'fineprint' }, rows.length ? 'Re-read after the click: nothing on your machine differs from before.' : 'No state could be read for this action.');
    const undo = el('div', { class: 'rc-undo' });
    if (noUndo || r.action === 'apply') {
      // A recommendation card carries its own Undo in its applied panel: one undo per change, so a
      // second button can never be left offering a token the first one already spent.
      if (r.ok && r.undoToken && !r.undoUsed && !noUndo) undo.append(el('span', {}, 'How to undo: use “Undo this change” on the recommendation card.'));
      else if (r.undoUsed) undo.append(el('span', {}, 'Undone — this change was reversed.'));
    } else if (r.undoSuperseded) {
      undo.append(el('span', {}, 'Undo no longer offered: the same settings were saved again after this, and undoing this one would wipe out that newer save. Use the newest receipt’s Undo.'));
    } else if (r.undoToken && !r.undoUsed && r.ok) {
      const btn = el('button', { class: 'btn btn-undo btn-sm', type: 'button' }, 'Undo this change');
      btn.addEventListener('click', () => { void undoFrom(r, btn, undo); });
      undo.append(el('span', {}, 'How to undo: '), btn);
    } else if (r.undoUsed) {
      undo.append(el('span', {}, 'Undone — this change was reversed.'));
    } else if (r.undoHow && r.ok) {
      undo.append(el('span', {}, `How to undo: ${r.undoHow}`));
    }
    return el('div', { class: `receipt rc-${r.verdict}`, 'data-receipt-id': r.id, role: 'status' },
      el('p', { class: 'rc-head' }, el('span', { class: `chip tone-${v.tone}` }, v.chip), ' ', el('b', {}, r.headline || r.title)),
      el('p', { class: 'rc-when fineprint' }, `${when(r.at)} · before and after were both read from your machine, not from this page`),
      table,
      // The console's own words are shown in full when they are short (one line) or when the action
      // failed — a refusal's reason folded away behind a click is a reason nobody reads. Long logs fold.
      r.log && (!r.ok || (!r.log.includes('\n') && r.log.length <= 240))
        ? el('p', { class: 'rc-why' }, r.ok ? '' : el('b', {}, 'Why: '), r.log)
        : r.log ? el('details', { class: 'sub rc-log' }, el('summary', {}, 'What the console logged'), el('pre', { class: 'log' }, r.log)) : null,
      undo.childNodes.length ? undo : null);
  }

  async function undoFrom(r, btn, slot) {
    btn.disabled = true; btn.textContent = 'Undoing…';
    try {
      const res = await postJSON('/api/undo', { undoToken: r.undoToken });
      const rec = res.data && res.data.receipt;
      if (res.status === 403) { slot.replaceChildren(el('span', { class: 'n-err' }, TOKEN_MSG)); return; }
      slot.replaceChildren(rec ? render(rec, { compact: true }) : el('span', {}, (res.data && res.data.log) || 'Undo answered with no receipt.'));
      announce(res.data && res.data.ok ? 'Undone. The receipt shows what changed back.' : `Undo did not complete: ${(res.data && res.data.log) || 'no reason given'}`);
      if (res.data && res.data.ok) {
        r.undoUsed = true;                         // a repaint must never offer this undo again
        const key = keyOf.get(r.id);
        if (key && rec) attach(key, rec);          // the inline slot now shows what the undo changed back
        void loadState(); void recheckMachine();
      }
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Undo this change';
      slot.append(el('span', { class: 'n-err' }, ` Could not reach the console server: ${e.message || e}`));
    }
    void refreshPanel();
  }

  function fill() {
    const now = Date.now();
    for (const slot of document.querySelectorAll('[data-receipt-slot]')) {
      const k = kept.get(slot.dataset.receiptSlot);
      if (!k || k.until < now) continue;
      if (slot.querySelector(`.receipt[data-receipt-id="${k.receipt.id}"]`)) continue;
      slot.append(render(k.receipt, { compact: false, noUndo: !!slot.closest('article.rec') }));
      // A receipt nobody can see is no receipt: a lesson switched off moves into a collapsed group, so
      // open the folds that hold this slot — ONCE per receipt, so a fold the owner later closes stays closed.
      if (!revealed.has(k.receipt.id)) {
        revealed.add(k.receipt.id);
        for (let d = slot.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true;
      }
    }
  }
  let queued = false;
  new MutationObserver(() => {
    if (queued || !kept.size) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fill(); });
  }).observe(document.documentElement, { childList: true, subtree: true });

  /** Show a server receipt next to its control (slot key) and in the history card. */
  function attach(key, receipt) {
    if (!receipt) return;
    kept.set(key, { receipt, until: Date.now() + KEEP_INLINE_MS });
    keyOf.set(receipt.id, key);
    for (const old of document.querySelectorAll(`[data-receipt-slot="${CSS.escape(key)}"] .receipt`)) {
      if (old.dataset.receiptId !== receipt.id) old.remove();   // one receipt per control: the newest
    }
    fill();
    void refreshPanel();
  }

  function panel() {
    let card = document.getElementById('card-receipts');
    if (card) return card;
    card = el('section', { class: 'card rail-prove', id: 'card-receipts', 'aria-labelledby': 'card-receipts-h' },
      el('div', { class: 'qgroup-head' },
        el('span', { class: 'card-head' },
          el('span', { class: 'stage st-prove' }, 'Prove'),
          el('h2', { id: 'card-receipts-h' }, 'What your clicks did'),
          el('span', { class: 'q' }, 'Every change made from this page, newest first — what was on your machine before the click, what is there after, and how to undo it.')),
        el('span', { class: 'chips', id: 'chips-receipts' })),
      el('div', { class: 'body', id: 'body-receipts' }, el('p', { class: 'loading-note' }, 'checking…')));
    const brain = document.getElementById('card-brain');
    if (brain) brain.after(card); else document.getElementById('main')?.prepend(card);
    return card;
  }

  let lastSignature = null;
  async function refreshPanel() {
    panel();
    const body = document.getElementById('body-receipts');
    let data;
    try { data = await getJSON('/api/receipts'); }
    catch (e) {
      body.replaceChildren(el('p', { class: 'n-err' }, `The receipt history could not be read: ${e.message || e}`));
      setChips('chips-receipts', [chip('unavailable', 'grey')]);
      return;
    }
    const list = Array.isArray(data.receipts) ? data.receipts : [];
    // Re-render only when the history actually changed: a rebuild collapses a fold the owner opened and
    // swaps elements out from under a pointer mid-click.
    const signature = list.map((r) => `${r.id}:${r.undoUsed ? 1 : 0}${r.undoSuperseded ? 's' : ''}`).join(',');
    if (signature === lastSignature && body.querySelector('.receipt, p.fineprint')) return;
    lastSignature = signature;
    setChips('chips-receipts', [chip(list.length ? `${list.length} recorded` : 'none yet', list.length ? 'green' : 'grey')]);
    if (!list.length) {
      body.replaceChildren(el('p', { class: 'fineprint' },
        'Nothing has been changed from this page yet. Every switch, Apply, Save and Undo you make will appear here with what it changed. Kept in ',
        el('code', {}, data.path || '~/.cache/ruvnet-brain/console-receipts.jsonl'), '.'));
      return;
    }
    const [first, ...rest] = list;
    body.replaceChildren(render(first),
      rest.length ? el('details', { class: 'sub' }, el('summary', {}, `Earlier changes (${rest.length})`),
        ...rest.map((r) => render(r, { compact: true }))) : null,
      el('p', { class: 'fineprint' }, 'Kept in ', el('code', {}, data.path || ''), '.'));
  }

  window.RNBReceipts = { attach, render, refreshPanel };
  void refreshPanel();
}());
