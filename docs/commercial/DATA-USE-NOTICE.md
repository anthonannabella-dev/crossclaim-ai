# Data Processing / Data Use Notice（数据处理与使用说明）

> documentKey: `data-use-notice`。

- **处理的数据类别**：account metadata；transaction / order / shipment data；claim / evidence files；provider identifiers。
- **保留**：与申请、对账、审计相关的事实按其域保留策略保存（例如资金/结算类事实按 24 个月默认保留期）。
- **删除 / 请求路径**：客户可通过账户设置或工单请求导出与删除；删除请求会记录处理事实。
- **第三方处理**：仅在必要的子处理方范围内使用；不写入真实生产凭据，不进行未披露的跨境传输。
- **安全**：租户隔离由数据库不变量强制；敏感字段不返回；日志不含 secret。
