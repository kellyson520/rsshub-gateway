import sharp from 'sharp';
import {
  DEFAULT_WEBP_OPTIONS as WEBP_OPTIONS,
  IMAGE_VARIANT_WIDTHS,
  isSupportedImageVariantType,
  isValidImageVariantWidth,
  normalizedImageContentType as normalizedType,
  originalImageResult as originalResult,
  SUPPORTED_IMAGE_VARIANT_TYPES as SUPPORTED_TYPES,
  unsupportedImageVariantWidthError as unsupportedWidthError,
} from './http-utils.js';

export {
  IMAGE_VARIANT_WIDTHS,
  isSupportedImageVariantType,
  isValidImageVariantWidth,
  SUPPORTED_TYPES,
  WEBP_OPTIONS,
  normalizedType,
  originalResult,
  unsupportedWidthError,
};

async function encodeWebp({ body, width, options }) {
  const image = sharp(body, { failOn: 'error' });
  const metadata = await image.metadata();
  if (metadata.pages && metadata.pages > 1) return body;
  return image
    .rotate()
    .resize({ width, withoutEnlargement: true })
    .webp(options)
    .toBuffer();
}

export async function createImageVariant({ body, contentType, width, encoder = encodeWebp }) {
  const normalizedContentType = normalizedType(contentType);
  if (!IMAGE_VARIANT_WIDTHS.includes(Number(width))) throw unsupportedWidthError();
  if (!SUPPORTED_TYPES.has(normalizedContentType) || !Buffer.isBuffer(body) || body.length === 0) {
    return originalResult(body, contentType);
  }

  try {
    const variant = await encoder({ body, width: Number(width), options: WEBP_OPTIONS });
    if (!Buffer.isBuffer(variant) || variant.length >= body.length) return originalResult(body, contentType);
    return { body: variant, contentType: 'image/webp', usedVariant: true };
  } catch {
    return originalResult(body, contentType);
  }
}
