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

export function hwpxToMarkdown(bytes: ArrayBuffer): string {
  let total = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(bytes), {
      // 필요한 파일만 풉니다(그림 등은 건너뜀).
      filter: (f) => {
        const want = /^Contents\/(content\.hpf|section\d+\.xml)$/i.test(f.name) || /^(META-INF\/manifest\.xml|Preview\/PrvText\.txt)$/i.test(f.name);
        if (want) total += f.originalSize;
        if (total > MAX_UNZIPPED_BYTES) throw new Error("HWPX 압축을 풀면 너무 큽니다(50MB 초과).");
        return want;
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("50MB")) throw e;
    throw new Error("HWPX 파일을 열 수 없습니다(ZIP 형식이 아님). 확장자만 바꾼 .hwp 파일이면 한글에서 'HWPX 로 저장'해 올려 주세요.");
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

type Table = { rows: string[][]; row: string[] | null; cell: string[] | null };

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
    const [, close, , local, , selfClose, text] = m;
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
          tables.push({ rows: [], row: null, cell: null });
        }
        if (closing) {
          const t = tables.pop();
          if (!t) break;
          const outer = tables.at(-1)?.cell;
          // 표 안의 표는 바깥 칸 안에 "a / b; c / d" 처럼 한 줄로 풀어 넣습니다.
          if (outer) outer.push(t.rows.map((r) => r.filter((c) => c.trim()).join(" / ")).filter(Boolean).join("; "));
          else if (t.rows.length) blocks.push(renderTable(t.rows));
        }
        break;
      case "tr": {
        const t = tables.at(-1);
        if (t && opening) t.row = [];
        if (t && closing && t.row) t.rows.push(t.row), (t.row = null);
        break;
      }
      case "tc": {
        const t = tables.at(-1);
        if (t && opening) t.cell = [];
        if (t && closing && t.cell) (t.row ??= []).push(t.cell.join(" ")), (t.cell = null);
        break;
      }
    }
  }
  return blocks.join("\n\n");
}

/** 행 목록 → Markdown 표. 첫 행을 머리글로 씁니다(chunk.ts 가 큰 표를 나눌 때 머리글을 조각마다 다시 붙임). */
function renderTable(rows: string[][]): string {
  const data = rows.filter((r) => r.some((c) => c.trim()));
  if (data.length === 0) return "";
  const cols = Math.max(...data.map((r) => r.length));
  const cell = (s: string | undefined) => (s ?? "").replace(/\|/g, "\\|").trim();
  const line = (r: string[]) => `| ${Array.from({ length: cols }, (_, i) => cell(r[i])).join(" | ")} |`;
  return [line(data[0]), `|${" --- |".repeat(cols)}`, ...data.slice(1).map(line)].join("\n");
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
