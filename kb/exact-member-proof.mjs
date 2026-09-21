import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PARSEABLE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']);

function topLevelClasses(program) {
  const classes = [];
  for (const statement of program.body) {
    if (statement.type === 'ClassDeclaration') classes.push(statement);
    else if (statement.type === 'ExportNamedDeclaration'
      || statement.type === 'ExportDefaultDeclaration') {
      if (statement.declaration?.type === 'ClassDeclaration') classes.push(statement.declaration);
    }
  }
  return classes;
}

/**
 * Prove a direct, concrete JS/TS class method declaration. Unsupported languages, parser
 * unavailability, malformed snippets, declarations, overload signatures, and indirect matches
 * fail closed. This intentionally does not claim exact-member proof for Rust or other languages.
 */
export function hasConcreteClassMethod(sourceText, filePath, { owner, member }) {
  const extension = path.extname(String(filePath || '').split(/[?#]/, 1)[0]).toLowerCase();
  if (!PARSEABLE_EXTENSIONS.has(extension)) return false;

  let parse;
  try {
    ({ parse } = require('@babel/parser'));
  } catch {
    return false;
  }

  let ast;
  try {
    ast = parse(String(sourceText || ''), {
      sourceType: 'unambiguous',
      errorRecovery: false,
      plugins: ['typescript', 'jsx'],
    });
  } catch {
    return false;
  }

  return topLevelClasses(ast.program).some((declaration) => {
    if (declaration.id?.name !== owner || declaration.declare || declaration.abstract) return false;
    return declaration.body.body.some((element) =>
      element.type === 'ClassMethod'
      && element.kind === 'method'
      && element.computed === false
      && element.key?.type === 'Identifier'
      && element.key.name === member
      && element.body?.type === 'BlockStatement');
  });
}
