/**
 * Adaptive media chunk planning.
 *
 * Chunk plans cover the full file with a bounded number of 64 KiB-aligned
 * ranges. Preferred chunk size grows with file size so small files stay
 * seek-friendly and large files keep per-request overhead low; an optional
 * bandwidth estimate sizes chunks to roughly `targetSeconds` of stream.
 */

const MIN_CHUNK_SIZE = 256 * 1024;
const MAX_CHUNK_SIZE = 16 * 1024 * 1024;
const MAX_CHUNKS = 256;
const DEFAULT_TARGET_SECONDS = 10;

function sizeTier(totalBytes) {
  if (totalBytes <= 64 * 1024 * 1024) return 1024 * 1024;
  if (totalBytes <= 512 * 1024 * 1024) return 4 * 1024 * 1024;
  if (totalBytes <= 2 * 1024 ** 3) return 8 * 1024 * 1024;
  return MAX_CHUNK_SIZE;
}

function align64k(value) {
  return Math.max(1, Math.ceil(value / (64 * 1024))) * (64 * 1024);
}

export function adaptiveChunkSize(totalBytes, {
  min = MIN_CHUNK_SIZE,
  max = MAX_CHUNK_SIZE,
  bytesPerSecond,
  targetSeconds = DEFAULT_TARGET_SECONDS,
} = {}) {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) return min;
  let size = sizeTier(totalBytes);
  if (Number.isFinite(bytesPerSecond) && bytesPerSecond > 0) {
    const bandwidthSize = bytesPerSecond * Math.max(1, Number(targetSeconds) || DEFAULT_TARGET_SECONDS);
    size = Math.min(size, bandwidthSize);
  }
  return Math.min(max, Math.max(min, align64k(size)));
}

export function chunkSizeFor(totalBytes, chunks, {
  min = MIN_CHUNK_SIZE,
  max = MAX_CHUNK_SIZE,
  bytesPerSecond,
  targetSeconds,
  maxChunks = MAX_CHUNKS,
} = {}) {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
    return { count: 1, size: Math.max(min, MIN_CHUNK_SIZE) };
  }
  const preferred = adaptiveChunkSize(totalBytes, { min, max, bytesPerSecond, targetSeconds });
  const naturalCount = Math.max(1, Math.ceil(totalBytes / preferred));
  const requested = Number.isInteger(chunks) && chunks >= 1 ? Math.min(chunks, maxChunks) : 0;
  const minimumCoveringCount = Math.max(1, Math.ceil(totalBytes / max));
  let count = requested > 0 ? Math.max(requested, minimumCoveringCount) : naturalCount;
  count = Math.min(count, Math.ceil(totalBytes / min));
  const size = Math.min(max, Math.max(min, align64k(totalBytes / count)));
  return { count, size };
}

export function planChunks(totalBytes, {
  chunkSize,
  chunks,
  min = MIN_CHUNK_SIZE,
  max = MAX_CHUNK_SIZE,
  bytesPerSecond,
  targetSeconds,
} = {}) {
  const safeTotal = Number.isSafeInteger(totalBytes) && totalBytes > 0 ? totalBytes : 0;
  if (safeTotal === 0) return [];
  const plan = chunkSizeFor(safeTotal, chunks, { min, max, bytesPerSecond, targetSeconds });
  const effectiveSize = Number.isInteger(chunkSize) && chunkSize > 0 ? chunkSize : plan.size;
  const list = [];
  let index = 0;
  for (let offset = 0; offset < safeTotal; offset += effectiveSize) {
    const end = Math.min(offset + effectiveSize - 1, safeTotal - 1);
    list.push({
      index,
      start: offset,
      end,
      size: end - offset + 1,
    });
    index += 1;
  }
  return list;
}
