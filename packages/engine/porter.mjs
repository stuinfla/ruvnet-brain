// Porter (1980) stemmer, ported line for line from the keyword analyser the retrieval run measured
// (source path in the work-package report). Kept identical on purpose, quirks included: the engine
// must cut words exactly as the measured lane did, or its score is not the measured score.

function isCons(s, i) {
  const c = s[i];
  if (c === 'a' || c === 'e' || c === 'i' || c === 'o' || c === 'u') return false;
  if (c === 'y') return i === 0 ? true : !isCons(s, i - 1);
  return true;
}

function measure(s) {
  let n = 0;
  let i = 0;
  while (i < s.length && isCons(s, i)) i++;
  while (i < s.length) {
    while (i < s.length && !isCons(s, i)) i++;
    if (i >= s.length) return n;
    n++;
    while (i < s.length && isCons(s, i)) i++;
  }
  return n;
}

function containsVowel(s) {
  for (let i = 0; i < s.length; i++) if (!isCons(s, i)) return true;
  return false;
}

function endsDoubleCons(s) {
  if (s.length < 2) return false;
  if (s[s.length - 2] !== s[s.length - 1]) return false;
  return isCons(s, s.length - 1);
}

function endsCvc(s) {
  if (s.length < 3) return false;
  if (!isCons(s, s.length - 3) || isCons(s, s.length - 2) || !isCons(s, s.length - 1)) return false;
  const last = s[s.length - 1];
  return !(last === 'w' || last === 'x' || last === 'y');
}

function replace(word, suffix, replacement, minM) {
  if (!word.endsWith(suffix)) return null;
  const stem = word.slice(0, word.length - suffix.length);
  return measure(stem) > minM ? stem + replacement : null;
}

function step1a(w) {
  if (w.endsWith('sses')) return w.slice(0, -2);
  if (w.endsWith('ies')) return w.slice(0, -2);
  if (w.endsWith('ss')) return w;
  if (w.endsWith('s')) return w.slice(0, -1);
  return w;
}

function step1b(w) {
  if (w.endsWith('eed')) {
    const stem = w.slice(0, -3);
    return measure(stem) > 0 ? stem + 'ee' : w;
  }
  let stem = null;
  if (w.endsWith('ed')) {
    const s = w.slice(0, -2);
    if (containsVowel(s)) stem = s;
  } else if (w.endsWith('ing')) {
    const s = w.slice(0, -3);
    if (containsVowel(s)) stem = s;
  }
  if (stem === null) return w;
  if (stem.endsWith('at') || stem.endsWith('bl') || stem.endsWith('iz')) return stem + 'e';
  if (endsDoubleCons(stem)) {
    const last = stem[stem.length - 1];
    return last !== 'l' && last !== 's' && last !== 'z' ? stem.slice(0, -1) : stem;
  }
  if (measure(stem) === 1 && endsCvc(stem)) return stem + 'e';
  return stem;
}

function step1c(w) {
  if (w.endsWith('y') && w.length > 1) {
    const stem = w.slice(0, -1);
    if (/[aeiouy]/.test(stem) && stem.split('').some((_, i) => !isCons(stem, i))) return stem + 'i';
  }
  return w;
}

const STEP2 = [
  ['ational', 'ate'], ['tional', 'tion'], ['enci', 'ence'], ['anci', 'ance'], ['izer', 'ize'], ['abli', 'able'],
  ['alli', 'al'], ['entli', 'ent'], ['eli', 'e'], ['ousli', 'ous'], ['ization', 'ize'], ['ation', 'ate'],
  ['ator', 'ate'], ['alism', 'al'], ['iveness', 'ive'], ['fulness', 'ful'], ['ousness', 'ous'], ['aliti', 'al'],
  ['iviti', 'ive'], ['biliti', 'ble'],
];
const STEP3 = [['icate', 'ic'], ['ative', ''], ['alize', 'al'], ['iciti', 'ic'], ['ical', 'ic'], ['ful', ''], ['ness', '']];

function rules(w, table) {
  for (const [suf, rep] of table) {
    const r = replace(w, suf, rep, 0);
    if (r !== null) return r;
  }
  return w;
}

// Longest suffix first; a failed condition does not fall through to a shorter suffix.
const STEP4 = ['ement', 'ance', 'ence', 'able', 'ible', 'ment', 'ant', 'ent', 'ism', 'ate', 'iti', 'ous', 'ive', 'ize', 'ion', 'al', 'er', 'ic', 'ou'];

function step4(w) {
  for (const suf of STEP4) {
    if (!w.endsWith(suf)) continue;
    const stem = w.slice(0, w.length - suf.length);
    if (measure(stem) > 1) {
      if (suf !== 'ion') return stem;
      const last = stem[stem.length - 1];
      if (last === 's' || last === 't') return stem;
    }
    return w;
  }
  return w;
}

function step5a(w) {
  if (w.endsWith('e')) {
    const stem = w.slice(0, -1);
    const m = measure(stem);
    if (m > 1) return stem;
    if (m === 1 && !endsCvc(stem)) return stem;
  }
  return w;
}

function step5b(w) {
  return w.endsWith('ll') && measure(w) > 1 ? w.slice(0, -1) : w;
}

/** Stems one lowercase token. Words of two characters or fewer are returned unchanged. */
export function porterStem(word) {
  if (word.length <= 2) return word;
  return step5b(step5a(step4(rules(rules(step1c(step1b(step1a(word))), STEP2), STEP3))));
}
