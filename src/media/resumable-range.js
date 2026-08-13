import { Readable } from 'node:stream';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pipeAttempt(stream, res, onBytes) {
  return new Promise((resolve) => {
    let bytes = 0;
    let pending = 0;
    let sourceDone = false;
    let paused = false;
    let error = null;

    const settle = () => {
      if (sourceDone && pending === 0) {
        res.off?.('drain', onDrain);
        resolve({ bytes, error });
      }
    };

    const onDrain = () => {
      if (paused) {
        paused = false;
        stream.resume();
      }
    };

    const finish = (err) => {
      if (sourceDone) return;
      sourceDone = true;
      if (err) error = err;
      settle();
    };

    res.on?.('drain', onDrain);
    stream.on('end', () => finish());
    stream.on('error', (err) => finish(err));
    stream.on('aborted', () => finish(new Error('upstream stream aborted')));
    stream.on('data', (chunk) => {
      if (res.destroyed || res.writableEnded) {
        finish(new Error('client response closed'));
        return;
      }
      pending += 1;
      let counted = false;
      const writable = res.write(chunk, (writeError) => {
        pending -= 1;
        if (writeError) {
          if (!error) error = writeError;
        } else if (!counted) {
          counted = true;
          bytes += chunk.length;
          onBytes?.(bytes);
        }
        settle();
      });
      if (!writable) {
        paused = true;
        stream.pause();
      }
    });
    stream.resume();
  });
}

export async function pumpResumableRange({
  response,
  fetchRange,
  res,
  start,
  end,
  maxAttempts = 3,
  backoffMs = 100,
  onBytes,
  onResume,
  onComplete,
  onTruncated,
} = {}) {
  const expectedBytes = end - start + 1;
  let current = response;
  let written = 0;
  let resumed = 0;
  let fetches = 1;
  let attempt = 0;

  while (written < expectedBytes && !res.destroyed && !res.writableEnded) {
    if (attempt > 0) {
      if (fetches >= maxAttempts) break;
      await sleep(backoffMs * attempt);
      let next;
      try {
        next = await fetchRange(`bytes=${start + written}-${end}`);
      } catch {
        next = null;
      }
      fetches += 1;
      if (!next?.ok || !next?.body) {
        attempt += 1;
        continue;
      }
      current = next;
      resumed += 1;
      onResume?.(written, attempt);
    }
    if (!current?.body) break;
    const { bytes, error } = await pipeAttempt(Readable.fromWeb(current.body), res, (n) => onBytes?.(written + n));
    written += bytes;
    attempt += 1;
    if (written >= expectedBytes) break;
  }

  if (written >= expectedBytes && !res.writableEnded) {
    onComplete?.({ written, resumed });
    res.end?.();
  } else if (!res.destroyed && !res.writableEnded) {
    onTruncated?.({ written, resumed });
    res.destroy?.();
  }
  return { written, resumed };
}
