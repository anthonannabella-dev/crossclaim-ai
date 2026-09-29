/**
 * C-0009.1-A — 极简 XLSX 读取（零新增依赖）
 * ---------------------------------------------------------------
 * 只用 Node 内置 `zlib` 解压 ZIP 条目，读取 `xl/sharedStrings.xml` 与第一张工作表。
 * 范围刻意收窄：取单元格文本/数值即可，不处理公式求值、样式、多工作表合并。
 * 若结构超出可理解范围 → 抛错，由上层转 QUARANTINE（不猜）。
 */

import { inflateRawSync } from 'node:zlib';

interface ZipEntry {
  name: string;
  data: Buffer;
}

/** 解析 ZIP（只支持 stored / deflate），返回感兴趣的条目。 */
export function readZipEntries(buffer: Buffer, wanted: (name: string) => boolean): ZipEntry[] {
  const out: ZipEntry[] = [];
  // 从尾部找 End of Central Directory（EOCD 签名 0x06054b50）
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i >= buffer.length - 66_000; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('XLSX_STRUCTURE_UNREADABLE: 找不到 ZIP 目录');

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('XLSX_STRUCTURE_UNREADABLE: 中央目录损坏');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

    if (wanted(name)) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const raw = buffer.subarray(dataStart, dataStart + compressedSize);
      const data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
      out.push({ name, data });
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const si of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const texts = [...si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((match) => decodeXml(match[1]));
    out.push(texts.join(''));
  }
  return out;
}

function columnIndex(reference: string): number {
  const letters = (reference.match(/^[A-Z]+/) ?? ['A'])[0];
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

function parseSheet(xml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = [];
  for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1];
      const inner = cellMatch[2];
      const reference = /r="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? '';
      const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? '';
      let value = '';
      if (type === 's') {
        const idx = Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '-1');
        value = sharedStrings[idx] ?? '';
      } else if (type === 'inlineStr') {
        value = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join('');
      } else {
        value = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '');
      }
      const index = reference ? columnIndex(reference) : cells.length;
      cells[index] = value;
    }
    rows.push(cells.map((cell) => cell ?? ''));
  }
  return rows;
}

/** XLSX → 行数组（第一张工作表）。异常一律向上抛，由上层转 QUARANTINE。 */
export function readXlsxRows(buffer: Buffer): string[][] {
  const entries = readZipEntries(
    buffer,
    (name) => name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet1\.xml$/.test(name),
  );
  const shared = entries.find((entry) => entry.name === 'xl/sharedStrings.xml');
  const sheet = entries.find((entry) => entry.name === 'xl/worksheets/sheet1.xml');
  if (!sheet) throw new Error('XLSX_STRUCTURE_UNREADABLE: 找不到第一张工作表');
  const sharedStrings = shared ? parseSharedStrings(shared.data.toString('utf8')) : [];
  return parseSheet(sheet.data.toString('utf8'), sharedStrings);
}
