// RAG(검색 증강 생성)의 "검색"과 "프롬프트 만들기"
//
//   질문 → 임베딩 → Vectorize 에서 가까운 청크 topK 개 → D1 에서 원문 → 프롬프트에 근거로 넣기
// LLM 은 학습 때 본 적 없는 사내 문서를 모르므로, 찾은 근거를 프롬프트에 넣어 "이것만 보고 답하라"고 시킵니다.

import { type ChatMessage, embed, queryVectors } from "./ai";
import type { Bindings } from "./auth";

export type Source = { id: string; docId: number; docName: string; seq: number; score: number; text: string };

const TOP_K = 5;
// 이 점수보다 낮은 청크는 관련 없다고 보고 버립니다(코사인 유사도, 1에 가까울수록 비슷).
// 진짜 모드(bge-m3)와 연습 모드(글자 해시)는 점수 분포가 달라 기준도 다르게 둡니다.
const MIN_SCORE = { real: 0.35, mock: 0.05 };

export async function retrieve(env: Bindings, question: string, mock: boolean, docId?: number): Promise<Source[]> {
  const [qvec] = await embed(env, [question]);
  // 연습 모드의 가짜 벡터는 뜻을 모르고, 긴 조각(큰 표)일수록 점수가 낮게 나옵니다.
  // 그래서 후보를 넉넉히 뽑은 뒤 "질문 단어가 실제로 들어 있는 조각"을 앞으로 올립니다(아래 keywordBoost).
  const k = mock ? MOCK_CANDIDATES : TOP_K;
  const matches = (await queryVectors(env, qvec, k, docId)).filter((m) => m.score >= MIN_SCORE[mock ? "mock" : "real"]);
  if (!matches.length) return [];

  // Vectorize 는 벡터만 돌려주므로 원문은 D1 에서 같은 id 로 꺼냅니다.
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.doc_id, c.seq, c.text, d.name
       FROM chunks c JOIN documents d ON d.id = c.doc_id
      WHERE c.id IN (${matches.map(() => "?").join(",")})`,
  )
    .bind(...matches.map((m) => m.id))
    .all<{ id: string; doc_id: number; seq: number; text: string; name: string }>();
  const byId = new Map(results.map((r) => [r.id, r]));

  // 점수 순서를 유지하고, 그 사이 삭제된 청크(Vectorize 는 반영이 몇 초 늦을 수 있음)는 건너뜁니다.
  const sources = matches.flatMap((m) => {
    const r = byId.get(m.id);
    return r ? [{ id: r.id, docId: r.doc_id, docName: r.name, seq: r.seq, score: m.score, text: r.text }] : [];
  });
  if (!mock) return sources;
  const words = queryWords(question);
  return sources
    .map((s) => ({ ...s, score: Math.round((s.score + keywordBoost(s.text, words)) * 1000) / 1000 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K);
}

const MOCK_CANDIDATES = 50;

/** 질문에서 검색어로 쓸 단어(두 글자 이상). "SK시그넷 모델은?" → ["sk시그넷", "모델은", "모델"] 처럼 끝의 조사도 떼어 봅니다. */
function queryWords(question: string): string[] {
  const out = new Set<string>();
  for (const w of question.toLowerCase().match(/[\p{L}\p{N}-]{2,}/gu) ?? []) {
    out.add(w);
    const stem = w.replace(/(은|는|이|가|을|를|의|에|에서|으로|로|과|와|도|만|요)$/u, "");
    if (stem.length >= 2) out.add(stem);
  }
  return [...out];
}

/** 질문 단어가 조각에 들어 있는 비율만큼 점수를 더합니다(연습 모드 전용, 0~0.5). */
function keywordBoost(text: string, words: string[]): number {
  if (!words.length) return 0;
  const lower = text.toLowerCase();
  return (0.5 * words.filter((w) => lower.includes(w)).length) / words.length;
}

const SYSTEM_PROMPT = `당신은 사내 문서를 근거로 답하는 도우미입니다.
규칙:
- 아래 [근거] 안의 내용만 사용해 한국어로 답하세요.
- 근거에 답이 없으면 지어내지 말고 "등록된 문서에서 찾지 못했습니다."라고 답하세요.
- 답의 근거가 된 부분 뒤에 [1], [2]처럼 근거 번호를 붙이세요.
- 짧고 정확하게, 필요하면 목록으로 정리하세요.`;

/** LLM 에 보낼 메시지 목록: 시스템 규칙 + 최근 대화 몇 턴 + (근거 + 질문) */
export function buildMessages(question: string, sources: Source[], history: ChatMessage[]): ChatMessage[] {
  const context = sources.length
    ? sources.map((s, i) => `[${i + 1}] (${s.docName}, 조각 ${s.seq + 1})\n${s.text}`).join("\n\n")
    : "(관련 근거를 찾지 못했습니다)";
  return [
    { role: "system", content: SYSTEM_PROMPT },
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
  return `(연습 모드: AI 가 답을 쓰지 않고, 가장 비슷한 근거 문단을 그대로 보여 줍니다)\n\n${text.replace(/^#+\s*/, "")} [${best.n}]`;
}
