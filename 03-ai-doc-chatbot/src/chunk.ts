// 텍스트를 검색하기 좋은 크기의 조각(청크)으로 나눕니다.
//
// 왜 나누나? 임베딩 벡터 하나는 "글 한 덩어리의 의미"를 요약합니다. 문서 전체를 벡터 하나로 만들면
// 질문과 관련된 한 문단이 묻혀 버리므로, 문단 단위(약 800자)로 잘라 각각 벡터를 만듭니다.
// 겹침(overlap)은 문장이 경계에서 잘려 의미가 끊기는 것을 줄이기 위해 앞 청크의 끝부분을 조금 붙이는 것입니다.

export type ChunkOptions = { size?: number; overlap?: number };

export function chunkText(input: string, { size = 800, overlap = 100 }: ChunkOptions = {}): string[] {
  const text = input.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return [];

  // 1) 빈 줄 기준으로 문단을 나누고, 한 문단이 너무 길면 문장/글자 단위로 다시 자릅니다.
  const pieces: string[] = [];
  for (const para of text.split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    if (p.length <= size) pieces.push(p);
    else if (isTable(p)) pieces.push(...splitTable(p, size));
    else pieces.push(...splitLong(p, size));
  }

  // 2) 문단을 size 를 넘지 않을 만큼 이어 붙입니다.
  const chunks: string[] = [];
  let cur = "";
  for (const p of pieces) {
    if (cur && cur.length + p.length + 2 > size) {
      chunks.push(cur);
      // 다음 청크는 앞 청크의 끝 overlap 글자로 시작
      // 단어 중간에서 시작하지 않도록 첫 공백 뒤부터 잘라 씁니다.
      const raw = overlap > 0 ? cur.slice(-overlap) : "";
      const tail = raw.slice(raw.search(/\s/) + 1).trim();
      // 표 조각은 머리글이 이미 붙어 있으므로 앞 조각 꼬리를 붙이지 않습니다.
      cur = tail && !isTable(p) ? `${tail}\n\n${p}` : p;
    } else {
      cur = cur ? `${cur}\n\n${p}` : p;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** Markdown 표인지: 모든 줄이 | 로 시작하고 둘째 줄이 구분선(| --- |) */
const isTable = (p: string) => {
  const lines = p.split("\n");
  return lines.length >= 3 && lines.every((l) => l.trim().startsWith("|")) && /^\|?\s*:?-{3,}/.test(lines[1].trim());
};

/**
 * 큰 표(엑셀 시트, CSV)는 행 단위로 자르되, 조각마다 머리글 두 줄을 다시 붙입니다.
 * 그래야 "E-21 행"만 담긴 조각도 각 칸이 무슨 열인지(코드, 내용, 조치…) 알 수 있어 검색과 답변이 정확해집니다.
 */
function splitTable(p: string, size: number): string[] {
  const [head, sep, ...rows] = p.split("\n");
  const header = `${head}\n${sep}`;
  const out: string[] = [];
  let cur = header;
  for (const r of rows) {
    if (cur !== header && cur.length + r.length + 1 > size) {
      out.push(cur);
      cur = header;
    }
    cur += `\n${r}`;
  }
  if (cur !== header) out.push(cur);
  return out;
}

/** 긴 문단을 문장 경계(. ? ! 。 줄바꿈)에서 자르고, 그래도 길면 글자 수로 자릅니다. */
function splitLong(p: string, size: number): string[] {
  const sentences = p.split(/(?<=[.?!。])\s+|\n/);
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (s.length > size) {
      if (cur) out.push(cur), (cur = "");
      for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
    } else if (cur.length + s.length + 1 > size) {
      out.push(cur);
      cur = s;
    } else {
      cur = cur ? `${cur} ${s}` : s;
    }
  }
  if (cur) out.push(cur);
  return out;
}
