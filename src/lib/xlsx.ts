/**
 * The first sheet of an Excel .xlsx file, as rows of text.
 *
 * An .xlsx is a zip of XML parts. fflate opens the zip; the XML is scanned
 * with regular expressions rather than DOMParser, for two reasons: it runs in
 * node, so the unit tests read real .xlsx bytes, and it avoids building a DOM
 * for a sheet that unpacks to a hundred megabytes of XML. Large lists still
 * import best as CSV, and the import screen says so.
 *
 * Covers what spreadsheets write for a plain table: shared strings (with rich
 * text runs), inline strings, formula results, numbers and booleans, and
 * empty cells — skipped in the XML, so placed by their cell reference. The old
 * binary .xls format is not read; it is a different file entirely.
 */

import { strFromU8, unzipSync } from 'fflate';

function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** All the <t> text inside one fragment — a shared string may be several runs. */
function texts(fragment: string): string {
  let out = '';
  for (const m of fragment.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)) out += m[1] ?? '';
  return decode(out);
}

/** "A" → 0, "Z" → 25, "AA" → 26. */
export function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function readXlsx(bytes: Uint8Array): string[][] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) => f.name.startsWith('xl/') && /\.(xml|rels)$/.test(f.name),
    });
  } catch {
    throw new Error('This is not an .xlsx file (old .xls files need saving as .xlsx or CSV first).');
  }
  const text = (p: string) => (files[p] ? strFromU8(files[p]) : null);

  const workbook = text('xl/workbook.xml');
  if (!workbook) throw new Error('No workbook inside this file.');
  const rid = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1];
  const rels = text('xl/_rels/workbook.xml.rels') ?? '';
  let target: string | null = null;
  if (rid) {
    for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
      if (new RegExp(`\\bId="${rid}"`).test(m[1])) target = /\bTarget="([^"]+)"/.exec(m[1])?.[1] ?? null;
    }
  }
  const path = target
    ? target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`
    : 'xl/worksheets/sheet1.xml';
  const sheet = text(path);
  if (!sheet) throw new Error('The first sheet could not be found inside this file.');

  const shared: string[] = [];
  for (const m of (text('xl/sharedStrings.xml') ?? '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    shared.push(texts(m[1]));
  }

  const rows: string[][] = [];
  for (const rm of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    let next = 0;
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const body = cm[2] ?? '';
      const ref = /\br="([A-Z]+)\d*"/i.exec(attrs)?.[1];
      const at = ref ? columnIndex(ref) : next;
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value = '';
      if (type === 's') value = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') value = texts(body);
      else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
      else value = v !== undefined ? decode(v) : '';
      while (row.length < at) row.push('');
      row[at] = value;
      next = at + 1;
    }
    if (row.some((c) => c.trim() !== '')) rows.push(row);
  }
  return rows;
}
