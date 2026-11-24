/* v5-workspace.js — RuvNet Brain v5.0 / ruPro On-Ramp Console panels
 * Renders:
 *   1. Proactive Codebase & ruPro Technology Translator (/api/proactive)
 *   2. Cross-Host AgentDB Project Lifecycle (/api/lifecycle + /api/lifecycle/checkpoint)
 *   3. Markdown Auto-Currency & Safe Dead-Code Hygiene (/api/hygiene/scan + /api/hygiene/docs + /api/hygiene/clean)
 * Self-contained, non-invasive module so existing app.js and ux-qe contracts stay 100% green.
 */
(function () {
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function apiGet(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async function apiPost(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: window.__CONSOLE_TOKEN__, ...body }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }

  function renderProactive(data) {
    const chip = document.getElementById('v5-proactive-chip');
    const out = document.getElementById('v5-proactive-body');
    if (!out) return;
    if (!data || !data.ok) {
      if (chip) chip.textContent = 'idle';
      out.innerHTML = `<p class="fineprint">No project source files detected in this directory yet.</p>`;
      return;
    }
    const recs = Array.isArray(data.recommendations) ? data.recommendations : [];
    const scannedCount = data.fileCount ?? data.scannedFiles ?? 0;
    if (chip) chip.textContent = `${recs.length} match${recs.length === 1 ? '' : 'es'} · ${scannedCount} files`;
    const wired = (data.alreadyIntegrated || []).length
      ? `<p class="fineprint"><b>Already wired in ${esc(data.project)}:</b> ${data.alreadyIntegrated.map(esc).join(', ')}</p>`
      : '';
    if (!recs.length) {
      out.innerHTML = `${wired}<p>This project already integrates the top RuvNet capabilities matched to its codebase.</p>`;
      return;
    }
    const rows = recs.map((r) => `
      <div class="v5-item" style="border:1px solid var(--border,#e5e7eb);border-radius:10px;padding:12px 14px;margin:10px 0;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;">
          <strong>${esc(r.title)}</strong>
          <span class="chip tone-ok">score ${esc(r.score)}</span>
        </div>
        <p style="margin:6px 0 4px;">${esc(r.whyItFits)}</p>
        <p class="fineprint" style="margin:4px 0;"><b>Observed in your code:</b> ${(r.evidence || []).map(esc).join(' · ')}</p>
        <p class="fineprint" style="margin:4px 0;"><b>First step:</b> <code>${esc(r.nextAction)}</code></p>
      </div>
    `).join('');
    const bpSteps = Array.isArray(data.blueprint?.steps) ? data.blueprint.steps : [];
    const bpHtml = bpSteps.length
      ? `<div class="v5-blueprint" style="margin-top:12px;padding:12px 14px;border:1px dashed var(--border,#cbd5e1);border-radius:10px;">
          <p style="margin:0 0 6px;"><b>Ordered ruPro Implementation Blueprint (${esc(bpSteps.length)} step${bpSteps.length === 1 ? '' : 's'}):</b></p>
          <ol style="margin:0;padding-left:20px;">${bpSteps.map((s) => `
            <li style="margin:6px 0;">
              <b>[${esc(s.layer || 'core')}] ${esc(s.capability)}</b> — <code>${esc(s.command)}</code>
              <button type="button" class="v5-copy-cmd" data-cmd="${esc(s.command)}" style="margin-left:6px;font-size:11px;padding:2px 6px;cursor:pointer;">Copy</button>
              ${s.verify ? `<div class="fineprint">Verify: <code>${esc(s.verify)}</code></div>` : ''}
            </li>`).join('')}</ol>
        </div>`
      : '';
    out.innerHTML = `${wired}${rows}${bpHtml}`;
    out.querySelectorAll('.v5-copy-cmd').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const cmd = btn.getAttribute('data-cmd') || '';
        try {
          await navigator.clipboard.writeText(cmd);
          btn.textContent = 'Copied';
          setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
        } catch { btn.textContent = 'Copy failed'; }
      });
    });
  }

  function renderLifecycleAndHygiene(lifecycle, scan) {
    const chip = document.getElementById('v5-hygiene-chip');
    const lcEl = document.getElementById('v5-lifecycle-summary');
    const docEl = document.getElementById('v5-docs-summary');
    const clEl = document.getElementById('v5-clean-summary');

    const safeCount = scan?.hygiene?.summary?.safeAutoCount ?? 0;
    const missingStamps = scan?.docs?.missingStamp ?? 0;
    const brokenDocs = scan?.docs?.brokenLinkDocs ?? 0;
    if (chip) {
      chip.textContent = safeCount === 0 && missingStamps === 0 && brokenDocs === 0
        ? 'clean'
        : `${missingStamps} doc stamp${missingStamps === 1 ? '' : 's'} · ${safeCount} cleanable`;
    }

    if (lcEl) {
      if (!lifecycle || !lifecycle.ok) {
        lcEl.innerHTML = '<p class="fineprint">Lifecycle store unavailable.</p>';
      } else {
        const hosts = (lifecycle.hostsSeen || []).length ? lifecycle.hostsSeen.join(', ') : 'none yet';
        const latest = lifecycle.latest
          ? `Last checkpoint by <b>${esc(lifecycle.latest.host)}</b> (${esc(lifecycle.latest.ts)}): ${esc(lifecycle.latest.summary || 'checkpoint recorded')}`
          : 'No cross-host lifecycle checkpoint recorded in this repo yet.';
        lcEl.innerHTML = `
          <p><b>Cross-Host AgentDB Lifecycle (${esc(lifecycle.project)}):</b>
            <code>${esc(lifecycle.dbPath)}</code> · ${lifecycle.dbPresent ? 'AgentDB present' : 'initializes on first checkpoint'} ·
            <b>${esc(lifecycle.checkpointCount)}</b> checkpoint(s) across hosts: <b>${esc(hosts)}</b>.</p>
          <p class="fineprint">${latest}</p>
        `;
      }
    }

    if (docEl && scan?.docs) {
      const d = scan.docs;
      docEl.innerHTML = `
        <p><b>Markdown Currency & Timestamps:</b> Scanned <b>${esc(d.scanned)}</b> docs —
          <b>${esc(d.stamped)}</b> stamped, <b>${esc(d.missingStamp)}</b> missing timestamp,
          <b>${esc(d.staleCodeDocs)}</b> behind linked code, <b>${esc(d.brokenLinkDocs)}</b> with broken local links.</p>
      `;
    }

    if (clEl && scan?.hygiene) {
      const h = scan.hygiene;
      const kb = ((h.summary?.reclaimableBytes || 0) / 1024).toFixed(1);
      const preview = (h.safeAuto || []).slice(0, 8).map((item) => `<code>${esc(item.path)}</code>`).join(', ');
      const extra = (h.safeAuto || []).length > 8 ? ` (+${h.safeAuto.length - 8} more)` : '';
      clEl.innerHTML = `
        <p><b>Dead-Code & Backup Hygiene:</b> <b>${esc(h.summary?.safeAutoCount || 0)}</b> safe-to-clean item(s)
          (${esc(kb)} KB), <b>${esc(h.summary?.reviewCount || 0)}</b> legacy file(s) flagged for review.</p>
        ${preview ? `<p class="fineprint">Targets: ${preview}${extra}</p>` : ''}
      `;
    }
  }

  async function refreshV5() {
    const promptInput = document.getElementById('v5-intent-input');
    const prompt = promptInput ? promptInput.value.trim() : '';
    const status = document.getElementById('v5-action-status');
    try {
      const [pro, lc, hy] = await Promise.all([
        apiGet(`/api/proactive${prompt ? `?prompt=${encodeURIComponent(prompt)}` : ''}`),
        apiGet('/api/lifecycle'),
        apiGet('/api/hygiene/scan'),
      ]);
      renderProactive(pro);
      renderLifecycleAndHygiene(lc, hy);
    } catch (e) {
      if (status) status.textContent = `Workspace refresh error: ${e.message}`;
    }
  }

  function wireControls() {
    const status = document.getElementById('v5-action-status');
    const setStatus = (msg) => { if (status) status.textContent = msg; };

    const askBtn = document.getElementById('v5-intent-btn');
    if (askBtn) {
      askBtn.addEventListener('click', async () => {
        setStatus('Analyzing codebase + intent…');
        await refreshV5();
        setStatus('Updated proactive recommendations.');
      });
    }

    const cpBtn = document.getElementById('v5-checkpoint-btn');
    if (cpBtn) {
      cpBtn.addEventListener('click', async () => {
        setStatus('Recording cross-host AgentDB lifecycle checkpoint…');
        try {
          const r = await apiPost('/api/lifecycle/checkpoint', {
            host: 'console',
            event: 'console-checkpoint',
            summary: 'Manual lifecycle snapshot saved from RuvNet Brain v5.0 Console',
          });
          setStatus(`Saved checkpoint (${r.record?.digest || 'ok'}) to ${r.dbFile ? '.swarm/memory.db' : 'lifecycle log'}.`);
          await refreshV5();
        } catch (e) { setStatus(`Checkpoint failed: ${e.message}`); }
      });
    }

    const docBtn = document.getElementById('v5-docs-btn');
    if (docBtn) {
      docBtn.addEventListener('click', async () => {
        setStatus('Stamping Markdown Updated/Created headers…');
        try {
          const r = await apiPost('/api/hygiene/docs', { apply: true });
          setStatus(`Stamped ${r.stampedNow || 0} Markdown file(s) with Eastern timestamp + Version ${r.projectVersion || ''}.`);
          await refreshV5();
        } catch (e) { setStatus(`Doc sync failed: ${e.message}`); }
      });
    }

    const cleanBtn = document.getElementById('v5-clean-btn');
    if (cleanBtn) {
      cleanBtn.addEventListener('click', async () => {
        setStatus('Previewing safe cleanup targets…');
        try {
          const dry = await apiPost('/api/hygiene/clean', { apply: false });
          const targets = Array.isArray(dry.wouldClean) ? dry.wouldClean : [];
          if (!targets.length) {
            setStatus('Nothing safe to clean — workspace is already tidy.');
            return;
          }
          const sample = targets.slice(0, 10).join('\n  - ');
          const more = targets.length > 10 ? `\n  ...and ${targets.length - 10} more` : '';
          if (!window.confirm(`Clean ${targets.length} safe backup/temp item(s)?\n\n  - ${sample}${more}`)) {
            setStatus('Cleanup cancelled.');
            return;
          }
          setStatus('Cleaning confirmed targets…');
          const r = await apiPost('/api/hygiene/clean', { apply: true, paths: targets });
          setStatus(`Cleaned ${r.cleanedCount || 0} safe item(s) via ${r.method || 'quarantine'}.`);
          await refreshV5();
        } catch (e) { setStatus(`Cleanup failed: ${e.message}`); }
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { wireControls(); refreshV5(); });
  } else {
    wireControls();
    refreshV5();
  }
})();
