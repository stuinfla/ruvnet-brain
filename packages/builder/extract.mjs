// One source -> store rows (architecture 2.4 step 3 and 4): documents are screened for secrets, cut
// into units, chunked, flagged for hostile text (kept and searchable; `flag` = 'hostile', the engine
// decides how to label or quote it), and given their metadata (repo, path, kind, language,
// symbol, line range, content hash, standing, date, commit). History items become rows of their own
// store. A pure function of (source snapshot, settings), so its result can be cached by content hash.
import crypto from 'node:crypto';
import path from 'node:path';
import { chunkDocument } from './chunker.mjs';
import { historyUnits } from './history.mjs';
import { hostileRule, redactSecrets } from './screen.mjs';
import { unitsFor } from './units.mjs';

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

function standingOf(doc, s) {
  if (s.standing.byKind[doc.kind]) return s.standing.byKind[doc.kind];
  return s.standing.docExt.has(path.posix.extname(doc.rel).toLowerCase()) ? s.standing.doc : s.standing.code;
}

/** snapshot: { meta, docs, history: { owner, raw } | null }. */
export function extract(snapshot, s) {
  const { meta } = snapshot;
  const screened = { secrets: [], hostile: [] };
  const passages = [];
  for (const doc of snapshot.docs) {
    const { text, hits } = redactSecrets(doc.text, s.screen.secrets, s.screen.redaction);
    for (const h of hits) screened.secrets.push({ repo: meta.repo, path: doc.rel, line: h.line, rule: h.rule });
    const lines = text.split('\n');
    const chunks = chunkDocument({ lines, units: unitsFor(doc.type, lines, doc.rel), cfg: s.chunker, repo: meta.repo, rel: doc.rel, lang: doc.lang, kind: doc.kind });
    for (const c of chunks) {
      const rule = hostileRule(`${c.sig}\n${c.text}`, s.screen.hostile);
      if (rule) screened.hostile.push({ repo: meta.repo, path: doc.rel, lines: `${c.start}-${c.end}`, rule });
      passages.push({
        flag: rule ? 'hostile' : null, flag_rule: rule,
        uid: sha(JSON.stringify([s.chunker.name, s.chunker.version, meta.repo, doc.rel, c.start, c.end, c.piece, c.text])).slice(0, 32),
        store: meta.repo, repo: meta.repo, path: doc.rel, kind: doc.kind, lang: doc.lang, symbol: c.symbol,
        start_line: c.start, end_line: c.end, piece: c.piece, header: c.header, label: c.label, text: c.text,
        hash: sha(c.text), tokens: c.tokens, standing: standingOf(doc, s), date: meta.date, commit_id: meta.commit,
        ref: null, title: null, subject: [c.header, c.label, c.sig].filter(Boolean).join('\n'),
      });
    }
  }
  let history = null;
  if (snapshot.history) {
    const { units, dropped } = historyUnits(snapshot.history.raw, { repo: meta.repo, owner: snapshot.history.owner, cfg: s.history });
    const rows = [];
    for (const u of units) {
      const { text, hits } = redactSecrets(u.text, s.screen.secrets, s.screen.redaction);
      for (const h of hits) screened.secrets.push({ repo: meta.repo, path: u.path, line: h.line, rule: h.rule });
      const title = redactSecrets(u.title, s.screen.secrets, s.screen.redaction).text;
      const header = redactSecrets(u.header, s.screen.secrets, s.screen.redaction).text;
      const rule = hostileRule(`${title}\n${text}`, s.screen.hostile);
      if (rule) screened.hostile.push({ repo: meta.repo, path: u.path, lines: null, rule });
      rows.push({
        flag: rule ? 'hostile' : null, flag_rule: rule,
        uid: sha(JSON.stringify(['history', meta.repo, u.path, u.piece, text])).slice(0, 32),
        store: `${meta.repo}-history`, repo: meta.repo, path: u.path, kind: u.kind, lang: 'text', symbol: title,
        start_line: null, end_line: null, piece: u.piece, header, label: '', text, hash: sha(text), tokens: null,
        standing: s.history.standing[u.kind], date: u.date, commit_id: meta.commit, ref: u.ref, title, subject: header,
      });
    }
    history = { owner: snapshot.history.owner, rows, dropped };
  }
  return { passages, history, screened };
}
