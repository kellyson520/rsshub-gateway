import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Compose enables the bounded E-Hentai cold-start defaults', async () => {
  const compose = await readFile(new URL('../docker-compose.yml', import.meta.url), 'utf8');

  assert.match(compose, /EH_COLD_START_ENABLED:\s*"true"/);
  assert.match(compose, /EH_FIRST_DETAIL_BUDGET_MS:\s*"1200"/);
});
