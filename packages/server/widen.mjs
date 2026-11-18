// What a search adds to the installed pack's answer, inside the worker thread:
// 1. Private packs (<home>/private/<name>/): each is searched with the caller's project folder, and the
//    engine's scope check answers only from a project on the pack's list. A folder in private/ that
//    does not say `access: "private"` is not searched at all (fail closed). A private pack that was not
//    searched leaves no trace in the answer, not even its name.
// 2. Extra terms (the caller's technical phrasings): only when the recipe switches the merging rule on
//    (`query.extraTerms: "append"`). The question as given is always searched and its items keep their
//    places and bytes; extra items only fill free item slots and leftover budget, never outrank.
import fs from 'node:fs';
import path from 'node:path';

const ROOM_PER_ITEM = 400; // the citation, flag and fence lines around one excerpt
const RESULT_SLACK = 2000; // header, mode and notes

/** A folder with its symbolic links resolved, or as given when it does not exist. */
export function real(p) {
  try {
    return fs.realpathSync(String(p));
  } catch {
    return String(p);
  }
}

/** The private packs, in name order. The folder and each PACK.json are read again on every call, and a
 *  pack whose PACK.json changed is opened again (or dropped), so an edited project list applies to the
 *  next question (review F08). */
export function openPrivates(engine, privates, dir) {
  const open = (privates.open ??= new Map()); // name -> { text, h }
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {}
  for (const [name, p] of open) if (!names.includes(name) && (open.delete(name), p.h)) engine.close(p.h);
  const list = [];
  for (const name of names) {
    let text = null;
    try {
      text = fs.readFileSync(path.join(dir, name, 'PACK.json'), 'utf8');
    } catch {}
    let p = open.get(name);
    if (!p || p.text !== text) {
      if (p?.h) engine.close(p.h);
      p = { text, h: null };
      open.set(name, p);
      try {
        p.h = engine.open(path.join(dir, name));
      } catch {
        continue;
      }
      // The caller's folder arrives as a real path (symbolic links resolved); so do the listed ones.
      if (p.h.pack.access === 'private' && Array.isArray(p.h.pack.projects)) p.h.pack.projects = p.h.pack.projects.map(real);
      else (engine.close(p.h), (p.h = null));
    }
    if (p.h) list.push({ name, h: p.h });
  }
  return list;
}

const excerptChars = (items) => items.reduce((n, it) => n + it.excerpt.length + ROOM_PER_ITEM, 0);

function addPrivate(engine, handle, privates, m, result) {
  if (!m.privateDir || !m.options?.project) return;
  const merged = new Set();
  for (const p of openPrivates(engine, privates, m.privateDir)) {
    const r = engine.search(p.h, m.query, m.options);
    for (const sec of r.sections) {
      const target = result.sections.find((s) => s.name === sec.name);
      if (!target || !sec.items.length) continue;
      // Cited with its pack, never mistaken for a public file (review F17): private:<name>/<repo>/<path>.
      target.items.push(...sec.items.map((it) => ({ ...it, repo: `private:${p.name}/${it.repo}` })));
      target.empty = null;
      merged.add(target);
    }
  }
  // A section that took private items is merged under the section's rules (review F17): ranked by score (bm25, lower first), one item per
  // file, at most maxItems.
  for (const sec of merged) {
    const max = handle.recipe.sections.find((s) => s.name === sec.name)?.maxItems ?? sec.items.length;
    const rank = (it) => (Number.isFinite(it.score) ? it.score : Infinity);
    const files = new Set();
    sec.items = sec.items.map((it, i) => [it, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([it]) => it).filter((it) => !files.has(`${it.repo}/${it.path}`) && files.add(`${it.repo}/${it.path}`)).slice(0, max);
  }
}

function addExtra(engine, handle, m, result) {
  const terms = m.extraTerms ?? [];
  if (!terms.length || handle.recipe.query?.extraTerms !== 'append') return;
  const lists = terms.map((t) => ({ term: t, r: engine.search(handle, t, m.options) }));
  const cap = handle.recipe.result.capChars[result.detail];
  let total = excerptChars(result.sections.flatMap((s) => s.items)) + RESULT_SLACK;
  for (const sec of result.sections) {
    const spec = handle.recipe.sections.find((s) => s.name === sec.name);
    if (!spec) continue;
    const budget = spec.budgetChars[result.detail];
    let used = excerptChars(sec.items);
    const files = new Set(sec.items.map((it) => `${it.repo}/${it.path}`));
    const hashes = new Set(sec.items.map((it) => it.hash));
    const queues = lists.map(({ term, r }) => ({ term, items: [...(r.sections.find((s) => s.name === sec.name)?.items ?? [])] }));
    // Round robin over the extra lists, so no one term crowds out the others.
    while (sec.items.length < spec.maxItems && queues.some((q) => q.items.length)) {
      for (const q of queues) {
        if (sec.items.length >= spec.maxItems) break;
        const it = q.items.shift();
        if (!it || files.has(`${it.repo}/${it.path}`) || hashes.has(it.hash)) continue;
        const need = it.excerpt.length + ROOM_PER_ITEM;
        if (used + need > budget || total + need > cap) continue;
        files.add(`${it.repo}/${it.path}`);
        hashes.add(it.hash);
        sec.items.push({ ...it, via: q.term });
        used += need;
        total += need;
        sec.empty = null;
      }
    }
  }
}

export function widen(engine, handle, privates, m, result) {
  addPrivate(engine, handle, privates, m, result);
  addExtra(engine, handle, m, result);
  return result;
}
