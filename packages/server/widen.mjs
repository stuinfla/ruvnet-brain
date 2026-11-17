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

/** The private packs, opened once per worker, in name order. */
export function openPrivates(engine, privates, dir) {
  if (privates.list) return privates.list;
  privates.list = [];
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {}
  for (const name of names) {
    let h = null;
    try {
      h = engine.open(path.join(dir, name));
    } catch {
      continue;
    }
    if (h.pack.access === 'private' && Array.isArray(h.pack.projects)) {
      // The caller's folder arrives as a real path (symbolic links resolved); so do the listed ones.
      h.pack.projects = h.pack.projects.map(real);
      privates.list.push({ name, h });
    } else engine.close(h);
  }
  return privates.list;
}

const excerptChars = (items) => items.reduce((n, it) => n + it.excerpt.length + ROOM_PER_ITEM, 0);

function addPrivate(engine, handle, privates, m, result) {
  if (!m.privateDir || !m.options?.project) return;
  for (const p of openPrivates(engine, privates, m.privateDir)) {
    const r = engine.search(p.h, m.query, m.options);
    for (const sec of r.sections) {
      const target = result.sections.find((s) => s.name === sec.name);
      if (!target || !sec.items.length) continue;
      target.items.push(...sec.items);
      target.empty = null;
    }
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
