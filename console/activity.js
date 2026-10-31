/* ============================================================================
   RUVNET BRAIN — ONBOARDING CONSOLE · "Brain activity" card
   ----------------------------------------------------------------------------
   Self-contained module: renders the approved glass-brain activity panel
   inside #body-activity, fed by GET /api/activity (live AgentDB state).
   All CSS is injected scoped under #card-activity. Design tokens (colors,
   fonts, radii) come from style.css — nothing is redefined here.
   Graceful degrade: fetch failure or hasStore:false → one calm line.
   ============================================================================ */
(function () {
  'use strict';

  /* #499: every figure this card shows, as display text. A value that could not be read (null /
     undefined / non-numeric) is the word "Unknown" — never 0, which would claim the store is empty.
     Pure and published on the global before the DOM guard below so a test can load this file without a
     page. nMem/nLes/nMachine are numeric (unknown -> 0) for the animation maths only; never display them. */
  function activityFigures(d) {
    function known(v) { return typeof v === 'number' && isFinite(v); }
    function show(v) { return known(v) ? Number(v).toLocaleString('en-US') : 'Unknown'; }
    function num(v) { return known(v) ? v : 0; }
    d = d || {};
    var t = d.totals || {};
    var ag = known(t.agentdbLessons) ? t.agentdbLessons : t.lessons;
    var ap = d.approvedLessons && d.approvedLessons.available === true ? d.approvedLessons.count : null;
    var mach = d.machine && d.machine.totalMemories;
    var apx = d.approvedLessons && d.approvedLessons.available === true ? d.approvedLessons.applicable : null;
    return {
      memories: show(t.memories), agentdbLessons: show(ag), lessons: show(ag),
      approvedLessons: show(ap), approvedMachine: show(ap), approvedApplicable: show(apx),
      // Stores the scan could not read are not zero: the readable sum is a floor, said as one.
      machine: known(mach) && d.machine && d.machine.unreadableStores > 0 ? show(mach) + '+' : show(mach),
      observations: show(t.observations), patterns: show(t.patterns), episodes: show(t.episodes),
      approvedAvailable: known(ap), agentdbKnown: known(ag),
      nMem: num(t.memories), nLes: num(ag), nMachine: num(mach)
    };
  }
  (typeof globalThis !== 'undefined' ? globalThis : this).activityFigures = activityFigures;

  function escText(v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  /* #499: the approved lessons that apply to this project, with the approval / scope / enforcement the owner
     set — rendered from the server's own bounded list. Pure; an unreadable lesson store says Unknown. */
  function approvedLessonsHTML(d) {
    var a = d && d.approvedLessons;
    if (!a || a.available !== true) return '<p class="ab-fallback">Approved lessons: Unknown (the lesson store could not be read).</p>';
    var items = Array.isArray(a.items) ? a.items : [];
    var F = activityFigures(d);
    var head = '<div class="ab-dl-title"><span class="ab-g">✦</span>' + F.approvedApplicable + ' approved lessons apply to this project · ' + F.approvedMachine + ' approved machine-wide</div>';
    if (!items.length) return head + '<p class="ab-fallback">None of your approved lessons are scoped to this project.</p>';
    return head + items.map(function (l) {
      return '<div class="ab-lrow"><b>' + escText(l.id) + '</b> ' + escText(l.title) +
        ' <span class="ab-lmeta">scope: ' + escText(l.scope) + ' · enforcement: ' + escText(l.enforcement == null ? 'unknown' : l.enforcement) +
        ' · ' + (l.ratified ? 'ratified by you' : escText(l.status || 'not ratified')) + '</span></div>';
    }).join('') + (a.itemsTruncated ? '<p class="ab-fallback">…showing the first ' + items.length + ' of ' + F.approvedApplicable + '.</p>' : '');
  }
  (typeof globalThis !== 'undefined' ? globalThis : this).activityApprovedHTML = approvedLessonsHTML;

  /* #500: which machine-wide row is "you". By STORE IDENTITY (the server's projectId against each fleet entry's
     id), never by folder name — two unrelated repos can both be called "app". No identity on either side means
     no match (the row is then synthesised from this project's own totals), not a guess from the name. */
  function activityUniverse(d) {
    d = d || {};
    var machine = d.machine || {};
    var projects = (Array.isArray(machine.projects) ? machine.projects.slice() : [])
      .sort(function (a, b) { return (b.memories || 0) - (a.memories || 0); });
    var isMe = function (p) { return !!d.projectId && p.id === d.projectId; };
    var found = projects.filter(isMe)[0] || null;
    var others = projects.filter(function (p) { return !isMe(p); });
    return { projects: projects, me: found, others: others.slice(0, 12), more: Math.max(0, others.length - 12) };
  }
  (typeof globalThis !== 'undefined' ? globalThis : this).activityUniverse = activityUniverse;

  /* #499: the rolling narration, from each pipeline stage's OWN measurement. Distillation turns observations
     into patterns and episodes; it does not write lessons — lessons are ratified by the owner. */
  function activityNarration(d) {
    var F = activityFigures(d);
    var lines = [
      'Your AI captures everything as it works — ' + F.memories + ' memories in this project so far.',
      'Learning pipeline in this project: ' + F.observations + ' workflow observations, ' + F.patterns + ' structural patterns, ' + F.episodes + ' episodes.',
      'Observations are distilled in the background (session end or compaction, when learning is on) into patterns and episodes — not into lessons.',
      F.approvedApplicable + ' approved lessons apply here (' + F.approvedMachine + ' machine-wide). You ratify lessons; nothing is auto-approved.'
    ];
    if (F.agentdbKnown) lines.push(F.agentdbLessons + ' AgentDB lesson records in this project.');
    else lines.push('AgentDB lesson records: Unknown.');
    lines.push('Click any number above to see exactly what it knows.');
    return lines;
  }
  (typeof globalThis !== 'undefined' ? globalThis : this).activityNarration = activityNarration;

  var CARD = document.getElementById('card-activity');
  var BODY = document.getElementById('body-activity');
  if (!CARD || !BODY) return;

  /* ------------------------- scoped styles ------------------------- */
  var CSS = [
    /* stat row (tiles are doors) */
    '#card-activity .ab-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:16px 0 4px}',
    '#card-activity .ab-stat{background:var(--surface-2);border:1px solid var(--ridge);border-radius:12px;padding:9px 14px 8px}',
    '#card-activity .ab-stat .ab-n{font-family:var(--mono);font-size:25px;line-height:1.15;color:var(--ink);font-weight:500;font-variant-numeric:tabular-nums}',
    '#card-activity .ab-stat .ab-l{font-size:13px;color:var(--ink-2);margin-top:1px}',
    '#card-activity .ab-stat.ab-door{cursor:pointer;position:relative;transition:border-color .18s,background .18s}',
    '#card-activity .ab-stat.ab-door:hover{border-color:color-mix(in srgb,var(--amber) 60%,var(--ridge))}',
    '#card-activity .ab-stat.ab-door:hover .ab-l{text-decoration:underline;text-underline-offset:3px;text-decoration-color:var(--faint)}',
    '#card-activity .ab-stat.ab-door:focus-visible{outline:2px solid var(--amber);outline-offset:2px}',
    '#card-activity .ab-stat.ab-door .ab-tchev{position:absolute;top:7px;right:10px;font-size:12px;color:var(--muted);transition:transform .25s,color .15s}',
    '#card-activity .ab-stat.ab-door .ab-hint{position:absolute;top:8px;right:26px;font-size:13px;color:var(--muted);opacity:0;transition:opacity .15s;white-space:nowrap;pointer-events:none}',
    '#card-activity .ab-stat.ab-door .ab-hint::after{content:"click to open"}',
    '#card-activity .ab-stat.ab-door.ab-on .ab-hint::after{content:"click to close"}',
    '#card-activity .ab-stat.ab-door:hover .ab-hint{opacity:1}',
    '#card-activity .ab-stat.ab-door:hover .ab-tchev{color:var(--amber-text)}',
    '#card-activity .ab-stat.ab-door.ab-on{border-color:var(--amber);background:color-mix(in srgb,var(--amber) 14%,transparent)}',
    '#card-activity .ab-stat.ab-door.ab-on .ab-tchev{transform:rotate(90deg);color:var(--amber-text)}',
    /* doors drawer */
    '#card-activity .ab-doors{display:grid;grid-template-rows:0fr;transition:grid-template-rows .35s ease}',
    '#card-activity .ab-doors.ab-open{grid-template-rows:1fr}',
    '#card-activity .ab-doors-clip{overflow:hidden}',
    '#card-activity .ab-door-box{background:var(--surface-2);border:1px solid var(--ridge);border-radius:12px;margin:10px 0 2px}',
    '#card-activity .ab-door-head{display:flex;align-items:baseline;gap:10px;padding:12px 16px 9px;border-bottom:1px solid color-mix(in srgb,var(--ridge) 60%,transparent)}',
    '#card-activity .ab-door-head .ab-t{font-family:var(--display);font-size:15.5px;font-weight:600;color:var(--ink)}',
    '#card-activity .ab-door-head .ab-s{font-size:13px;color:var(--muted)}',
    '#card-activity .ab-door-close{margin-left:auto;background:none;border:1px solid var(--ridge);border-radius:8px;color:var(--muted);cursor:pointer;font:13px var(--sans);padding:3px 9px}',
    '#card-activity .ab-door-close:hover{color:var(--ink);border-color:var(--amber)}',
    '#card-activity .ab-door-view{display:none;padding:10px 16px 14px;max-height:520px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:var(--ridge) transparent}',
    '#card-activity .ab-door-view.ab-active{display:block}',
    '#card-activity .ab-door-view::-webkit-scrollbar{width:8px}',
    '#card-activity .ab-door-view::-webkit-scrollbar-thumb{background:var(--ridge);border-radius:4px}',
    '#card-activity .ab-door-foot{font-size:13px;color:var(--muted);margin-top:10px;padding-top:8px;border-top:1px solid color-mix(in srgb,var(--ridge) 55%,transparent)}',
    '#card-activity .ab-door-foot .mono{font-size:13px;color:var(--ink-2)}',
    /* lessons door */
    '#card-activity .ab-dl-title{font-size:13.5px;font-weight:600;color:var(--amber-text);margin:8px 0 0}',
    '#card-activity .ab-dl-title .ab-g{color:var(--amber);margin-right:7px}',
    '#card-activity .ab-door-view .ab-lesson-card{margin:6px 0 14px;background:var(--surface)}',
    /* memories-breakdown door */
    '#card-activity .ab-krow{display:grid;grid-template-columns:162px 210px 58px 1fr;gap:12px;align-items:center;padding:3.5px 0}',
    '#card-activity .ab-krow .ab-kn{font-family:var(--mono);font-size:13px;color:var(--ink-2)}',
    '#card-activity .ab-krow .ab-kbar{height:8px;border-radius:4px;background:color-mix(in srgb,var(--ridge) 50%,transparent);overflow:hidden}',
    '#card-activity .ab-krow .ab-kbar i{display:block;height:100%;background:var(--amber);border-radius:4px}',
    '#card-activity .ab-krow .ab-kc{font-family:var(--mono);font-size:13px;color:var(--ink);text-align:right;font-variant-numeric:tabular-nums}',
    '#card-activity .ab-krow .ab-kg{font-size:13px;color:var(--ink-2)}',
    /* universe door */
    '#card-activity .ab-urow{display:grid;grid-template-columns:252px 1fr 76px;gap:12px;align-items:center;padding:3.5px 0}',
    '#card-activity .ab-urow .ab-un{font-family:var(--mono);font-size:13px;color:var(--ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#card-activity .ab-urow .ab-ubar{height:8px;border-radius:4px;background:color-mix(in srgb,var(--ridge) 50%,transparent);overflow:hidden}',
    '#card-activity .ab-urow .ab-ubar i{display:block;height:100%;background:var(--cyan);border-radius:4px;opacity:.8}',
    '#card-activity .ab-urow .ab-uc{font-family:var(--mono);font-size:13px;color:var(--ink);text-align:right;font-variant-numeric:tabular-nums}',
    '#card-activity .ab-urow.ab-me .ab-un,#card-activity .ab-urow.ab-me .ab-uc{color:var(--amber-text);font-weight:600}',
    '#card-activity .ab-urow.ab-me .ab-ubar i{background:var(--amber);opacity:1}',
    '#card-activity .ab-umore{font-size:13px;color:var(--muted);padding:6px 0 0}',
    /* distillation flow strip (84px animation zone + 24px narration bar) */
    '#card-activity .ab-flow{position:relative;height:108px;margin:12px 0 0;border:1px solid var(--ridge);border-radius:12px;background:var(--surface-2);overflow:hidden}',
    '#card-activity .ab-flow canvas{position:absolute;top:0;left:0;width:100%;height:84px;display:block}',
    '#card-activity .ab-flow-label{position:absolute;bottom:31px;font-size:13px;color:var(--ink-2);pointer-events:none;z-index:2}',
    '#card-activity .ab-flow-label .mono{font-size:13px}',
    '#card-activity .ab-flow-label.ab-left{left:14px}',
    '#card-activity .ab-flow-label.ab-gate{left:54%;transform:translateX(-50%);color:var(--amber-text);font-size:13px;letter-spacing:.1em}',
    '#card-activity .ab-flow-label.ab-right{right:14px}',
    '#card-activity .ab-flow-hit{position:absolute;top:0;bottom:24px;z-index:1;cursor:pointer}',
    '#card-activity .ab-flow-hit.ab-left{left:0;width:52%}',
    '#card-activity .ab-flow-hit.ab-right{left:52%;right:0}',
    '#card-activity .ab-flow-hit:hover{background:color-mix(in srgb,var(--amber) 5%,transparent)}',
    '#card-activity .ab-flow-hit:focus-visible{outline:2px solid var(--amber);outline-offset:-2px}',
    /* rolling narration */
    '#card-activity .ab-flow-narr{position:absolute;left:14px;right:14px;bottom:0;height:24px;z-index:2;display:flex;align-items:center;justify-content:center;gap:10px;pointer-events:none}',
    '#card-activity .ab-fn-text{font-family:var(--display);font-style:italic;font-size:13.5px;color:var(--ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:1;transition:opacity .55s ease}',
    '#card-activity .ab-fn-steps{flex:none;font-size:11px;letter-spacing:3px;line-height:1;color:var(--faint)}',
    '#card-activity .ab-fn-steps .ab-on{color:var(--amber-text)}',
    /* vocabulary + receipt */
    '#card-activity .ab-vocab{font-size:13px;color:var(--ink-2);margin:9px 2px 0}',
    '#card-activity .ab-vocab b{color:var(--ink);font-weight:600}',
    '#card-activity .ab-empty-note{font-size:13px;color:var(--muted);margin:8px 2px 2px;font-style:italic}',
    /* roster strip */
    '#card-activity .ab-roster{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:10px 0 8px}',
    '#card-activity .ab-roster .ab-who{font-size:13px;color:var(--muted);margin-right:2px}',
    '#card-activity .ab-rchip{font:13px var(--mono);color:var(--ink-2);border:1px solid var(--ridge);background:var(--surface-2);border-radius:999px;padding:3px 11px;cursor:default;transition:border-color .15s,color .15s}',
    '#card-activity .ab-rchip:hover{border-color:var(--amber);color:var(--ink)}',
    '#card-activity .ab-rchip .ab-k{color:var(--faint);margin-left:6px}',
    '#card-activity .ab-rchip .ab-cs{color:var(--muted);margin-left:6px;font-size:13px}',
    /* feed */
    '#card-activity .ab-feed{border-top:1px solid var(--ridge);max-height:252px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:var(--ridge) transparent;transition:max-height .3s ease;margin-top:8px}',
    '#card-activity .ab-feed.ab-expanded{max-height:460px}',
    '#card-activity .ab-feed::-webkit-scrollbar{width:8px}',
    '#card-activity .ab-feed::-webkit-scrollbar-thumb{background:var(--ridge);border-radius:4px}',
    '#card-activity .ab-rowwrap{border-bottom:1px solid color-mix(in srgb,var(--ridge) 55%,transparent)}',
    '#card-activity .ab-row{display:grid;grid-template-columns:112px 20px 1fr auto;gap:10px;align-items:baseline;padding:6.5px 6px 6.5px 2px;transition:opacity .18s}',
    '#card-activity .ab-row .ab-ts{font-family:var(--mono);font-size:13px;color:var(--muted);white-space:nowrap}',
    '#card-activity .ab-row .ab-glyph{font-size:13px;text-align:center}',
    '#card-activity .ab-row .ab-glyph.ab-amber{color:var(--amber-text)}',
    '#card-activity .ab-row .ab-glyph.ab-cyan{color:var(--cyan-text)}',
    '#card-activity .ab-row .ab-glyph.ab-green{color:var(--green-text)}',
    '#card-activity .ab-row .ab-txt{font-size:13.5px;color:var(--ink-2)}',
    '#card-activity .ab-badge{font:13px var(--mono);color:var(--muted);border:1px solid var(--ridge);border-radius:6px;padding:1px 7px;white-space:nowrap}',
    '#card-activity .ab-feed.ab-spot .ab-row{opacity:.3}',
    '#card-activity .ab-feed.ab-spot .ab-row.ab-lit{opacity:1}',
    '#card-activity .ab-row.ab-lesson{cursor:pointer}',
    '#card-activity .ab-row.ab-lesson .ab-txt{color:var(--amber-text);font-weight:600}',
    '#card-activity .ab-row.ab-lesson:hover{background:color-mix(in srgb,var(--amber) 14%,transparent)}',
    '#card-activity .ab-row.ab-lesson .ab-rchev{color:var(--faint);font-size:11px;margin-left:8px;display:inline-block;transition:transform .25s}',
    '#card-activity .ab-rowwrap.ab-ropen .ab-rchev{transform:rotate(90deg)}',
    /* drill-down lesson card */
    '#card-activity .ab-exp{display:grid;grid-template-rows:0fr;transition:grid-template-rows .3s ease}',
    '#card-activity .ab-rowwrap.ab-ropen .ab-exp{grid-template-rows:1fr}',
    '#card-activity .ab-exp>div{overflow:hidden}',
    '#card-activity .ab-lesson-card{margin:2px 8px 12px 132px;padding:12px 16px;background:var(--surface-2);border:1px solid var(--ridge);border-left:2px solid var(--amber);border-radius:10px}',
    '#card-activity .ab-seg{margin:0 0 7px;max-width:none}',
    '#card-activity .ab-seg .ab-lab{font-size:13px;font-weight:700;letter-spacing:.09em;font-variant:small-caps;text-transform:lowercase;margin-right:8px}',
    '#card-activity .ab-seg .ab-lab.ab-task{color:var(--cyan-text)}',
    '#card-activity .ab-seg .ab-lab.ab-tried{color:var(--red)}',
    '#card-activity .ab-seg .ab-lab.ab-works{color:var(--green-text)}',
    '#card-activity .ab-seg .ab-lab.ab-crit{color:var(--muted)}',
    '#card-activity .ab-seg .ab-lab.ab-out{color:var(--green-text)}',
    '#card-activity .ab-seg .ab-body{font-size:13.5px;color:var(--ink-2)}',
    '#card-activity .ab-lesson-meta{font-family:var(--mono);font-size:13px;color:var(--muted);margin-top:9px}',
    '#card-activity .ab-lesson-src{font-size:13px;color:var(--muted);margin-top:3px;font-style:italic}',
    /* foot strip */
    '#card-activity .ab-foot{border-top:1px solid var(--ridge);display:flex;align-items:center;gap:14px;padding:10px 2px 2px;margin-top:0}',
    '#card-activity .ab-growth{display:flex;align-items:center;gap:10px}',
    '#card-activity .ab-growth .ab-gl{font-size:13px;color:var(--ink-2)}',
    '#card-activity .ab-thesis{flex:1;text-align:center;font-family:var(--display);font-style:italic;font-size:13.5px;color:var(--muted);line-height:1.45}',
    '#card-activity .ab-thesis .ab-attr{font-style:normal;color:var(--muted);font-size:13px;display:block}',
    '#card-activity .ab-thesis .ab-tagline{display:block;font-style:italic;color:var(--muted);font-size:13px;margin-top:3px}',
    '#card-activity .ab-ghostlink{font-size:13px;color:var(--muted);white-space:nowrap;text-decoration:none;cursor:pointer}',
    '#card-activity .ab-ghostlink:hover{color:var(--amber-text)}',
    /* delight: newest glyph pulses once */
    '@keyframes ab-pulse-once{0%{text-shadow:0 0 0 rgba(240,168,48,0);transform:scale(1)}40%{text-shadow:0 0 14px rgba(240,168,48,.9);transform:scale(1.35)}100%{text-shadow:0 0 0 rgba(240,168,48,0);transform:scale(1)}}',
    '#card-activity .ab-glyph.ab-pulse{animation:ab-pulse-once 1.1s ease-out 1;display:inline-block}',
    '#card-activity .ab-caret{display:inline-block;width:7px;color:var(--amber-text)}',
    /* graceful degrade */
    '#card-activity .ab-lrow{font-size:13px;color:var(--ink-2);margin:6px 2px;line-height:1.4}',
    '#card-activity .ab-lmeta{display:block;font-size:12px;color:var(--muted)}',
    '#card-activity .ab-fallback{margin-top:16px;font-size:13.5px;color:var(--ink-2);font-style:italic}',
    '@media (prefers-reduced-motion:reduce){',
    '  #card-activity .ab-glyph.ab-pulse{animation:none}',
    '  #card-activity .ab-exp{transition:none}',
    '  #card-activity .ab-doors{transition:none}',
    '  #card-activity .ab-fn-text{transition:none}',
    '}',
    '@media (max-width:760px){',
    '  #card-activity .ab-stats{grid-template-columns:repeat(2,1fr)}',
    '  #card-activity .ab-foot{flex-wrap:wrap}',
    '  #card-activity .ab-lesson-card{margin-left:8px}',
    '  #card-activity .ab-krow{grid-template-columns:120px 1fr 52px}',
    '  #card-activity .ab-krow .ab-kg{grid-column:1/-1;padding-left:2px;margin-top:-2px}',
    '  #card-activity .ab-urow{grid-template-columns:140px 1fr 64px}',
    '}'
  ].join('\n');
  var styleEl = document.createElement('style');
  styleEl.setAttribute('data-owner', 'card-activity');
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);

  /* ------------------------- helpers ------------------------- */
  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function fmt(n) { return Number(n || 0).toLocaleString('en-US'); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtTs(at) { // "2026-07-15 15:44:02" → "Jul 15 · 15:44"
    var m = String(at || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    if (!m) return esc(at || '');
    return MONTHS[+m[2] - 1] + ' ' + (+m[3]) + ' · ' + m[4] + ':' + m[5];
  }
  function fmtDay(day) { // "2026-06-30" → "Jun 30"
    var m = String(day || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? MONTHS[+m[2] - 1] + ' ' + (+m[3]) : '';
  }
  function setChips(html) {
    var c = document.getElementById('chips-activity');
    if (c) c.innerHTML = html;
  }
  function degrade() {
    BODY.innerHTML = '<p class="ab-fallback">memory store not readable right now</p>';
    setChips('<span class="chip tone-grey">unavailable</span>');
  }

  /* #499: no readable project store, but the approved-lesson count is a separate, readable fact. */
  function degradeWithApprovals(d) {
    var F = activityFigures(d);
    BODY.innerHTML = '<p class="ab-fallback">This project\'s memory store is not readable right now (memories: ' + F.memories + '). ' +
      '<b>' + F.approvedMachine + '</b> approved lessons are in force on this machine' + (F.approvedApplicable !== 'Unknown' ? ' (<b>' + F.approvedApplicable + '</b> apply to this project)' : '') + '.</p>' + approvedLessonsHTML(d);
    setChips('<span class="chip tone-grey">memories unknown</span><span class="chip tone-green">' + F.approvedMachine + ' approved lessons (machine-wide)</span>');
  }

  /* ---------------- key → plain-English sentence mapper ---------------- */
  var TOOL_LABEL = { memory: 'AgentDB', autocapture: 'Autocapture', hooks: 'Hooks intel', metaharness: 'MetaHarness' };
  var LESSON_TITLES = {
    'lesson-capture-lessons-not-transcripts': 'capture lessons, not transcripts',
    'lesson-telemetry-drowns-signal': 'telemetry drowns the signal at recall time',
    'lesson-verify-by-mechanism': 'verify by mechanism, not by found instances',
    'lesson-never-cp-live-db': 'never cp a live database',
    'lesson-npx-disease': 'the npx disease: fix the producer, not the copies'
  };
  function lessonTitle(key) {
    return LESSON_TITLES[key] || String(key).replace(/^lesson-/, '').replace(/-/g, ' ');
  }
  function describe(r) {
    var k = String(r.key || ''), ns = String(r.namespace || '');
    if (ns === 'lessons' || /^lesson-/.test(k))
      return { tool: 'memory', g: '✦', c: 'amber', txt: 'stored lesson — ' + lessonTitle(k), lessonKey: k };
    if (/^project-state-current/.test(k))
      return { tool: 'memory', g: '✦', c: 'amber', txt: 'project checkpoint written — append-only, safe under concurrent sessions' };
    if (/^session-sessionend/.test(k) || ns === 'sessions')
      return { tool: 'autocapture', g: '◆', c: 'cyan', txt: 'session snapshot captured — nothing lost' };
    if (/^feedback-edit-/.test(k)) {
      var f = k.replace(/^feedback-edit-/, '').replace(/-\d{10,}$/, '').split('/').pop();
      return { tool: 'hooks', g: '●', c: 'green', txt: 'edit verified & feedback scored — ' + f };
    }
    if (ns === 'feedback')
      return { tool: 'hooks', g: '●', c: 'green', txt: 'edit verified & feedback scored' };
    if (/^pattern[_-]/.test(k) || ns === 'pattern')
      return { tool: 'hooks', g: '✦', c: 'amber', txt: "pattern learned from this session's edits" };
    if (/^trajectory-/.test(k) || ns === 'trajectories')
      return { tool: 'hooks', g: '◆', c: 'cyan', txt: 'trajectory recorded — reasoning steps kept for replay' };
    if (ns === 'metaharness-audit' || /^audit-/.test(k))
      return { tool: 'metaharness', g: '●', c: 'green', txt: 'MetaHarness audit passed — composite clean' };
    if (/^session-/.test(k))
      return { tool: 'autocapture', g: '◆', c: 'cyan', txt: 'session observed — ' + k.replace(/^session-/, '').replace(/-\d+$/, '').replace(/-/g, ' ') };
    return { tool: 'memory', g: '✦', c: 'amber', txt: 'stored memory — ' + k.replace(/-\d{10,}$/, '').replace(/[-_]+/g, ' ') };
  }

  /* ---------------- lesson excerpt → structured segments ---------------- */
  var LAB = { task: 'task', tried: 'tried (failed)', works: 'works', crit: 'critique', out: 'outcome' };
  function parseExcerpt(ex) {
    var parts = String(ex || '').split(/(TASK:|TRIED\s*\(failed\):|WORKED(?:\s*\(fix\))?:|CRITIQUE:|OUTCOME:)/);
    var kindOf = function (tok) {
      if (/^TASK/.test(tok)) return 'task';
      if (/^TRIED/.test(tok)) return 'tried';
      if (/^WORKED/.test(tok)) return 'works';
      if (/^CRITIQUE/.test(tok)) return 'crit';
      if (/^OUTCOME/.test(tok)) return 'out';
      return null;
    };
    var segs = [];
    for (var i = 1; i < parts.length; i += 2) {
      var kind = kindOf(parts[i]);
      var body = (parts[i + 1] || '').trim();
      if (kind && body) segs.push([kind, body]);
    }
    if (!segs.length && String(ex || '').trim()) segs.push(['task', String(ex).trim()]);
    return segs;
  }
  function lessonCardHTML(L) {
    var inner = '<div class="ab-lesson-card">';
    L.segs.forEach(function (kv) {
      inner += '<p class="ab-seg"><span class="ab-lab ab-' + kv[0] + '">' + LAB[kv[0]] + '</span><span class="ab-body">' + esc(kv[1]) + '</span></p>';
    });
    inner += '<div class="ab-lesson-meta">learned ' + esc(L.learned) + ' · recalled ' + (L.recalled || 0) + '×</div>';
    inner += '<div class="ab-lesson-src">a real memory from this machine — .swarm/memory.db</div>';
    inner += '</div>';
    return inner;
  }

  /* ------------------------- fetch + render ------------------------- */
  fetch('/api/activity', { headers: { Accept: 'application/json' } })
    .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
    .then(function (d) {
      if (d && d.hasStore === false && d.approvedLessons && d.approvedLessons.available === true) { degradeWithApprovals(d); return; }
      if (!d || d.hasStore === false || !d.totals) { degrade(); return; }
      render(d);
    })
    .catch(degrade);

  function render(d) {
    var totals = d.totals || {};
    var lessonsRaw = Array.isArray(d.lessons) ? d.lessons : [];
    var recent = Array.isArray(d.recent) ? d.recent : [];
    var breakdown = Array.isArray(d.breakdown) ? d.breakdown : [];
    var growthRaw = Array.isArray(d.growth) ? d.growth : [];
    var machine = d.machine || {};
    var projects = (Array.isArray(machine.projects) ? machine.projects.slice() : [])
      .sort(function (a, b) { return (b.memories || 0) - (a.memories || 0); });
    var projectName = d.project || 'this project';
    var F = activityFigures(d);
    var nMem = F.nMem, nLes = F.nLes;
    var nProj = projects.length;

    var LESSONS = lessonsRaw.map(function (l) {
      return { key: l.key, learned: l.learned, recalled: l.access_count || 0, segs: parseExcerpt(l.excerpt) };
    });
    var lessonByKey = {};
    LESSONS.forEach(function (L) { lessonByKey[L.key] = L; });

    /* summary chips */
    setChips(
      '<span class="chip tone-amber">' + F.memories + ' memories</span>' +
      '<span class="chip tone-green">' + F.approvedApplicable + ' approved lessons · this project</span>' +
      '<span class="chip tone-grey">' + F.approvedMachine + ' approved machine-wide</span>' +
      '<span class="chip tone-grey">' + F.agentdbLessons + ' AgentDB lesson records</span>'
    );

    /* ---------------- panel skeleton ---------------- */
    BODY.innerHTML =
      '<div class="ab-stats">' +
        '<div class="ab-stat ab-door" id="ab-stat-memories" role="button" tabindex="0" aria-expanded="false" aria-controls="ab-doors">' +
          '<span class="ab-hint"></span><span class="ab-tchev">▸</span>' +
          '<div class="ab-n">' + F.memories + '</div><div class="ab-l">memories · this project</div></div>' +
        '<div class="ab-stat ab-door" id="ab-stat-lessons" role="button" tabindex="0" aria-expanded="false" aria-controls="ab-doors">' +
          '<span class="ab-hint"></span><span class="ab-tchev">▸</span>' +
          '<div class="ab-n">' + F.approvedApplicable + '</div><div class="ab-l">approved lessons · apply to this project</div>' +
          '<div class="ab-l">' + F.approvedMachine + ' approved machine-wide</div>' +
          '<div class="ab-l">' + F.agentdbLessons + ' AgentDB lesson records · this project</div></div>' +
        '<div class="ab-stat ab-door" id="ab-stat-projects" role="button" tabindex="0" aria-expanded="false" aria-controls="ab-doors">' +
          '<span class="ab-hint"></span><span class="ab-tchev">▸</span>' +
          '<div class="ab-n">' + fmt(nProj) + '</div><div class="ab-l">projects machine-wide</div></div>' +
        '<div class="ab-stat ab-door" id="ab-stat-machine" role="button" tabindex="0" aria-expanded="false" aria-controls="ab-doors">' +
          '<span class="ab-hint"></span><span class="ab-tchev">▸</span>' +
          '<div class="ab-n">' + F.machine + '</div><div class="ab-l">memories machine-wide</div></div>' +
      '</div>' +
      '<div class="ab-doors" id="ab-doors">' +
        '<div class="ab-doors-clip"><div class="ab-door-box">' +
          '<div class="ab-door-head">' +
            '<span class="ab-t" id="ab-doorTitle"></span><span class="ab-s" id="ab-doorSub"></span>' +
            '<button class="ab-door-close" id="ab-doorClose" aria-label="close panel view">✕ close</button>' +
          '</div>' +
          '<div class="ab-door-view" id="ab-view-lessons"></div>' +
          '<div class="ab-door-view" id="ab-view-memories"></div>' +
          '<div class="ab-door-view" id="ab-view-universe"></div>' +
        '</div></div>' +
      '</div>' +
      '<div class="ab-flow" id="ab-flow" aria-label="' + F.memories + ' captured memories, of which ' + F.lessons + ' are kept lesson records">' +
        '<canvas id="ab-flowCanvas"></canvas>' +
        '<div class="ab-flow-hit ab-left" id="ab-flowHitLeft" role="button" tabindex="0" aria-label="see the ' + F.memories + ' memories by kind" title="see the ' + F.memories + ' memories by kind"></div>' +
        '<div class="ab-flow-hit ab-right" id="ab-flowHitRight" role="button" tabindex="0" aria-label="open the ' + F.lessons + ' lesson records" title="open the ' + F.lessons + ' lesson records"></div>' +
        '<div class="ab-flow-label ab-left"><span class="mono">' + F.memories + '</span> captured</div>' +
        '<div class="ab-flow-label ab-gate">curated</div>' +
        '<div class="ab-flow-label ab-right"><span class="mono">' + F.lessons + '</span> lesson records — the keepers</div>' +
        '<div class="ab-flow-narr"><span class="ab-fn-text" id="ab-fnText"></span><span class="ab-fn-steps" id="ab-fnSteps" aria-hidden="true"></span></div>' +
      '</div>' +
      '<div class="ab-vocab"><b>memories</b> = everything your AI captures automatically&ensp;·&ensp;<b>lesson records</b> = the ones kept in the AgentDB lessons namespace (task → what failed → what works)&ensp;·&ensp;<b>approved lessons</b> = the ones you ratified. Background distillation makes patterns and episodes, not lessons.</div>' +
      ((nLes || !F.agentdbKnown) ? '' : '<div class="ab-empty-note">No lesson records in this project\'s AgentDB yet. Lessons are ratified by you; background distillation (session end or compaction, when learning is on) produces patterns and episodes, not lesson records. <code>record-lesson</code> keeps one now. Approved lessons are counted separately above.</div>') +
      '<div class="ab-roster" id="ab-roster">' +
        '<span class="ab-who">written by</span>' +
        '<span class="ab-rchip" data-tool="memory">AgentDB<span class="ab-cs">via ruflo memory</span><span class="ab-k">✦</span></span>' +
        '<span class="ab-rchip" data-tool="autocapture">Autocapture hooks<span class="ab-k">◆</span></span>' +
        '<span class="ab-rchip" data-tool="hooks">Hooks intelligence<span class="ab-k">◆●</span></span>' +
        '<span class="ab-rchip" data-tool="metaharness">MetaHarness<span class="ab-k">●</span></span>' +
      '</div>' +
      '<div class="ab-feed" id="ab-feed" role="log" aria-label="recent brain activity"></div>' +
      '<div class="ab-foot">' +
        '<div class="ab-growth"><svg id="ab-spark" width="140" height="28" viewBox="0 0 140 28" aria-label="memory growth sparkline"></svg>' +
          '<span class="ab-gl" id="ab-growthLabel"></span></div>' +
        '<div class="ab-thesis">“not just visualization — visualization + personalization is the product.”' +
          '<span class="ab-attr">— product thesis · stored to memory Jul 15</span>' +
          '<span class="ab-tagline">the model is the engine — this is the harness driving it.</span></div>' +
        '<a class="ab-ghostlink" href="#" id="ab-openUniverse">open universe view →</a>' +
      '</div>';

    var feedEl = document.getElementById('ab-feed');
    var doorsEl = document.getElementById('ab-doors');

    /* ---------------- feed ---------------- */
    recent.forEach(function (r, i) {
      var m = describe(r);
      var L = m.lessonKey ? lessonByKey[m.lessonKey] : null;
      var isLesson = !!L;
      var wrap = document.createElement('div');
      wrap.className = 'ab-rowwrap';
      var row = document.createElement('div');
      row.className = 'ab-row' + (isLesson ? ' ab-lesson' : '');
      row.dataset.tool = m.tool;
      row.title = (r.key || '') + ' · ' + (r.namespace || '');
      if (isLesson) { row.setAttribute('role', 'button'); row.setAttribute('tabindex', '0'); row.setAttribute('aria-expanded', 'false'); }
      row.innerHTML =
        '<span class="ab-ts">' + fmtTs(r.at) + '</span>' +
        '<span class="ab-glyph ab-' + m.c + '">' + m.g + '</span>' +
        '<span class="ab-txt">' + esc(m.txt) + (isLesson ? '<span class="ab-rchev">▸</span>' : '') + '</span>' +
        '<span class="ab-badge">' + TOOL_LABEL[m.tool] + '</span>';
      wrap.appendChild(row);
      if (isLesson) {
        var exp = document.createElement('div');
        exp.className = 'ab-exp';
        exp.innerHTML = '<div>' + lessonCardHTML(L) + '</div>';
        wrap.appendChild(exp);
        var toggle = function () {
          wrap.classList.toggle('ab-ropen');
          var open = wrap.classList.contains('ab-ropen');
          row.setAttribute('aria-expanded', open);
          feedEl.classList.toggle('ab-expanded', !!feedEl.querySelector('.ab-rowwrap.ab-ropen'));
          if (open) setTimeout(function () { wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 320);
        };
        row.addEventListener('click', toggle);
        row.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      }
      feedEl.appendChild(wrap);
    });

    /* roster hover → spotlight matching rows */
    BODY.querySelectorAll('.ab-rchip').forEach(function (chip) {
      chip.addEventListener('mouseenter', function () {
        feedEl.classList.add('ab-spot');
        feedEl.querySelectorAll('.ab-row').forEach(function (r) { r.classList.toggle('ab-lit', r.dataset.tool === chip.dataset.tool); });
      });
      chip.addEventListener('mouseleave', function () {
        feedEl.classList.remove('ab-spot');
        feedEl.querySelectorAll('.ab-row').forEach(function (r) { r.classList.remove('ab-lit'); });
      });
    });

    /* ---------------- doors ---------------- */
    document.getElementById('ab-view-lessons').innerHTML = approvedLessonsHTML(d) + (LESSONS.length
      ? LESSONS.map(function (L) {
          return '<div class="ab-dl-title"><span class="ab-g">✦</span>' + esc(lessonTitle(L.key)) + '</div>' + lessonCardHTML(L);
        }).join('')
      : (F.agentdbKnown
        ? '<p class="ab-fallback">No lesson records in this project\'s AgentDB yet. Lessons are ratified by you; background distillation produces patterns and episodes, not lesson records. <code>record-lesson</code> keeps one now.</p>'
        : '<p class="ab-fallback">AgentDB lesson records: Unknown (the store could not be read).</p>'));

    (function () {
      var GLOSS = {
        'ruvnet-brain': 'project knowledge & KB work',
        sessions: 'session snapshots (compaction survivors)',
        'default': 'checkpoints & decisions',
        'adr-patterns': 'architecture decision patterns',
        'adr-edges': 'links between decisions',
        trajectories: 'reasoning paths kept for replay',
        lessons: 'lesson records — the keepers',
        'metaharness-audit': 'MetaHarness audit runs',
        feedback: 'edit verifications, scored',
        pattern: 'learned edit patterns',
        session: 'observed sessions'
      };
      if (!breakdown.length) {
        document.getElementById('ab-view-memories').innerHTML = '<p class="ab-fallback">no namespace breakdown available</p>';
        return;
      }
      var lmax = Math.log10(Math.max.apply(null, breakdown.map(function (b) { return b.n; })) + 1);
      document.getElementById('ab-view-memories').innerHTML = breakdown.map(function (b) {
        var w = Math.max(9, Math.round(100 * Math.log10(b.n + 1) / lmax));
        return '<div class="ab-krow"><span class="ab-kn">' + esc(b.namespace) + '</span>' +
          '<span class="ab-kbar"><i style="width:' + w + '%"></i></span>' +
          '<span class="ab-kc">' + fmt(b.n) + '</span>' +
          '<span class="ab-kg">' + esc(GLOSS[b.namespace] || '') + '</span></div>';
      }).join('') +
      '<div class="ab-door-foot">' + breakdown.length + ' namespaces · <span class="mono">' + F.memories + '</span> rows — live from <span class="mono">.swarm/memory.db</span> · bars log-scaled</div>';
    })();

    (function () {
      if (!projects.length) {
        document.getElementById('ab-view-universe').innerHTML = '<p class="ab-fallback">no machine-wide data available</p>';
        return;
      }
      /* #500: "you are here" is the project whose STORE IDENTITY matches, never whose folder name does —
         two unrelated repos can share a name. No identity (older payload) means no match, not a name guess. */
      var U = activityUniverse(d);
      var others = U.others;
      var meRow = U.me || { name: projectName, memories: nMem };
      var more = U.more;
      var top = Math.log10(Math.max(projects[0].memories || 1, 10));
      var base = Math.min(2.7, top - 0.5);
      var wU = function (n) { return Math.round(100 * Math.max(0.10, (Math.log10(Math.max(n, 1)) - base) / (top - base))); };
      var rowHTML = function (name, n, me) {
        return '<div class="ab-urow' + (me ? ' ab-me' : '') + '"><span class="ab-un">' + esc(name) + (me ? ' — you are here' : '') + '</span>' +
          '<span class="ab-ubar"><i style="width:' + wU(n) + '%"></i></span>' +
          '<span class="ab-uc">' + (n == null ? 'Unknown' : fmt(n)) + '</span></div>';
      };
      document.getElementById('ab-view-universe').innerHTML =
        others.map(function (p) { return rowHTML(p.name, p.memories, false); }).join('') +
        rowHTML(meRow.name, meRow.memories, true) +
        (more ? '<div class="ab-umore">…and ' + more + ' more projects</div>' : '') +
        '<div class="ab-door-foot"><span class="mono">' + F.machine + '</span> memories machine-wide — every one persists across sessions and reboots</div>';
    })();

    var DOOR_META = {
      lessons: [F.lessons + ' lesson records', 'kept in this project\'s AgentDB lessons namespace — every card is a real memory'],
      memories: [F.memories + ' memories in this project', 'by namespace — what your AI writes down as you work'],
      universe: [fmt(nProj) + ' projects machine-wide', "everywhere this machine's AI remembers"]
    };
    var VIEW_OF = { 'ab-stat-memories': 'memories', 'ab-stat-lessons': 'lessons', 'ab-stat-projects': 'universe', 'ab-stat-machine': 'universe' };
    var curView = null, curTile = null;

    function openDoor(view, tileId) {
      BODY.querySelectorAll('.ab-door-view').forEach(function (v) { v.classList.toggle('ab-active', v.id === 'ab-view-' + view); });
      BODY.querySelectorAll('.ab-stat.ab-door').forEach(function (s) {
        var on = s.id === tileId;
        s.classList.toggle('ab-on', on);
        s.setAttribute('aria-expanded', on ? 'true' : 'false');
      });
      document.getElementById('ab-doorTitle').textContent = DOOR_META[view][0];
      document.getElementById('ab-doorSub').textContent = DOOR_META[view][1];
      doorsEl.classList.add('ab-open');
      curView = view; curTile = tileId;
      setTimeout(function () { doorsEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 380);
    }
    function closeDoors() {
      doorsEl.classList.remove('ab-open');
      BODY.querySelectorAll('.ab-stat.ab-door').forEach(function (s) { s.classList.remove('ab-on'); s.setAttribute('aria-expanded', 'false'); });
      curView = null; curTile = null;
    }
    BODY.querySelectorAll('.ab-stat.ab-door').forEach(function (tile) {
      var go = function () { (curTile === tile.id) ? closeDoors() : openDoor(VIEW_OF[tile.id], tile.id); };
      tile.addEventListener('click', go);
      tile.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
    document.getElementById('ab-doorClose').addEventListener('click', closeDoors);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && curView) closeDoors(); });
    document.getElementById('ab-openUniverse').addEventListener('click', function (e) {
      e.preventDefault(); openDoor('universe', 'ab-stat-machine');
      BODY.querySelector('.ab-stats').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    [['ab-flowHitLeft', 'memories', 'ab-stat-memories'], ['ab-flowHitRight', 'lessons', 'ab-stat-lessons']].forEach(function (t) {
      var el = document.getElementById(t[0]);
      var go = function () { (curView === t[1] && curTile === t[2]) ? closeDoors() : openDoor(t[1], t[2]); };
      el.addEventListener('click', go);
      el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });

    /* ---------------- distillation flow strip — canvas ---------------- */
    (function () {
      var flowEl = document.getElementById('ab-flow');
      var cv = document.getElementById('ab-flowCanvas');
      var ctx = cv.getContext('2d');
      var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      var W = 0, H = 0, colors = {};

      function refreshColors() {
        var cs = getComputedStyle(document.documentElement);
        colors = {
          muted: cs.getPropertyValue('--muted').trim(),
          faint: cs.getPropertyValue('--faint').trim(),
          amber: cs.getPropertyValue('--amber').trim()
        };
      }
      refreshColors();
      /* the console theme toggle flips html[data-theme] — re-read the palette */
      new MutationObserver(function () { refreshColors(); if (reduce) drawScene(0, true); })
        .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

      var dots = Array.from({ length: 76 }, function () {
        return { fx: .025 + Math.random() * .375, fy: .14 + Math.random() * .56, r: .8 + Math.random() * .9, a: .3 + Math.random() * .4, ph: Math.random() * 6.283 };
      });
      /* honest: zero lessons means zero keeper-stars, never a decorative placeholder count */
      var nStars = nLes > 0 ? Math.max(1, Math.min(7, nLes)) : 0;
      var stars = Array.from({ length: nStars }, function (_, i) {
        return { fx: .665 + i * (.31 / Math.max(nStars, 2)), ph: Math.random() * 6.283, pulse: -9999 };
      });
      var GX = .54, CY = .40;

      function roundBar(x, y, w, h) {
        var r = 1.5;
        ctx.beginPath();
        ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.fill();
      }
      function sparkle(x, y, s) {
        ctx.beginPath();
        ctx.moveTo(x, y - s);
        ctx.quadraticCurveTo(x + s * .18, y - s * .18, x + s, y);
        ctx.quadraticCurveTo(x + s * .18, y + s * .18, x, y + s);
        ctx.quadraticCurveTo(x - s * .18, y + s * .18, x - s, y);
        ctx.quadraticCurveTo(x - s * .18, y - s * .18, x, y - s);
        ctx.closePath(); ctx.fill();
      }
      var ease = function (p) { return p < 0 ? 0 : p > 1 ? 1 : p * p * (3 - 2 * p); };

      var motes = [], lastSpawn = 0, nextGap = 1200, seq = 0, cueLine = 0;
      function spawn(now, forcePass) {
        var d0 = dots[(Math.random() * dots.length) | 0];
        /* honest: with zero real lessons there are zero keepers — never let a mote pass through */
        var pass = nStars > 0 && (forcePass !== undefined ? forcePass : (cueLine === 2 ? false : (seq++ % 4) === 2));
        motes.push({ sfx: d0.fx, sfy: d0.fy, t0: now, dur: 2400 + Math.random() * 700, pass: pass, star: (Math.random() * nStars) | 0, phase: 0, t1: 0 });
      }
      /* narration sync (best-effort): line 2 → motes dissolve at the gate; line 3 → send one keeper through (only if any exist) */
      window.__abFlowCue = function (line) {
        cueLine = line;
        if (line === 3 && nStars > 0 && !reduce && !document.hidden) { spawn(performance.now(), true); lastSpawn = performance.now(); }
      };

      function drawScene(now, still) {
        if (!W || !H) return;
        ctx.clearRect(0, 0, W, H);
        var cy = H * CY, gx = W * GX;

        dots.forEach(function (d0) {
          var y = d0.fy * H + (still ? 0 : Math.sin(now * .0006 + d0.ph) * 1.4);
          ctx.globalAlpha = d0.a;
          ctx.fillStyle = colors.muted;
          ctx.beginPath(); ctx.arc(d0.fx * W, y, d0.r, 0, 6.283); ctx.fill();
        });
        ctx.globalAlpha = 1;

        ctx.globalAlpha = .05;
        ctx.fillStyle = colors.amber;
        ctx.beginPath(); ctx.arc(gx, cy, 15, 0, 6.283); ctx.fill();
        ctx.globalAlpha = 1;
        ctx.shadowColor = colors.amber; ctx.shadowBlur = 8;
        roundBar(gx - 1.5, cy - 26, 3, 17);
        roundBar(gx - 1.5, cy + 9, 3, 17);
        ctx.shadowBlur = 0;

        stars.forEach(function (s) {
          var x = s.fx * W;
          var tw = still ? 1 : .82 + .18 * Math.sin(now * .0011 + s.ph);
          var since = now - s.pulse;
          var pk = (!still && since < 700) ? (1 - since / 700) : 0;
          ctx.globalAlpha = Math.min(1, tw + pk * .4);
          ctx.fillStyle = colors.amber;
          if (pk > 0) { ctx.shadowColor = colors.amber; ctx.shadowBlur = 14 * pk; }
          sparkle(x, cy, 7 + 3 * pk);
          ctx.shadowBlur = 0;
        });
        ctx.globalAlpha = 1;

        if (still) {
          ctx.fillStyle = colors.muted; ctx.globalAlpha = .6;
          [.42, .48].forEach(function (f) { ctx.beginPath(); ctx.arc(f * W, cy - 3, 1.6, 0, 6.283); ctx.fill(); });
          ctx.globalAlpha = 1;
          return;
        }

        for (var i = motes.length - 1; i >= 0; i--) {
          var m = motes[i];
          if (m.phase === 0) {
            var p = (now - m.t0) / m.dur;
            if (p >= 1) { m.phase = m.pass ? 2 : 1; m.t1 = now; }
            else {
              var e = ease(p);
              var x = m.sfx * W + (gx - m.sfx * W) * e;
              var y = m.sfy * H + (cy - m.sfy * H) * e - Math.sin(p * Math.PI) * 5;
              ctx.globalAlpha = .45 + .45 * e;
              ctx.fillStyle = e > .75 ? colors.amber : colors.muted;
              ctx.beginPath(); ctx.arc(x, y, 1.6, 0, 6.283); ctx.fill();
              continue;
            }
          }
          if (m.phase === 1) {
            var p1 = (now - m.t1) / 480;
            if (p1 >= 1) { motes.splice(i, 1); continue; }
            ctx.globalAlpha = .5 * (1 - p1);
            ctx.fillStyle = colors.faint;
            ctx.beginPath(); ctx.arc(gx + 5 + p1 * 7, cy, 1.6 + p1 * 2.6, 0, 6.283); ctx.fill();
          } else if (m.phase === 2) {
            var p2 = (now - m.t1) / 1050;
            var st = stars[m.star], tx = st.fx * W;
            if (p2 >= 1) { st.pulse = now; motes.splice(i, 1); continue; }
            var e2 = ease(p2);
            ctx.globalAlpha = .95;
            ctx.fillStyle = colors.amber;
            ctx.beginPath(); ctx.arc(gx + (tx - gx) * e2, cy - Math.sin(p2 * Math.PI) * 4, 1.8, 0, 6.283); ctx.fill();
          }
        }
        ctx.globalAlpha = 1;
      }

      function resize() {
        var dpr = window.devicePixelRatio || 1;
        W = flowEl.clientWidth; H = cv.clientHeight;
        if (!W || !H) return;
        cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (reduce) drawScene(0, true);
      }
      resize();
      addEventListener('resize', resize);
      CARD.addEventListener('toggle', function () { if (CARD.open) resize(); });

      if (!reduce) {
        var started = false;
        var loop = function (now) {
          if (!started) { spawn(now - 1500); lastSpawn = now; nextGap = 1100; started = true; }
          if (!document.hidden && CARD.open) {
            if (now - lastSpawn > nextGap) { spawn(now); lastSpawn = now; nextGap = 1500 + Math.random() * 700; }
            drawScene(now, false);
          }
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      }
    })();

    /* ---------------- sparkline — live daily counts (zero-filled) ---------------- */
    (function () {
      var svg = document.getElementById('ab-spark');
      var series = [];
      if (growthRaw.length) {
        var map = {};
        growthRaw.forEach(function (g) { map[g.day] = g.n; });
        var t0 = Date.parse(growthRaw[0].day + 'T00:00:00Z');
        var t1 = Date.parse(growthRaw[growthRaw.length - 1].day + 'T00:00:00Z');
        for (var t = t0; t <= t1; t += 86400000) {
          var k = new Date(t).toISOString().slice(0, 10);
          series.push(map[k] || 0);
        }
      }
      if (series.length < 2) series = [0, 0];
      var W = 140, H = 28, P = 2, max = Math.max.apply(null, series.concat([1]));
      var pts = series.map(function (n, i) {
        var x = P + i * (W - 2 * P) / (series.length - 1);
        var y = H - P - (n / max) * (H - 2 * P);
        return [x.toFixed(1), y.toFixed(1)];
      });
      var line = pts.map(function (p) { return p.join(','); }).join(' ');
      var area = line + ' ' + (W - P) + ',' + (H - P) + ' ' + P + ',' + (H - P);
      svg.innerHTML =
        '<polygon points="' + area + '" fill="var(--cyan)" opacity="0.12"/>' +
        '<polyline points="' + line + '" fill="none" stroke="var(--cyan)" stroke-width="1.5" stroke-linejoin="round"/>' +
        '<circle cx="' + pts[pts.length - 1][0] + '" cy="' + pts[pts.length - 1][1] + '" r="2" fill="var(--cyan)"/>';
      document.getElementById('ab-growthLabel').textContent =
        'memory growth · ' + (growthRaw.length ? fmtDay(growthRaw[0].day) + ' → today' : 'no data yet');
    })();

    /* ---------------- the ONE delight: newest row types itself in ---------------- */
    (function () {
      var newRow = feedEl.querySelector('.ab-row');
      if (!newRow) return;
      var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      var txtEl = newRow.querySelector('.ab-txt');
      var glyph = newRow.querySelector('.ab-glyph');
      glyph.classList.add('ab-pulse');
      if (reduce || newRow.classList.contains('ab-lesson')) return;
      var full = txtEl.textContent;
      txtEl.innerHTML = '<span class="ab-typed"></span><span class="ab-caret">▍</span>';
      var typed = txtEl.querySelector('.ab-typed'), caret = txtEl.querySelector('.ab-caret');
      var i = 0;
      var t = setInterval(function () {
        typed.textContent = full.slice(0, ++i);
        if (i >= full.length) { clearInterval(t); setTimeout(function () { caret.remove(); }, 600); }
      }, 16);
    })();

    /* ---------------- rolling narration — the takeaway in plain English ---------------- */
    (function () {
      var LINES = activityNarration(d);
      var txt = document.getElementById('ab-fnText');
      var steps = document.getElementById('ab-fnSteps');
      var idx = 0;
      function show() {
        txt.textContent = LINES[idx];
        steps.innerHTML = LINES.map(function (_, i) { return '<span' + (i === idx ? ' class="ab-on"' : '') + '>·</span>'; }).join('');
        if (window.__abFlowCue) window.__abFlowCue(idx + 1);
      }
      show();
      setInterval(function () {
        if (doorsEl.classList.contains('ab-open')) return; // hold the line while a door is open
        txt.style.opacity = '0';
        setTimeout(function () { idx = (idx + 1) % LINES.length; show(); txt.style.opacity = '1'; }, 560);
      }, 6500);
    })();
  }
})();
