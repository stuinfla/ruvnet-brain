import { rerankPairs, ceWorkerStats } from '../../kb/forge-rerank.mjs';
const docs = Array.from({ length: 24 }, (_, i) => ({ path: `p${i}`, fullText: `Source-grounded retrieval passage ${i}.` }));
await rerankPairs('retrieval', docs);
process.send(ceWorkerStats());
setInterval(() => {}, 1000);
