// Embed one text with the corpus' pinned embedder in a FRESH process and print the sha256 of the
// raw float32 bytes. Used by tests/unit/rvf-store-audit.test.mjs to prove cross-process embedding
// determinism — the assumption the passage<->vector probe rests on. Config mirrors kb/forge-big.mjs
// (pinned model + revision, cls pooling, normalized, quantized, passages embedded with NO prefix).
import crypto from 'node:crypto';
import { createPassageEmbedder } from '../../scripts/rvf-index-audit.mjs';

const [text] = process.argv.slice(2);
const embed = await createPassageEmbedder({
  model: 'Xenova/bge-base-en-v1.5',
  revision: '4d6cd88e18e51a5e020c2c305726d76ada9c03cf',
  pooling: 'cls',
  normalize: true,
});
const [vector] = await embed([text]);
process.stdout.write(crypto.createHash('sha256').update(Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)).digest('hex'));
