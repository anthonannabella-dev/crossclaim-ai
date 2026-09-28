// HS Code Bulk Importer — reads merged JSON and inserts into database.
// Run: npx tsx prisma\seed_hs_bulk.ts

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
  const jsonPath = path.resolve(__dirname, "..", "..", "data_fetcher", "output", "hs_codes.json");

  if (!fs.existsSync(jsonPath)) {
    console.error(`File not found: ${jsonPath}`);
    console.log("Run: cd data_fetcher && python expand_hs_tree.py && python merge_hs.py");
    process.exit(1);
  }

  const raw = fs.readFileSync(jsonPath, "utf-8");
  const records: HsRecord[] = JSON.parse(raw);
  console.log(`Found ${records.length} HS code records to import...`);

  // Clear existing HS codes before importing
  await prisma.hSCode.deleteMany();
  console.log("Cleared existing HS codes.");

  const BATCH = 500;
  let inserted = 0;

  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH);
    await prisma.hSCode.createMany({
      data: batch.map((rec) => {
        const chap = rec.chapter || rec.code.split(".")[0];
        const chapNum = parseInt(chap, 10);

        let category = "工业品";
        if (chapNum >= 1 && chapNum <= 24) category = "农产品";
        else if (chapNum >= 25 && chapNum <= 27) category = "矿产品";
        else if (chapNum >= 28 && chapNum <= 38) category = "化工品";
        else if (chapNum >= 39 && chapNum <= 40) category = "塑料橡胶";
        else if (chapNum >= 41 && chapNum <= 43) category = "皮革毛皮";
        else if (chapNum >= 44 && chapNum <= 49) category = "木及纸制品";
        else if (chapNum >= 50 && chapNum <= 63) category = "纺织品";
        else if (chapNum >= 64 && chapNum <= 67) category = "鞋帽";
        else if (chapNum >= 68 && chapNum <= 70) category = "石料陶瓷";
        else if (chapNum === 71) category = "贵金属";
        else if (chapNum >= 72 && chapNum <= 83) category = "金属制品";
        else if (chapNum >= 84 && chapNum <= 85) category = "机电产品";
        else if (chapNum >= 86 && chapNum <= 89) category = "运输设备";
        else if (chapNum >= 90 && chapNum <= 92) category = "光学仪器";
        else if (chapNum === 93) category = "武器";
        else if (chapNum >= 94 && chapNum <= 96) category = "杂项制品";
        else if (chapNum === 97) category = "艺术品";

        return {
          code: rec.code,
          description: rec.name,
          unit: rec.unit || "个",
          tariffRate: rec.mfn_rate || 0,
          exportRate: rec.export_rate ?? null,
          vatRate: rec.vat_rate ?? null,
          exciseRate: rec.excise_rate ?? null,
          supervision: rec.supervision || null,
          category,
        };
      }),
      skipDuplicates: true,
    });
    inserted += batch.length;
    console.log(`  ${i + batch.length}/${records.length} ...`);
  }

  const total = await prisma.hSCode.count();
  console.log(`Done: ${total} HS codes in database.`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
