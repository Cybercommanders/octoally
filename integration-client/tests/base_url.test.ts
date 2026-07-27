import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { DEFAULT_BASE_URL, OctoAllyClient, resolveBaseUrl } from '../octoally_research_session.ts';

const ENV_KEYS = ['OCTOALLY_BASE_URL', 'PORT'] as const;

function withEnv(overrides: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) {
  for (const key of ENV_KEYS) {
    const value = overrides[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => withEnv({ OCTOALLY_BASE_URL: undefined, PORT: undefined }));

describe('base URL resolution', () => {
  test('falls back to the real server port, not 3000', () => {
    withEnv({ OCTOALLY_BASE_URL: undefined, PORT: undefined });
    assert.equal(resolveBaseUrl(), 'http://127.0.0.1:42010');
    assert.equal(DEFAULT_BASE_URL, 'http://127.0.0.1:42010');
  });

  test('PORT overrides the default port', () => {
    withEnv({ PORT: '43999' });
    assert.equal(resolveBaseUrl(), 'http://127.0.0.1:43999');
  });

  test('OCTOALLY_BASE_URL wins over PORT', () => {
    withEnv({ OCTOALLY_BASE_URL: 'http://octoally.internal:8080', PORT: '43999' });
    assert.equal(resolveBaseUrl(), 'http://octoally.internal:8080');
  });

  test('trailing slashes are stripped from the env value', () => {
    withEnv({ OCTOALLY_BASE_URL: 'http://127.0.0.1:42010///' });
    assert.equal(resolveBaseUrl(), 'http://127.0.0.1:42010');
  });

  test('a non-numeric PORT is ignored rather than producing a broken URL', () => {
    withEnv({ PORT: 'not-a-port' });
    assert.equal(resolveBaseUrl(), 'http://127.0.0.1:42010');
  });

  test('an out-of-range PORT is ignored', () => {
    withEnv({ PORT: '70000' });
    assert.equal(resolveBaseUrl(), 'http://127.0.0.1:42010');
  });

  test('an explicit baseUrl option still wins over the environment', () => {
    withEnv({ OCTOALLY_BASE_URL: 'http://from-env:1234' });
    const client = new OctoAllyClient({ baseUrl: 'http://explicit:9999/' });
    assert.equal(client.baseUrl, 'http://explicit:9999');
  });

  test('a client with no options picks up the environment', () => {
    withEnv({ OCTOALLY_BASE_URL: 'http://from-env:1234' });
    assert.equal(new OctoAllyClient().baseUrl, 'http://from-env:1234');
  });
});
