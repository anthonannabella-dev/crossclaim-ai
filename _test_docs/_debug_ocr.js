
const fs = require('fs');
const code = fs.readFileSync('/app/dist/services/ocrParser.js', 'utf-8');
// 在 parseDocument 函数起始加日志
const mark = 'async function parseDocument(imagePath, category) {';
const insert = 'async function parseDocument(imagePath, category) {\n    console.log("[PARSEDOC START]", imagePath, category);';
const patched = code.replace(mark, insert);
// 在 recognizeImage 开头也加日志
const mark2 = 'async function recognizeImage(imagePath) {';
const insert2 = 'async function recognizeImage(imagePath) {\n    console.log("[RECOGNIZE START]", imagePath);';
const patched2 = patched.replace(mark2, insert2);
// 在 extractWithAI 开头加
const mark3 = 'async function extractWithAI(text, mode) {';
const insert3 = 'async function extractWithAI(text, mode) {\n    console.log("[EXTRACT START]", mode, "text_len:", text.length);';
const patched3 = patched2.replace(mark3, insert3);
fs.writeFileSync('/app/dist/services/ocrParser.js', patched3, 'utf-8');
console.log('DEBUG PATCHED');
