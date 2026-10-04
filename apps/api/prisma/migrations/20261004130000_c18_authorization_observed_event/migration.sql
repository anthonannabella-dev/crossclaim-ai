-- C18 PRODUCTION PERSISTENCE CHECKPOINT FINAL-3（MSG-20261004-31 CHANGE D）
-- 新增一个**非 transition** 的事件语义：收到并验证了一个 provider authorization 观察，
-- 但该观察没有改变 current submission gate 的状态（例如 ACTIVE + RENEWED，或换了一个 providerAuthorizationRef）。
--
-- 为什么需要它：lineage 已经被定义为「下一次 fold 的 durable history」，因此 gate 未变化的合法观察
-- 也必须耐久化（否则续期、新的 expiresAt、新的 authorization ref 会永久丢失）；但用 RESTORED 记录
-- 这类观察会制造「此前不可用」的假事实。所以补一个语义准确的枚举值，而不是删掉事实。
--
-- 风险面：只做 `ALTER TYPE ... ADD VALUE`（append-only，位置在末尾，与 schema.prisma 的枚举顺序一致），
-- 无表/列/数据变更，无 DROP。声明：本 migration **未**在 shared / production 执行；只在一次性 ephemeral 库验证。

ALTER TYPE "CustomsProviderBindingEvent" ADD VALUE IF NOT EXISTS 'AUTHORIZATION_OBSERVED';
