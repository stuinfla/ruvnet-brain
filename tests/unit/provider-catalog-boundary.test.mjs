import { describe, expect, it } from 'vitest';
import { providerAvailability } from '../../scripts/provider-availability.mjs';
import { gatherRouterEngine } from '../../scripts/onboarding-console.mjs';

describe('issue #86 — provider catalog boundary', () => {
  it('detects OpenAI and both Google aliases without returning credential values', () => {
    const catalog = {
      providers: {
        openai: { detect_env: ['OPENAI_API_KEY'] },
        google: { detect_env: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'] },
      },
    };
    const result = providerAvailability(catalog, {}, {
      OPENAI_API_KEY: 'dummy-openai-secret',
      GEMINI_API_KEY: 'dummy-gemini-secret',
    });
    expect(result).toEqual({ openai: true, google: true });
    expect(JSON.stringify(result)).not.toContain('dummy');
  });

  it('uses boolean native subscription detections in degraded mode and keeps negative controls false', () => {
    expect(providerAvailability(null, {
      openai: { apiKey: true },
      google: { apiKey: true },
      anthropic: { subscription: true },
    }, {})).toEqual({ openai: true, google: true, anthropic: false });
    expect(providerAvailability({ providers: { openai: { detect_env: ['OPENAI_API_KEY'] } } }, {}, {}))
      .toEqual({ openai: false });
  });

  it('the Console API read model exposes degraded catalog health without false-negative keys', () => {
    const before = {
      catalog: process.env.RUVNET_MODEL_CATALOG,
      openai: process.env.OPENAI_API_KEY,
      google: process.env.GOOGLE_API_KEY,
    };
    process.env.RUVNET_MODEL_CATALOG = '/definitely/missing/model-catalog.json';
    process.env.OPENAI_API_KEY = 'dummy-openai';
    process.env.GOOGLE_API_KEY = 'dummy-google';
    try {
      const result = gatherRouterEngine();
      expect(result.providerCatalog.status).toBe('degraded');
      expect(result.keys).toMatchObject({ openai: true, google: true });
      expect(JSON.stringify(result)).not.toContain('dummy-openai');
      expect(JSON.stringify(result)).not.toContain('dummy-google');
    } finally {
      if (before.catalog === undefined) delete process.env.RUVNET_MODEL_CATALOG; else process.env.RUVNET_MODEL_CATALOG = before.catalog;
      if (before.openai === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = before.openai;
      if (before.google === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = before.google;
    }
  });
});
