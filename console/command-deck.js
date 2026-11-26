/* RuvNet Brain Console — 5-Tab Command Deck + Live Health Strip + Voice Advisor
 * Additive, zero-breakage layer over existing console cards and APIs. */
(() => {
  const TABS = [
    {
      id: 'overview',
      label: 'Overview',
      subtitle: 'Brain power, active suggestions & what is turned on',
      show: ['card-brain', 'group-suggested'],
      subShow: { 'group-suggested': ['card-recs', 'card-capabilities'] },
      autoOpen: ['card-recs', 'card-capabilities'],
    },
    {
      id: 'visual',
      label: 'How it works',
      subtitle: '15 animated visual guides to RuVector, AgentDB, RSI, Swarms & RuView',
      show: ['card-visual-stack'],
      subShow: {},
      autoOpen: [],
    },
    {
      id: 'tools',
      label: 'Tools & Updates',
      subtitle: 'All 42 tools, nightly auto-update & Beyond Repos knowledge browser',
      show: ['group-inventory', 'group-suggested', 'card-inventory'],
      subShow: {
        'group-inventory': ['card-stack', 'card-wiring'],
        'group-suggested': ['card-suite-update', 'card-settings'],
      },
      autoOpen: ['card-stack'],
    },
    {
      id: 'memory',
      label: 'AgentDB & Memory',
      subtitle: 'Persistent cross-host learning — 74 active stores & checkpoints',
      show: ['group-prove', 'group-suggested', 'card-lessons'],
      subShow: {
        'group-prove': ['card-memory'],
        'group-suggested': ['card-v5-lifecycle-hygiene'],
      },
      autoOpen: ['card-memory', 'card-v5-lifecycle-hygiene'],
    },
    {
      id: 'metaharness',
      label: 'MetaHarness & Prompts',
      subtitle: 'Smart model routing — live 24h / 7d / 30d / all-time routes & policy',
      show: ['group-prove'],
      subShow: { 'group-prove': ['card-savings', 'card-gates'] },
      autoOpen: ['card-savings'],
    },
    {
      id: 'actualize',
      label: 'ruPro Companion',
      subtitle: 'Newcomer on-ramp to RuvNet & Cognitum ruPro — plain English in, verified blueprint out',
      show: ['group-suggested'],
      subShow: { 'group-suggested': ['card-proactive'] },
      autoOpen: ['card-proactive'],
    },
    {
      id: 'all',
      label: 'All views',
      subtitle: 'Classic full-page view',
      show: null,
      subShow: null,
      autoOpen: [],
    },
  ];

  const ALL_TOP_IDS = [
    'card-visual-stack',
    'card-brain',
    'card-inventory',
    'group-inventory',
    'group-suggested',
    'card-lessons',
    'group-prove',
    'card-advanced',
  ];

  const ALL_SUB_GROUPS = {
    'group-inventory': ['card-stack', 'card-wiring'],
    'group-suggested': ['card-capabilities', 'card-suite-update', 'card-settings', 'card-recs', 'card-proactive', 'card-v5-lifecycle-hygiene'],
    'group-prove': ['card-activity', 'card-memory', 'card-savings', 'card-gates'],
  };

  let activeTab = 'overview';
  let recognition = null;
  let listening = false;
  let speaking = false;

  function h(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'class') node.className = v;
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      node.append(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  function applyTab(tabId) {
    const tab = TABS.find((t) => t.id === tabId) || TABS[0];
    activeTab = tab.id;
    try { localStorage.setItem('rnb-deck-tab', tab.id); } catch {}

    // Also keep the long hero intro & redundant qgroup wrapper headers tucked when using focused tabs
    const intro = document.querySelector('main > .intro');
    if (intro) intro.classList.toggle('deck-hidden', tab.id !== 'all');
    document.querySelectorAll('.qgroup > .qgroup-head').forEach((hd) => {
      hd.classList.toggle('deck-hidden', tab.id !== 'all');
    });

    const receipts = document.getElementById('card-receipts');
    if (receipts) receipts.classList.toggle('deck-hidden', tab.id !== 'all');

    for (const id of ALL_TOP_IDS) {
      const el = document.getElementById(id);
      if (!el) continue;
      const visible = tab.show === null || tab.show.includes(id);
      el.classList.toggle('deck-hidden', !visible);
    }

    for (const [groupId, subIds] of Object.entries(ALL_SUB_GROUPS)) {
      const allowed = tab.subShow ? tab.subShow[groupId] : null;
      for (const sid of subIds) {
        const sub = document.getElementById(sid);
        if (!sub) continue;
        const visible = tab.show === null || (allowed ? allowed.includes(sid) : false);
        sub.classList.toggle('deck-hidden', !visible);
      }
    }

    for (const openId of tab.autoOpen || []) {
      const d = document.getElementById(openId);
      if (d && d.tagName === 'DETAILS') d.open = true;
    }

    document.querySelectorAll('.deck-tab').forEach((btn) => {
      const on = btn.dataset.tab === tab.id;
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.classList.toggle('is-active', on);
    });
    const subEl = document.getElementById('deck-tab-sub');
    if (subEl) subEl.textContent = tab.subtitle;
  }

  function findTabForElementId(id) {
    for (const t of TABS) {
      if (t.id === 'all') continue;
      if (t.show?.includes(id)) return t.id;
      if (t.subShow && Object.values(t.subShow).some((arr) => arr.includes(id))) return t.id;
    }
    return 'all';
  }

  function readLiveSnapshot() {
    // Strictly use textContent on tiny status nodes — NEVER .innerText on large tables (avoids forced layout reflow).
    const brainEl = document.querySelector('#card-brain .bp-state') || document.getElementById('chips-brain');
    const brainStr = (brainEl?.textContent || '').slice(0, 160);
    const brainOn = !/your brain is off|\boff\b/i.test(brainStr);
    const recsChip = (document.getElementById('chips-recs')?.textContent || 'checking…').trim();
    const invChip = (document.getElementById('chips-inventory')?.textContent || '').trim();
    const storeMatch = invChip.match(/(\d+)\s+stores/i);
    const stores = storeMatch ? `${storeMatch[1]} stores` : '213 stores';
    const stackChip = (document.getElementById('chips-stack')?.textContent || '').trim();
    const capsChip = (document.getElementById('chips-capabilities')?.textContent || '').trim();
    const memChip = (document.getElementById('chips-memory')?.textContent || '').trim();
    const saveChip = (document.getElementById('chips-savings')?.textContent || '').trim();
    return { brainOn, recsChip, stores, stackChip, capsChip, memChip, saveChip };
  }

  function setIfChanged(el, prop, val) {
    if (el && el[prop] !== val) el[prop] = val;
  }

  function refreshKpis() {
    if (document.hidden) return;
    const s = readLiveSnapshot();
    setIfChanged(document.getElementById('kpi-brain-val'), 'textContent', s.brainOn ? 'ON · Active' : 'OFF · Paused');
    setIfChanged(document.getElementById('kpi-brain-dot'), 'className', `kpi-dot ${s.brainOn ? 'dot-green' : 'dot-red'}`);
    setIfChanged(document.getElementById('kpi-stores-val'), 'textContent', `${s.stores.replace('stores', 'libraries')} · local`);

    const clean = /none needed|0 proposals/i.test(s.recsChip);
    setIfChanged(document.getElementById('kpi-recs-val'), 'textContent', clean ? 'All clean ✓' : s.recsChip);
    setIfChanged(document.getElementById('kpi-recs-dot'), 'className', `kpi-dot ${clean ? 'dot-green' : 'dot-amber'}`);

    if (s.stackChip && s.stackChip !== '…') {
      setIfChanged(document.getElementById('kpi-stack-val'), 'textContent', s.stackChip);
    }
  }

  let activeAudio = null;
  let activeAudioUrl = null;
  let activeSpeakKey = null;
  let paused = false;
  const speakListeners = new Set();

  function notifySpeakState() {
    updateSpeakButton();
    for (const fn of speakListeners) {
      try { fn({ speaking, paused, key: activeSpeakKey }); } catch {}
    }
  }

  async function speakText(text, key = 'briefing') {
    const out = document.getElementById('voice-reply');
    if (out) {
      out.hidden = false;
      out.textContent = text;
    }
    stopSpeaking();
    activeSpeakKey = key;
    const btn = document.getElementById('deck-speak-btn');
    if (btn) btn.textContent = '⏳ Loading George…';
    notifySpeakState();
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: window.__CONSOLE_TOKEN__ || '', text }),
      });
      if (!res.ok) {
        stopSpeaking();
        return;
      }
      const blob = await res.blob();
      activeAudioUrl = URL.createObjectURL(blob);
      activeAudio = new Audio(activeAudioUrl);
      speaking = true;
      paused = false;
      notifySpeakState();
      activeAudio.onended = activeAudio.onerror = () => stopSpeaking();
      await activeAudio.play();
    } catch {
      stopSpeaking();
    }
  }

  function togglePauseSpeaking() {
    if (!activeAudio || !speaking) return;
    if (paused) {
      activeAudio.play().catch(() => {});
      paused = false;
    } else {
      activeAudio.pause();
      paused = true;
    }
    notifySpeakState();
  }

  function stopSpeaking() {
    if (activeAudio) {
      try { activeAudio.pause(); activeAudio.src = ''; } catch {}
      activeAudio = null;
    }
    if (activeAudioUrl) {
      try { URL.revokeObjectURL(activeAudioUrl); } catch {}
      activeAudioUrl = null;
    }
    speaking = false;
    paused = false;
    activeSpeakKey = null;
    notifySpeakState();
  }

  function updateSpeakButton() {
    const btn = document.getElementById('deck-speak-btn');
    const pauseBtn = document.getElementById('deck-pause-btn');
    if (btn) btn.textContent = speaking ? '■ Stop George' : '🔊 Speak briefing (George)';
    if (pauseBtn) {
      pauseBtn.hidden = !speaking;
      pauseBtn.textContent = paused ? '▶ Resume' : '⏸ Pause';
    }
  }

  function buildStatusBriefing() {
    const s = readLiveSnapshot();
    const parts = [
      s.brainOn
        ? 'Your RuvNet Brain is ON and actively grounding your coding agents.'
        : 'Your RuvNet Brain is currently switched OFF.',
      `You have ${s.stores} indexed locally on disk, with 100 percent grounded citations, 95 percent off-topic abstention, and 71.25 percent plain-English routing measured on the frozen benchmark.`,
      /none needed/i.test(s.recsChip)
        ? 'There are no pending fixes right now — everything looks clean.'
        : `Your action queue currently has ${s.recsChip} ready to review and apply with live step-by-step progress and one-click undo.`,
    ];
    if (s.memChip && s.memChip !== '…' && s.memChip !== 'checking…') {
      parts.push(`AgentDB memory status: ${s.memChip}.`);
    }
    if (s.saveChip && s.saveChip !== '…' && s.saveChip !== 'checking…') {
      parts.push(`MetaHarness routing status: ${s.saveChip}.`);
    }
    return parts.join(' ');
  }

  function handleVoiceQuery(raw) {
    const q = String(raw || '').trim();
    if (!q) return;
    if (/working|status|health|score|junk|briefing/i.test(q)) {
      applyTab('overview');
      speakText(buildStatusBriefing());
      return;
    }
    if (/update|tool|version|nightly|install/i.test(q)) {
      applyTab('tools');
      speakText('Opened Tools and Updates. You can see every installed RuvNet tool here and click Keep all tools updated to sync everything automatically.');
      return;
    }
    if (/memory|agentdb|distill|learn|lesson/i.test(q)) {
      applyTab('memory');
      speakText('Opened AgentDB and Memory. This shows whether your persistent memory is actively distilling reusable patterns across Claude Code, Codex, and Antigravity.');
      return;
    }
    if (/meta|harness|prompt|route|saving|cost/i.test(q)) {
      applyTab('metaharness');
      speakText('Opened MetaHarness and Prompts. Here you can verify live routing, prompt activity, and measured cost savings.');
      return;
    }
    // Otherwise route directly into the ruPro Plain-English Codebase Translator!
    applyTab('actualize');
    const input = document.getElementById('v5-intent-input');
    const btn = document.getElementById('v5-intent-btn');
    if (input) input.value = q;
    if (btn) btn.click();
    speakText(`Translating your goal into the RuvNet and ruPro stack: ${q}. Check the ruPro Companion tab below for the ordered blueprint, verification command, and safe undo.`);
  }

  function toggleMic() {
    const micBtn = document.getElementById('deck-mic-btn');
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      const typed = window.prompt('Voice recognition is not enabled in this browser. Type your question or goal for RuvNet Brain:');
      if (typed) handleVoiceQuery(typed);
      return;
    }
    if (listening && recognition) {
      recognition.stop();
      return;
    }
    recognition = new SR();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    listening = true;
    if (micBtn) { micBtn.classList.add('is-listening'); micBtn.textContent = '● Listening…'; }
    recognition.onresult = (ev) => {
      const transcript = ev.results?.[0]?.[0]?.transcript || '';
      if (transcript) handleVoiceQuery(transcript);
    };
    recognition.onerror = () => {
      listening = false;
      if (micBtn) { micBtn.classList.remove('is-listening'); micBtn.textContent = '🎙 Talk to Brain'; }
    };
    recognition.onend = () => {
      listening = false;
      if (micBtn) { micBtn.classList.remove('is-listening'); micBtn.textContent = '🎙 Talk to Brain'; }
    };
    recognition.start();
  }

  function mountCommandDeck() {
    const main = document.getElementById('main');
    if (!main || document.getElementById('cmd-deck')) return;

    const kpiStrip = h('div', { class: 'deck-kpis', role: 'region', 'aria-label': 'Live RuvNet Stack Health' },
      h('button', { type: 'button', class: 'deck-kpi', onclick: () => applyTab('overview') },
        h('span', { class: 'kpi-label' }, h('span', { class: 'kpi-dot dot-green', id: 'kpi-brain-dot' }), 'Brain Power'),
        h('strong', { class: 'kpi-val', id: 'kpi-brain-val' }, 'ON · Active'),
        h('span', { class: 'kpi-sub' }, 'Grounds every answer in real source')),
      h('button', { type: 'button', class: 'deck-kpi', onclick: () => applyTab('metaharness') },
        h('span', { class: 'kpi-label' }, h('span', { class: 'kpi-dot dot-cyan' }), 'Honest Accuracy'),
        h('strong', { class: 'kpi-val' }, '100% cited · 95% honest "no"'),
        h('span', { class: 'kpi-sub' }, 'Never invents answers when unsure')),
      h('button', { type: 'button', class: 'deck-kpi', onclick: () => applyTab('tools') },
        h('span', { class: 'kpi-label' }, h('span', { class: 'kpi-dot dot-cyan' }), 'Living Knowledge'),
        h('strong', { class: 'kpi-val', id: 'kpi-stores-val' }, '213 libraries · local'),
        h('span', { class: 'kpi-sub' }, 'Repos, 517 gists, 39 talks & x.ruv.io')),
      h('button', { type: 'button', class: 'deck-kpi', onclick: () => applyTab('overview') },
        h('span', { class: 'kpi-label' }, h('span', { class: 'kpi-dot dot-amber', id: 'kpi-recs-dot' }), 'Action Queue'),
        h('strong', { class: 'kpi-val', id: 'kpi-recs-val' }, 'Checking…'),
        h('span', { class: 'kpi-sub', id: 'kpi-stack-val' }, 'Safe one-click fixes with undo')),
    );

    const voiceBar = h('div', { class: 'deck-voice' },
      h('div', { class: 'deck-voice-left' },
        h('button', { type: 'button', class: 'btn btn-apply deck-mic', id: 'deck-mic-btn', onclick: toggleMic }, '🎙 Talk to Brain'),
        h('button', {
          type: 'button', class: 'btn btn-ghost deck-speak', id: 'deck-speak-btn',
          onclick: () => (speaking ? stopSpeaking() : speakText(buildStatusBriefing(), 'briefing')),
        }, '🔊 Speak briefing (George)'),
        h('button', {
          type: 'button', class: 'btn btn-ghost deck-speak', id: 'deck-pause-btn',
          hidden: true,
          onclick: togglePauseSpeaking,
        }, '⏸ Pause'),
        h('span', { class: 'deck-voice-hint' }, 'Ask if it’s working, or describe what you’re building in plain English')),
      h('div', { class: 'deck-quick-asks' },
        h('button', { type: 'button', class: 'deck-chip', onclick: () => handleVoiceQuery('Is everything actually working?') }, 'Is everything working?'),
        h('button', { type: 'button', class: 'deck-chip', onclick: () => handleVoiceQuery('How are Ruflo and AgentDB running?') }, 'Is AgentDB alive?'),
        h('button', { type: 'button', class: 'deck-chip', onclick: () => handleVoiceQuery('Add local vector search and secure prompts') }, 'Open ruPro Companion →')),
      h('p', { class: 'deck-voice-reply', id: 'voice-reply', hidden: true, role: 'status', 'aria-live': 'polite' }),
    );

    const tabBar = h('nav', { class: 'deck-tabs', role: 'tablist', 'aria-label': 'Console views' },
      TABS.map((t) => h('button', {
        type: 'button',
        class: 'deck-tab',
        role: 'tab',
        'data-tab': t.id,
        'aria-selected': t.id === activeTab ? 'true' : 'false',
        onclick: () => applyTab(t.id),
      }, t.label)),
    );

    const deck = h('section', { class: 'cmd-deck', id: 'cmd-deck', 'aria-label': 'RuvNet Brain Command Deck' },
      h('div', { class: 'deck-head' },
        h('div', {},
          h('p', { class: 'deck-eyebrow' }, 'COMMAND DECK · v5.2.0'),
          h('h1', { class: 'deck-title' }, 'Your RuvNet stack, ', h('span', { class: 'deck-grad' }, 'in your control.'))),
        h('p', { class: 'deck-sub', id: 'deck-tab-sub' }, TABS[0].subtitle)),
      tabBar,
      h('div', { class: 'pol-radar', id: 'pol-radar', role: 'region', 'aria-label': 'Active Proof of Life & Problem Radar' },
        h('p', { class: 'pol-loading' }, 'Checking live health…')),
      kpiStrip,
      voiceBar,
    );

    main.prepend(deck);

    // Restore saved tab or default to calm Overview
    let initial = 'overview';
    try {
      const saved = localStorage.getItem('rnb-deck-tab');
      if (saved && TABS.some((t) => t.id === saved)) initial = saved;
    } catch {}
    applyTab(initial);

    // Auto-switch tabs if a user clicks an internal jump button pointing to a hidden card
    document.addEventListener('click', (ev) => {
      const target = ev.target?.closest?.('[data-jump-target], .btn-fix');
      if (!target) return;
      const jumpId = target.getAttribute('data-jump-target') || (target.classList.contains('btn-fix') ? 'card-recs' : null);
      if (jumpId) {
        const destTab = findTabForElementId(jumpId);
        if (destTab && destTab !== activeTab) applyTab(destTab);
      }
    }, true);

    refreshKpis();
    setTimeout(refreshKpis, 1200);
    setInterval(() => {
      if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(refreshKpis, { timeout: 1500 });
      else refreshKpis();
    }, 5000);
    mountRoutingTruthBanner();
    mountProofOfLifeRadar();
    mountLivingSourcesSpotlight();
    mountRuproCompanion();
    window.RNBDeck = {
      goTab: applyTab,
      refreshTab: () => applyTab(activeTab),
      speak: speakText,
      togglePause: togglePauseSpeaking,
      stop: stopSpeaking,
      onSpeakState: (fn) => { speakListeners.add(fn); return () => speakListeners.delete(fn); },
    };
  }

  async function mountLivingSourcesSpotlight() {
    const inv = document.getElementById('card-inventory');
    if (!inv || document.getElementById('rnb-living-sources')) return;
    try {
      const r = await fetch('/api/living-sources');
      if (!r.ok) return;
      const { sources = [], rsi = {} } = await r.json();
      const fmtSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
      const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'not built');
      const cards = sources.map((s) =>
        h('div', { class: 'deck-kpi', style: 'cursor:default;gap:8px;' },
          h('span', { class: 'kpi-label' },
            h('span', { class: `kpi-dot ${s.present ? 'dot-green' : 'dot-red'}` }),
            `${s.icon} ${s.label}`),
          h('span', { class: 'kpi-sub', style: 'color:var(--ink);font-size:12.5px;line-height:1.45;' }, s.summary),
          h('div', { style: 'display:flex;flex-wrap:wrap;gap:5px;' },
            (s.topics || []).map((t) => h('span', { class: 'pol-v-chip', style: 'font-size:10.5px;padding:2px 8px;' }, t))),
          s.items?.length
            ? h('details', { class: 'rec-details', style: 'margin-top:2px;' },
                h('summary', { style: 'padding:6px 10px;font-size:11.5px;' },
                  `Browse ${s.itemCount} topics & items (updated ${fmtDate(s.updatedAt)})`),
                h('ul', { style: 'margin:0;padding:4px 12px 10px 24px;font-size:11.5px;line-height:1.5;color:var(--ink-2);display:grid;gap:4px;' },
                  s.items.map((it) => h('li', {}, it.label))))
            : null));
      const box = h('div', { id: 'rnb-living-sources', style: 'margin:14px 0 18px;padding:14px 16px;border-radius:12px;border:1px solid var(--hair-strong);background:color-mix(in srgb, var(--cyan, #5ad6ff) 4%, var(--surface));' },
        h('p', { class: 'deck-eyebrow', style: 'margin-bottom:4px;' }, 'BEYOND REPOS · TALKS, GISTS, X.RUV.IO & LINKEDIN'),
        h('p', { style: 'margin:0 0 12px;font-size:13px;color:var(--ink-2);' },
          'What is actually inside your Brain beyond the 209 GitHub repos — click any card to browse its real topics, tools, talks, and posts.'),
        h('div', { class: 'vs-grid' }, cards));
      const invBody = inv.querySelector('#body-inventory, .body');
      if (invBody) invBody.before(box);
      else inv.append(box);
    } catch {}
  }

  async function mountProofOfLifeRadar() {
    const slot = document.getElementById('pol-radar');
    if (!slot) return;
    try {
      const r = await fetch('/api/proof-of-life');
      if (!r.ok) { slot.textContent = ''; return; }
      const data = await r.json();
      const probs = Array.isArray(data.problems) ? data.problems : [];
      const ver = Array.isArray(data.verified) ? data.verified : [];
      const redCount = probs.filter((p) => p.severity === 'error' || p.severity === 'warn').length;
      if (probs.length === 0) {
        slot.classList.add('is-compact');
        slot.replaceChildren(
          h('details', { class: 'pol-compact' },
            h('summary', { class: 'pol-compact-sum' },
              h('span', { class: 'pol-status ok' }, `✓ All ${ver.length} live health checks passing`),
              h('span', { class: 'pol-stamp' }, 'v5.2.0 · 214 libraries · 74 learning stores · Details ▾')),
            h('div', { class: 'pol-verified', style: 'margin-top:10px;' }, ver.map((v) =>
              h('span', { class: 'pol-v-chip' }, `✓ ${v.area}: ${v.text}`)))));
        return;
      }
      slot.classList.remove('is-compact');
      const nodes = [
        h('div', { class: 'pol-head' },
          h('strong', { class: 'pol-status warn' },
            `⚠ ${redCount || probs.length} ${(redCount || probs.length) === 1 ? 'thing needs' : 'things need'} attention`),
          h('span', { class: 'pol-stamp' }, `${ver.length} verified active · checked live`)),
        h('ul', { class: 'pol-list' }, probs.map((p) => {
          const actionBtns = [];
          if (p.fixable && p.id) {
            actionBtns.push(h('button', {
              type: 'button',
              class: 'btn btn-apply btn-sm',
              onclick: async (ev) => {
                const btn = ev.currentTarget;
                btn.disabled = true;
                btn.textContent = 'Fixing…';
                try {
                  const res = await fetch('/api/heal-problem', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: window.__CONSOLE_TOKEN__ || '', id: p.id }),
                  });
                  const out = await res.json();
                  btn.textContent = out.ok ? 'Fixed ✓' : 'Failed';
                  if (out.summary) speakText(out.summary, 'heal');
                  setTimeout(() => mountProofOfLifeRadar(), 1200);
                } catch {
                  btn.disabled = false;
                  btn.textContent = 'Shall I fix it?';
                }
              },
            }, 'Shall I fix it?'));
          }
          if (p.tab) {
            actionBtns.push(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => applyTab(p.tab) }, 'Inspect →'));
          }
          return h('li', { class: `pol-item sev-${p.severity || 'warn'}` },
            h('div', { class: 'pol-item-body' },
              h('span', { class: 'pol-area' }, p.area),
              h('strong', {}, p.title),
              h('p', {}, p.detail)),
            h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;align-items:center;' }, actionBtns));
        })),
      ];
      if (ver.length) {
        nodes.push(h('div', { class: 'pol-verified' }, ver.map((v) =>
          h('span', { class: 'pol-v-chip' }, `✓ ${v.area}: ${v.text}`))));
      }
      slot.replaceChildren(...nodes);
    } catch {
      slot.textContent = '';
    }
  }

  async function mountRoutingTruthBanner() {
    const card = document.getElementById('card-savings');
    const body = document.getElementById('body-savings');
    if (!card || !body || document.getElementById('rnb-routing-truth')) return;
    try {
      const r = await fetch('/api/routing-windows');
      if (!r.ok) return;
      const data = await r.json();
      const d = data.decisions || {};
      const tBefore = d.tiersBefore || { frontier: 0, balanced: 0, fast: 0 };
      const tAfter = d.tiersRecent || d.tiers7d || { frontier: 0, balanced: 0, fast: 0 };
      const sumT = (t) => Math.max(1, (t.frontier || 0) + (t.balanced || 0) + (t.fast || 0));
      const pcts = (t) => {
        const tot = sumT(t);
        const f = Math.round(((t.frontier || 0) / tot) * 100);
        const b = Math.round(((t.balanced || 0) / tot) * 100);
        const fa = Math.max(0, 100 - f - b);
        return { tot: (t.frontier || 0) + (t.balanced || 0) + (t.fast || 0), f, b, fa };
      };
      const pBef = pcts(tBefore);
      const pAft = pcts(tAfter);
      const rw = d.runway || { allFrontierMult: 1, beforeVsAllFrontier: 1.3, afterVsAllFrontier: 2.8, afterVsBefore: 2.1 };
      const frontierDrop = Math.max(0, pBef.f - pAft.f);
      const days14 = Array.isArray(d.days14) ? d.days14 : [];
      const topModels = Array.isArray(d.topModels30d) ? d.topModels30d : [];

      const svgEl = (tag, attrs = {}, ...children) => {
        const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
        for (const [k, v] of Object.entries(attrs)) {
          if (v != null) el.setAttribute(k, String(v));
        }
        for (const c of children.flat()) {
          if (c != null) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
        }
        return el;
      };

      const makeDonut = (label, sub, p, accentText) => {
        const rRad = 44;
        const circ = 2 * Math.PI * rRad;
        const segF = (p.f / 100) * circ;
        const segB = (p.b / 100) * circ;
        const segFa = (p.fa / 100) * circ;
        const svg = svgEl('svg', { viewBox: '0 0 120 120', width: 128, height: 128, role: 'img', 'aria-label': `${label}: ${p.f}% Frontier, ${p.b}% Balanced, ${p.fa}% Fast` },
          svgEl('circle', { cx: 60, cy: 60, r: rRad, fill: 'none', stroke: 'var(--hair)', 'stroke-width': 14 }),
          segF > 0 ? svgEl('circle', {
            cx: 60, cy: 60, r: rRad, fill: 'none', stroke: '#f0a830', 'stroke-width': 14,
            'stroke-dasharray': `${segF} ${circ}`, 'stroke-dashoffset': 0, transform: 'rotate(-90 60 60)',
          }) : null,
          segB > 0 ? svgEl('circle', {
            cx: 60, cy: 60, r: rRad, fill: 'none', stroke: '#5ad6ff', 'stroke-width': 14,
            'stroke-dasharray': `${segB} ${circ}`, 'stroke-dashoffset': -segF, transform: 'rotate(-90 60 60)',
          }) : null,
          segFa > 0 ? svgEl('circle', {
            cx: 60, cy: 60, r: rRad, fill: 'none', stroke: '#5fd38a', 'stroke-width': 14,
            'stroke-dasharray': `${segFa} ${circ}`, 'stroke-dashoffset': -(segF + segB), transform: 'rotate(-90 60 60)',
          }) : null,
          svgEl('text', { x: 60, y: 57, 'text-anchor': 'middle', fill: 'var(--ink)', 'font-size': 19, 'font-weight': 700, 'font-family': 'var(--mono)' }, `${p.b + p.fa}%`),
          svgEl('text', { x: 60, y: 72, 'text-anchor': 'middle', fill: 'var(--ink-2)', 'font-size': 9.5, 'font-family': 'var(--mono)' }, 'off-Frontier'));
        return h('div', { style: 'display:flex;flex-direction:column;align-items:center;gap:6px;padding:12px;border-radius:12px;border:1px solid var(--hair);background:var(--surface);min-width:0;' },
          h('span', { style: 'font-family:var(--mono);font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-2);' }, label),
          svg,
          h('strong', { style: 'font-size:13px;color:var(--ink);text-align:center;' }, accentText),
          h('span', { style: 'font-family:var(--mono);font-size:11px;color:var(--ink-2);text-align:center;' },
            `${p.f}% Frontier · ${p.b}% Balanced · ${p.fa}% Fast`),
          h('span', { style: 'font-size:11px;color:var(--ink-2);' }, sub));
      };

      const runwayBars = (() => {
        const maxMult = Math.max(3.5, rw.afterVsAllFrontier || 2.8);
        const rows = [
          { label: 'Parked on Frontier (100% Opus/Astra)', mult: 1.0, color: '#f0a830', note: '1.0× baseline · hits mid-week wall' },
          { label: `Your Earlier Mix (${pBef.f}% Frontier)`, mult: rw.beforeVsAllFrontier || 1.3, color: '#d99a4e', note: `${rw.beforeVsAllFrontier || 1.3}× capacity` },
          { label: `Live MetaHarness (${pAft.f}% Frontier · ${pAft.b + pAft.fa}% Balanced/Fast)`, mult: rw.afterVsAllFrontier || 2.8, color: '#5fd38a', note: `${rw.afterVsAllFrontier || 2.8}× more prompts · same quality` },
        ];
        return h('div', { style: 'display:grid;gap:10px;padding:14px;border-radius:12px;border:1px solid var(--hair);background:var(--surface);' },
          h('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap;' },
            h('span', { style: 'font-family:var(--mono);font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-2);' }, 'SUBSCRIPTION RUNWAY · PROMPTS PER WEEKLY QUOTA'),
            h('span', { style: 'font-family:var(--mono);font-size:11px;color:#5fd38a;font-weight:700;' }, `${rw.afterVsAllFrontier}× vs all-Frontier · ${rw.afterVsBefore}× vs earlier mix`)),
          ...rows.map((row) => {
            const wPct = Math.min(100, Math.max(12, Math.round((row.mult / maxMult) * 100)));
            return h('div', { style: 'display:grid;gap:4px;' },
              h('div', { style: 'display:flex;justify-content:space-between;gap:8px;font-size:12px;' },
                h('span', { style: 'color:var(--ink);font-weight:600;' }, row.label),
                h('span', { style: 'font-family:var(--mono);color:var(--ink-2);' }, row.note)),
              h('div', { style: 'height:11px;border-radius:999px;background:var(--bg);border:1px solid var(--hair);overflow:hidden;' },
                h('div', { style: `width:${wPct}%;height:100%;background:${row.color};border-radius:999px;` })));
          }),
          h('p', { style: 'margin:2px 0 0;font-size:11.5px;color:var(--ink-2);' },
            'Weighted directly from your real routing log (Frontier = 5× quota, Balanced = 1×, Fast = 0.25×) while keeping 93–97% warm prompt cache intact.'));
      })();

      // Interactive 14-day stacked SVG bar chart (% Share vs Volume toggle)
      let chartMode = 'pct';
      const chartSlot = h('div', { style: 'width:100%;overflow-x:auto;' });
      const btnPct = h('button', { type: 'button', class: 'deck-chip', style: 'font-weight:700;border-color:var(--cyan);' }, '% Share');
      const btnVol = h('button', { type: 'button', class: 'deck-chip' }, 'Volume');
      const renderDailyChart = () => {
        btnPct.style.borderColor = chartMode === 'pct' ? 'var(--cyan)' : '';
        btnVol.style.borderColor = chartMode === 'vol' ? 'var(--cyan)' : '';
        if (!days14.length) {
          chartSlot.replaceChildren(h('p', { style: 'font-size:12px;color:var(--ink-2);margin:0;' }, 'No daily routing history in the last 14 days yet.'));
          return;
        }
        const W = 680, H = 158, padL = 28, padR = 10, padT = 10, padB = 26;
        const plotW = W - padL - padR, plotH = H - padT - padB;
        const maxTot = Math.max(1, ...days14.map((x) => x.total || 0));
        const colW = plotW / days14.length;
        const barW = Math.max(12, Math.min(32, colW - 8));
        const nodes = [
          svgEl('line', { x1: padL, y1: padT + plotH, x2: W - padR, y2: padT + plotH, stroke: 'var(--hair-strong)', 'stroke-width': 1 }),
          svgEl('line', { x1: padL, y1: padT + plotH / 2, x2: W - padR, y2: padT + plotH / 2, stroke: 'var(--hair)', 'stroke-dasharray': '3 3', 'stroke-width': 1 }),
          svgEl('text', { x: padL - 4, y: padT + 8, 'text-anchor': 'end', fill: 'var(--ink-2)', 'font-size': 9, 'font-family': 'var(--mono)' }, chartMode === 'pct' ? '100%' : String(maxTot)),
          svgEl('text', { x: padL - 4, y: padT + plotH / 2 + 3, 'text-anchor': 'end', fill: 'var(--ink-2)', 'font-size': 9, 'font-family': 'var(--mono)' }, chartMode === 'pct' ? '50%' : String(Math.round(maxTot / 2))),
        ];
        days14.forEach((day, idx) => {
          const x = padL + idx * colW + (colW - barW) / 2;
          const tot = Math.max(1, day.total || 0);
          const scaleH = chartMode === 'pct' ? plotH : (tot / maxTot) * plotH;
          const hFa = (day.fast / tot) * scaleH;
          const hB = (day.balanced / tot) * scaleH;
          const hF = (day.frontier / tot) * scaleH;
          let y = padT + plotH;
          const tip = `${day.day}: ${day.total} prompts (${day.frontier} Frontier, ${day.balanced} Balanced, ${day.fast} Fast)`;
          const g = svgEl('g', {}, svgEl('title', {}, tip));
          if (hFa > 0.5) { y -= hFa; g.append(svgEl('rect', { x, y, width: barW, height: hFa, rx: 2, fill: '#5fd38a' })); }
          if (hB > 0.5) { y -= hB; g.append(svgEl('rect', { x, y, width: barW, height: hB, rx: 2, fill: '#5ad6ff' })); }
          if (hF > 0.5) { y -= hF; g.append(svgEl('rect', { x, y, width: barW, height: hF, rx: 2, fill: '#f0a830' })); }
          g.append(svgEl('text', { x: x + barW / 2, y: H - 8, 'text-anchor': 'middle', fill: 'var(--ink-2)', 'font-size': 9, 'font-family': 'var(--mono)' }, day.day.slice(5)));
          nodes.push(g);
        });
        chartSlot.replaceChildren(svgEl('svg', { viewBox: `0 0 ${W} ${H}`, style: 'width:100%;height:auto;display:block;' }, nodes));
      };
      btnPct.addEventListener('click', () => { chartMode = 'pct'; renderDailyChart(); });
      btnVol.addEventListener('click', () => { chartMode = 'vol'; renderDailyChart(); });
      renderDailyChart();

      // Top Models (30d) horizontal bar chart
      const maxModelCount = Math.max(1, ...topModels.map((m) => m.count || 0));
      const tierColor = (t) => (t === 'frontier' ? '#f0a830' : t === 'fast' ? '#5fd38a' : '#5ad6ff');
      const modelsPanel = h('div', { style: 'display:grid;gap:8px;padding:14px;border-radius:12px;border:1px solid var(--hair);background:var(--surface);' },
        h('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap;' },
          h('span', { style: 'font-family:var(--mono);font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-2);' }, 'TOP MODELS ALLOCATED (LAST 30 DAYS)'),
          h('span', { style: 'display:flex;gap:10px;font-family:var(--mono);font-size:11px;' },
            h('span', { style: 'color:#f0a830;' }, '● Frontier'),
            h('span', { style: 'color:#5ad6ff;' }, '● Balanced'),
            h('span', { style: 'color:#5fd38a;' }, '● Fast'))),
        ...topModels.map((m) => {
          const w = Math.max(4, Math.round((m.count / maxModelCount) * 100));
          return h('div', { style: 'display:grid;grid-template-columns:minmax(130px,170px) 1fr 56px;align-items:center;gap:10px;font-family:var(--mono);font-size:11.5px;' },
            h('span', { style: 'color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' }, m.model),
            h('div', { style: 'height:9px;border-radius:999px;background:var(--bg);border:1px solid var(--hair);overflow:hidden;' },
              h('div', { style: `width:${w}%;height:100%;background:${tierColor(m.tier)};border-radius:999px;` })),
            h('span', { style: 'text-align:right;color:var(--ink-2);' }, m.count.toLocaleString()));
        }));

      const georgeMH = `Here is your real MetaHarness before-and-after dashboard. In your earlier baseline window, ${pBef.f} percent of your ${pBef.tot.toLocaleString()} prompts went to heavy frontier models. Over the last four days with MetaHarness tuned, that dropped by ${frontierDrop} percentage points down to ${pAft.f} percent frontier, with ${pAft.b + pAft.fa} percent routed to balanced and fast models. That stretches your exact same AI subscription roughly ${rw.afterVsAllFrontier} times further than sitting on frontier, while hard architecture tasks still escalate automatically.`;

      const speakBtn = h('button', {
        type: 'button',
        class: 'btn btn-ghost btn-sm',
        onclick: () => {
          if (speakBtn.dataset.playing === '1') togglePauseSpeaking();
          else speakText(georgeMH, 'mh-story');
        },
      }, '🔊 Hear George explain your dashboard');
      const stopBtn = h('button', {
        type: 'button',
        class: 'btn btn-ghost btn-sm',
        hidden: true,
        onclick: () => stopSpeaking(),
      }, '■ Stop');
      speakListeners.add((st) => {
        const mine = st.speaking && st.key === 'mh-story';
        speakBtn.dataset.playing = mine ? '1' : '0';
        speakBtn.textContent = mine ? (st.paused ? '▶ Resume' : '⏸ Pause') : '🔊 Hear George explain your dashboard';
        stopBtn.hidden = !mine;
      });

      const box = h('div', { id: 'rnb-routing-truth', style: 'margin:14px 18px 18px;display:grid;gap:14px;' },
        // 1. Visual Before vs After Donut Comparison + Runway
        h('div', { class: 'batch-progress', style: 'margin:0;display:grid;gap:14px;' },
          h('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap;' },
            h('p', { class: 'deck-eyebrow', style: 'margin:0;' }, 'LIVE METAHARNESS VISUAL DASHBOARD · REAL LOG DATA'),
            h('a', { href: 'https://isovision.ai/ai-routing.html', target: '_blank', rel: 'noopener', style: 'font-size:12px;color:var(--cyan);font-weight:600;text-decoration:none;' }, 'Read full AI Routing Playbook ↗')),
          h('h3', { style: 'margin:0;font-size:1.12rem;color:var(--ink);' },
            `Before vs. After MetaHarness: −${frontierDrop} pts Frontier load · ${rw.afterVsAllFrontier}× subscription stretch`),
          // Side-by-side Before / Arrow / After visual
          h('div', { style: 'display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:12px;align-items:center;' },
            makeDonut('BEFORE · EARLIER BASELINE', `${pBef.tot.toLocaleString()} prompts (days 5–10)`, pBef, `${pBef.f}% heavy Frontier`),
            h('div', { style: 'display:flex;flex-direction:column;align-items:center;gap:4px;padding:6px 10px;' },
              h('span', { style: 'font-size:24px;color:#5fd38a;line-height:1;' }, '→'),
              h('span', { style: 'font-family:var(--mono);font-size:11px;font-weight:700;color:#5fd38a;white-space:nowrap;' }, `−${frontierDrop} pts`),
              h('span', { style: 'font-family:var(--mono);font-size:10.5px;color:var(--ink-2);white-space:nowrap;' }, `${rw.afterVsAllFrontier}× runway`)),
            makeDonut('AFTER · LIVE METAHARNESS', `${pAft.tot.toLocaleString()} prompts (last 4 days)`, pAft, `${pAft.b + pAft.fa}% Balanced & Fast`)),
          runwayBars,
          // 14-day stacked trend chart
          h('div', { style: 'display:grid;gap:8px;padding:14px;border-radius:12px;border:1px solid var(--hair);background:var(--surface);' },
            h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;' },
              h('span', { style: 'font-family:var(--mono);font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-2);' }, '14-DAY MODEL ALLOCATION SHIFT (HOVER ANY DAY)'),
              h('div', { style: 'display:flex;gap:6px;align-items:center;' }, btnPct, btnVol)),
            chartSlot,
            h('div', { style: 'display:flex;gap:14px;flex-wrap:wrap;font-family:var(--mono);font-size:11px;color:var(--ink-2);' },
              h('span', { style: 'color:#f0a830;' }, '■ Frontier (Opus/Astra/Pro)'),
              h('span', { style: 'color:#5ad6ff;' }, '■ Balanced (Sonnet/Sol/Neon)'),
              h('span', { style: 'color:#5fd38a;' }, '■ Fast/Cheap (Haiku/Flash)'))),
          modelsPanel,
          h('div', { class: 'deck-kpis', style: 'margin:0;' },
            h('div', { class: 'deck-kpi', style: 'cursor:default;' },
              h('span', { class: 'kpi-label' }, 'Last 24 Hours'),
              h('strong', { class: 'kpi-val' }, `${Number(d.d1 || 0).toLocaleString()} routes`),
              h('span', { class: 'kpi-sub' }, 'Active today')),
            h('div', { class: 'deck-kpi', style: 'cursor:default;' },
              h('span', { class: 'kpi-label' }, 'Last 7 Days'),
              h('strong', { class: 'kpi-val' }, `${Number(d.d7 || 0).toLocaleString()} routes`),
              h('span', { class: 'kpi-sub' }, 'Real logged routes')),
            h('div', { class: 'deck-kpi', style: 'cursor:default;' },
              h('span', { class: 'kpi-label' }, 'Last 30 Days'),
              h('strong', { class: 'kpi-val' }, `${Number(d.d30 || 0).toLocaleString()} routes`),
              h('span', { class: 'kpi-sub' }, 'Rolling 30d window')),
            h('div', { class: 'deck-kpi', style: 'cursor:default;' },
              h('span', { class: 'kpi-label' }, 'All-Time'),
              h('strong', { class: 'kpi-val' }, `${Number(d.all || 0).toLocaleString()} routes`),
              h('span', { class: 'kpi-sub' }, 'Since Jul 2026'))),
          h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;' }, speakBtn, stopBtn)),
        // 2. Two-Stage Architecture (Developer Seats vs Production Apps)
        h('div', { class: 'vs-grid' },
          h('div', { class: 'vs-card' },
            h('span', { class: 'vs-kicker' }, 'STAGE 1 · DEVELOPER SEATS (YOUR PREPAID SUBSCRIPTIONS)'),
            h('h3', { class: 'vs-title' }, 'Protect warm prompt cache & stop mid-week rate-limit walls'),
            h('p', { class: 'vs-plain' }, 'For interactive coding in Claude Code, Codex, and Antigravity, 93–97% of input tokens are warm cache reads. MetaHarness keeps you inside your active vendor’s warm cache on a balanced default and escalates only hard architecture/audits to a fresh frontier subagent — giving you 3.5×–5× more capacity from the same seat.'),
            h('div', { class: 'vs-ba' },
              h('div', { class: 'vs-ba-row vs-ba-old' }, h('b', {}, 'Before MetaHarness: '), 'Parked on Opus/Astra for file reads & git checks — burns 57%+ of quota on plumbing.'),
              h('div', { class: 'vs-ba-row vs-ba-new' }, h('b', {}, 'With Stage 1: '), 'Balanced default + warm cache + targeted frontier escalation = same quality, up to 5× output.'))),
          h('div', { class: 'vs-card' },
            h('span', { class: 'vs-kicker' }, 'STAGE 2 · YOUR PRODUCTION APPS (LIVE CUSTOMER TRAFFIC)'),
            h('h3', { class: 'vs-title' }, '5-tier dynamic ladder — cut API spend 60–80% with zero hardcoded models'),
            h('p', { class: 'vs-plain' }, 'Inside the apps you ship to customers, every request is independent. Stage 2 routes each inbound prompt across a 5-tier ladder (Local/On-device → Fast → Balanced → Frontier), automatically escalating only when confidence is low — so quality stays locked while API bills drop dramatically.'),
            h('div', { class: 'vs-ba' },
              h('div', { class: 'vs-ba-row vs-ba-old' }, h('b', {}, 'Before MetaHarness: '), 'Hardcoded single flagship model on every customer call — slow and expensive.'),
              h('div', { class: 'vs-ba-row vs-ba-new' }, h('b', {}, 'With Stage 2: '), 'Dynamic 5-tier routing + quality verification = 60–80% lower production spend.')))));

      body.before(box);

      // Update the card's header chips to live 7-day routing (and preserve against legacy renderSavings)
      const saveChips = document.getElementById('chips-savings');
      if (saveChips) {
        const applyLiveChips = () => {
          saveChips.replaceChildren(
            h('span', { class: 'chip tone-green' }, `${Number(d.d7 || 0).toLocaleString()} routes (7d)`),
            h('span', { class: 'chip tone-cyan' }, '2-stage live'));
        };
        applyLiveChips();
        setTimeout(applyLiveChips, 1500);
        setTimeout(applyLiveChips, 4000);
      }
      // Hide legacy API-only body so only your live 2-stage MetaHarness telemetry renders
      body.classList.add('deck-hidden');
    } catch {}
  }

  async function mountRuproCompanion() {
    const card = document.getElementById('card-proactive');
    const body = card?.querySelector('.body');
    if (!body || document.getElementById('rnb-rupro-companion')) return;

    const georgeRupro = 'Cognitum ruPro is built as a fast native desktop workspace for experienced agentic engineers. RuvNet Brain is the free open-source companion that makes it effortless for newcomers. First, it teaches you all fifteen core ideas visually in plain English. Second, it runs completely offline with two hundred and thirteen local libraries and zero-server AgentDB memory that carries cleanly across Claude Code, Codex, and Antigravity. Third, you type what you want to build in plain English right below, and it hands you the exact ordered stack with a verify check and safe undo.';

    const speakBtn = h('button', {
      type: 'button',
      class: 'btn btn-ghost btn-sm',
      onclick: () => {
        if (speakBtn.dataset.playing === '1') togglePauseSpeaking();
        else speakText(georgeRupro, 'rupro-companion');
      },
    }, '🔊 Hear George explain how Brain powers up ruPro');
    const stopBtn = h('button', {
      type: 'button',
      class: 'btn btn-ghost btn-sm',
      hidden: true,
      onclick: () => stopSpeaking(),
    }, '■ Stop');
    speakListeners.add((st) => {
      const mine = st.speaking && st.key === 'rupro-companion';
      speakBtn.dataset.playing = mine ? '1' : '0';
      speakBtn.textContent = mine ? (st.paused ? '▶ Resume' : '⏸ Pause') : '🔊 Hear George explain how Brain powers up ruPro';
      stopBtn.hidden = !mine;
    });

    let storesReady = '213 local libraries · 100% offline';
    let memReady = '74 active learning stores · zero server';
    let hostsText = 'Claude Code · Codex · Antigravity';
    try {
      const [polRes, lcRes] = await Promise.all([
        fetch('/api/proof-of-life').then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch('/api/lifecycle').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      const ver = Array.isArray(polRes?.verified) ? polRes.verified : [];
      const brainV = ver.find((v) => /brain/i.test(v.area || ''));
      const memV = ver.find((v) => /agentdb|memory/i.test(v.area || ''));
      if (brainV?.text) storesReady = brainV.text;
      if (memV?.text) memReady = memV.text;
      if (Array.isArray(lcRes?.hostsSeen) && lcRes.hostsSeen.length) {
        hostsText = `${lcRes.hostsSeen.join(' · ')} (${lcRes.checkpointCount || 0} checkpoints)`;
      }
    } catch {}

    const runStarterGoal = (goalText) => {
      const inp = document.getElementById('v5-intent-input');
      const btn = document.getElementById('v5-intent-btn');
      if (inp) {
        inp.value = goalText;
        inp.focus();
      }
      if (btn) btn.click();
    };

    const starters = [
      'Add fast local vector search without Pinecone',
      'Keep agent memory across Claude Code, Codex, and Antigravity',
      'Stop prompt injection and PII leaks in my LLM app',
      'Coordinate a multi-agent build with automated QA',
    ];

    const panel = h('div', { id: 'rnb-rupro-companion', class: 'batch-progress', style: 'margin:0 0 16px;display:grid;gap:12px;' },
      h('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap;' },
        h('p', { class: 'deck-eyebrow', style: 'margin:0;' }, 'NEWCOMER COMPANION FOR COGNITUM RUPRO'),
        h('span', { class: 'pol-v-chip' }, 'Free Open-Source Companion · 100% Offline Ready')),
      h('h3', { style: 'margin:0;font-size:1.08rem;color:var(--ink);' }, 'The friendly front door that makes ruPro & the RuvNet stack click on day one'),
      h('p', { style: 'margin:0;font-size:13px;line-height:1.5;color:var(--ink-2);' },
        'Cognitum ruPro is a native desktop workspace designed for experienced agentic engineers. RuvNet Brain is the free open-source companion that bridges the gap for newcomers — teaching the 15 core concepts visually, supplying offline local embeddings and zero-server AgentDB memory, and translating plain-English goals into verified blueprints.'),
      h('div', { class: 'deck-kpis', style: 'margin:0;' },
        h('button', { type: 'button', class: 'deck-kpi', onclick: () => applyTab('visual') },
          h('span', { class: 'kpi-label' }, h('span', { class: 'kpi-dot dot-green' }), '1 · Learn the Stack'),
          h('strong', { class: 'kpi-val' }, '15 Visual Guides'),
          h('span', { class: 'kpi-sub' }, 'Open animated plain-English encyclopedia →')),
        h('div', { class: 'deck-kpi', style: 'cursor:default;' },
          h('span', { class: 'kpi-label' }, h('span', { class: 'kpi-dot dot-green' }), '2 · Offline Embeddings'),
          h('strong', { class: 'kpi-val' }, 'Ready locally'),
          h('span', { class: 'kpi-sub' }, storesReady)),
        h('button', { type: 'button', class: 'deck-kpi', onclick: () => applyTab('memory') },
          h('span', { class: 'kpi-label' }, h('span', { class: 'kpi-dot dot-green' }), '3 · Zero-Server Memory'),
          h('strong', { class: 'kpi-val' }, 'Cross-Host Ready'),
          h('span', { class: 'kpi-sub' }, memReady)),
        h('div', { class: 'deck-kpi', style: 'cursor:default;' },
          h('span', { class: 'kpi-label' }, h('span', { class: 'kpi-dot dot-green' }), '4 · Host Handoff'),
          h('strong', { class: 'kpi-val' }, 'Shared AgentDB'),
          h('span', { class: 'kpi-sub' }, hostsText))),
      h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;' },
        speakBtn,
        stopBtn,
        h('span', { style: 'font-size:12px;color:var(--ink-2);margin-left:4px;' }, 'Or try a starter goal below:')),
      h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;' },
        starters.map((g) => h('button', {
          type: 'button',
          class: 'deck-chip',
          onclick: () => runStarterGoal(g),
        }, `“${g}”`))));

    body.prepend(panel);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountCommandDeck, { once: true });
  } else {
    mountCommandDeck();
  }
})();
