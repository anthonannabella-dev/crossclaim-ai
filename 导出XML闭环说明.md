# 自动化报关 · 导出 XML 闭环说明

## 为什么这样做
没有海关单一窗口直连资质时的标准做法：系统把单证跑完自动化处理，
生成**标准报关单 XML 报文**，由报关员导出，导入贵司自己对接海关的客户端完成申报，
再把海关回执回填进系统。整条链路真实闭环、全程留痕，只是把「自动调 API」换成「导出文件 + 回执回填」。

## 改造后的状态机（与代码一致）

```
上传单证
  → ocr_running / ocr_done        OCR 识别（需 OCR 引擎）
  → ai_checking / ai_done         AI 校验（需 DEEPSEEK_API_KEY）
  → auto_filling / auto_filled    自动填制草稿
  → pending_review                人工复核（通过 / 驳回）
  → pre_checking
  → checked                       预检通过·待导出申报   ← 新逻辑停在这里，不再假申报
  ──（报关员点「导出XML申报」）──→
  → declared                      已导出报文·已线下申报·待回执（记录 declaredAt + xmlPath）
  ──（拿到海关回执后在系统回填）──→
  → customs_review                已申报·待回执（确认接单，可选）
  → released                      放行（可从 declared 或 customs_review 直接回填）
  → completed                     结关
  或 → rejected                   海关退单（填代码+原因，退回修改）
```

关键改动：
- 复核+预检通过后**不再自动调用单一窗口 API 假提交**，停在 `checked`。
- **导出 XML = 完成线下申报登记**：导出端点会把 `checked → declared`，记录报文文件名与申报时间。
- 回执回填用现成端点 `POST /batch-group/:id/customs-response`（accepted / released / rejected / completed）。
- `markReleased` 放宽：可从 `declared` 或 `customs_review` 直接放行。

## 改了哪些文件
| 文件 | 改动 |
|---|---|
| backend/src/services/groupPipelineService.ts | 去掉假申报；新增 `markExported`（导出即申报登记）；放行可从 declared 推进 |
| backend/src/routes/routes/batchGroup.ts | 导出端点调用 markExported 推进状态；修复文件名插值 bug |
| frontend/src/pages/BatchArchivePage.tsx | 步骤/状态文案改为导出口径；`checked` 状态加「导出XML申报」主按钮；导出后刷新状态 |

## XML 报文格式（已按官方规范重写）
已把 `generateCustomsXML` 重写为符合 **海关总署2018年第67号公告《进出口货物报关单申报电子报文格式》** 的字段命名：
- 表头 `DecHead`：IEFlag/CustomMaster/IEPort/ContrNo/TradeName/AgentName/AgentCode/TrafMode/TrafName/BillNo/TradeMode/CutMode/LicenseNo/TradeCountry/DistinatePort/TransMode/PackNo/WrapType/GrossWet/NetWt…（SeqNo/PreEntryId/EntryId 首次导入传空，由系统生成）
- 表体 `DecLists/DecList`：GNo/CodeTS/GName/GModel/GQty/GUnit/DeclPrice/DeclTotal/TradeCurr/OriginCountry/DestinationCountry/DutyMode
- 成交方式 TransMode 按 FOB→3 / CIF→1 / C&F→2 等自动映射
- 已用真实样例数据运行生成 `sample_declaration.xml`，并通过 XML 解析器校验为 well-formed、必备字段齐全。

⚠️ 仍需你确认两点（与具体客户端相关，无法臆测）：
1. **最外层信封/根节点**：本文件根节点用的是 `<DecMessage>`。部分单一窗口客户端要求特定根名或额外包裹层，若不同只需改最外层标签，内部字段通用。
2. **代码类字段需填海关代码而非中文**：CustomMaster(关区)、TradeMode(监管方式)、CutMode(征免性质)、TradeCountry/OriginCountry(国别)、币制、计量单位等，正式申报要填**海关代码表里的代码**（样例里国别用了 502/142 这种代码占位）。贵司客户端若按代码导入则已就位；若按中文导入，告诉我改映射。

## 依赖说明
- **导出闭环本身零外部依赖**：`generateCustomsXML` 是纯函数，预检→导出→回执回填即使没配 AI/OCR 也能跑。
- 前半段 OCR / AI 校验需要：OCR 引擎、对象存储(MinIO)、`DEEPSEEK_API_KEY`。
- 覆盖文件后本地跑 `npm run build` / `tsc --noEmit` 确认类型通过。

## 补充:结关后自动归档(已收口)
`markCompleted` 结关时自动:
- 盖 `archivedAt` 时间戳;
- 调 `archiveGroup` 把「报关单 + 随附单证清单 + 报文路径 + 申报时间」写入审计日志,形成可追溯归档包;
- 状态保持 `completed`(不从列表消失,统计不受影响),前端标「已结关·已归档」,详情即调档。

## OCR 说明
- 流水线实际用后端内置 `tesseract.js`(图片)+ `pdf-parse`(PDF),npm install 即有,无需额外起服务。
- `ocr_service/`(FastAPI+PaddleOCR,端口8001/8002)是可选高精度服务,当前未接入流水线;如需启用,把 runDocumentOCR 改为调 OCR_SERVICE_URL。
