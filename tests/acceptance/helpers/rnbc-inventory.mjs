// rnbc-inventory.mjs — enumerate EVERY interactive element on a console page and give each one a
// semantic key, so a click-everything test can prove it handled every element (RNBC QA 2026-10-01).
//
// "Interactive" is deliberately wide: anything focusable or clickable by a person — links, buttons,
// inputs, summaries, ARIA buttons/switches, positive tabindex — PLUS any element whose computed cursor
// is `pointer` and that is not inside one of those (a clickable <div> is still a control). An element
// the classifier cannot name gets the key `UNCLASSIFIED:…`, which the test treats as a failure: an
// element with no rule is an element nobody has said what it does.
import fs from 'node:fs';
import path from 'node:path';

/** Runs IN THE PAGE. Returns [{ key, tag, text, visible, disabled, href }]. */
export function inventoryInPage(pageName) {
  const SEL = 'a[href], button, input, select, textarea, summary, [role="button"], [role="switch"], [role="tab"], [tabindex]:not([tabindex="-1"])';
  const base = [...document.querySelectorAll(SEL)];
  const inBase = (el) => base.some((b) => b !== el && b.contains(el));
  const pointer = [...document.querySelectorAll('body *')].filter((el) => {
    if (base.includes(el) || inBase(el) || base.some((b) => el.contains(b))) return false;
    const cs = getComputedStyle(el);
    if (cs.cursor !== 'pointer') return false;
    const parent = el.parentElement;
    return !(parent && getComputedStyle(parent).cursor === 'pointer'); // the outermost pointer region only
  });
  const txt = (el) => (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 90);
  const card = (el) => el.closest('[id^="card-"],[id^="group-"]')?.id || (el.closest('header') ? 'header' : 'page');
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

  function classify(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id;
    const cls = typeof el.className === 'string' ? el.className : '';
    const href = el.getAttribute('href');
    const t = txt(el);
    const c = card(el);
    if (tag === 'a' && cls.includes('skip-link')) return 'link:skip';
    if (tag === 'a' && href && /^https?:\/\//.test(href)) return `extlink:${c}:${href}`;
    if (tag === 'a' && href === '#' && id) return `link:${id}`;
    if (tag === 'a' && href && href.startsWith('#')) return `anchor:${href}`;
    if (tag === 'a' && href) return `link:${c}:${href.split('?')[0]}:${slug(t)}`;
    if (id === 'suite-update-run') return 'btn:suite-update';
    if (id === 'suite-update-channel') return 'select:suite-update-channel';
    if (tag === 'label' && el.htmlFor === 'suite-update-channel') return 'label:suite-update-channel';
    if (id === 'brain-update') return 'btn:update-gong';
    if (id === 'freshness-pill') return 'btn:freshness';
    if (id === 'recheck-btn') return 'btn:recheck';
    if (id === 'theme-toggle') return 'btn:theme';
    if (cls.includes('bp-switch')) return 'btn:bp-switch';
    if (tag === 'input' && el.name === 'brain-profile') return `radio:profile:${el.value}`;
    if (tag === 'button' && el.closest('.bp-profile-actions')) return 'btn:profile-apply';
    if (tag === 'button' && el.closest('#bp-confirm-slot')) return `btn:bp-confirm:${slug(t)}`;
    if (tag === 'summary') {
      const d = el.closest('details');
      const owner = d?.id || el.closest('[id^="rec-"]')?.id || el.closest('.lesson-row') && `lesson-${el.closest('.lesson-row').querySelector('.lesson-switch')?.id}` || '';
      // counts in a summary ("The 3 rules already in force") change as the page is used; the key must not
      return `summary:${c}:${owner}:${slug(t.replace(/\d+/g, 'n').replace(/\brules\b/gi, 'rule').replace(/\brecords\b/gi, 'record')).slice(0, 40)}`;
    }
    if (cls.includes('info-btn')) return `info:${c}:${slug(el.getAttribute('aria-label') || t)}`;
    if (tag === 'input' && cls.includes('inv-filter')) return 'input:inv-filter';
    if (tag === 'input' && cls.includes('lesson-switch')) return `checkbox:lesson:${id.replace(/^lsw-/, '')}`;
    if (tag === 'input' && cls.includes('cap-toggle')) return `checkbox:cap:${id}`;
    if (tag === 'input' && el.type === 'radio' && el.name.startsWith('seg-')) return `radio:${el.name.slice(4)}:${el.value}`;
    if (tag === 'input' && el.type === 'checkbox' && el.closest('.field')) return `checkbox:setting:${el.closest('.field').id.replace(/^field-/, '')}`;
    if (tag === 'input' && el.closest('.secret-input-row')) return 'input:secret';
    if (tag === 'button' && (el.closest('.secret-input-row') || el.closest('.secret-set-row'))) return `btn:secret:${slug(t)}`;
    if (tag === 'button' && el.type === 'submit' && el.closest('form.settings-form')) {
      const forms = [...document.querySelectorAll('form.settings-form')];
      return `btn:save:${forms.indexOf(el.closest('form'))}`;
    }
    if (tag === 'button' && cls.includes('btn-undo') && el.closest('form.settings-form')) return `btn:save-undo:${[...document.querySelectorAll('form.settings-form')].indexOf(el.closest('form'))}`;
    if (tag === 'button' && el.closest('#recs-batch')) return `btn:fixall:${slug(t).replace(/-\d+$/, '')}`;
    if (tag === 'button' && el.closest('article.rec')) return `btn:rec:${el.closest('article.rec').id}:${slug(t)}`;
    if (tag === 'button' && cls.includes('plan-action')) return `jump:plan:${slug(t)}`;
    if (tag === 'button' && (cls.includes('mh-enable') || el.closest('.mh-cta'))) return `btn:routing-cta:${slug(t)}`;
    if (tag === 'button' && cls.includes('adv-opt')) return `btn:adv:${slug(t)}`;
    if (tag === 'button' && cls.includes('cap-setting-jump')) return `jump:cap-setting:${el.closest('.cap-row')?.querySelector('.cap-name')?.firstChild?.textContent || ''}`;
    if (tag === 'button' && cls.includes('btn-fix')) return `jump:fix:${slug(t)}`;
    if (tag === 'button' && el.closest('.bp-parts')) return `jump:bp-parts:${slug(t)}`;
    if (tag === 'button' && /take me to it/i.test(t)) return 'jump:to-brain';
    if (tag === 'button' && /try again/i.test(t)) return `btn:retry:${c}`;
    if (id === 'ab-doorClose') return 'btn:door-close';
    if (cls.includes('ab-stat')) return `door:${id}`;
    if (cls.includes('ab-flow-hit')) return `door:${id}`;
    if (cls.includes('ab-row') && cls.includes('ab-lesson')) return `row:ab-lesson:${slug(t).slice(0, 30)}`;
    if (cls.includes('ab-chip') || cls.includes('ab-flow')) return `pointer:${slug(cls)}`;
    if (cls.includes('seg-lab')) { const i = el.closest('label')?.querySelector('input'); return `seglabel:${(i?.name || '').replace(/^seg-/, '')}:${i?.value}`; }
    if (tag === 'button' && cls.includes('view') && el.dataset.view) return `btn:scope-view:${el.dataset.view}`;
    if (tag === 'input' && id === 'search') return 'input:scope-search';
    if (tag === 'th' && el.dataset.key) return `th:scope-sort:${el.closest('table')?.id}:${el.dataset.key}`;
    if (tag === 'button' && /expand all|collapse all/i.test(t)) return 'btn:tips-expand-all';
    if (cls.includes('depth-head')) return `toggle:tips-depth:${slug(t).slice(0, 24)}`;
    if (tag === 'input' && el.type === 'checkbox' && el.closest('.row')) return `checkbox:mockup:${slug(el.closest('.row').innerText).slice(0, 30)}`;
    if (tag === 'button' && pageName === 'install-mockup.html') return `btn:mockup:${slug(t).replace(/-\d+-selected$/, '')}`;
    return `UNCLASSIFIED:${pageName}:${tag}.${slug(cls)}:${slug(t).slice(0, 30)}`;
  }

  const all = [...base.map((el) => ({ el, via: 'focusable' })), ...pointer.map((el) => ({ el, via: 'cursor-pointer' }))];
  const seen = new Map();
  return all.map(({ el, via }) => {
    let key = classify(el);
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (n > 1) key = `${key}#${n}`;
    const r = el.getBoundingClientRect();
    el.setAttribute('data-qa-key', key);
    return {
      key, via, tag: el.tagName.toLowerCase(), text: txt(el), href: el.getAttribute('href'),
      visible: !!(r.width || r.height), disabled: !!el.disabled, card: card(el),
    };
  });
}

/** Markdown ledger: one row per element, with the claim, the action, what was observed, a verdict. */
export function writeLedger(file, { rows, meta }) {
  const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 220);
  const counts = rows.reduce((acc, r) => { acc[r.verdict] = (acc[r.verdict] || 0) + 1; return acc; }, {});
  const lines = [
    '# RNBC coverage ledger',
    '',
    `Generated by \`tests/acceptance/rnbc-every-element.acceptance.test.mjs\` against an ISOLATED console (fixture HOME, two-store fixture KB — no private data), installed the way a customer gets it: \`npm pack\` → \`installConsoleRuntime()\` → \`<brainHome>/.console-runtime\`. ${meta.generatedAt}.`,
    '',
    `Elements found: **${meta.found}** · rows: **${rows.length}** · ${Object.entries(counts).map(([k, v]) => `${k}: **${v}**`).join(' · ')}`,
    '',
    'Verdicts: PASS = the action produced the stated effect (DOM + network + persisted state + consumer where one exists). FAIL = it did not. INERT = the element does nothing and is labelled as a preview/indicator. NOT-RENDERED = present in markup but hidden in this state (reason given).',
    '',
    '| # | page | element (semantic key) | what the UI says | action | observed | verdict |',
    '|---|---|---|---|---|---|---|',
    ...rows.map((r, i) => `| ${i + 1} | ${esc(r.page)} | \`${esc(r.key)}\` | ${esc(r.claim)} | ${esc(r.action)} | ${esc(r.observed)} | ${r.verdict} |`),
    '',
  ];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n'));
}
