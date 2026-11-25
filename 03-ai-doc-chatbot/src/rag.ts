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
  const matches = (await queryVectors(env, qvec, TOP_K, docId)).filter((m) => m.score >= MIN_SCORE[mock ? "mock" : "real"]);
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
  return matches.flatMap((m) => {
    const r = byId.get(m.id);
    return r ? [{ id: r.id, docId: r.doc_id, docName: r.name, seq: r.seq, score: m.score, text: r.text }] : [];
  });
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
 * 연습 모드의 가짜 답변: 가장 비슷한 근거에서 질문과 글자 조각이 가장 많이 겹치는 문단을 그대로 보여 줍니다.
 * (진짜 모드에서는 이 자리에서 LLM 이 근거를 읽고 문장으로 답합니다.)
 */
export function mockAnswer(question: string, sources: Source[]): string {
  if (!sources.length) return "(연습 모드) 등록된 문서에서 찾지 못했습니다.";
  const grams = (t: string) => {
    const s = t.toLowerCase().replace(/\s+/g, "");
    return new Set(Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2)));
  };
  const q = grams(question);
  // "E-21" 같은 코드·단어가 통째로 들어 있으면 가산점
  const words = question.toLowerCase().match(/[\p{L}\p{N}-]{2,}/gu) ?? [];
  const paras = sources[0].text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  let best = paras[0] ?? "";
  let bestScore = -1;
  for (const p of paras) {
    const g = grams(p);
    const lower = p.toLowerCase();
    const score = [...q].filter((x) => g.has(x)).length + 5 * words.filter((w) => lower.includes(w)).length;
    if (score > bestScore) (best = p), (bestScore = score);
  }
  return `(연습 모드: AI 없이 가장 비슷한 근거 문단을 그대로 보여 줍니다)\n\n${best.replace(/^#+\s*/, "")} [1]`;
}
