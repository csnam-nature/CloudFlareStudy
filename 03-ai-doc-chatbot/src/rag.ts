// RAG(검색 증강 생성)의 "검색"과 "프롬프트 만들기"
//
//   질문 → 임베딩 → Vectorize 에서 가까운 청크 topK 개 → D1 에서 원문 → 프롬프트에 근거로 넣기
// LLM 은 학습 때 본 적 없는 사내 문서를 모르므로, 찾은 근거를 프롬프트에 넣어 "이것만 보고 답하라"고 시킵니다.

import { type ChatMessage, embed, queryVectors } from "./ai";
import type { Bindings } from "./auth";
import type { Settings } from "./settings";

export type Source = { id: string; docId: number; docName: string; seq: number; score: number; text: string };

// 이 점수보다 낮은 청크는 관련 없다고 보고 버립니다(코사인 유사도, 1에 가까울수록 비슷).
// 진짜 모드(bge-m3)와 연습 모드(글자 해시)는 점수 분포가 달라 기준도 다르게 둡니다.
// 단, 질문 단어가 그대로 들어 있는 조각(키워드 검색에 걸린 조각)은 이 기준과 상관없이 후보에 남깁니다.
// 진짜 모드 기준은 관리 화면 설정(minScore, 기본 0.35), 연습 모드는 0.05 고정.
const MOCK_MIN_SCORE = 0.05;
// 벡터 검색에서 먼저 뽑는 후보 수. 여기서 키워드 점수를 더해 다시 줄을 세운 뒤 설정의 topK 개만 씁니다.
const CANDIDATES = { real: 20, mock: 50 };
// 키워드 검색으로 더하는 후보 수(단어마다)
const KEYWORD_LIMIT = 20;

/**
 * 하이브리드 검색 = 벡터 검색(뜻이 비슷한 조각) + 키워드 검색(질문 단어가 그대로 들어 있는 조각).
 *
 * 왜 키워드도 쓰나? "SK시그넷"처럼 짧은 회사명·모델명·코드만 물으면, 수십 행짜리 표 조각과의 벡터 유사도는
 * 낮게 나와(문장 뜻이 거의 없으므로) 기준(minScore) 아래로 떨어지기 쉽습니다. 그러면 근거가 0개가 되어
 * 모델은 "등록된 문서에서 찾지 못했습니다"라고 답합니다. 이름·번호 같은 것은 글자 그대로 찾는 편이 정확합니다.
 */
export async function retrieve(env: Bindings, s: Settings, question: string, mock: boolean, docId?: number): Promise<Source[]> {
  const minScore = mock ? MOCK_MIN_SCORE : s.minScore;
  const mode = mock ? "mock" : "real";
  const words = queryWords(question);
  const [qvec] = await embed(env, [question]);
  const [vecMatches, keywordIds] = await Promise.all([
    queryVectors(env, qvec, Math.max(CANDIDATES[mode], s.topK * 2), docId),
    keywordSearch(env, words, docId),
  ]);

  const vecScore = new Map(vecMatches.map((m) => [m.id, m.score]));
  const ids = new Set([...vecMatches.filter((m) => m.score >= minScore).map((m) => m.id), ...keywordIds]);
  if (!ids.size) {
    console.log(`검색: 근거 없음 (벡터 최고 점수 ${vecMatches[0]?.score.toFixed(3) ?? "-"}, 기준 ${minScore}, 키워드 ${JSON.stringify(words)})`);
    return [];
  }

  // Vectorize 는 벡터만 돌려주므로 원문은 D1 에서 같은 id 로 꺼냅니다.
  const list = [...ids];
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.doc_id, c.seq, c.text, d.name
       FROM chunks c JOIN documents d ON d.id = c.doc_id
      WHERE c.id IN (${list.map(() => "?").join(",")})`,
  )
    .bind(...list)
    .all<{ id: string; doc_id: number; seq: number; text: string; name: string }>();

  // 최종 점수 = 벡터 점수 + 키워드 점수(질문 단어가 들어 있는 비율 × 0.5). 그 사이 삭제된 청크는 결과에 없으므로 빠집니다.
  const sources = results
    .map((r) => {
      const score = (vecScore.get(r.id) ?? 0) + keywordBoost(r.text, words);
      return { id: r.id, docId: r.doc_id, docName: r.name, seq: r.seq, score: Math.round(score * 1000) / 1000, text: r.text };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, s.topK);
  console.log(`검색: ${sources.map((s) => `${s.docName}#${s.seq + 1}(${s.score}${vecScore.has(s.id) ? "" : ", 키워드"})`).join(", ")}`);
  return sources;
}

/** 질문 단어가 그대로 들어 있는 청크 id (D1 에서 글자 검색). 단어마다 최대 KEYWORD_LIMIT 개. */
async function keywordSearch(env: Bindings, words: string[], docId?: number): Promise<string[]> {
  // 너무 흔한 짧은 말은 빼고, 긴 단어(회사명·코드일 가능성이 큼)부터 최대 4개만 찾습니다.
  const terms = [...words].sort((a, b) => b.length - a.length).slice(0, 4);
  if (!terms.length) return [];
  const stmts = terms.map((w) =>
    env.DB.prepare(
      `SELECT id FROM chunks WHERE instr(lower(text), ?) > 0 ${docId ? "AND doc_id = ?" : ""} ORDER BY doc_id DESC, seq LIMIT ${KEYWORD_LIMIT}`,
    ).bind(...(docId ? [w, docId] : [w])),
  );
  const res = await env.DB.batch<{ id: string }>(stmts);
  return [...new Set(res.flatMap((r) => r.results.map((x) => x.id)))];
}

// 질문에 자주 붙는, 검색어로는 쓸모없는 말
const STOP_WORDS = new Set(["알려줘", "알려", "주세요", "무엇", "무엇인가요", "뭐야", "어떤", "어떻게", "있나요", "있어", "목록", "관련", "대해", "대한", "내용"]);

/** 질문에서 검색어로 쓸 단어(두 글자 이상). "SK시그넷 모델은?" → ["sk시그넷", "모델은", "모델"] 처럼 끝의 조사도 떼어 봅니다. */
function queryWords(question: string): string[] {
  const out = new Set<string>();
  for (const w of question.toLowerCase().match(/[\p{L}\p{N}-]{2,}/gu) ?? []) {
    out.add(w);
    const stem = w.replace(/(은|는|이|가|을|를|의|에|에서|으로|로|과|와|도|만|요)$/u, "");
    if (stem.length >= 2) out.add(stem);
  }
  return [...out].filter((w) => !STOP_WORDS.has(w));
}

/** 질문 단어가 조각에 들어 있는 비율만큼 점수를 더합니다(0~0.5). */
function keywordBoost(text: string, words: string[]): number {
  if (!words.length) return 0;
  const lower = text.toLowerCase();
  return (0.5 * words.filter((w) => lower.includes(w)).length) / words.length;
}

export const SYSTEM_PROMPT = `당신은 네이처텍 사내 문서를 근거로 답하는 도우미입니다.
규칙:
- 아래 [근거] 안의 내용만 사용해 한국어로 답하세요.
- 근거에 답이 없으면 지어내지 말고 "등록된 문서에서 찾지 못했습니다."라고 답하세요.
- 근거에 Markdown 표가 있으면 첫 줄(머리글)로 각 열의 뜻을 알고 행을 읽으세요.
- 질문이 회사명·모델명·코드처럼 짧은 낱말뿐이면, 근거에서 그 낱말이 들어 있는 행·문장을 찾아 정리해 보여 주세요.
- 답의 근거가 된 부분 뒤에 [1], [2]처럼 근거 번호를 붙이세요.
- 짧고 정확하게, 필요하면 목록으로 정리하세요.`;

/** LLM 에 보낼 메시지 목록: 시스템 규칙 + 최근 대화 몇 턴 + (근거 + 질문) */
export function buildMessages(question: string, sources: Source[], history: ChatMessage[], systemPrompt = ""): ChatMessage[] {
  const context = sources.length
    ? sources.map((s, i) => `[${i + 1}] (${s.docName}, 조각 ${s.seq + 1})\n${s.text}`).join("\n\n")
    : "(관련 근거를 찾지 못했습니다)";
  return [
    { role: "system", content: systemPrompt.trim() || SYSTEM_PROMPT },
    ...history,
    { role: "user", content: `[근거]\n${context}\n\n[질문]\n${question}` },
  ];
}

/**
 * 연습 모드의 가짜 답변: 찾은 근거들에서 질문과 가장 많이 겹치는 문단을 그대로 보여 줍니다.
 * 그 문단이 표이면 머리글과 질문 단어가 들어 있는 행만 골라 보여 줍니다(큰 표 전체를 늘어놓지 않도록).
 * (진짜 모드에서는 이 자리에서 LLM 이 근거를 읽고 문장으로 답합니다.)
 */
export function mockAnswer(question: string, sources: Source[]): string {
  if (!sources.length) return "(연습 모드) 등록된 문서에서 찾지 못했습니다.";
  const grams = (t: string) => {
    const s = t.toLowerCase().replace(/\s+/g, "");
    return new Set(Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2)));
  };
  const q = grams(question);
  // "E-21", "SK시그넷" 같은 코드·단어가 통째로 들어 있으면 가산점
  const words = queryWords(question);
  const hits = (t: string) => {
    const lower = t.toLowerCase();
    return words.filter((w) => lower.includes(w)).length;
  };
  let best = { text: "", n: 1, score: -1 };
  sources.forEach((src, i) => {
    for (const p of src.text.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean)) {
      // 표 문단은 머리글을 뺀 행만으로 겹침을 셉니다(머리글은 어느 조각에나 붙어 있으므로).
      const body = p.startsWith("|") ? p.split("\n").slice(2).join("\n") : p;
      const g = grams(body);
      // 앞쪽(더 비슷한) 근거를 조금 우대
      const score = [...q].filter((x) => g.has(x)).length + 5 * hits(body) - i * 0.5;
      if (score > best.score) best = { text: p, n: i + 1, score };
    }
  });
  let text = best.text;
  const lines = text.split("\n");
  if (lines.length > 3 && lines.every((l) => l.trim().startsWith("|"))) {
    const rows = lines.slice(2).filter((l) => hits(l) > 0);
    if (rows.length) text = [lines[0], lines[1], ...rows.slice(0, 15)].join("\n");
  }
  // 표는 끝에 근거 번호를 붙이면 표 줄이 깨지므로 다음 줄에 둡니다.
  const cite = text.startsWith("|") ? `\n\n(근거 [${best.n}])` : ` [${best.n}]`;
  return `(연습 모드: AI 가 답을 쓰지 않고, 가장 비슷한 근거 문단을 그대로 보여 줍니다)\n\n${text.replace(/^#+\s*/, "")}${cite}`;
}
