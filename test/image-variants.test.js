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

test('returns original when content type is unsupported, empty, or encoder throws', async () => {
  const gifSource = Buffer.from('gif-bytes');
  const unsupportedType = await createImageVariant({
    body: gifSource,
    contentType: 'image/gif',
    width: 1280,
  });
  assert.equal(unsupportedType.usedVariant, false);
  assert.deepEqual(unsupportedType.body, gifSource);

  const empty = await createImageVariant({
    body: Buffer.alloc(0),
    contentType: 'image/jpeg',
    width: 1280,
  });
  assert.equal(empty.usedVariant, false);

  const throwing = await createImageVariant({
    body: Buffer.from('valid-jpeg'),
    contentType: 'image/jpeg',
    width: 1280,
    encoder: async () => {
      throw new Error('Sharp processing failed');
    },
  });
  assert.equal(throwing.usedVariant, false);
  assert.deepEqual(throwing.body, Buffer.from('valid-jpeg'));

  const nonBuffer = await createImageVariant({
    body: 'not a buffer',
    contentType: 'image/jpeg',
    width: 1280,
  });
  assert.equal(nonBuffer.usedVariant, false);
  assert.equal(nonBuffer.body, 'not a buffer');
});

test('isSupportedImageVariantType and isValidImageVariantWidth predicates work correctly', async () => {
  const { isSupportedImageVariantType, isValidImageVariantWidth } = await import('../src/image-variants.js');
  assert.equal(isSupportedImageVariantType('image/jpeg'), true);
  assert.equal(isSupportedImageVariantType('image/png; charset=utf-8'), true);
  assert.equal(isSupportedImageVariantType('image/webp'), true);
  assert.equal(isSupportedImageVariantType('image/gif'), false);
  assert.equal(isSupportedImageVariantType('video/mp4'), false);
  assert.equal(isSupportedImageVariantType(null), false);

  assert.equal(isValidImageVariantWidth(1280), true);
  assert.equal(isValidImageVariantWidth('1920'), true);
  assert.equal(isValidImageVariantWidth(2560), true);
  assert.equal(isValidImageVariantWidth(1600), false);
  assert.equal(isValidImageVariantWidth(null), false);
});

test('exports SUPPORTED_TYPES, WEBP_OPTIONS, normalizedType and originalResult helpers', async () => {
  const {
    SUPPORTED_TYPES,
    WEBP_OPTIONS,
    normalizedType,
    originalResult,
    unsupportedWidthError,
  } = await import('../src/image-variants.js');

  assert.ok(SUPPORTED_TYPES.has('image/jpeg'));
  assert.ok(SUPPORTED_TYPES.has('image/png'));
  assert.ok(SUPPORTED_TYPES.has('image/webp'));

  assert.equal(WEBP_OPTIONS.quality, 92);
  assert.equal(WEBP_OPTIONS.nearLossless, true);

  assert.equal(normalizedType('Image/JPEG ; charset=binary'), 'image/jpeg');
  assert.equal(normalizedType(null), '');

  const orig = originalResult(Buffer.from('test'), 'image/png');
  assert.equal(orig.usedVariant, false);
  assert.equal(orig.contentType, 'image/png');

  const err = unsupportedWidthError();
  assert.equal(err.code, 'IMAGE_VARIANT_UNSUPPORTED_WIDTH');
});
