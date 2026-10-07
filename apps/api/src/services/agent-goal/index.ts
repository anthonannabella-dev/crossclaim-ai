// AGENT EXPERIENCE LAYER / P1 — Agent Goal Domain（薄层）统一出口
// 只表达「客户想得到什么结果」，不携带动作 / 工具 / 权限，不构成第二 runtime 或第二事实源。

export * from './goal-contract';
export * from './goal-schema';
export * from './goal-compiler';
export * from './goal-validator';
export * from './goal-capability-resolver';
export * from './goal-task-planner';
// P9/AEL-FINAL2：**不**导出 goal-runtime-adapter —— 它含 direct-runner dispatch，
// 属 internal/test-only 面；产品执行准入唯一入口是 goal-runtime-binding（既有任务队列）。
export * from './goal-runtime-binding';
export * from './goal-store';
