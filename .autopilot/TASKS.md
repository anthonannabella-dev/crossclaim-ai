# B2-FIX R1 任务队列（自治循环；完成即自动进入下一项）

- [x] RuleSet ownership immutable behavior tests (8626e56)
- [ ] 1. RuleVersion + RuleEvaluation reference behavior tests（A/B 可引用 SYSTEM 版本；跨租户引用 TENANT 版本被拒；拒绝后引用关系不变）
- [ ] 2. D 剩余：既有租户触发器逐项核对（name / table / enabled / actual rejection behavior）
- [ ] 3. E：独立临时 PostgreSQL（migrate 到 B2 前 → seed legacy data → apply B2 → 断言关系保留；不 reset、不换 DB）
- [ ] 4. F：迁移同名重纳 byte-identical + checksum
- [ ] 5. G：历史口径纠偏（等价复合外键表述 / B1 当时 REVISE / B3 license 空转）
- [ ] 6. final local verification
- [ ] 7. final CI
- [ ] 8. independent FIX PR
- [ ] 9. READY_FOR_REVIEW
- [ ] 10. ChatGPT final audit
