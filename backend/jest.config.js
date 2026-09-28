module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    // p-limit@7 是纯 ESM，Jest 的 CJS 运行时加载不了；映射到行为一致的 CJS 实现。
    // 只影响测试环境，不动运行时依赖。详见 test-utils/p-limit.cjs
    '^p-limit$': '<rootDir>/test-utils/p-limit.cjs',
  },
  roots: ['<rootDir>/__tests__'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\.ts$': 'ts-jest',
  },
};
