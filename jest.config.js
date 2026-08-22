/**
 * Scoped to the pure layers only (src/proto, src/core, src/transport) so tests
 * run in plain node in ~2 seconds with no React Native transform in the loop.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          target: 'es2020',
          esModuleInterop: true,
          types: ['jest', 'node'],
        },
      },
    ],
  },
};
