
-- Disable triggers for speed
SET session_replication_role = 'replica';

-- Create temp table
CREATE TEMP TABLE tmp_hscode (data jsonb);

-- Load JSON (need to copy it into a psql variable)
\set content `cat /tmp/hs_codes.json`
INSERT INTO tmp_hscode SELECT jsonb_array_elements(:'content'::jsonb);

-- Now upsert
INSERT INTO "HSCode" (id, code, description, unit, "tariffRate", "exportRate", "vatRate", "exciseRate", supervision, category, "updatedAt")
SELECT 
  gen_random_uuid()::text,
  t.data->>'code',
  COALESCE(t.data->>'name', ''),
  COALESCE(t.data->>'unit', ''),
  COALESCE((t.data->>'mfn_rate')::numeric, 0),
  COALESCE((t.data->>'export_rate')::numeric, 0),
  COALESCE((t.data->>'vat_rate')::numeric, 0),
  COALESCE((t.data->>'excise_rate')::numeric, 0),
  COALESCE(t.data->>'supervision', ''),
  CASE 
    WHEN t.data->>'chapter' IS NOT NULL AND t.data->>'chapter' != ''
    THEN 
      CASE 
        WHEN (t.data->>'chapter')::int BETWEEN 1 AND 24 THEN '农产品'
        WHEN (t.data->>'chapter')::int BETWEEN 25 AND 27 THEN '矿产品'
        WHEN (t.data->>'chapter')::int BETWEEN 28 AND 38 THEN '化工品'
        WHEN (t.data->>'chapter')::int BETWEEN 39 AND 40 THEN '塑料橡胶'
        WHEN (t.data->>'chapter')::int BETWEEN 41 AND 43 THEN '皮革毛皮'
        WHEN (t.data->>'chapter')::int BETWEEN 44 AND 49 THEN '木及纸制品'
        WHEN (t.data->>'chapter')::int BETWEEN 50 AND 63 THEN '纺织品'
        WHEN (t.data->>'chapter')::int BETWEEN 64 AND 67 THEN '鞋帽'
        WHEN (t.data->>'chapter')::int BETWEEN 68 AND 70 THEN '石料陶瓷'
        WHEN (t.data->>'chapter')::int = 71 THEN '贵金属'
        WHEN (t.data->>'chapter')::int BETWEEN 72 AND 83 THEN '金属制品'
        WHEN (t.data->>'chapter')::int BETWEEN 84 AND 85 THEN '机电产品'
        WHEN (t.data->>'chapter')::int BETWEEN 86 AND 89 THEN '运输设备'
        WHEN (t.data->>'chapter')::int BETWEEN 90 AND 92 THEN '光学仪器'
        WHEN (t.data->>'chapter')::int = 93 THEN '武器'
        WHEN (t.data->>'chapter')::int BETWEEN 94 AND 96 THEN '杂项制品'
        WHEN (t.data->>'chapter')::int = 97 THEN '艺术品'
        ELSE '工业品'
      END
    ELSE '工业品'
  END,
  NOW()
FROM tmp_hscode t
ON CONFLICT (code) DO UPDATE SET
  description = EXCLUDED.description,
  unit = EXCLUDED.unit,
  "tariffRate" = EXCLUDED."tariffRate",
  "exportRate" = EXCLUDED."exportRate",
  "vatRate" = EXCLUDED."vatRate",
  "exciseRate" = EXCLUDED."exciseRate",
  supervision = EXCLUDED.supervision,
  category = EXCLUDED.category,
  "updatedAt" = NOW();

-- Re-enable triggers
SET session_replication_role = 'origin';

SELECT COUNT(*) AS total FROM "HSCode";
