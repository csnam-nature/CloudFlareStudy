// 답변 저장: Markdown(.md) · Word(.docx) · PDF(인쇄 화면 → "PDF로 저장")
//
// 빌드 없는 화면이라 라이브러리 없이 브라우저에서 바로 만듭니다.
//   MD   : 답변 글(Markdown) 그대로 + 질문·근거 문서 목록
//   DOCX : Word 파일은 ZIP 안에 XML 몇 개가 든 형식입니다. 아래 makeZip(무압축 ZIP)과 docx* 함수로 직접 만듭니다.
//          제목·문단·목록·표·굵게를 Word 서식으로 옮깁니다.
//   PDF  : 한글 글꼴을 PDF 에 넣으려면 큰 글꼴 파일이 필요해서, 대신 인쇄용 화면을 만들어 브라우저 인쇄 창을 엽니다.
//          인쇄 창에서 대상(프린터)을 "PDF로 저장"으로 고르면 됩니다.

import { esc } from "./common.js";

// ── 공통: 답변 Markdown → 블록 ─────────────────────────────

/**
 * 답변에 쓰이는 정도의 Markdown 을 블록으로 나눕니다.
 * { type: "h", level, text } | { type: "p", text } | { type: "ul"|"ol", items } | { type: "table", rows } | { type: "hr" }
 */
export function parseBlocks(md) {
  const lines = String(md ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let list = null;
  let para = [];
  const flushPara = () => {
    if (para.length) blocks.push({ type: "p", text: para.join(" ") }), (para = []);
  };
  const flushList = () => {
    if (list) blocks.push(list), (list = null);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 표: | a | b | 다음 줄이 | --- | --- |  (줄 끝에 붙은 근거 번호 "| ... | [1]" 도 표의 행으로 봄)
    if (TABLE_ROW.test(line) && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? "")) {
      flushPara(), flushList();
      const rows = [splitRow(line)];
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i])) rows.push(splitRow(lines[i++]));
      i--;
      blocks.push({ type: "table", rows });
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushPara(), flushList();
      blocks.push({ type: "h", level: h[1].length, text: h[2] });
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flushPara(), flushList();
      blocks.push({ type: "hr" });
      continue;
    }
    const li = line.match(/^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/);
    if (li) {
      flushPara();
      const type = li[1] ? "ol" : "ul";
      if (list?.type !== type) flushList(), (list = { type, items: [] });
      list.items.push(li[2]);
      continue;
    }
    if (!line.trim()) {
      flushPara(), flushList();
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushPara(), flushList();
  return blocks;
}

const TABLE_ROW = /^\s*\|.*\|\s*(?:\[\d+\]\s*)*$/;

function splitRow(line) {
  // 줄 끝 근거 번호는 마지막 칸에 붙입니다.
  const m = line.trim().match(/^(.*\|)\s*((?:\[\d+\]\s*)*)$/);
  const cells = m[1]
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, "|").trim());
  if (m[2].trim()) cells[cells.length - 1] += ` ${m[2].trim()}`;
  return cells;
}

/** 글 안의 **굵게** 와 `코드` 를 조각으로 나눕니다. [{ text, bold, code }] */
function inlineRuns(text) {
  const runs = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index) });
    runs.push(m[1] != null ? { text: m[1], bold: true } : { text: m[2], code: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs;
}

// ── 공통: 저장할 문서 모양 ───────────────────────────────

/**
 * items: [{ question, answer, sources }]  (sources: [{ docName, seq, score, text }])
 * 반환: { title, md } — 모든 형식이 이 Markdown 하나에서 만들어집니다.
 */
function buildMarkdown(appTitle, items) {
  const now = new Date();
  const stamp = now.toLocaleString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const title = items.length === 1 ? `${appTitle} 답변` : `${appTitle} 대화 기록`;
  const out = [`# ${title}`, "", `저장한 시각: ${stamp}`, ""];
  items.forEach((it, n) => {
    if (items.length > 1) out.push(`## ${n + 1}. ${oneLine(it.question)}`, "");
    else out.push(`## 질문`, "", it.question || "(질문 없음)", "");
    if (items.length === 1) out.push("## 답변", "");
    // 제목은 한 줄로 줄이고, 본문에는 질문 전체를 넣습니다(긴 질문의 조건이 잘리지 않게).
    else out.push("**질문**", "", String(it.question ?? "").trim() || "(질문 없음)", "");
    out.push(it.answer.trim() || "(답변 없음)", "");
    if (it.sources?.length) {
      out.push(items.length > 1 ? "**근거 문서**" : "## 근거 문서", "");
      it.sources.forEach((s, i) => out.push(`${i + 1}. [${i + 1}] ${s.docName} · 조각 ${s.seq + 1} (유사도 ${s.score})`));
      out.push("");
    }
  });
  return { title, md: out.join("\n").replace(/\n{3,}/g, "\n\n") };
}

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || "(질문 없음)";

/** 파일 이름: "네이처텍 문서 챗봇 답변 2026-11-26 1530.md" (파일 이름에 못 쓰는 글자는 뺌) */
function fileName(title, ext) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
  return `${title} ${stamp}.${ext}`.replace(/[\\/:*?"<>|]/g, "");
}

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

// ── 저장 (밖에서 부르는 함수) ─────────────────────────────

export function exportItems(format, appTitle, items) {
  const { title, md } = buildMarkdown(appTitle, items);
  if (format === "md") return download(new Blob([md], { type: "text/markdown;charset=utf-8" }), fileName(title, "md"));
  if (format === "docx") return download(makeDocx(title, parseBlocks(md)), fileName(title, "docx"));
  if (format === "pdf") return printPdf(fileName(title, "pdf").replace(/\.pdf$/, ""), parseBlocks(md));
}

// ── PDF: 인쇄용 화면 ──────────────────────────────────────

/** 블록 → HTML (인쇄용) */
export function blocksToHtml(blocks) {
  const inline = (t) =>
    inlineRuns(t)
      .map((r) => (r.bold ? `<b>${esc(r.text)}</b>` : r.code ? `<code>${esc(r.text)}</code>` : esc(r.text)))
      .join("");
  return blocks
    .map((b) => {
      if (b.type === "h") return `<h${b.level}>${inline(b.text)}</h${b.level}>`;
      if (b.type === "p") return `<p>${inline(b.text)}</p>`;
      if (b.type === "hr") return "<hr />";
      if (b.type === "ul" || b.type === "ol") return `<${b.type}>${b.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${b.type}>`;
      if (b.type === "table") {
        const [head, ...rows] = b.rows;
        return `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`;
      }
      return "";
    })
    .join("\n");
}

const PRINT_CSS = `
  @page { size: A4; margin: 18mm 16mm; }
  body { font-family: "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif; font-size: 11pt; line-height: 1.6; color: #111; }
  h1 { font-size: 18pt; border-bottom: 2px solid #f38020; padding-bottom: 4px; }
  h2 { font-size: 13.5pt; margin-top: 18pt; }
  table { border-collapse: collapse; width: 100%; margin: 6pt 0; font-size: 9.5pt; }
  th, td { border: 1px solid #999; padding: 3pt 5pt; text-align: left; vertical-align: top; }
  th { background: #f2f2f2; }
  tr, li { break-inside: avoid; }
  code { font-family: Consolas, monospace; background: #f4f4f4; padding: 0 2px; }
`;

/** 숨긴 iframe 에 인쇄용 문서를 넣고 인쇄 창을 엽니다. (새 창이 아니라 팝업 차단에 걸리지 않음) */
function printPdf(title, blocks) {
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  document.body.append(frame);
  const doc = frame.contentDocument;
  doc.open();
  doc.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PRINT_CSS}</style></head><body>${blocksToHtml(blocks)}</body></html>`);
  doc.close();
  // 인쇄 창의 기본 PDF 파일 이름은 부모 창 제목을 따르는 브라우저가 있어 잠시 바꿔 둡니다.
  const oldTitle = document.title;
  document.title = title;
  setTimeout(() => {
    frame.contentWindow.focus();
    frame.contentWindow.print();
    document.title = oldTitle;
    setTimeout(() => frame.remove(), 1000);
  }, 100);
}

// ── DOCX ──────────────────────────────────────────────────

const xml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function docxRuns(text, { bold = false, size } = {}) {
  return inlineRuns(text)
    .map((r) => {
      const props = [
        r.bold || bold ? "<w:b/>" : "",
        r.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:shd w:val="clear" w:fill="F4F4F4"/>' : "",
        size ? `<w:sz w:val="${size}"/>` : "",
      ].join("");
      return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${xml(r.text)}</w:t></w:r>`;
    })
    .join("");
}

const para = (inner, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}${inner}</w:p>`;

function docxBody(blocks) {
  return blocks
    .map((b) => {
      if (b.type === "h") return para(docxRuns(b.text), b.level === 1 ? "Title" : `Heading${Math.min(b.level - 1, 3)}`);
      if (b.type === "p") return para(docxRuns(b.text));
      if (b.type === "hr") return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="999999"/></w:pBdr></w:pPr></w:p>';
      if (b.type === "ul" || b.type === "ol")
        // 번호 매기기 정의(numbering.xml) 대신 글머리 기호·번호를 글자로 넣고 들여쓰기만 합니다.
        return b.items
          .map((it, i) => `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/></w:pPr>${docxRuns(`${b.type === "ol" ? `${i + 1}.` : "•"} `)}${docxRuns(it)}</w:p>`)
          .join("");
      if (b.type === "table") {
        const cols = Math.max(...b.rows.map((r) => r.length));
        const row = (r, head) =>
          `<w:tr>${head ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${Array.from({ length: cols }, (_, i) =>
            `<w:tc><w:tcPr>${head ? '<w:shd w:val="clear" w:fill="F2F2F2"/>' : ""}</w:tcPr>${para(docxRuns(r[i] ?? "", { bold: head, size: 18 }))}</w:tc>`,
          ).join("")}</w:tr>`;
        return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/></w:tblPr><w:tblGrid>${'<w:gridCol/>'.repeat(cols)}</w:tblGrid>${b.rows
          .map((r, i) => row(r, i === 0))
          .join("")}</w:tbl>${para("")}`;
      }
      return "";
    })
    .join("");
}

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W_NS}>
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Malgun Gothic" w:eastAsia="Malgun Gothic" w:hAnsi="Malgun Gothic" w:cs="Malgun Gothic"/><w:sz w:val="21"/><w:lang w:val="ko-KR" w:eastAsia="ko-KR"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="4" w:color="F38020"/></w:pBdr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="320" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="40"/><w:ind w:left="400" w:hanging="250"/></w:pPr></w:style>
  <w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders>
    <w:top w:val="single" w:sz="4" w:color="999999"/><w:left w:val="single" w:sz="4" w:color="999999"/><w:bottom w:val="single" w:sz="4" w:color="999999"/>
    <w:right w:val="single" w:sz="4" w:color="999999"/><w:insideH w:val="single" w:sz="4" w:color="999999"/><w:insideV w:val="single" w:sz="4" w:color="999999"/>
  </w:tblBorders><w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;

export function makeDocx(title, blocks) {
  const enc = new TextEncoder();
  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`,
    "docProps/core.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${xml(title)}</dc:title><dc:creator>${xml(title)}</dc:creator>
  <dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</dcterms:created>
</cp:coreProperties>`,
    "word/_rels/document.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    "word/styles.xml": STYLES,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W_NS}><w:body>${docxBody(blocks)}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1077" w:bottom="1134" w:left="1077" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`,
  };
  return new Blob([makeZip(Object.entries(files).map(([name, text]) => [name, enc.encode(text)]))], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

// ── 무압축 ZIP 만들기 ─────────────────────────────────────
// ZIP = [로컬 헤더 + 파일 내용] × N + 중앙 디렉터리 + 끝 표시. 압축(deflate) 없이 "저장" 방식만 씁니다.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function makeZip(entries) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const n = enc.encode(name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // 필요한 버전
    local.setUint16(6, 0x0800, true); // 이름이 UTF-8
    local.setUint16(8, 0, true); // 압축 없음
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, n.length, true);
    parts.push(new Uint8Array(local.buffer), n, data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, n.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), n);
    offset += 30 + n.length + data.length;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)]);
}
