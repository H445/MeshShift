import { defineConfig } from 'vitest/config';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Tell the converter where the vendored assimpjs files live (for tests).
process.env.MESHSHIFT_ASSIMP_DIR = resolve(__dirname, 'src', 'client', 'public');

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
  },
  resolve: {
    alias: {
      '@core': resolve(__dirname, 'src/core/index.ts'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@': resolve(__dirname, 'src/client'),
    },
  },
});
