export default {
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.js'],
  // ESM project: no Babel transform needed.
  transform: {},
  testTimeout: 30000,
};
