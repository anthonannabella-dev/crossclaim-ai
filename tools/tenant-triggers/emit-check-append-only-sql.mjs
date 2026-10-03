#!/usr/bin/env node
// R43 Implementation S1 / MSG-20261001-32 ② —— append-only / 受控变更触发器清单校验 SQL
// 用法（CI 与本地通用）：
//   node tools/tenant-triggers/emit-check-append-only-sql.mjs | PGPASSWORD=... psql -h ... -U ... -d ... -v ON_ERROR_STOP=1
// 行为：
//   1) 清单中每个触发器必须存在、挂在指定表、tgtype 匹配、tgenabled='O'；
//   2) 反向核对：不得存在清单之外的启用 cc_append_only__* / cc_recoverypackage_* 触发器；
//   3) 被覆盖的表必须都是 append-only / 受控变更语义所声明的表（清单即白名单）。
// 失败会 RAISE EXCEPTION → psql 非零退出码 → CI 变红。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(here, 'append-only-triggers.json'), 'utf8'));

const values = config.triggers
  .map((entry) => `    ('${entry.name}', '${entry.table}', ${entry.tgtype})`)
  .join(',\n');

const unexpected = (config.unexpectedPrefixes ?? [])
  .map((prefix) => `'${prefix}'`)
  .join(', ');

const sql = `DO $$
DECLARE
  missing    text;
  extra      text;
BEGIN
  -- 1) 必需 append-only / 受控变更触发器：名称 + 表 + 事件类型 + 启用
  SELECT string_agg(r.name || ' @ ' || r.tbl || ' (tgtype=' || r.tgtype || ')', ', ')
    INTO missing
    FROM (VALUES
${values}
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
    RAISE EXCEPTION 'missing/mismatched append-only triggers: %', missing;
  END IF;

  -- 2) 反向核对：清单之外不得存在启用的 append-only / 受控变更触发器
  SELECT string_agg(g.tgname || ' @ ' || c.relname, ', ')
    INTO extra
    FROM pg_trigger g
    JOIN pg_class c ON c.oid = g.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = current_schema()
   WHERE NOT g.tgisinternal
     AND g.tgenabled = 'O'
     AND (${unexpected.length > 0 ? `g.tgname LIKE ANY (ARRAY[${unexpected}])` : 'false'})
     AND NOT EXISTS (
       SELECT 1 FROM (VALUES
${values}
       ) AS r(name, tbl, tgtype)
        WHERE r.name = g.tgname AND r.tbl = c.relname
     );
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'unexpected append-only triggers not covered by checklist: %', extra;
  END IF;

  RAISE NOTICE 'OK: append-only/controlled-mutation triggers=% (checklist)',
    (SELECT count(*) FROM (VALUES
${values}
    ) AS r(name, tbl, tgtype));
END
$$;
`;

process.stdout.write(sql);
