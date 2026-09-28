const fs = require('fs');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
const data = JSON.parse(fs.readFileSync('hscodes_2026.json', 'utf8'));
console.log('待导入:', data.length, '条');
let ok = 0, fail = 0;
for (const r of data) {
try {
await prisma.hSCode.upsert({
where: { code: r.code },
update: { description: r.description, declarationElements: r.declarationElements },
create: { code: r.code, description: r.description, declarationElements: r.declarationElements },
});
ok++;
if (ok % 1000 === 0) console.log(' 已导入', ok);
} catch (e) {
fail++;
if (fail <= 5) console.log(' 失败:', r.code, e.message);
}
}
console.log('完成: 成功', ok, '失败', fail);
const total = await prisma.hSCode.count();
console.log('HSCode 表现有总数:', total);
await prisma.$disconnect();
}
main().catch(e => { console.error('FATAL:', e); process.exit(1); });
