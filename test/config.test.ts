import { describe, expect, it } from 'vitest';
import {
  configFromEnv,
  OPENROUTER_DECISIONS_URL,
  OPENROUTER_JEV_MODEL,
} from '../src/shared/config.js';
import { DEFAULT_MODEL, SYSTEM_ONE_URL } from '../src/vendor/fast-jev-compaction/index.js';

describe('configFromEnv provider resolution', () => {
  it('defaults to typesafe with its endpoint and model', () => {
    const config = configFromEnv({ TYPESAFE_API_KEY: 'ts-key' });
    expect(config.provider).toBe('typesafe');
    expect(config.apiKey).toBe('ts-key');
    expect(config.baseUrl).toBe(SYSTEM_ONE_URL);
    expect(config.model).toBe(DEFAULT_MODEL);
  });

  it('auto-detects openrouter when only OPENROUTER_API_KEY is set', () => {
    const config = configFromEnv({ OPENROUTER_API_KEY: 'or-key' });
    expect(config.provider).toBe('openrouter');
    expect(config.apiKey).toBe('or-key');
    expect(config.baseUrl).toBe(OPENROUTER_DECISIONS_URL);
    expect(config.model).toBe(OPENROUTER_JEV_MODEL);
  });

  it('prefers typesafe when both keys are present', () => {
    const config = configFromEnv({ TYPESAFE_API_KEY: 'ts', OPENROUTER_API_KEY: 'or' });
    expect(config.provider).toBe('typesafe');
    expect(config.apiKey).toBe('ts');
  });

  it('honours an explicit JEVC_PROVIDER over auto-detection', () => {
    const config = configFromEnv({ JEVC_PROVIDER: 'openrouter', TYPESAFE_API_KEY: 'ts', OPENROUTER_API_KEY: 'or' });
    expect(config.provider).toBe('openrouter');
    expect(config.apiKey).toBe('or');
    expect(config.model).toBe(OPENROUTER_JEV_MODEL);
  });

  it('reads the openrouter key for an explicitly openrouter provider', () => {
    const config = configFromEnv({ JEVC_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'or' });
    expect(config.provider).toBe('openrouter');
    expect(config.apiKey).toBe('or');
  });

  it('keeps JEVC_API_KEY provider-neutral (no accidental openrouter switch)', () => {
    const config = configFromEnv({ JEVC_API_KEY: 'custom-key' });
    expect(config.provider).toBe('typesafe');
    expect(config.apiKey).toBe('custom-key');
  });

  it('lets JEVC_API_KEY ride along with an explicit provider', () => {
    const config = configFromEnv({ JEVC_PROVIDER: 'openrouter', JEVC_API_KEY: 'custom-or-key' });
    expect(config.provider).toBe('openrouter');
    expect(config.apiKey).toBe('custom-or-key');
    expect(config.baseUrl).toBe(OPENROUTER_DECISIONS_URL);
  });

  it('ignores an invalid provider value and falls back to detection', () => {
    const config = configFromEnv({ JEVC_PROVIDER: 'nonsense', OPENROUTER_API_KEY: 'or' });
    expect(config.provider).toBe('openrouter');
  });

  it('leaves the key empty when the declared provider has no key', () => {
    const config = configFromEnv({ JEVC_PROVIDER: 'typesafe', OPENROUTER_API_KEY: 'or' });
    expect(config.provider).toBe('typesafe');
    expect(config.apiKey).toBe(''); // hooks stay inert
  });

  it('applies JEVC_MODEL and JEVC_BASE_URL overrides on either provider', () => {
    const typesafe = configFromEnv({ TYPESAFE_API_KEY: 'ts', JEVC_MODEL: 'jev-1.13', JEVC_BASE_URL: 'https://proxy.example/v1/systemone' });
    expect(typesafe.model).toBe('jev-1.13');
    expect(typesafe.baseUrl).toBe('https://proxy.example/v1/systemone');

    const openrouter = configFromEnv({ OPENROUTER_API_KEY: 'or', JEVC_MODEL: 'typesafe/jev-1.13' });
    expect(openrouter.model).toBe('typesafe/jev-1.13');

    // Default OpenRouter slug is the versioned model that actually exists there.
    const openrouterDefault = configFromEnv({ OPENROUTER_API_KEY: 'or' });
    expect(openrouterDefault.model).toBe('typesafe/jev-1.13');
    expect(openrouter.baseUrl).toBe(OPENROUTER_DECISIONS_URL);
  });
});
