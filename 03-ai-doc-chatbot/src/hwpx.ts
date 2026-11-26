// HWPX(한글 2014 이후 기본 저장 형식) → Markdown
//
// HWPX 는 ZIP 안에 XML 을 담은 공개 형식(KS X 6101, OWPML)이라 AI 없이 직접 읽을 수 있습니다.
// 그래서 연습 모드에서도 됩니다. 구조는 대략 이렇습니다.
//   Contents/content.hpf      : 본문 파일 목록과 순서(spine)
//   Contents/section0.xml ... : 본문. 문단 <hp:p> 안의 <hp:run> 안의 <hp:t> 에 글자가 있고,
//                               표는 <hp:tbl> → <hp:tr>(행) → <hp:tc>(칸) → <hp:subList> → <hp:p> 로 들어 있습니다.
// 예전 바이너리 형식 .hwp 는 구조가 전혀 달라 지원하지 않습니다(한글에서 HWPX 나 PDF 로 다시 저장해 올리세요).

import { unzipSync, strFromU8 } from "fflate";

/** 압축을 풀었을 때 크기 한도. 작은 ZIP 이 엄청나게 부풀어 오르는 "압축 폭탄"을 막습니다. */
const MAX_UNZIPPED_BYTES = 50 * 1024 * 1024;

/** 본문을 읽는 데 필요한 파일만 풉니다(그림 등은 건너뜀). */
const wanted = (name: string) =>
  /^Contents\/(content\.hpf|section\d+\.xml)$/i.test(name) || /^(META-INF\/manifest\.xml|Preview\/PrvText\.txt)$/i.test(name);

export async function hwpxToMarkdown(bytes: ArrayBuffer): Promise<string> {
  const u8 = new Uint8Array(bytes);
  // 파일 앞 4바이트(매직 넘버)로 진짜 형식을 먼저 확인합니다.
  //   50 4B 03 04 = "PK" ZIP(HWPX)   D0 CF 11 E0 = OLE 복합 문서(예전 HWP·DOC·XLS)
  const magic = Array.from(u8.subarray(0, 4), (b) => b.toString(16).padStart(2, "0")).join(" ");
  if (magic === "d0 cf 11 e0")
    throw new Error("확장자는 .hwpx 지만 실제로는 예전 형식(HWP) 파일입니다. 한글에서 열어 [다른 이름으로 저장] → 파일 형식 'HWPX' 로 저장해 올려 주세요.");
  if (!magic.startsWith("50 4b"))
    throw new Error(`HWPX 파일이 아닙니다(ZIP 형식이 아님, 파일 앞부분 ${magic || "비어 있음"}). 한글에서 'HWPX' 형식으로 다시 저장해 올려 주세요.`);

  let files: Record<string, Uint8Array>;
  try {
    files = unzipFast(u8);
    // 위치 정보가 어긋난 ZIP 은 fflate 가 오류 없이 빈 목록을 줄 때가 있어, 본문이 없으면 예비 읽기로 다시 확인합니다.
    if (!Object.keys(files).some((n) => /^Contents\/section\d+\.xml$/i.test(n))) throw new Error("본문 파일을 찾지 못함");
  } catch (e) {
    if (e instanceof TooBigError) throw e;
    // fflate 가 못 여는 ZIP(일부 프로그램이 만든 특이한 구조)은 Workers 내장 압축 해제로 한 번 더 시도합니다.
    try {
      files = await unzipFallback(u8);
    } catch (e2) {
      if (e2 instanceof TooBigError) throw e2;
      const why = (x: unknown) => (x instanceof Error ? x.message : String(x));
      console.error("HWPX 압축 풀기 실패", why(e), "/", why(e2));
      throw new Error(`HWPX 압축을 풀지 못했습니다(${why(e)}). 한글에서 열어 'HWPX' 로 다시 저장한 뒤 올려 주세요.`);
    }
  }

  // 암호를 건 문서·배포용 문서는 본문이 암호화되어 있어 읽을 수 없습니다.
  const manifest = files["META-INF/manifest.xml"];
  if (manifest && /encryption-data/i.test(strFromU8(manifest)))
    throw new Error("암호가 걸렸거나 배포용으로 저장된 HWPX 는 읽을 수 없습니다. 한글에서 암호·배포용 설정을 풀고 다시 저장해 올려 주세요.");

  const sections = sectionOrder(files);
  if (sections.length === 0) throw new Error("HWPX 안에 본문(Contents/section*.xml)이 없습니다.");

  const parts = sections.map((name) => sectionToMarkdown(strFromU8(files[name]))).filter((s) => s.trim());
  const md = parts.join("\n\n").trim();
  if (md) return md;

  // 본문에서 글자를 못 찾으면 한글이 만들어 두는 미리보기 글(앞부분만)이라도 씁니다.
  const preview = files["Preview/PrvText.txt"];
  return preview ? strFromU8(preview).trim() : "";
}

class TooBigError extends Error {
  constructor() {
    super(`HWPX 압축을 풀면 너무 큽니다(${MAX_UNZIPPED_BYTES / 1024 / 1024}MB 초과).`);
  }
}

/** fflate 로 풀기(빠름) */
function unzipFast(u8: Uint8Array): Record<string, Uint8Array> {
  let total = 0;
  return unzipSync(u8, {
    filter: (f) => {
      if (!wanted(f.name)) return false;
      total += f.originalSize;
      if (total > MAX_UNZIPPED_BYTES) throw new TooBigError();
      return true;
    },
  });
}

/**
 * 예비 ZIP 읽기: ZIP 끝의 "중앙 디렉터리"에서 파일 목록을 읽고, 압축(deflate)은 Workers 내장 DecompressionStream 으로 풉니다.
 * ZIP64(4GB 넘는 크기 표기)와 앞에 다른 데이터가 붙은 ZIP 도 처리합니다.
 */
async function unzipFallback(u8: Uint8Array): Promise<Record<string, Uint8Array>> {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const u16 = (o: number) => dv.getUint16(o, true);
  const u32 = (o: number) => dv.getUint32(o, true);
  const u64 = (o: number) => u32(o) + u32(o + 4) * 2 ** 32;

  // 1) 끝에서부터 EOCD(PK\x05\x06) 찾기 (뒤에 주석이 최대 65535바이트 붙을 수 있음)
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--)
    if (u32(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error("ZIP 끝 표시(EOCD)가 없습니다. 파일이 잘렸을 수 있습니다");
  let count = u16(eocd + 10);
  let cdSize = u32(eocd + 12);
  let cdOff = u32(eocd + 16);
  if (eocd >= 20 && u32(eocd - 20) === 0x07064b50) {
    const z64 = u64(eocd - 20 + 8);
    if (u32(z64) === 0x06064b50) (count = u64(z64 + 32)), (cdSize = u64(z64 + 40)), (cdOff = u64(z64 + 48));
  }
  // 앞에 다른 데이터가 붙어 있으면 기록된 위치가 밀려 있으므로 실제 위치에 맞춥니다.
  const shift = eocd - cdSize - cdOff > 0 && u32(eocd - cdSize) === 0x02014b50 ? eocd - cdSize - cdOff : 0;

  const out: Record<string, Uint8Array> = {};
  let total = 0;
  let p = cdOff + shift;
  for (let n = 0; n < count && u32(p) === 0x02014b50; n++) {
    const flags = u16(p + 8);
    const method = u16(p + 10);
    let csize = u32(p + 20);
    let usize = u32(p + 24);
    const nameLen = u16(p + 28);
    const extraLen = u16(p + 30);
    const commentLen = u16(p + 32);
    let local = u32(p + 42);
    const name = new TextDecoder(flags & 0x800 ? "utf-8" : "latin1").decode(u8.subarray(p + 46, p + 46 + nameLen));
    // ZIP64 추가 필드(0x0001): 0xFFFFFFFF 로 표시된 값만 차례로 들어 있음
    for (let e = p + 46 + nameLen; e < p + 46 + nameLen + extraLen; ) {
      const id = u16(e);
      const len = u16(e + 2);
      if (id === 1) {
        let q = e + 4;
        if (usize === 0xffffffff) (usize = u64(q)), (q += 8);
        if (csize === 0xffffffff) (csize = u64(q)), (q += 8);
        if (local === 0xffffffff) local = u64(q);
      }
      e += 4 + len;
    }
    p += 46 + nameLen + extraLen + commentLen;
    if (!wanted(name)) continue;
    if (flags & 1) throw new Error("ZIP 자체에 암호가 걸려 있습니다");
    total += usize;
    if (total > MAX_UNZIPPED_BYTES) throw new TooBigError();

    const lh = local + shift;
    if (u32(lh) !== 0x04034b50) throw new Error(`${name} 의 위치 정보가 맞지 않습니다`);
    const start = lh + 30 + u16(lh + 26) + u16(lh + 28);
    const data = u8.subarray(start, start + csize);
    if (method === 0) out[name] = data.slice();
    else if (method === 8) out[name] = await inflateRaw(data);
    else throw new Error(`${name} 의 압축 방식(${method})을 지원하지 않습니다`);
  }
  return out;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 본문 파일 순서: content.hpf 의 spine 순서를 따르고, 없으면 section 번호 순으로. */
function sectionOrder(files: Record<string, Uint8Array>): string[] {
  const all = Object.keys(files).filter((n) => /^Contents\/section\d+\.xml$/i.test(n));
  const num = (n: string) => Number(n.match(/section(\d+)/i)![1]);
  const fallback = all.sort((a, b) => num(a) - num(b));

  const hpf = files["Contents/content.hpf"];
  if (!hpf) return fallback;
  const xml = strFromU8(hpf);
  const hrefById = new Map<string, string>();
  for (const m of xml.matchAll(/<(?:\w+:)?item\b([^>]*)>/g)) {
    const id = attr(m[1], "id");
    const href = attr(m[1], "href");
    if (id && href) hrefById.set(id, href);
  }
  const ordered: string[] = [];
  for (const m of xml.matchAll(/<(?:\w+:)?itemref\b([^>]*)>/g)) {
    const href = hrefById.get(attr(m[1], "idref") ?? "");
    if (!href) continue;
    const name = href.startsWith("Contents/") ? href : `Contents/${href.replace(/^\.\//, "")}`;
    if (files[name] && /section\d+\.xml$/i.test(name) && !ordered.includes(name)) ordered.push(name);
  }
  // spine 에 빠진 section 이 있으면 뒤에 붙입니다.
  for (const n of fallback) if (!ordered.includes(n)) ordered.push(n);
  return ordered;
}

const attr = (attrs: string, name: string) => attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

/** 표의 칸 하나. r·c 는 위치(cellAddr), rs·cs 는 병합 크기(cellSpan). */
type Cell = { text: string; r?: number; c?: number; rs: number; cs: number; row: number };
type Table = { cells: Cell[]; rowIdx: number; cell: string[] | null; meta: { r?: number; c?: number; rs: number; cs: number } };

/**
 * section XML 하나 → Markdown.
 * Workers 에는 DOMParser 가 없어서, 태그를 차례로 훑는 작은 파서로 필요한 것(문단·표)만 골라냅니다.
 */
export function sectionToMarkdown(xml: string): string {
  const blocks: string[] = []; // 결과 블록(문단 한 줄 또는 표 하나)
  const paras: string[] = []; // 열려 있는 문단들(표 칸 안에 문단이 겹쳐 들어가므로 스택)
  const tables: Table[] = []; // 열려 있는 표들(표 안의 표도 있음)
  let inText = 0; // <hp:t> 안인가

  // 문단이 끝났을 때 결과를 넣을 곳: 가장 안쪽 표의 칸(한 줄로), 없으면 본문.
  const emit = (text: string) => {
    const cell = tables.at(-1)?.cell;
    if (cell) {
      if (text.trim()) cell.push(text.replace(/\s*\n\s*/g, " ").trim());
    } else if (text.trim()) blocks.push(text.trim());
  };

  for (const m of xml.matchAll(/<(\/?)([\w.-]+:)?([\w.-]+)((?:\s[^>]*?)?)(\/?)>|([^<]+)/g)) {
    const [, close, , local, attrs, selfClose, text] = m;
    if (text !== undefined) {
      if (inText > 0 && paras.length) paras[paras.length - 1] += decodeEntities(text);
      continue;
    }
    const opening = !close;
    const closing = !!close || !!selfClose;

    switch (local) {
      case "p":
        if (opening) paras.push("");
        if (closing) emit(paras.pop() ?? "");
        break;
      case "t":
        if (opening && !selfClose) inText++;
        else if (close) inText = Math.max(0, inText - 1);
        break;
      case "tab":
        if (paras.length) paras[paras.length - 1] += " ";
        break;
      case "lineBreak":
        if (paras.length) paras[paras.length - 1] += "\n";
        break;
      case "tbl":
        if (opening) {
          // 표 앞에 같은 문단의 글자가 있으면 먼저 내보냅니다.
          if (paras.length && paras[paras.length - 1].trim()) {
            emit(paras[paras.length - 1]);
            paras[paras.length - 1] = "";
          }
          tables.push({ cells: [], rowIdx: -1, cell: null, meta: { rs: 1, cs: 1 } });
        }
        if (closing) {
          const t = tables.pop();
          if (!t) break;
          const grid = toGrid(t.cells);
          const outer = tables.at(-1)?.cell;
          // 표 안의 표는 바깥 칸 안에 "a / b; c / d" 처럼 한 줄로 풀어 넣습니다.
          if (outer) outer.push(grid.map((r) => dedupe(r).join(" / ")).filter(Boolean).join("; "));
          else {
            const md = renderTable(grid);
            if (md) blocks.push(md);
          }
        }
        break;
      case "tr": {
        const t = tables.at(-1);
        if (t && opening) t.rowIdx++;
        break;
      }
      case "tc": {
        const t = tables.at(-1);
        if (t && opening) (t.cell = []), (t.meta = { rs: 1, cs: 1 });
        if (t && closing && t.cell) {
          t.cells.push({ text: t.cell.join(" ").trim(), ...t.meta, row: Math.max(0, t.rowIdx) });
          t.cell = null;
        }
        break;
      }
      // 칸의 위치와 병합 크기. 칸 내용(subList) 뒤에 나오므로 칸이 닫힐 때 씁니다.
      // (표 안의 표가 있어도, 안쪽 표의 칸은 이미 닫혔으므로 가장 안쪽 열린 표가 이 칸의 표입니다.)
      case "cellAddr": {
        const t = tables.at(-1);
        if (t?.cell) (t.meta.c = num(attrs, "colAddr")), (t.meta.r = num(attrs, "rowAddr"));
        break;
      }
      case "cellSpan": {
        const t = tables.at(-1);
        if (t?.cell) (t.meta.cs = num(attrs, "colSpan") ?? 1), (t.meta.rs = num(attrs, "rowSpan") ?? 1);
        break;
      }
    }
  }
  return blocks.join("\n\n");
}

const num = (attrs: string, name: string) => {
  const v = Number(attr(attrs, name));
  return Number.isFinite(v) && attr(attrs, name) !== undefined ? v : undefined;
};

/** 같은 병합 칸이 이어서 반복된 것은 한 번만 */
const dedupe = (r: (Cell | null)[]) => r.filter((c, i) => c && c.text && c !== r[i - 1]).map((c) => c!.text);

/**
 * 칸 목록 → 2차원 격자. 병합된 칸은 덮는 자리마다 같은 칸을 가리킵니다.
 * 위치(cellAddr)가 있으면 그대로 쓰고, 없으면 HTML 표처럼 "다음 빈 자리"에 차례로 채웁니다.
 */
function toGrid(cells: Cell[]): (Cell | null)[][] {
  const grid: (Cell | null)[][] = [];
  const at = (r: number) => (grid[r] ??= []);
  const hasAddr = cells.length > 0 && cells.every((c) => c.r !== undefined && c.c !== undefined);
  let lastRow = -1;
  let col = 0;
  for (const cell of cells) {
    let r: number, c: number;
    if (hasAddr) (r = cell.r!), (c = cell.c!);
    else {
      if (cell.row !== lastRow) (lastRow = cell.row), (col = 0);
      r = cell.row;
      while (at(r)[col]) col++;
      c = col;
    }
    const rs = Math.max(1, Math.min(cell.rs, 500));
    const cs = Math.max(1, Math.min(cell.cs, 100));
    for (let i = 0; i < rs; i++) for (let j = 0; j < cs; j++) at(r + i)[c + j] = cell;
    col = c + cs;
  }
  const cols = Math.max(0, ...grid.map((r) => (r ? r.length : 0)));
  return Array.from(grid, (r) => Array.from({ length: cols }, (_, i) => r?.[i] ?? null));
}

/**
 * 격자 → Markdown. 공문서 표에 흔한 모양을 정리합니다.
 *  - 칸 하나짜리 표(제목 상자)나 한 줄·한 열짜리 표 → 표가 아니라 그냥 글로
 *  - 맨 위·맨 아래의 "가로 전체를 합친 행"(표 제목, ※ 비고) → 표 앞뒤의 글로
 *  - 머리글이 두 줄 이상으로 병합돼 있으면(예: "충전기 | 충전기" 아래 "모델명 | 용량") 열마다 합쳐 한 줄로
 *  - 세로로 병합된 칸(같은 제조사 여러 모델 등)은 행마다 다시 적어, 행 하나만 잘려 나와도 뜻이 통하게
 */
function renderTable(grid: (Cell | null)[][]): string {
  const rows = grid.filter((r) => r.some((c) => c?.text));
  const cols = rows[0]?.length ?? 0;
  if (!rows.length) return "";
  const fullWidth = (r: (Cell | null)[]) => r.every((c) => c === r[0]);
  const lines = (rs: (Cell | null)[][]) => rs.map((r) => dedupe(r).join(" / ")).filter(Boolean);

  if (cols <= 1 || rows.length <= 1) return lines(rows).join("\n");

  const before: string[] = [];
  const after: string[] = [];
  while (rows.length && fullWidth(rows[0])) before.push(...lines([rows.shift()!]));
  while (rows.length && fullWidth(rows[rows.length - 1])) after.unshift(...lines([rows.pop()!]));
  if (rows.length <= 1) return [...before, ...lines(rows), ...after].join("\n\n");

  // 머리글 줄 수: 첫 행 칸들이 세로로 병합돼 내려온 만큼(최대 3줄). 가로 병합만 있으면 다음 줄까지.
  let headRows = 1;
  for (const c of new Set(rows[0])) if (c) headRows = Math.max(headRows, c.rs);
  if (headRows === 1 && rows[0].some((c, i) => c && c === rows[0][i + 1])) headRows = 2;
  headRows = Math.min(headRows, 3, rows.length - 1);

  const header = Array.from({ length: cols }, (_, i) => {
    const parts: string[] = [];
    for (let r = 0; r < headRows; r++) {
      const t = rows[r][i]?.text ?? "";
      if (t && !parts.includes(t)) parts.push(t);
    }
    return parts.join(" ");
  });
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
  const line = (r: string[]) => `| ${r.map(cell).join(" | ")} |`;
  const body = rows.slice(headRows).map((r) =>
    // 가로 병합의 이어진 자리는 비우고(같은 글이 옆으로 반복되지 않게), 세로 병합은 그대로 반복
    r.map((c, i) => (c && (i === 0 || r[i - 1] !== c) ? c.text : "")),
  );
  const table = [line(header), `|${" --- |".repeat(cols)}`, ...body.map(line)].join("\n");
  return [...before, table, ...after].join("\n\n");
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    }
    return { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }[e.toLowerCase()] ?? "";
  });
}
