import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: '/crypto-lab-reshare-circle/',
  build: {
    target: 'es2022',
  },
  test: {
    include: ['src/**/*.test.ts'],
    // Real 2048-bit group exponentiations (RFC 3526) are slow in BigInt;
    // the full-verification refresh tests legitimately take > 5 s.
    testTimeout: 120000,
  },
});
