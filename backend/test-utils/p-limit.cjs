/**
 * p-limit 的 CJS 实现 —— 仅供 Jest 使用
 * ---------------------------------------------------------------
 * 为什么需要它：
 *   项目装的是 p-limit@7，它是**纯 ESM**（package.json 里没有 require 入口）。
 *   Node 22+ 能 require(esm)，但 Jest 29 用自己的 jest-runtime 模块注册表，
 *   享受不到这个能力，于是 5 个测试套件只要 import 到 deepseek.ts 就报
 *   "Cannot use import statement outside a module"。
 *
 * 为什么不用降级 p-limit 解决：
 *   p-limit 是**运行时依赖**，降级会改动生产代码的行为面。
 *   测试环境的问题就该在测试环境解决 —— 所以走 Jest 的 moduleNameMapper。
 *
 * 语义与 p-limit v7 对齐：
 *   pLimit(n)(fn, ...args) 返回 Promise；超出并发数的调用进入队列。
 *   另提供 activeCount / pendingCount / clearQueue。
 */

'use strict';

function pLimit(concurrency) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError('Expected `concurrency` to be a positive integer');
  }

  const queue = [];
  let activeCount = 0;

  const next = () => {
    activeCount--;
    if (queue.length > 0) {
      queue.shift()();
    }
  };

  const run = async (fn, resolve, args) => {
    activeCount++;
    const result = (async () => fn(...args))();
    resolve(result);
    try {
      await result;
    } catch (_) {
      // 错误由调用方通过返回的 Promise 处理，这里只负责让出并发槽位
    }
    next();
  };

  const enqueue = (fn, resolve, args) => {
    queue.push(run.bind(undefined, fn, resolve, args));
    (async () => {
      await Promise.resolve();
      if (activeCount < concurrency && queue.length > 0) {
        queue.shift()();
      }
    })();
  };

  const generator = (fn, ...args) =>
    new Promise((resolve) => {
      enqueue(fn, resolve, args);
    });

  Object.defineProperties(generator, {
    activeCount: { get: () => activeCount },
    pendingCount: { get: () => queue.length },
    clearQueue: {
      value: () => {
        queue.length = 0;
      },
    },
  });

  return generator;
}

// 同时兼容 `import pLimit from 'p-limit'` 与 `const pLimit = require('p-limit')`
module.exports = pLimit;
module.exports.default = pLimit;
