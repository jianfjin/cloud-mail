import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/attachment-download.spec.js'],
    environment: 'node',
  },
});
