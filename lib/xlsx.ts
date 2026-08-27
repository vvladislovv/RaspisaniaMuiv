/**
 * Чтение xlsx: листы как разряжённая сетка «адрес → строка».
 * Без внешних зависимостей — только распаковка и регулярки по XML.
 */
import { unzip } from './unzip';

export interface Sheet {
  name: string;
  /** `A1` → текст ячейки. Пустые ячейки отсутствуют. */
  cells: Map<string, string>;
  /** Объединённые диапазоны, например `A6:A10`. */
  merges: string[];
  maxRow: number;
}

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

function decodeXml(s: string): string {
  return s
    .replace(/&(?:amp|lt|gt|quot|apos);/g, (e) => XML_ENTITIES[e])
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)));
}

/** Склеивает `<t>` внутри одного `<si>` — форматированный текст разбит на run-ы. */
function readSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const out: string[] = [];
  for (const si of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    let text = '';
    for (const t of si[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) {
      text += decodeXml(t[1]);
    }
    out.push(text);
  }
  return out;
}

function readSheet(name: string, xml: string, shared: string[]): Sheet {
  const cells = new Map<string, string>();
  let maxRow = 0;

  for (const row of xml.matchAll(/<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const rowNum = Number(row[1]);
    if (rowNum > maxRow) maxRow = rowNum;

    // Атрибуты лениво: иначе жадный [^>]* съедает `/>` и захватывает следующую ячейку
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    for (const c of row[2].matchAll(cellRe)) {
      const attrs = c[1];
      const inner = c[2];
      if (!inner) continue;

      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      if (!ref) continue;

      const type = /\bt="([a-z]+)"/.exec(attrs)?.[1];
      let value: string | undefined;

      if (type === 'inlineStr') {
        value = [...inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
          .map((m) => decodeXml(m[1]))
          .join('');
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        if (v === undefined) continue;
        value = type === 's' ? (shared[Number(v)] ?? '') : decodeXml(v);
      }

      const trimmed = value.trim();
      if (trimmed) cells.set(ref, trimmed);
    }
  }

  const merges = [...xml.matchAll(/<mergeCell ref="([^"]+)"/g)].map((m) => m[1]);

  return { name, cells, merges, maxRow };
}

/** Разбирает xlsx в список листов в порядке, заданном книгой. */
export function readWorkbook(buf: Buffer): Sheet[] {
  const zip = unzip(buf);
  const get = (p: string) => zip.get(p)?.toString('utf8');

  const workbook = get('xl/workbook.xml');
  if (!workbook) throw new Error('xlsx: нет xl/workbook.xml');

  const rels = get('xl/_rels/workbook.xml.rels') ?? '';
  const relTarget = new Map<string, string>();
  for (const r of rels.matchAll(/<Relationship\b([^>]*)\/>/g)) {
    const id = /\bId="([^"]+)"/.exec(r[1])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(r[1])?.[1];
    if (id && target) relTarget.set(id, target.replace(/^\/?xl\//, '').replace(/^\.\//, ''));
  }

  const shared = readSharedStrings(get('xl/sharedStrings.xml'));
  const sheets: Sheet[] = [];

  for (const s of workbook.matchAll(/<sheet\b([^>]*)\/>/g)) {
    const attrs = s[1];
    const name = decodeXml(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? '');
    const rid = /\br:id="([^"]+)"/.exec(attrs)?.[1] ?? '';
    const target = relTarget.get(rid);
    const xml = target ? get(`xl/${target}`) : undefined;
    if (!xml) continue;
    sheets.push(readSheet(name, xml, shared));
  }

  if (sheets.length === 0) throw new Error('xlsx: не найдено ни одного листа');
  return sheets;
}

/** `A` → 1, `Z` → 26, `AA` → 27. */
export function colToIndex(col: string): number {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export function indexToCol(index: number): string {
  let n = index;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * Значение ячейки с учётом объединений: у объединённого диапазона значение
 * хранится только в левой верхней ячейке.
 */
export function resolveMerges(sheet: Sheet): void {
  for (const range of sheet.merges) {
    const [from, to] = range.split(':');
    const a = /([A-Z]+)(\d+)/.exec(from);
    const b = /([A-Z]+)(\d+)/.exec(to);
    if (!a || !b) continue;

    const value = sheet.cells.get(from);
    if (!value) continue;

    const c1 = colToIndex(a[1]);
    const c2 = colToIndex(b[1]);
    const r1 = Number(a[2]);
    const r2 = Number(b[2]);

    for (let c = c1; c <= c2; c++) {
      for (let r = r1; r <= r2; r++) {
        const ref = indexToCol(c) + r;
        if (!sheet.cells.has(ref)) sheet.cells.set(ref, value);
      }
    }
  }
}
