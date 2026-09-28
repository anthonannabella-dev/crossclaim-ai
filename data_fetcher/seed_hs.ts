// HS Code Database Seeder
// ========================
// Imports HS code data from scraper output into the Prisma database.
// Run: cd backend && tsx ..\data_fetcher\seed_hs.ts

import { PrismaClient } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

const prisma = new PrismaClient();

interface HsRecord {
  code: string;
  name: string;
  unit: string;
  mfn_rate: number;
  export_rate: number;
  vat_rate: number;
  excise_rate: number;
  supervision: string;
  chapter: string;
}

async function main() {
  const jsonPath = path.resolve(__dirname, "output", "hs_codes.json");

  if (!fs.existsSync(jsonPath)) {
    console.error(`File not found: ${jsonPath}`);
    console.log("Run 'cd data_fetcher && python scrape_hs.py' first to generate data.");
    process.exit(1);
  }

  const raw = fs.readFileSync(jsonPath, "utf-8");
  const records: HsRecord[] = JSON.parse(raw);

  console.log(`Found ${records.length} HS code records to import...`);

  let inserted = 0;
  let skipped = 0;

  for (const rec of records) {
    const exists = await prisma.hSCode.findUnique({ where: { code: rec.code } });
    if (exists) {
      skipped++;
      continue;
    }

    // Determine category from chapter
    let category = "工业品";
    const chap = parseInt(rec.code.split(".")[0], 10);
    if (chap >= 1 && chap <= 24) category = "农产品";
    else if (chap >= 25 && chap <= 27) category = "矿产品";
    else if (chap >= 28 && chap <= 38) category = "化工品";
    else if (chap >= 39 && chap <= 40) category = "塑料橡胶";
    else if (chap >= 41 && chap <= 43) category = "皮革毛皮";
    else if (chap >= 44 && chap <= 49) category = "木及纸制品";
    else if (chap >= 50 && chap <= 63) category = "纺织品";
    else if (chap >= 64 && chap <= 67) category = "鞋帽";
    else if (chap >= 68 && chap <= 70) category = "石料陶瓷";
    else if (chap >= 71 && chap <= 71) category = "贵金属";
    else if (chap >= 72 && chap <= 83) category = "金属制品";
    else if (chap >= 84 && chap <= 85) category = "机电产品";
    else if (chap >= 86 && chap <= 89) category = "运输设备";
    else if (chap >= 90 && chap <= 92) category = "光学仪器";
    else if (chap >= 93 && chap <= 93) category = "武器";
    else if (chap >= 94 && chap <= 96) category = "杂项制品";

    await prisma.hSCode.create({
      data: {
        code: rec.code,
        description: rec.name,
        unit: rec.unit || "个",
        tariffRate: rec.mfn_rate,
        category,
      },
    });
    inserted++;
  }

  console.log(`Done: ${inserted} inserted, ${skipped} skipped (already exist)`);

  const total = await prisma.hSCode.count();
  console.log(`Total HS codes in database: ${total}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
