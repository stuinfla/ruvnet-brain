// Capitalises the first letter of every word.
export function titleCase(text) {
  return String(text).split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
