import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('shared cancellation terminates a real routed writer and releases its effective lock', () => {
  const result = spawnSync('node', ['--import', 'tsx', fileURLToPath(new URL('./fixtures/client-cancel.mjs', import.meta.url))], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    encoding: 'utf8',
    timeout: 20_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain('PASS real-route shared cancellation');
});
