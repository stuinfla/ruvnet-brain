// Turns a title into a URL slug.
export function slugify(title) {
  return String(title).trim().toLowerCase().replace(/\s+/g, '-');
}
