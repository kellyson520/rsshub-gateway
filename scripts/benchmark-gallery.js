import { benchmarkGallery } from '../src/gallery-benchmark.js';

try {
  const result = await benchmarkGallery({ gatewayUrl: process.argv[2] });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  process.stderr.write('benchmark failed\n');
  process.exitCode = 1;
}
