// The one chunker (RECIPE-FINAL 2.1), ported from kb/forge-chunk-v2.mjs on branch
// worktree-agent-a00e59ae16c567ff6: units are grouped while small, an over-budget unit descends into
// its children or is line-packed with its signature rows repeated, a single over-long line is split
// into pieces. Every passage is at most `maxTokens` counted as the reference did: special tokens +
// label reserve + header + repeated signature + body. Differences from the reference, all recipe-set:
// the token counter is the recipe's estimator; a passage is also bounded by the recipe's outer
// maxLines / maxChars; and the stored text is the body only (the cited source lines), while the header,
// label line and repeated signature rows go to the indexed subject.
import { labelLine } from './labels.mjs';

export function lineModel(text, counter) {
  const lines = text.split('\n');
  const tc = lines.map((l) => (l.trim() ? counter.count(l) : 0));
  const cc = lines.map((l) => l.length + 1);
  const tp = new Float64Array(lines.length + 1);
  const cp = new Float64Array(lines.length + 1);
  for (let i = 0; i < lines.length; i++) {
    tp[i + 1] = tp[i] + tc[i];
    cp[i + 1] = cp[i] + cc[i];
  }
  const span = (p) => (a, b) => (b < a ? 0 : p[b + 1] - p[a]);
  return { lines, tc, sum: span(tp), chars: span(cp) };
}

export const headerOf = (cfg, repo, rel, symbol) => [repo, rel, symbol].filter((p) => p && String(p).trim()).join(cfg.separator);

/** Chunks one document. Returns passages { symbol, start, end (1-based), piece, header, label, sig, text, tokens }. */
export function chunkDocument({ lines: rawLines, units, cfg, repo, rel, lang, kind }) {
  const lm = lineModel(rawLines.join('\n'), cfg.counter);
  const reserved = cfg.specialTokens + cfg.labelTokens;
  const trimSym = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, cfg.maxSymbolChars);
  const hdrTok = (symbol) => cfg.counter.count(headerOf(cfg, repo, rel, trimSym(symbol)));
  const sigFor = (sig, start) => (sig || []).filter((row) => row < start);
  const sigTok = (rows) => rows.reduce((n, row) => n + lm.tc[row], 0);
  const fits = (start, end, symbol, sig) =>
    reserved + hdrTok(symbol) + sigTok(sigFor(sig, start)) + lm.sum(start, end) <= cfg.maxTokens &&
    end - start + 1 <= cfg.maxLines && lm.chars(start, end) <= cfg.maxChars;
  const raw = [];
  const push = (start, end, symbol, sigRows, extra = {}) =>
    raw.push({ start, end, symbol: trimSym(symbol), sigRows, bodyLines: extra.body ?? lm.lines.slice(start, end + 1), piece: extra.piece ?? 0, joined: !!extra.joined });

  function linePack(start, end, rawSymbol, sig) {
    const symbol = trimSym(rawSymbol); // trimmed here and again in push(), as the reference does
    const header = hdrTok(symbol);
    let rows = [...new Set((sig || []).filter((r) => r >= 0 && r < lm.lines.length && lm.lines[r].trim()))].sort((a, b) => a - b);
    const budgetFor = (s) => cfg.maxTokens - reserved - header - s.reduce((n, r) => n + lm.tc[r], 0);
    if (budgetFor(rows) < (cfg.maxTokens * 2) / 3) rows = rows.slice(0, 1);
    if (budgetFor(rows) < (cfg.maxTokens * 2) / 3) rows = [];
    let i = start;
    while (i <= end) {
      const sigRows = rows.filter((r) => r < i);
      const budget = budgetFor(sigRows);
      if (lm.tc[i] > budget || lm.lines[i].length + 1 > cfg.maxChars) {
        for (const p of splitLongLine(lm.lines[i], budget, cfg)) push(i, i, symbol, sigRows, { body: [p.text], piece: p.index, joined: true });
        i++;
        continue;
      }
      let j = i;
      let used = lm.tc[i];
      while (j + 1 <= end && used + lm.tc[j + 1] <= budget && j + 2 - i <= cfg.maxLines && lm.chars(i, j + 1) <= cfg.maxChars) {
        j++;
        used += lm.tc[j];
      }
      if (j < end) {
        for (let k = j; k > i + Math.floor((j - i) * 0.7); k--) {
          const line = lm.lines[k].trim();
          if (!line || /[;}\])]\s*$|^end\b/.test(line)) {
            j = k;
            break;
          }
        }
      }
      push(i, j, symbol, sigRows);
      i = j + 1;
    }
  }

  function walk(list, sig) {
    let cur = null;
    const flush = () => {
      if (cur) push(cur.start, cur.end, cur.symbol, sigFor(sig, cur.start));
      cur = null;
    };
    const groupSymbol = (a, b) => {
      const extra = b.isSymbol && b.symbol && !(a.names || []).some((n) => n === b.symbol || b.symbol.startsWith(`${n} > `)) ? [b.symbol] : [];
      const names = [...(a.names || []), ...extra];
      const shown = names.length > 3 ? `${names.slice(0, 3).join(', ')}, …` : names.join(', ');
      return { names, symbol: shown || a.symbol || b.symbol };
    };
    for (const unit of list) {
      if (unit.end < unit.start) continue;
      if (!fits(unit.start, unit.end, unit.symbol, sig)) {
        flush();
        const parts = unit.split ? unit.split() : null;
        if (parts && parts.units && parts.units.length > 1) walk(parts.units, [...(sig || []), ...(parts.sig || [])]);
        else linePack(unit.start, unit.end, unit.symbol, [...(sig || []), ...((parts && parts.sig) || unit.packSig || [unit.start])]);
        continue;
      }
      if (cur) {
        const merged = groupSymbol(cur, unit);
        const bothPlain = !cur.hasSymbol && !unit.isSymbol;
        const small = lm.sum(cur.start, unit.end) <= cfg.groupTarget;
        if ((bothPlain || small) && fits(cur.start, unit.end, merged.symbol, sig)) {
          Object.assign(cur, { end: unit.end, names: merged.names, symbol: merged.symbol, hasSymbol: cur.hasSymbol || unit.isSymbol });
          continue;
        }
        flush();
      }
      cur = { start: unit.start, end: unit.end, symbol: unit.symbol, names: unit.isSymbol && unit.symbol ? [unit.symbol] : [], hasSymbol: Boolean(unit.isSymbol) };
    }
    flush();
  }

  walk(units, []);
  return finalize(raw, { lm, cfg, repo, rel, lang, kind });
}

/** Splits one line into pieces that each fit `budget` tokens (and the outer character bound). */
export function splitLongLine(line, budget, cfg) {
  const words = line.match(/\S+\s*|\s+/g) || [line];
  const maxChars = cfg.maxChars - 1;
  const pieces = [];
  let cur = '';
  let curTok = 0;
  const flush = () => {
    if (cur) pieces.push(cur);
    cur = '';
    curTok = 0;
  };
  for (const word of words) {
    const t = cfg.counter.count(word);
    if (t > budget || word.length > maxChars) {
      flush();
      let rest = word;
      while (rest) {
        let lo = 1;
        let hi = Math.min(rest.length, maxChars);
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          if (cfg.counter.count(rest.slice(0, mid)) <= budget) lo = mid;
          else hi = mid - 1;
        }
        pieces.push(rest.slice(0, lo));
        rest = rest.slice(lo);
      }
      continue;
    }
    if (curTok + t > budget || cur.length + word.length > maxChars) flush();
    cur += word;
    curTok += t;
  }
  flush();
  return pieces.map((text, index) => ({ text, index }));
}

function finalize(raw, { lm, cfg, repo, rel, lang, kind }) {
  const out = [];
  for (const c of raw) {
    let body = c.bodyLines;
    let { start, end } = c;
    if (!c.joined) {
      while (body.length && !body[0].trim()) {
        body = body.slice(1);
        start++;
      }
      while (body.length && !body[body.length - 1].trim()) {
        body = body.slice(0, -1);
        end--;
      }
      if (!body.length) continue;
    }
    const sig = c.sigRows.map((r) => lm.lines[r]).join('\n');
    const header = headerOf(cfg, repo, rel, c.symbol);
    const text = body.join('\n');
    const label = labelLine({ lang, kind, body: sig ? `${sig}\n${text}` : text, counter: cfg.counter, maxTokens: cfg.labelTokens });
    const tokens = cfg.specialTokens + cfg.counter.count(`${header}\n${label}${sig ? `\n${sig}` : ''}\n${text}`);
    if (tokens > cfg.maxTokens) throw new Error(`passage over the recipe cap: ${repo}/${rel}:${start + 1}-${end + 1} is ${tokens} tokens (cap ${cfg.maxTokens})`);
    out.push({ symbol: c.symbol, start: start + 1, end: end + 1, piece: c.piece, header, label, sig, text, tokens });
  }
  return out;
}
