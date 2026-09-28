# 报关单 XML · 代码字段映射补齐说明

## 解决的问题
导出 XML 时，`监管方式(TradeMode)`、`征免性质(CutMode)`、`包装种类(WrapType)`、
`关区(CustomMaster)`、`口岸(IEPort)` 之前是**原样透传**——若 OCR/人工填的是中文
（如「一般贸易」），就会原样输出中文而非海关代码 `0110`，正式申报会被退单。

现已全部接入代码映射：填中文/英文别名 → 自动转海关代码；已经是代码则透传。

## 改了哪些文件
| 文件 | 改动 |
|---|---|
| backend/src/services/customsCodes.ts | 新增 4 张标准码表：`SUPERVISION_MODE_CODES`(监管方式)、`EXEMPTION_CODES`(征免性质)、`WRAP_TYPE_CODES`(包装种类)、`DISTRICT_CODES`(关区/口岸)；扩展外部加载器；新增**零配置自动加载** data/customsCodes.generated.json |
| backend/src/services/declarationBuilder.ts | 把 TradeMode/CutMode/WrapType/CustomMaster/IEPort 5 个字段接 `toCustomsCode`；预检守卫 CODE001 增加监管方式/征免性质/关区可解析性校验 |
| backend/data/customsCodes.generated.json | 全量表(190+ 监管方式 / 710 国别)随镜像打包 |
| backend/Dockerfile | 镜像复制上述全量表 |

## 验证结果（实跑）
```
监管方式  "一般贸易"     -> 0110
监管方式  "跨境电商9610" -> 9610
征免性质  "照章征税"     -> 101
包装种类  "纸箱"         -> 2
包装种类  "PALLET"       -> 92
关区      "深圳海关"     -> 5300
口岸      "盐田"         -> 5341
已是代码  "0110"         -> 0110 (透传)
零配置自动加载后：监管方式 201 条、国别 729 条；"旅游购物商品" -> 0139
```
后端 `tsc --noEmit` 全程 0 错误。

## 三档使用方式
1. **零配置**：什么都不做，内置常用子集 + 自动加载 data 下全量表即可覆盖绝大多数场景。
2. **换全量官方表**：从单一窗口下载官方代码表，整理成 `{中文/别名:"代码"}` 结构，
   设 `CUSTOMS_CODE_TABLE_PATH=/path/to/your.json` 覆盖即可（支持键名
   transport/currency/country/unit/supervision/exemption/wrap/district，
   也兼容生成文件的 TRADE_MODE_CODES/COUNTRY_CODES 原生键）。
3. **严格卡口**：设 `STRICT_CUSTOMS_CODES=1`，则映射不到代码的字段在预检阶段
   直接报 error 阻断导出（默认是 warning 提示，不阻断）。

## 最外层根节点 / 信封 —— 已做成可配置（无需改代码）
不同单一窗口客户端要求的根节点/信封不同，现支持用环境变量切换：

| 环境变量 | 作用 | 默认 |
|---|---|---|
| `CUSTOMS_XML_ROOT` | 根节点名 | `DecMessage` |
| `CUSTOMS_XML_ROOT_ATTRS` | 根节点属性(如命名空间) | 空 |
| `CUSTOMS_XML_ENVELOPE` | 外层信封名(设了才输出) | 空 |

示例（CEB 跨境电商报文风格）：
```
CUSTOMS_XML_ROOT=CEB311Message
CUSTOMS_XML_ROOT_ATTRS=xmlns="http://www.chinaport.gov.cn/ceb"
```
四种组合（默认/自定义根/根+命名空间/带信封）均已实跑验证为 well-formed。
内部 DecHead/DecLists 字段通用，不随根节点变化。

## 仍需你确认的（与客户端相关）
- 关区/口岸表只内置了主要口岸子集；若你常用口岸不在 `DISTRICT_CODES` 里，
  按同样结构补一行，或用上面方式 2 加载全量口岸表。