#!/usr/bin/env node
// gen-images.mjs — generate a cohesive set of explainer images (OpenAI gpt-image-1, fallback dall-e-3).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'explainer/assets/img');
fs.mkdirSync(OUT, { recursive: true });
const RAWKEY = process.env.OPENAI_API_KEY || (fs.readFileSync((process.env.RUVNET_ENV_FILE || '.env'), 'utf8').match(/^OPENAI_API_KEY=(.+)$/m) || [])[1] || '';
const KEY = (RAWKEY.match(/sk-[A-Za-z0-9_\-]+/) || [''])[0];   // first valid token only — handles dup lines / whitespace
if (!KEY) { console.error('no OPENAI_API_KEY'); process.exit(2); }
const redact = (s) => String(s).replace(/sk-[A-Za-z0-9_\-]+/g, 'sk-***');   // never let a key reach logs

const STYLE = ' — Style: dark near-black background (#0b0d0f) with a faint blueprint grid, sophisticated premium editorial-tech aesthetic, restrained warm amber (#f0a830) and cool cyan (#5ad6ff) accent light only, cinematic volumetric glow, fine detail, high craft, elegant and confident. Absolutely NO text, NO words, NO letters, NO numbers, NO UI chrome, NO logos.';

const IMAGES = [
  { slug: 'hero', size: '1536x1024', p: 'A luminous intricate three-dimensional structure resembling a brain fused with a vast interconnected codebase: thousands of glowing amber and cyan filaments forming one elegant organized sphere of intelligence, floating in dark space, a sense of all knowledge made orderly and alive.' },
  { slug: 'problem-skim', size: '1536x1024', p: 'A vast deep canyon made of densely stacked layers of code and documents descending far into darkness; a single small fragile light hovers at the very top only grazing the surface, never reaching the immense depth below. The feeling of skimming and missing everything underneath.' },
  { slug: 'point-deeper', size: '1536x1024', p: 'One precise clean beam of warm amber light cutting straight down through many deep translucent strata of a vast structure to perfectly illuminate a single exact point far below; surgical precision locating the one true answer in the depths.' },
  { slug: 'architecture', size: '1536x1024', p: 'An elegant isometric exploded view of five translucent glass layers floating one above another in dark space, each a slightly different luminous tone, joined by thin vertical conduits of light; a refined premium product render of a clean layered system.' },
  { slug: 'proof', size: '1536x1024', p: 'Three distinct elegant luminous measuring instruments aim converging beams of light onto a single crystalline object at center that glows confident green, while one beam exposes a hidden flaw glowing warning red; independent rigorous verification against a single source of truth.' },
];

async function gen(model, prompt, size) {
  const body = model === 'gpt-image-1'
    ? { model, prompt, size, quality: 'high', n: 1 }
    : { model, prompt, size: size === '1536x1024' ? '1792x1024' : '1024x1024', response_format: 'b64_json', n: 1 };
  const r = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${model} HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const j = await r.json();
  return j.data[0].b64_json;
}

for (const im of IMAGES) {
  const prompt = im.p + STYLE;
  let b64;
  try { b64 = await gen('gpt-image-1', prompt, im.size); console.log(`✓ ${im.slug} (gpt-image-1)`); }
  catch (e) {
    console.log(`  gpt-image-1 failed for ${im.slug}: ${redact(e.message)} — trying dall-e-3`);
    try { b64 = await gen('dall-e-3', prompt, im.size); console.log(`✓ ${im.slug} (dall-e-3)`); }
    catch (e2) { console.error(`✗ ${im.slug}: ${redact(e2.message)}`); continue; }
  }
  fs.writeFileSync(path.join(OUT, `${im.slug}.png`), Buffer.from(b64, 'base64'));
}
console.log('done →', OUT);
