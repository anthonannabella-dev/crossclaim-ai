# ACTION GUARD CP2 · 状态口径与业务接入清单

依据：架构方 **MSG-20260930-12**（Gate 7 / 授权项② Action Guard CP2，VERDICT: REVISE）第 4、5、6 节。

本文件只做**口径与清单**，不改变任何实现语义。

---

## 1. 状态拆分（CHANGE B 要求，禁止合并成一格）

| 范围 | 当前状态 | 证据 / 说明 |
| --- | --- | --- |
| **CP2 基础模块**（决策函数 own-key、runtime guard、capability source、enforcement wrapper） | **修订待复核** | HEAD 见提交；本轮已按 CHANGE A 修未知动作自有键，按 CHANGE B 修口径 |
| **② 业务强制覆盖**（生产危险动作真正接入 runtime guard） | **NOT COMPLETE** | 尚未有 service/route/job/HITL 调用点接入；不得以基础模块完成追认 |
| **真实 resolver / config / audit 端口接线** | **未验收** | capability source 目前通过注入端口工作；尚未接真实配置源与真实审计落地 |

> 明确作废的过强表述（CHANGE B）：不再声称「唯一入口」「已不可绕过」「忘记调用守卫在类型与测试层面都不可行」。
> 仓库中的静态扫描只是**有限静态约定检查**（单引号字面量 + 同文件字符串），仅作辅助，不作为覆盖验收证据。

## 2. 后续接入验收条件（MSG-20260930-12 §5，逐条保留）

1. **审批不能仅凭非空 `approvalId` 放行**：服务端必须验证其租户、权限、动作、目标对象/证据版本、有效期、撤销与消费状态。
2. **不得直接信任请求体中的 `capabilities` / `hostApprovalGranted`**：能力快照必须由服务端可信源解析。
3. **同一真实业务入口必须验证零副作用**：DENY / REQUIRE_APPROVAL / 能力异常 / 审计异常时，业务数据库变更与外部适配器调用均为 **0**；ALLOW 时恰好执行一次。
4. **守卫前不得发生受保护副作用**：审计记录与业务零副作用分别验收。
5. **控制面保留**：全局禁用优先、租户与平台启用分层、默认 read-only。
6. **重试与队列执行重新核验**：不得沿用旧 ALLOW；需明确并测试 Kill Switch 缓存与撤销延迟。
7. **口径准确性**：审计端口不可用时拒绝仍可生效，但不得声称「每次都已持久化审计」；`runtime evaluate` 会尝试写审计，不是纯展示函数。

## 3. 业务接入清单（动作 → 入口 → 副作用边界 → 审批验证 → 集成测试）

> 状态一律先记 TODO；完成一项填一项，且每项都必须有「拒绝时零副作用 + 允许时恰好一次」的集成测试证据。

| 动作（catalog） | service / route / job / HITL 入口 | 副作用边界 | 审批验证 | 集成测试 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `claim.submit` | 待定（提交路径，HITL 人工闸门） | 平台外写（当前 HOLD，传输开关 false） | approvalId 服务端校验（租户/动作/对象/有效期/消费） | 待补 | TODO |
| `appeal.submit` | 待定（申诉路径） | 平台外写（HOLD） | 同上 | 待补 | TODO |
| `platform.write` | 待定（适配器写路径） | 平台外写（HOLD） | 同上 | 待补 | TODO |
| `commission.charge` | 待定（结算/佣金路径） | 资金动作（HOLD） | 同上 + 财务复核 | 待补 | TODO |
| `payment.capture` | 待定（支付路径） | 资金动作（HOLD） | 同上 + 财务复核 | 待补 | TODO |
| `secret.rotate` | 待定（运维路径） | 凭据操作（HOST ONLY） | HOST APPROVAL | 待补 | TODO |
| `claim.prepare` | 待定（内部写入） | 业务库写入 | 不要求人工审批，但需能力闸门 | 待补 | TODO |
| `billing.draft` | 待定（内部写入） | 业务库写入 | 不要求人工审批 | 待补 | TODO |
| `evidence.read` | 待定（只读） | 无 | 无 | 待补 | TODO |

## 4. 下一 Checkpoint 关系

- 允许继续 **③ PRODUCTION CONTROL PLANE**（真实配置、有效 Kill Switch 与审计依赖的组合入口，保持默认 read-only）。
- 仍需单独安排 **② 具体 service/route/job/HITL 接入及集成验收收口**；③ 完成不追认 ② 完成。
- 不得仅凭基础模块的 CI 绿灯开启高危能力；Production Enablement / 真实外写 / 资金 / 客户提交 / 生产凭据继续 HOLD。
