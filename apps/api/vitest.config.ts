import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    /**
     * 数据库级测试（tenant-isolation / audit-db）会 TRUNCATE 同一批表并重新播种。
     * 若测试文件并行执行，两个套件会互相截断对方的种子数据，
     * 表现为 "Unique constraint failed on (id)" 与 "deadlock detected (40P01)"。
     * 因此这里关闭文件级并行：数据库套件必须串行。
     */
    fileParallelism: false,
  },
});
