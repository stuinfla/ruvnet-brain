/** ADR-087: syntax-backed source candidates. Unsupported syntax is never a whole-file fallback. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { parseDocument } from 'yaml';
import toml from '@iarna/toml';
import { parse as parseHtml } from 'parse5';
import { parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';
import { XMLValidator } from 'fast-xml-parser';
import { Parser, Language } from 'web-tree-sitter';
import { parse as parseJavaScript } from '@babel/parser';

const require = createRequire(import.meta.url);
const grammarRoot = path.dirname(require.resolve('@vscode/tree-sitter-wasm/package.json'));
export const ADAPTER_VERSION = 'source-adapters/1';
export { languageOf } from './source-language.mjs';
import { languageOf } from './source-language.mjs';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const charToByte = (text, offset) => Buffer.byteLength(text.slice(0, offset), 'utf8');
function span(text, start, end, kind, name, sourceType) {
  return {kind, name, sourceType, startByte:charToByte(text,start), endByte:charToByte(text,end),
    startLine:text.slice(0,start).split('\n').length, endLine:text.slice(0,end).split('\n').length};
}
function whole(text, type) {
  return text.length > 0 ? [span(text,0,text.length,`${type}-document`,null,type)] : [];
}
function markdown(text) {
  const tree = fromMarkdown(text);
  const children = tree.children;
  const starts = [0, ...children.flatMap((n,i)=>n.type==='heading'?[i]:[])];
  const units=[];
  for (const index of [...new Set(starts)]) {
    const node=children[index]; if (!node) continue;
    const heading=node.type==='heading';
    let end=index+1;
    while(end<children.length && children[end].type!=='heading') end++;
    const name=heading?(node.children || []).map(n=>n.value || '').join(''):null;
    const last=children[end-1];
    units.push(span(text,node.position.start.offset,last.position.end.offset,'markdown-section',name,'markdown'));
  }
  return {units,errors:[]};
}

// Named node kinds are the published boundary policy. Comments and empty statements are context,
// not units. Top-level declarations/statements remain candidates; semantic eligibility is reviewed
// against the exact blob before freezing U (unit-inventory owns that disposition).
export const IGNORED_NODE_KINDS = Object.freeze(['comment','line_comment','block_comment','hash_bang_line','empty_statement']);
const STRUCTURED = new Set(['markdown','text','json','jsonc','jsonl','xml','yaml','toml','html','javascript','typescript','tsx']);
let initialized;
const grammars=new Map();
async function grammar(name) {
  initialized ??= Parser.init(); await initialized;
  if (!grammars.has(name)) {
    const file=path.join(grammarRoot,'wasm',`tree-sitter-${name}.wasm`);
    const bytes=fs.readFileSync(file);
    grammars.set(name,{language:await Language.load(bytes),identity:`web-tree-sitter/${hash(bytes)}`});
  }
  return grammars.get(name);
}
function syntaxAdapter(name, loaded) {
  const CONTAINERS = new Set(['class_definition', 'decorated_definition', 'impl_item', 'trait_item', 'mod_item',
    'struct_item', 'enum_item', 'namespace_definition', 'module', 'internal_module']);
  const nodeName = (node) => node.childForFieldName('name')?.text
    || node.childForFieldName('left')?.text || node.childForFieldName('field')?.text
    || (node.type === 'assignment' ? node.namedChildren[0]?.text : null) || null;
  const ownedUnits = (text, node) => {
    if (node.type === 'decorated_definition') {
      const definition = node.childForFieldName('definition');
      return definition ? [span(text, node.startIndex, definition.startIndex, 'decorator-header', null, name), ...ownedUnits(text, definition)] : [span(text, node.startIndex, node.endIndex, node.type, nodeName(node), name)];
    }
    if (!CONTAINERS.has(node.type)) return [span(text, node.startIndex, node.endIndex, node.type,
      nodeName(node), name)];
    const body = node.childForFieldName('body') || node.namedChildren.find((child) =>
      /(?:block|body|list)$/.test(child.type));
    const children = body?.namedChildren?.filter((child) => !IGNORED_NODE_KINDS.includes(child.type)) || [];
    if (!children.length) return [span(text, node.startIndex, node.endIndex, node.type, node.childForFieldName('name')?.text || null, name)];
    const headerEnd = body.startIndex > node.startIndex ? body.startIndex : children[0].startIndex;
    const units = headerEnd > node.startIndex
      ? [span(text, node.startIndex, headerEnd, `${node.type}-header`, nodeName(node), name)] : [];
    for (const child of children) units.push(...ownedUnits(text, child));
    return units;
  };
  return {
    id:`tree-sitter-${name}`, version:ADAPTER_VERSION, parserIdentity:loaded.identity,
    matches:(entry,text)=>languageOf(entry,text)===name,
    enumerate:({text})=>{
      const parser=new Parser(); parser.setLanguage(loaded.language);
      let tree;
      try {
        tree=parser.parse(text);
        if (!tree || tree.rootNode.hasError) return {units:[],errors:[{message:`${name} syntax contains parser errors`,location:null}]};
        const nodes=tree.rootNode.namedChildren.filter(n=>!IGNORED_NODE_KINDS.includes(n.type));
        const units=name==='css'?whole(text,'css'):nodes.flatMap(n=>ownedUnits(text,n));
        return {units,errors:[]};
      } finally {tree?.delete();parser.delete();}
    },
  };
}
function documentAdapter(type) {
  const packageName={jsonc:'jsonc-parser',xml:'fast-xml-parser',markdown:'mdast-util-from-markdown',yaml:'yaml',toml:'@iarna/toml',html:'parse5',javascript:'@babel/parser',typescript:'@babel/parser',tsx:'@babel/parser'}[type];
  return {
    id:`document-${type}`,version:ADAPTER_VERSION,
    parserIdentity:packageName?`${packageName}/${hash(fs.readFileSync(require.resolve(packageName)))}`:`builtin/${type}/1`,
    matches:(entry,text)=>languageOf(entry,text)===type,
    enumerate:({text})=>{
      try {
        if(type==='markdown') return markdown(text);
        if(['javascript','typescript','tsx'].includes(type)) {
          const plugins=['decorators-legacy', ...(type==='typescript'?['typescript']:type==='tsx'?['typescript','jsx']:['jsx'])];
          const tree=parseJavaScript(text,{sourceType:'unambiguous',plugins});
          const nodes=[...tree.program.directives,...tree.program.body].filter(n=>n.type!=='EmptyStatement');
          const owned=(node)=>{
            const declaration=node.declaration || node;
            const body=declaration.body;
            if (declaration.type==='TSModuleDeclaration' && body?.type==='TSModuleDeclaration') {
              return [span(text,node.start,body.start,'TSModuleDeclaration-header',declaration.id?.name || null,type), ...owned(body)];
            }
            const members=Array.isArray(body?.body) ? body.body.filter(member=>member.type!=='EmptyStatement') : [];
            const container=declaration.type==='ClassDeclaration' || declaration.type==='TSModuleDeclaration';
            const object=declaration.type==='VariableDeclaration' && declaration.declarations.length===1
              && declaration.declarations[0].init?.type==='ObjectExpression' ? declaration.declarations[0].init : null;
            if(object && object.properties.length) {
              const units=[span(text,node.start,object.start,'ObjectHeader',declaration.declarations[0].id?.name || null,type)];
              for(const member of object.properties) units.push(span(text,member.start,member.end,member.type,
                member.key?.name || member.key?.value || null,type));
              return units;
            }
            const declarationName=declaration.id?.name || declaration.key?.name || declaration.key?.value || declaration.declarations?.map(item=>item.id?.name).filter(Boolean).join(',') || null;
            if(!container || !members.length) return [span(text,node.start,node.end,node.type,declarationName,type)];
            const units=[span(text,node.start,body.start,`${declaration.type}-header`,declarationName,type)];
            for(const member of members) units.push(...owned(member));
            return units;
          };
          const units=nodes.flatMap(owned);
          return {units,errors:[]};
        }
        if(type==='json') JSON.parse(text.replace(/^\uFEFF/, ''));
        if(type==='jsonl') for(const line of text.split('\n').filter(line=>line.trim())) JSON.parse(line);
        if(type==='jsonc') {
          const errors=[];parseJsonc(text.replace(/^\uFEFF/, ''),errors,{allowTrailingComma:true});
          if(errors.length) throw new Error(errors.map(error=>printParseErrorCode(error.error)).join('; '));
        }
        if(type==='xml') {const valid=XMLValidator.validate(text);if(valid!==true) throw new Error(valid.err.msg);}
        if(type==='yaml') {const doc=parseDocument(text);if(doc.errors.length) throw new Error(doc.errors.map(e=>e.message).join('; '));}
        if(type==='toml') toml.parse(text);
        if(type==='html') {
          const errors=[];
          parseHtml(text,{onParseError:e=>{if(e.code!=='missing-doctype')errors.push(e.code);}});
          if(errors.length) throw new Error(errors.join('; '));
        }
        return {units:whole(text,type),errors:[]};
      } catch(error) {return {units:[],errors:[{message:error.message,location:null}]};}
    },
  };
}
export async function createSourceAdapters({manifest,blobs}) {
  const languages=[...new Set(manifest.entries.map(entry=>languageOf(entry,blobs.get(entry.objectSha)?.toString('utf8'))).filter(Boolean))].sort();
  const adapters=[];
  for(const name of languages) {
    try { adapters.push(STRUCTURED.has(name)?documentAdapter(name):syntaxAdapter(name,await grammar(name))); }
    catch(error) { adapters.push({ id:`unavailable-${name}`, version:ADAPTER_VERSION, parserIdentity:'unavailable',
      matches:(entry,text)=>languageOf(entry,text)===name, enumerate:()=>({units:[],errors:[{message:`parser unavailable: ${error.message}`,location:null}]}) }); }
  }
  return adapters;
}
