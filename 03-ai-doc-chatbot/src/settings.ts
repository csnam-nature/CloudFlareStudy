// 관리 화면에서 바꾸는 설정 (D1 settings 테이블)
//
// 기본값은 wrangler.jsonc 의 vars(CHAT_MODEL 등)에서 가져오고, 관리자가 화면에서 바꾼 항목만 D1 에 저장해 덮어씁니다.
// 그래서 다시 배포하지 않고도 모델·검색 개수·청크 크기 같은 값을 바꿔 볼 수 있습니다.
// 저장한 값은 다음 요청부터 바로 쓰입니다(색인 관련 값은 다음에 올리거나 "다시 색인"하는 문서부터).

import { Hono } from "hono";
import { CHART_RULE, MODE_RULES, SYSTEM_PROMPT } from "./rag";
import { explainExternalError, keyStatus, providerOf, testExternal } from "./providers";
import { type AppEnv, type Bindings, isMock, nowSec, requireAdmin } from "./auth";

export type Settings = {
  appTitle: string; // 화면 제목
  chatModel: string; // 답변 모델
  ocrModel: string; // 이미지 글자 읽기(OCR) 모델 (이미지를 읽을 수 있는 비전 모델)
  thinking: boolean; // 생각(reasoning) 모드. 끄면 바로 답을 써서 빠르고 빈 답이 줄어듦
  temperature: number; // 답변의 다양성(0 = 매번 같은 답)
  maxTokens: number; // 답변 길이 상한(= Neurons 사용량 상한)
  topK: number; // 근거로 넣을 조각 수
  minScore: number; // 이 유사도보다 낮은 조각은 버림(진짜 모드, 키워드가 맞는 조각은 예외)
  chunkSize: number; // 조각 크기(글자)
  chunkOverlap: number; // 조각끼리 겹치는 글자 수
  maxChunksPerDoc: number; // 문서 하나의 조각 수 한도
  systemPrompt: string; // 비우면 기본 규칙(src/rag.ts)
  allowWebSearch: boolean; // 질문창의 🌐 웹 검색 허용 (Claude·OpenAI 모델만, 검색마다 요금)
  allowCharts: boolean; // 답변에 그래프(```chart)·도식(```mermaid) 허용 → 프롬프트에 그래프 규칙(CHART_RULE)을 덧붙임
};

/** 고를 수 있는 모델 목록 (2026-11 기준 무료 플랜에서 쓸 수 있고 지원 종료 예정이 아닌 모델). 목록에 없는 모델은 직접 입력할 수 있습니다. */
export const CHAT_MODELS = [
  { id: "@cf/google/gemma-4-26b-a4b-it", note: "기본 · 한국어 좋음 · 빠름" },
  { id: "@cf/qwen/qwen3.8-27b", note: "한국어 좋음 · 긴 문맥" },
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", note: "큰 모델 · 정확" },
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct", note: "긴 문맥" },
  { id: "@cf/openai/gpt-oss-20b", note: "추론형 · 작음" },
  { id: "@cf/openai/gpt-oss-120b", note: "추론형 · 큼" },
  { id: "@cf/zai-org/glm-4.7-flash", note: "빠름" },
  { id: "@cf/zai-org/glm-5.3", note: "최상위급 · 느리고 Neurons 많이 씀" },
  { id: "@cf/deepseek-ai/deepseek-v4.1-flash-1017", note: "최상위급 · 긴 문맥" },
  { id: "@cf/meta/llama-3.1-8b-instruct-fast", note: "아주 빠름 · 한국어 약함" },
  // 외부 AI (API 키 필요, 사용한 만큼 해당 회사에 요금. 질문과 문서 조각이 그 회사로 보내짐)
  { id: "anthropic/claude-opus-5-5", note: "Claude 최상위 · 정확 · 비쌈", provider: "anthropic" },
  { id: "anthropic/claude-sonnet-5-5", note: "Claude 균형 · 추천", provider: "anthropic" },
  { id: "anthropic/claude-haiku-5-5", note: "Claude 빠르고 저렴", provider: "anthropic" },
  { id: "openai/gpt-6.2-sol", note: "OpenAI 최신 주력", provider: "openai" },
  { id: "openai/gpt-6.1-terra", note: "OpenAI 균형 · 저렴", provider: "openai" },
  { id: "openai/gpt-6-luna", note: "OpenAI 아주 저렴 · 빠름", provider: "openai" },
];
export const OCR_MODELS = [
  { id: "@cf/google/gemma-4-26b-a4b-it", note: "기본 · 이미지 입력 · 한국어 OCR" },
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct", note: "이미지 입력" },
];

/** 숫자 항목의 허용 범위 */
const RANGES: Record<string, [number, number]> = {
  temperature: [0, 1.5],
  maxTokens: [128, 4096],
  topK: [1, 20],
  minScore: [0, 0.9],
  chunkSize: [300, 3000],
  chunkOverlap: [0, 500],
  maxChunksPerDoc: [10, 5000],
};

export const DEFAULT_TITLE = "네이처텍 문서 챗봇";

/** wrangler vars 에서 만든 기본값 */
export function defaults(env: Bindings): Settings {
  return {
    appTitle: DEFAULT_TITLE,
    chatModel: env.CHAT_MODEL,
    ocrModel: env.OCR_MODEL,
    thinking: false,
    temperature: 0.2,
    maxTokens: 1536,
    topK: 5,
    minScore: 0.35,
    chunkSize: 800,
    chunkOverlap: 100,
    maxChunksPerDoc: Number(env.MAX_CHUNKS_PER_DOC) || 400,
    systemPrompt: "",
    allowWebSearch: true,
    allowCharts: true,
  };
}

/** 값 하나를 검사·정리합니다. 틀리면 오류 문구를 던집니다. */
function clean(key: keyof Settings, v: unknown): Settings[keyof Settings] {
  const range = RANGES[key];
  if (range) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < range[0] || n > range[1]) throw new Error(`${key} 는 ${range[0]} ~ ${range[1]} 사이 숫자여야 합니다.`);
    return ["topK", "maxTokens", "chunkSize", "chunkOverlap", "maxChunksPerDoc"].includes(key) ? Math.round(n) : n;
  }
  if (key === "thinking" || key === "allowWebSearch" || key === "allowCharts") return v === true || v === "true";
  const s = String(v ?? "").trim();
  if (key === "chatModel" && /^(openai|anthropic)\/[\w.:-]+$/.test(s)) return s; // 외부 AI (src/providers.ts)
  if (key === "chatModel" || key === "ocrModel") {
    if (!/^@[\w-]+\/[\w.-]+\/[\w.:-]+$/.test(s))
      throw new Error(key === "chatModel" ? `답변 모델은 "@cf/회사/모델", "openai/모델", "anthropic/모델" 중 한 형식이어야 합니다.` : `${key} 는 "@cf/회사/모델" 형식이어야 합니다.`);
    return s;
  }
  if (key === "appTitle") {
    if (!s || s.length > 40) throw new Error("화면 제목은 1~40자로 적어 주세요.");
    return s;
  }
  if (key === "systemPrompt") {
    if (s.length > 4000) throw new Error("시스템 프롬프트는 4000자까지입니다.");
    return s;
  }
  throw new Error(`모르는 설정 항목입니다: ${key}`);
}

/** 기본값 + D1 에 저장된 값 = 지금 쓰는 설정. (작은 표라 요청마다 읽어도 부담이 작습니다) */
export async function getSettings(env: Bindings): Promise<Settings> {
  const s = defaults(env);
  const { results } = await env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>().catch(() => ({ results: [] }));
  for (const r of results) {
    if (!(r.key in s)) continue;
    try {
      (s as Record<string, unknown>)[r.key] = clean(r.key as keyof Settings, JSON.parse(r.value));
    } catch {
      // 범위가 바뀌어 맞지 않는 옛 값은 무시하고 기본값을 씁니다.
    }
  }
  if (s.chunkOverlap >= s.chunkSize / 2) s.chunkOverlap = Math.floor(s.chunkSize / 4);
  return s;
}

/**
 * 웹 검색을 쓸 수 있는지와 못 쓰는 이유.
 * Workers AI 모델에는 자체 웹 검색 도구가 없어 Claude·OpenAI 모델을 골랐을 때만 됩니다.
 */
export function webSearchState(env: Bindings, s: Settings): { available: boolean; reason: string } {
  if (!s.allowWebSearch) return { available: false, reason: "관리자가 웹 검색을 꺼 두었습니다(설정 화면)." };
  const p = providerOf(s.chatModel);
  if (p === "workers-ai") return { available: false, reason: "웹 검색은 답변 모델이 Claude·OpenAI 일 때만 됩니다(설정 화면에서 모델 변경)." };
  if (isMock(env)) return { available: false, reason: "연습 모드에서는 웹 검색을 하지 않습니다." };
  const key = p === "openai" ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY;
  if (!key) return { available: false, reason: `${p === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"} 가 없어 쓸 수 없습니다.` };
  return { available: true, reason: "" };
}

/** 생각(reasoning) 모드를 끄는 옵션을 받는 모델인지 */
export const supportsThinkingSwitch = (model: string) => /gemma-4|qwen3|glm-4\.7|glm-5/.test(model);

// ── API ─────────────────────────────────────────────────────

export const settingsApi = new Hono<AppEnv>();

// 지금 설정 + 기본값 + 모델 목록 (관리자)
settingsApi.get("/", requireAdmin, async (c) =>
  c.json({
    settings: await getSettings(c.env),
    defaults: defaults(c.env),
    chatModels: CHAT_MODELS,
    ocrModels: OCR_MODELS,
    embedModel: c.env.EMBED_MODEL,
    mock: isMock(c.env),
    external: keyStatus(c.env), // 외부 AI 키가 들어 있는지(값은 보내지 않음)
    defaultSystemPrompt: SYSTEM_PROMPT, // "기본값 불러오기" 버튼용
    modeRules: MODE_RULES, // 답변 모드별로 자동으로 덧붙는 규칙(읽기 전용 안내)
    chartRule: CHART_RULE, // 그래프 허용 시 덧붙는 규칙(읽기 전용 안내)
  }),
);

// 일부 항목만 바꾸기. 기본값과 같은 값은 저장하지 않고 지웁니다(나중에 vars 를 바꾸면 그대로 따라가도록).
settingsApi.put("/", requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => null)) as Partial<Record<keyof Settings, unknown>> | null;
  if (!body || typeof body !== "object") return c.json({ error: "JSON 본문이 필요합니다." }, 400);
  const def = defaults(c.env) as Record<string, unknown>;
  const stmts: D1PreparedStatement[] = [];
  try {
    for (const [k, v] of Object.entries(body)) {
      // 기본값 그대로면 검사 없이 "저장 안 함"(연습 모드의 모델 이름 "mock" 같은 값도 그대로 둘 수 있게)
      const val = v === def[k] ? v : clean(k as keyof Settings, v);
      stmts.push(
        val === def[k]
          ? c.env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(k)
          : c.env.DB.prepare(
              "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            ).bind(k, JSON.stringify(val), nowSec()),
      );
    }
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
  const merged = { ...(await getSettings(c.env)), ...body } as Settings;
  if (Number(merged.chunkOverlap) >= Number(merged.chunkSize) / 2) return c.json({ error: "겹침(chunkOverlap)은 조각 크기의 절반보다 작아야 합니다." }, 400);
  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json({ settings: await getSettings(c.env) });
});

// 모두 기본값으로
settingsApi.delete("/", requireAdmin, async (c) => {
  await c.env.DB.prepare("DELETE FROM settings").run();
  return c.json({ settings: await getSettings(c.env) });
});

// 모델 시험: 짧은 질문 하나를 보내 이 계정에서 쓸 수 있는지 확인합니다(5018 접근 불가·5028 지원 종료·5035 유료 필요 등).
settingsApi.post("/test", requireAdmin, async (c) => {
  const { model } = ((await c.req.json().catch(() => ({}))) ?? {}) as { model?: string };
  // 외부 AI(OpenAI·Claude)는 연습 모드에서도 키만 있으면 시험할 수 있습니다.
  if (isMock(c.env) && providerOf(String(model ?? "")) === "workers-ai")
    return c.json({ ok: false, error: "연습 모드에는 Workers AI 가 없어 시험할 수 없습니다. npm run dev 에서 시험하세요." });
  let id: string;
  try {
    id = clean("chatModel", model) as string;
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
  }
  const started = Date.now();
  if (providerOf(id) !== "workers-ai") {
    try {
      const text = (await testExternal(c.env, id)).trim();
      return c.json({ ok: true, ms: Date.now() - started, sample: text.slice(0, 80) || "(빈 답)" });
    } catch (e) {
      return c.json({ ok: false, error: explainExternalError(e) });
    }
  }
  try {
    const ai = c.env.AI as unknown as { run(m: string, i: object): Promise<unknown> };
    const res = (await ai.run(id, {
      messages: [{ role: "user", content: "'좋아요' 한 단어로만 답하세요." }],
      max_tokens: 64,
      ...(supportsThinkingSwitch(id) ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    })) as { response?: string; choices?: { message?: { content?: string | null } }[] };
    const text = (res.response || res.choices?.[0]?.message?.content || "").trim();
    return c.json({ ok: true, ms: Date.now() - started, sample: text.slice(0, 80) || "(빈 답)" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const hint = /5018/.test(msg) ? "이 계정에서 쓸 수 없는 모델" : /5028/.test(msg) ? "지원이 끝난 모델" : /5035/.test(msg) ? "유료 플랜이 필요한 모델" : "";
    return c.json({ ok: false, error: hint ? `${hint}: ${msg}` : msg });
  }
});
