# B2-FIX R1 任务队列（自治循环；完成即自动进入下一项）

- [x] RuleSet ownership immutable behavior tests (8626e56)
- [x] 1. RuleVersion + RuleEvaluation reference behavior tests（MSG-09 TEST 清单 7/7；0023f51）
- [x] 2. D：既有租户触发器逐项核对（清单式 CI 断言 name/table/type/enabled + 反向清单；c74d9bb）
- [x] 3. E：独立临时 PostgreSQL 两段升级（pre-B2 → seed legacy → apply B2 → 断言关系保留；c74d9bb）
- [x] 4. F：迁移同名重纳 byte-identical + checksum（sha256 2acbd87a…；c74d9bb）
- [x] 5. G：历史口径纠偏（docs/releases/B2-FIX-R1-RECORD-CORRECTIONS.md；c74d9bb）
- [ ] 6. final local verification
- [ ] 7. final CI
- [ ] 8. independent FIX PR
- [ ] 9. READY_FOR_REVIEW
- [ ] 10. ChatGPT final audit（右侧网页通道；当前 Codex auth token 不可用 → 持续重试）
