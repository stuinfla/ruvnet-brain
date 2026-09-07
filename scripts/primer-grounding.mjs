import fs from 'node:fs';
import path from 'node:path';

// Citation presence is an admission check, not semantic verification of each generated claim.
export function countPrimerReferences(primer, sourcePaths) {
  const paths = [...new Set(sourcePaths)].filter((value) => typeof value === 'string' && value);
  const citations = new Set([...primer.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]));
  const basenames = new Map();
  for (const file of paths) basenames.set(path.basename(file), (basenames.get(path.basename(file)) || 0) + 1);
  return paths.filter((file) => citations.has(file)
    || (basenames.get(path.basename(file)) === 1 && citations.has(path.basename(file))));
}

export function writeGroundedPrimer({ primer, sourcePaths, output, minimum = 6 }) {
  if (!Number.isInteger(minimum) || minimum < 1) throw new Error('invalid primer citation minimum');
  const refs = countPrimerReferences(primer, sourcePaths);
  if (refs.length < minimum) throw new Error(`THIN primer: ${refs.length} distinct source citations; requires ${minimum}. Existing primer preserved.`);
  fs.writeFileSync(output, primer);
  return refs;
}
