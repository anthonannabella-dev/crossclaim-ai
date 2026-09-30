#!/usr/bin/env node
// B2-FIX R1 / MSG-20260930-06 CHANGE D
// 从 required-triggers.json 生成「必需租户保护触发器」校验 SQL（名称 / 所属表 / 事件类型 / 启用状态）。
// 用法（CI 与本地通用）：
//   node tools/tenant-triggers/emit-check-sql.mjs | PGPASSWORD=... psql -h ... -U ... -d ... -v ON_ERROR_STOP=1
// 说明：校验失败会 RAISE EXCEPTION → psql 以非零退出码结束，CI 变红。
//   1) 清单中每个触发器都必须存在、挂在指定表上、tgtype 匹配、tgenabled='O'；
//   2) 运行库不得出现清单之外启用的 cc_tenant_*（非 immutable）触发器（新增保护必须同步清单）；
//   3) 每张含 organizationId 的表都必须有 cc_tenant_immutable__<表>（BEFORE UPDATE）；
//   4) scopedTriggers 必须限定 schema 与表。
// 不再使用「总数 >= N」这类下限断言。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(here, 'required-triggers.json'), 'utf8'));

const baseTgtype = config.baselineTgtype ?? 23;

const baselineValues = config.baselineTriggers
  .map((entry) => `    ('${entry.name}', '${entry.table}', ${baseTgtype})`)
  .join(',\n');

const scopedValues = config.scopedTriggers
  .map((entry) => `    ('${entry.name}', '${entry.table}', ${entry.tgtype})`)
  .join(',\n');

const sql = `DO $$
DECLARE
  missing    text;
  unexpected text;
  gap        text;
BEGIN
  -- 1) 必需基线触发器：名称 + 所属表 + 事件类型 + 启用
  SELECT string_agg(r.name || ' @ ' || r.tbl || ' (tgtype=' || r.tgtype || ')', ', ')
    INTO missing
    FROM (VALUES
${baselineValues}
    ) AS r(name, tbl, tgtype)
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_trigger g
       JOIN pg_class c ON c.oid = g.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = current_schema()
      WHERE NOT g.tgisinternal
        AND g.tgenabled = 'O'
        AND g.tgname = r.name
        AND c.relname = r.tbl
        AND g.tgtype = r.tgtype
   );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'missing/mismatched required tenant triggers: %', missing;
  END IF;

  -- 2) 反向核对：运行库不应存在清单未覆盖的启用 cc_tenant_* 保护
  SELECT string_agg(g.tgname || ' @ ' || c.relname, ', ')
    INTO unexpected
    FROM pg_trigger g
    JOIN pg_class c ON c.oid = g.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = current_schema()
   WHERE NOT g.tgisinternal
     AND g.tgenabled = 'O'
     AND g.tgname LIKE 'cc_tenant_%'
     AND g.tgname NOT LIKE '${config.immutablePrefix}%'
     AND NOT EXISTS (
       SELECT 1 FROM (VALUES
${baselineValues}
       ) AS r(name, tbl, tgtype)
        WHERE r.name = g.tgname AND r.tbl = c.relname
     );
  IF unexpected IS NOT NULL THEN
    RAISE EXCEPTION 'unexpected tenant triggers not covered by checklist: %', unexpected;
  END IF;

  -- 3) 逐表归属不可变覆盖：含 organizationId 的每张表都要有 BEFORE UPDATE 触发器
  SELECT string_agg(ic.table_name, ', ')
    INTO gap
    FROM information_schema.columns ic
   WHERE ic.table_schema = current_schema()
     AND ic.column_name = 'organizationId'
     AND ic.table_name <> '_prisma_migrations'
     AND NOT EXISTS (
       SELECT 1
         FROM pg_trigger g
         JOIN pg_class c ON c.oid = g.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = current_schema()
        WHERE NOT g.tgisinternal
          AND g.tgenabled = 'O'
          AND c.relname = ic.table_name
          AND g.tgname = '${config.immutablePrefix}' || ic.table_name
          AND g.tgtype = ${config.immutableTgtype}
     );
  IF gap IS NOT NULL THEN
    RAISE EXCEPTION 'tables missing organizationId-immutability trigger: %', gap;
  END IF;

  -- 4) 归属 scoped 触发器：限定 schema 与表
  SELECT string_agg(r.name || ' @ ' || r.tbl || ' (tgtype=' || r.tgtype || ')', ', ')
    INTO gap
    FROM (VALUES
${scopedValues}
    ) AS r(name, tbl, tgtype)
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_trigger g
       JOIN pg_class c ON c.oid = g.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = current_schema()
      WHERE NOT g.tgisinternal
        AND g.tgenabled = 'O'
        AND g.tgname = r.name
        AND c.relname = r.tbl
        AND g.tgtype = r.tgtype
   );
  IF gap IS NOT NULL THEN
    RAISE EXCEPTION 'missing/mismatched scoped ownership triggers: %', gap;
  END IF;

  RAISE NOTICE 'OK: required tenant triggers=% baseline, % immutable per contains-organizationId table, % scoped',
    (SELECT count(*) FROM (VALUES
${baselineValues}
    ) AS r(name, tbl, tgtype)),
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = current_schema() AND column_name = 'organizationId' AND table_name <> '_prisma_migrations'),
    (SELECT count(*) FROM (VALUES
${scopedValues}
    ) AS r(name, tbl, tgtype));
END
$$;
`;

process.stdout.write(sql);
