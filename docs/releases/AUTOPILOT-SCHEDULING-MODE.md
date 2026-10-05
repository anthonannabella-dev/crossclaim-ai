# AUTOPILOT 调度模式：事件驱动连续执行 + Heartbeat 看门狗兜底

- 生效时间：2026-10-05T03:25:15.494Z（由宿主要求切换；不再是「5 分钟 heartbeat 触发下一轮」）
- 机器可读状态：`.autopilot/STATE.json` 的 `scheduling_mode` / `continue_required` / `lane_a` / `lane_b`

## 1. 执行规则

1. 一个 execution unit 完成后**立刻**：更新 RUN_LOG / STATE / BACKLOG → 重新计算 SAFE_CONTINUATION_QUEUE → 若非空**立即领取下一个**；不等 heartbeat、不 sleep、不输出「下一轮」。
2. Heartbeat 降级为 **watchdog**：只用于检测进程卡死、事件遗漏、CI/verdict 长时间未被重读；不再触发正常推进。
3. 任何等待态（WAITING_FOR_CI / ARCHITECT_VERDICT / EXTERNAL_DEPENDENCY / PROVIDER_API / HOST_ACTION）**不得整体停机**：必须寻找不依赖该 blocker 的内部任务继续。

## 2. 双通道

- **LANE A（EXECUTION）**：BG-008 → BG-014 → BG-015 → BG-018 → 其它无外部依赖 backlog；持续领取，不等 Lane B。
- **LANE B（VALIDATION/AUDIT）**：CI 结论（BG-003/BG-004/BG-007/BG-008…）、BG-011 架构审计、后续 verdict；异步跟踪，不阻塞 Lane A。

## 3. CI 回调

- CI SUCCESS 到达 → 立即把对应项 `IMPLEMENTED_PENDING_CI` 翻为 `COMPLETED`（可批量）。
- CI FAILURE → **只暂停失败任务自身**并建 FIX task；其余无依赖项继续推进。

## 4. 架构裁决

需要裁决时：生成 Audit Pack（REVIEWED_HEAD / scope / invariant / tests / schema delta / requested verdict）→ 唤醒右侧 ChatGPT 审计会话 → 标记 `WAITING_FOR_VERDICT` → **立即寻找下一条 SAFE 任务**。verdict 一旦返回即消费，不等 heartbeat。

## 5. 停机条件（唯一）

`SAFE_CONTINUATION_QUEUE = EMPTY` 且所有内部可完成项 COMPLETED/CLOSED 且剩余全部属于 HOLD_EXTERNAL / HOST_ACTION_REQUIRED / PRODUCTION_CREDENTIAL_REQUIRED / LEGAL·PROVIDER_APPROVAL_REQUIRED。
停机时输出 Closure Report（INTERNAL_CODE_COMPLETE / INTERNAL_TEST_COMPLETE / CI_COMPLETE / ARCHITECTURE_AUDIT_COMPLETE / PRODUCTION_ENABLEMENT_STATUS / EXTERNAL_DEPENDENCIES / HOST_ACTION_REQUIRED）。
在此之前 `continue_required = TRUE`。
