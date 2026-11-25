// Workers AI · Vectorize 호출을 한곳에 모은 파일
//
// 다른 파일은 여기의 함수만 부릅니다. 그래서 연습 모드(MOCK)와 진짜 AI 모드를 이 파일 안에서만 갈라 처리합니다.
//   진짜 AI   : env.AI(Workers AI, AI Gateway 경유) + env.VECTORS(Vectorize)
//   연습 모드 : 글자 조각 해시로 만든 가짜 벡터 + D1 mock_vectors 테이블 + "근거를 그대로 보여 주는" 가짜 답변

import { type Bindings, isMock } from "./auth";

// ── 공통: Workers AI 호출 ─────────────────────────────────────

// 모델 이름을 vars 에서 바꿀 수 있도록 문자열로 받는 느슨한 타입을 씁니다.
type LooseAi = { run(model: string, input: object, options?: object): Promise<unknown> };

/**
 * env.AI.run() 에 AI Gateway 옵션을 붙여 호출합니다.
 * AI_GATEWAY_ID 가 있으면 모든 호출이 게이트웨이를 거쳐 대시보드에 로그·비용·캐시가 남습니다.
 */
function runAi(env: Bindings, model: string, input: object): Promise<unknown> {
  const ai = env.AI as unknown as LooseAi;
  const gateway = env.AI_GATEWAY_ID
    ? { gateway: { id: env.AI_GATEWAY_ID, metadata: { app: "doc-chatbot" } } }
    : {};
  return ai.run(model, input, gateway);
}

// ── 1. 문서 → 텍스트 ─────────────────────────────────────────

export const SUPPORTED_EXT = ["pdf", "docx", "txt", "md"] as const;
export const extOf = (filename: string) => filename.split(".").pop()?.toLowerCase() ?? "";

/**
 * 원본 파일에서 텍스트를 꺼냅니다.
 * TXT·MD 는 그대로 읽고, PDF·DOCX 는 Workers AI 의 Markdown 변환(toMarkdown, 현재 베타)을 씁니다.
 * toMarkdown 은 Neurons 를 쓰지 않는 변환 기능입니다(이미지 설명 생성 제외).
 */
export async function extractText(env: Bindings, filename: string, bytes: ArrayBuffer, contentType: string) {
  const ext = extOf(filename);
  if (ext === "txt" || ext === "md") return new TextDecoder("utf-8").decode(bytes);
  if (isMock(env)) throw new Error("연습 모드에서는 TXT·MD 파일만 색인할 수 있습니다. PDF·DOCX 는 npm run dev(진짜 AI 모드)에서 시험하세요.");

  const result = await env.AI!.toMarkdown({ name: filename, blob: new Blob([bytes], { type: contentType }) });
  if (result.format === "error") throw new Error(`문서 변환 실패: ${result.error}`);
  return result.data;
}

// ── 2. 임베딩 ────────────────────────────────────────────────

/** 텍스트 여러 개를 벡터로 바꿉니다. 진짜 모드는 bge-m3(1024차원, 한국어 포함 다국어). */
export async function embed(env: Bindings, texts: string[]): Promise<number[][]> {
  if (isMock(env)) return texts.map(mockEmbed);
  const out: number[][] = [];
  // 한 번에 너무 많이 보내지 않도록 20개씩 나눠 호출합니다.
  for (let i = 0; i < texts.length; i += 20) {
    const res = (await runAi(env, env.EMBED_MODEL, { text: texts.slice(i, i + 20) })) as { data?: number[][] };
    if (!res.data || res.data.length !== Math.min(20, texts.length - i)) throw new Error("임베딩 응답 형식이 예상과 다릅니다.");
    out.push(...res.data);
  }
  return out;
}

/**
 * 연습 모드용 가짜 임베딩: 글자 2개씩 묶은 조각(bigram)과 단어를 256칸에 해시로 흩뿌린 뒤 길이를 1로 맞춥니다.
 * 뜻은 모르지만 "같은 글자 조각이 많이 겹치면 가깝다" 정도는 흉내 냅니다.
 */
const MOCK_DIM = 256;
function mockEmbed(text: string): number[] {
  const v = new Array<number>(MOCK_DIM).fill(0);
  const t = text.toLowerCase().replace(/\s+/g, " ");
  const add = (s: string, w: number) => {
    let h = 2166136261; // FNV-1a 해시
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    v[(h >>> 0) % MOCK_DIM] += w;
  };
  for (let i = 0; i < t.length - 1; i++) if (t[i] !== " " && t[i + 1] !== " ") add(t.slice(i, i + 2), 1);
  for (const w of t.split(/[^\p{L}\p{N}-]+/u)) if (w.length > 1) add(w, 2);
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

// ── 3. 벡터 저장·검색 (Vectorize) ─────────────────────────────
//
// 로컬 `npm run dev` 와 배포본은 D1 은 따로 쓰지만 Vectorize 인덱스는 같은 원격 인덱스를 씁니다.
// 둘 다 "1:0" 같은 청크 id 를 만들 수 있으므로, Vectorize 에는 "<네임스페이스>:<청크id>" 로 넣고
// 검색도 같은 네임스페이스 안에서만 합니다(배포본 prod, 로컬 dev). 그래야 로컬 시험이 배포본 벡터를 덮어쓰거나 지우지 않습니다.

const ns = (env: Bindings) => env.VECTOR_NAMESPACE || "prod";
const toVecId = (env: Bindings, chunkId: string) => `${ns(env)}:${chunkId}`;
const fromVecId = (env: Bindings, vecId: string) => vecId.slice(ns(env).length + 1);

export type VectorItem = { id: string; docId: number; values: number[] };
export type VectorMatch = { id: string; score: number };

/** 벡터를 저장합니다. 같은 id 가 있으면 덮어씁니다(upsert). */
export async function upsertVectors(env: Bindings, items: VectorItem[]) {
  if (isMock(env)) {
    const stmt = env.DB.prepare("INSERT OR REPLACE INTO mock_vectors (id, doc_id, vec) VALUES (?, ?, ?)");
    for (let i = 0; i < items.length; i += 50)
      await env.DB.batch(items.slice(i, i + 50).map((x) => stmt.bind(x.id, x.docId, JSON.stringify(x.values))));
    return;
  }
  // 메타데이터 docId 는 "특정 문서만 검색" 필터에 씁니다. 메타데이터 인덱스를 string 으로 만들었으므로 문자열로 넣습니다.
  for (let i = 0; i < items.length; i += 100)
    await env.VECTORS!.upsert(
      items.slice(i, i + 100).map((x) => ({
        id: toVecId(env, x.id),
        namespace: ns(env),
        values: x.values,
        metadata: { docId: String(x.docId) },
      })),
    );
}

/** 질문 벡터와 가장 가까운 청크 id 를 topK 개 찾습니다. docId 를 주면 그 문서 안에서만 찾습니다. */
export async function queryVectors(env: Bindings, values: number[], topK: number, docId?: number): Promise<VectorMatch[]> {
  if (isMock(env)) {
    // 연습 모드는 전부 읽어서 코사인 유사도(벡터 길이가 1이라 내적과 같음)를 직접 계산합니다. 데이터가 적을 때만 쓸 방법입니다.
    const q = docId
      ? env.DB.prepare("SELECT id, vec FROM mock_vectors WHERE doc_id = ?").bind(docId)
      : env.DB.prepare("SELECT id, vec FROM mock_vectors");
    const { results } = await q.all<{ id: string; vec: string }>();
    return results
      .map((r) => {
        const v = JSON.parse(r.vec) as number[];
        return { id: r.id, score: v.reduce((s, x, i) => s + x * values[i], 0) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
  const res = await env.VECTORS!.query(values, {
    topK,
    namespace: ns(env),
    ...(docId ? { filter: { docId: String(docId) } } : {}),
  });
  return res.matches.map((m) => ({ id: fromVecId(env, m.id), score: m.score }));
}

/** 벡터를 지웁니다(문서 삭제·다시 색인 때). */
export async function deleteVectors(env: Bindings, ids: string[]) {
  if (!ids.length) return;
  if (isMock(env)) {
    for (let i = 0; i < ids.length; i += 50) {
      const part = ids.slice(i, i + 50);
      await env.DB.prepare(`DELETE FROM mock_vectors WHERE id IN (${part.map(() => "?").join(",")})`).bind(...part).run();
    }
    return;
  }
  const vecIds = ids.map((id) => toVecId(env, id));
  for (let i = 0; i < vecIds.length; i += 100) await env.VECTORS!.deleteByIds(vecIds.slice(i, i + 100));
}

// ── 4. 답변 생성 (스트리밍) ───────────────────────────────────

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/**
 * LLM 답변을 조각(토큰 묶음) 단위로 내보냅니다. for await (const piece of streamChat(...)) 로 씁니다.
 * Workers AI 는 stream: true 이면 SSE(Server-Sent Events) 형식의 스트림을 돌려줍니다.
 *   data: {"response":"안녕"}      ← Workers AI 고유 형식
 *   data: {"choices":[{"delta":{"content":"안녕"}}]}  ← OpenAI 호환 형식(일부 모델)
 *   data: [DONE]
 */
export async function* streamChat(env: Bindings, messages: ChatMessage[], mockAnswer: string): AsyncGenerator<string> {
  if (isMock(env)) {
    // 연습 모드: 미리 만든 답을 단어 단위로 조금씩 흘려 보내 스트리밍을 흉내 냅니다.
    for (const word of mockAnswer.split(/(?<=\s)/)) {
      await new Promise((r) => setTimeout(r, 15));
      yield word;
    }
    return;
  }

  const stream = (await runAi(env, env.CHAT_MODEL, {
    messages,
    stream: true,
    max_tokens: 1024, // 답변 길이 상한 = Neurons 사용량 상한
    temperature: 0.2, // 문서 근거 답변이라 창의성보다 일관성
  })) as ReadableStream<Uint8Array>;

  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const j = JSON.parse(data) as { response?: string; choices?: { delta?: { content?: string } }[] };
        const piece = j.response ?? j.choices?.[0]?.delta?.content;
        if (piece) yield piece;
      } catch {
        // 형식이 다른 줄(사용량 정보 등)은 건너뜁니다.
      }
    }
  }
}
