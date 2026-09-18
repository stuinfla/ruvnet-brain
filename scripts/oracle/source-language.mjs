/** Shared source modality recognition for enumeration and binary classification. */
import path from 'node:path';
const EXTENSIONS = Object.freeze({
  '.md':'markdown', '.markdown':'markdown', '.txt':'text', '.rst':'text',
  '.js':'javascript', '.mjs':'javascript', '.cjs':'javascript', '.jsx':'javascript',
  '.ts':'typescript', '.mts':'typescript', '.cts':'typescript', '.tsx':'tsx',
  '.rs':'rust', '.py':'python', '.go':'go', '.java':'java', '.cs':'c-sharp',
  '.c':'cpp', '.h':'cpp', '.cc':'cpp', '.cpp':'cpp', '.hpp':'cpp', '.cxx':'cpp',
  '.sh':'bash', '.bash':'bash', '.ps1':'powershell', '.rb':'ruby', '.php':'php',
  '.css':'css', '.json':'json', '.yml':'yaml', '.yaml':'yaml', '.toml':'toml',
  '.html':'html', '.htm':'html', '.svg':'xml', '.xml':'xml', '.plist':'xml',
  '.jsonc':'jsonc', '.jsonl':'jsonl', '.ini':'text', '.conf':'text', '.pem':'text',
});
export function languageOf(entry, text = '') {
  const base = path.posix.basename(entry.path);
  if (/^(?:tsconfig|jsconfig)(?:\.[^.]+)?\.json$/.test(base) || /(?:^|\/)(?:\.vscode|\.devcontainer)\/[^/]+\.json$/.test(entry.path)) return 'jsonc';
  if (['.gitignore','.vercelignore','.dockerignore','.npmignore','.npmrc','.editorconfig','.gitattributes','CODEOWNERS'].includes(base)) return 'text';
  const language = EXTENSIONS[path.posix.extname(entry.path).toLowerCase()];
  if (language) return language;
  if (/^#![^\n]*\b(?:ba|z|k)?sh\b/.test(text)) return 'bash';
  if (/^#![^\n]*\bpython[\d.]*\b/.test(text)) return 'python';
  return null;
}
