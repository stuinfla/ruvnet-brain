// tests/unit/model-catalog.test.mjs — locks THE WALL (ADR-0016). verify-model-catalog.mjs is the gate
// that stops a model/version fact from ever shipping unverified again; a gate is only trustworthy if it
// is itself tested, so this exercises every failure branch (missing model, wrong price, stale snapshot,
// missing frontier) plus the drift/price helpers. Pure functions, no I/O.
import { describe, it, expect } from 'vitest';
import { verifyCatalog, findModel } from '../../scripts/verify-model-catalog.mjs';
import { priceMap, detectDrift, shapeSnapshot, syncCatalogPrices } from '../../scripts/refresh-model-catalog.mjs';
import { loadCatalog, detectProvider, frontierFor, ladderFor, providerChoices, providerLabel } from '../../scripts/model-catalog.mjs';

const CATALOG = {
  providers: {
    anthropic: { frontier: { model: 'claude-fable-5', in: 10, out: 50 }, mid: { model: 'claude-sonnet-5', in: 2, out: 10 }, cheap: { model: 'claude-haiku-4.5', in: 1, out: 5 } },
    openai: { frontier: { model: 'openai/gpt-5.6-sol', in: 5, out: 30 } },        // frontier-only lineup is allowed
    codex: { aliasOf: 'openai' },                                                  // alias — must be skipped entirely
    xai: { frontier: { model: 'x-ai/grok-4.5', in: 2, out: 6 }, mid: { model: 'x-ai/grok-4.3', in: 1.25, out: 2.5 } },
  },
};
const MODELS = {
  'anthropic/claude-fable-5': { in: 10, out: 50 },
  'anthropic/claude-sonnet-5': { in: 2, out: 10 },
  'anthropic/claude-haiku-4.5': { in: 1, out: 5 },
  'openai/gpt-5.6-sol': { in: 5, out: 30 },
  'x-ai/grok-4.5': { in: 2, out: 6 },
  'x-ai/grok-4.3': { in: 1.25, out: 2.5 },
};
const NOW = new Date('2026-07-15T18:00:00Z').getTime();
const fresh = (models = MODELS, pulledAt = '2026-07-15T12:00:00Z') => ({ pulledAt, models });

describe('verify-model-catalog — the wall', () => {
  it('passes when every catalog model exists at the right price (codex alias skipped, xai has no cheap)', () => {
    const r = verifyCatalog(CATALOG, fresh(), { now: NOW });
    expect(r.ok).toBe(true);
    expect(r.fails).toEqual([]);
    expect(r.checked).toBe(6); // anthropic 3 + openai 1 + xai 2; codex (alias) contributes 0
  });

  it('findModel resolves bare Claude ids via the anthropic/ prefix, slugs directly, unknown → null', () => {
    expect(findModel(MODELS, 'claude-fable-5')).toEqual({ in: 10, out: 50 });
    expect(findModel(MODELS, 'openai/gpt-5.6-sol')).toEqual({ in: 5, out: 30 });
    expect(findModel(MODELS, 'openai/nope')).toBeNull();
  });

  it('REJECTS a fabricated model (the exact failure that shipped)', () => {
    const bad = structuredClone(CATALOG);
    bad.providers.openai.frontier.model = 'openai/gpt-9.9-ultra-imaginary';
    const r = verifyCatalog(bad, fresh(), { now: NOW });
    expect(r.ok).toBe(false);
    expect(r.fails.join('\n')).toMatch(/MISSING: openai\.frontier .*imaginary/);
  });

  it('REJECTS a wrong price beyond tolerance', () => {
    const bad = structuredClone(CATALOG);
    bad.providers.anthropic.frontier.in = 20; // live is 10 → 100% off
    const r = verifyCatalog(bad, fresh(), { now: NOW });
    expect(r.ok).toBe(false);
    expect(r.fails.join('\n')).toMatch(/PRICE: anthropic\.frontier .* in = catalog \$20 vs live \$10/);
  });

  it('accepts a price within the 5% tolerance', () => {
    const near = structuredClone(MODELS);
    near['anthropic/claude-fable-5'] = { in: 10.3, out: 50 }; // 3% off — within tol
    expect(verifyCatalog(CATALOG, fresh(near), { now: NOW }).ok).toBe(true);
  });

  it('REJECTS a stale source (older than maxAgeDays)', () => {
    const r = verifyCatalog(CATALOG, fresh(MODELS, '2026-06-01T00:00:00Z'), { now: NOW });
    expect(r.ok).toBe(false);
    expect(r.fails.join('\n')).toMatch(/STALE/);
  });

  it('flags a provider with no frontier as INCOMPLETE', () => {
    const bad = { providers: { weird: { mid: { model: 'openai/gpt-5.6-sol', in: 5, out: 30 } } } };
    const r = verifyCatalog(bad, fresh(), { now: NOW });
    expect(r.ok).toBe(false);
    expect(r.fails.join('\n')).toMatch(/INCOMPLETE: weird has no frontier/);
  });
});

describe('refresh-model-catalog helpers', () => {
  it('priceMap converts OpenRouter per-token pricing to $/Mtok', () => {
    const m = priceMap([{ id: 'a/b', pricing: { prompt: '0.000005', completion: '0.00003' } }]);
    expect(m).toEqual({ 'a/b': { in: 5, out: 30 } });
  });

  it('detectDrift returns [] when all catalog models exist, names the ones that vanished', () => {
    expect(detectDrift(CATALOG, MODELS)).toEqual([]);
    const gone = { ...MODELS };
    delete gone['x-ai/grok-4.3'];
    expect(detectDrift(CATALOG, gone)).toEqual(['xai.mid "x-ai/grok-4.3"']);
  });

  it('shapeSnapshot stamps modelCount + pulledAt and carries the models map', () => {
    const s = shapeSnapshot(MODELS, '2026-07-15T00:00:00Z');
    expect(s._meta.modelCount).toBe(6);
    expect(s._meta.pulledAt).toBe('2026-07-15T00:00:00Z');
    expect(s.models).toBe(MODELS);
  });

  it('synchronizes catalog prices and provenance from the live snapshot response', () => {
    const catalog = {
      _meta: { sources: { prices: 'stale' } },
      providers: {
        openai: { frontier: { model: 'openai/gpt-test', in: 2.5, out: 15 } },
        codex: { aliasOf: 'openai' },
        anthropic: { cheap: { model: 'claude-test', in: 1, out: 5 } },
      },
    };
    const models = {
      'openai/gpt-test': { in: 2, out: 10 },
      'anthropic/claude-test': { in: 1, out: 5 },
    };

    expect(syncCatalogPrices(catalog, models, '2026-09-04T11:01:15.396Z')).toEqual([
      {
        provider: 'openai', tier: 'frontier', model: 'openai/gpt-test',
        from: { in: 2.5, out: 15 }, to: { in: 2, out: 10 },
      },
    ]);
    expect(catalog.providers.openai.frontier).toMatchObject({ in: 2, out: 10 });
    expect(catalog._meta.sources.prices).toContain('pulled 2026-09-04');
  });
});

describe('model-catalog accessor — per-house personalization over the REAL verified catalog', () => {
  const cat = loadCatalog();

  it('detectProvider: explicit config wins → env API key → default anthropic (Claude Code)', () => {
    expect(detectProvider(cat, { provider: 'openai' })).toEqual({ provider: 'openai', source: 'config' });
    expect(detectProvider(cat, { env: { OPENAI_API_KEY: 'x' } }).provider).toBe('openai');
    expect(detectProvider(cat, { env: { XAI_API_KEY: 'x' } }).provider).toBe('xai');
    expect(detectProvider(cat, { env: {} })).toEqual({ provider: 'anthropic', source: 'default' });
  });

  it('frontierFor personalizes per house; codex aliases to OpenAI Sol; price is real', () => {
    expect(frontierFor(cat, 'anthropic').model).toBe('claude-fable-5');
    expect(frontierFor(cat, 'openai').model).toBe('openai/gpt-5.6-sol');
    expect(frontierFor(cat, 'codex').model).toBe('openai/gpt-5.6-sol'); // aliasOf openai
    expect(frontierFor(cat, 'xai').model).toBe('x-ai/grok-4.5');
    expect(frontierFor(cat, 'anthropic').costPerMTok).toBe(30); // (10 + 50) / 2
  });

  it('ladderFor returns cheap/mid/frontier; xai honestly has no cheap tier', () => {
    const l = ladderFor(cat, 'anthropic');
    expect(l.cheap.model).toBe('claude-haiku-4.5');
    expect(l.mid.model).toBe('claude-sonnet-5');
    expect(l.frontier.model).toBe('claude-fable-5');
    expect(ladderFor(cat, 'xai').cheap).toBeNull();
  });

  it('providerChoices lists the houses; providerLabel resolves the label', () => {
    expect(providerChoices(cat).map((c) => c.id)).toEqual(expect.arrayContaining(['anthropic', 'openai', 'codex', 'google', 'xai']));
    expect(providerLabel(cat, 'anthropic')).toMatch(/Claude/);
    expect(providerLabel(cat, 'codex')).toMatch(/Codex|OpenAI/);
  });
});
