import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageVariant } from '../src/image-variants.js';

test('rejects unsupported widths before decoding', async () => {
  await assert.rejects(
    createImageVariant({ body: Buffer.from('source'), contentType: 'image/webp', width: 1600 }),
    (error) => error.code === 'IMAGE_VARIANT_UNSUPPORTED_WIDTH',
  );
});

test('returns the original body when the derived WebP is not smaller', async () => {
  const source = Buffer.from('small-source');
  const result = await createImageVariant({
    body: source,
    contentType: 'image/webp',
    width: 1280,
    encoder: async () => source,
  });
  assert.equal(result.usedVariant, false);
  assert.deepEqual(result.body, source);
});

test('returns a high-quality WebP only when it reduces transfer bytes', async () => {
  const result = await createImageVariant({
    body: Buffer.from('larger-source-image'),
    contentType: 'image/jpeg',
    width: 1920,
    encoder: async ({ options }) => {
      assert.deepEqual(options, { quality: 92, nearLossless: true, effort: 4, smartSubsample: false });
      return Buffer.from('smaller');
    },
  });
  assert.equal(result.usedVariant, true);
  assert.equal(result.contentType, 'image/webp');
  assert.deepEqual(result.body, Buffer.from('smaller'));
});
