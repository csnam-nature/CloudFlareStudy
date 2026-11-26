// 외부 AI(OpenAI · Anthropic Claude)로 답변 만들기
//
// 모델 이름 앞부분으로 어느 회사 AI 인지 고릅니다.
//   @cf/...        → Workers AI (src/ai.ts)
//   openai/...     → OpenAI     (Chat Completions API)
//   anthropic/...  → Claude     (Messages API, 공식 SDK @anthropic-ai/sdk)
//
// API 키는 화면에 넣지 않고 Worker 비밀 값(secret)으로 둡니다.
//   로컬: .dev.vars 에 OPENAI_API_KEY=... / ANTHROPIC_API_KEY=...
//   배포: npx wrangler secret put OPENAI_API_KEY   (ANTHROPIC_API_KEY 도 같은 방법)
// AI_GATEWAY_ID 가 있으면 AI Gateway 를 거쳐 호출해 대시보드에 로그·비용이 함께 남습니다.
// 게이트웨이에 "인증(Authenticated Gateway)"을 켰다면 CF_AIG_TOKEN 비밀 값도 넣으세요.
//
// 주의: 외부 AI 를 고르면 질문과 함께 검색된 문서 조각이 그 회사 서버로 보내집니다.
// 임베딩(검색)과 OCR 은 계속 Workers AI 를 씁니다.

import Anthropic from "@anthropic-ai/sdk";
import type { Bindings } from "./auth";
import type { Settings } from "./settings";

export type Provider = "workers-ai" | "openai" | "anthropic";
export type ProviderMessage = { role: "system" | "user" | "assistant"; content: string };

export const providerOf = (model: string): Provider =>
  model.startsWith("openai/") ? "openai" : model.startsWith("anthropic/") ? "anthropic" : "workers-ai";

/** "openai/gpt-6.2-sol" → "gpt-6.2-sol" */
const bareModel = (model: string) => model.slice(model.indexOf("/") + 1);

/** 외부 AI 키가 들어 있는지 (값은 절대 화면에 보내지 않습니다) */
export function keyStatus(env: Bindings) {
  return {
    openai: !!env.OPENAI_API_KEY,
    anthropic: !!env.ANTHROPIC_API_KEY,
    gateway: env.AI_GATEWAY_ID || null,
    gatewayToken: !!env.CF_AIG_TOKEN,
  };
}

/** 외부 AI 답변은 생각(reasoning) 토큰도 답변 한도에 들어가므로, 한도가 너무 작으면 본문이 비지 않게 최소값을 둡니다. */
export const externalMaxTokens = (s: Settings) => Math.max(s.maxTokens, 4096);

/** AI Gateway 주소(있으면) 또는 회사 API 주소 */
async function baseUrl(env: Bindings, provider: "openai" | "anthropic"): Promise<string> {
  if (env.AI_GATEWAY_ID && env.AI) {
    const gw = (env.AI as unknown as { gateway(id: string): { getUrl(p: string): Promise<string> } }).gateway(env.AI_GATEWAY_ID);
    return (await gw.getUrl(provider)).replace(/\/$/, "");
  }
  return provider === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com";
}

const gatewayHeaders = (env: Bindings): Record<string, string> =>
  env.CF_AIG_TOKEN && env.AI_GATEWAY_ID ? { "cf-aig-authorization": `Bearer ${env.CF_AIG_TOKEN}` } : {};

function needKey(env: Bindings, provider: "openai" | "anthropic"): string {
  const key = provider === "openai" ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY;
  if (!key) {
    const name = provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
    throw new Error(`${name} 가 없습니다. 로컬은 .dev.vars, 배포는 "npx wrangler secret put ${name}" 으로 넣은 뒤 다시 시도하세요.`);
  }
  return key;
}

// ── OpenAI ─────────────────────────────────────────────

/** OpenAI Chat Completions 를 스트리밍으로 받아 본문 조각을 내보냅니다. */
async function* streamOpenAI(env: Bindings, s: Settings, messages: ProviderMessage[], maxTokens: number): AsyncGenerator<string> {
  const key = needKey(env, "openai");
  const res = await fetch(`${await baseUrl(env, "openai")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}`, ...gatewayHeaders(env) },
    body: JSON.stringify({
      model: bareModel(s.chatModel),
      messages,
      stream: true,
      // 최신 GPT 는 모두 추론형이라 max_tokens 대신 max_completion_tokens 를 쓰고, temperature 는 기본값만 받습니다.
      max_completion_tokens: maxTokens,
      reasoning_effort: s.thinking ? "medium" : "low",
    }),
  });
  if (!res.ok || !res.body) throw new Error(`OpenAI 오류 ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  let finish: string | undefined;
  let yielded = 0;
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
      if (data === "[DONE]") continue;
      try {
        const j = JSON.parse(data) as { choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[] };
        const c = j.choices?.[0];
        if (c?.finish_reason) finish = c.finish_reason;
        const piece = c?.delta?.content;
        if (piece) {
          yielded += piece.length;
          yield piece;
        }
      } catch {
        // 형식이 다른 줄은 건너뜁니다.
      }
    }
  }
  if (!yielded) throw new Error(finish === "length" ? "답변 길이 상한에 걸려 본문이 비었습니다. 설정에서 답변 길이 상한을 늘려 보세요." : "OpenAI 가 빈 답을 돌려줬습니다.");
  if (finish === "length") yield "\n\n…(답변 길이 상한에 걸려 여기서 끊겼습니다)";
}

// ── Anthropic Claude ───────────────────────────────────

async function claudeClient(env: Bindings) {
  // 키는 x-api-key 헤더로 보냅니다. SDK 기본값(Authorization: Bearer)은 AI Gateway 의 anthropic 경로가 회사 키로 인식하지 않기 때문입니다.
  return new Anthropic({
    apiKey: null,
    authToken: null,
    baseURL: await baseUrl(env, "anthropic"),
    defaultHeaders: { "x-api-key": needKey(env, "anthropic"), ...gatewayHeaders(env) },
  });
}

/** system 메시지는 Messages API 의 system 칸으로 옮기고, 나머지는 대화로 보냅니다. */
function splitSystem(messages: ProviderMessage[]) {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const rest = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  return { system, messages: rest };
}

/**
 * Claude 요청 본문.
 * - 최신 Claude 는 temperature 를 받지 않아(400) 보내지 않습니다.
 * - 생각(thinking)은 모델이 알아서 정하고(adaptive), 깊이는 effort 로 조절합니다. 설정에서 생각 모드를 끄면 low.
 * - fallbacks "default": 정책상 답을 거절하면 같은 요청을 Anthropic 이 정한 다른 모델로 한 번 더 시도합니다.
 */
function claudeParams(s: Settings, messages: ProviderMessage[], maxTokens: number) {
  return {
    model: bareModel(s.chatModel),
    max_tokens: maxTokens,
    ...splitSystem(messages),
    output_config: { effort: s.thinking ? ("medium" as const) : ("low" as const) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default" as const,
  };
}

async function* streamClaude(env: Bindings, s: Settings, messages: ProviderMessage[], maxTokens: number): AsyncGenerator<string> {
  const client = await claudeClient(env);
  const stream = client.beta.messages.stream(claudeParams(s, messages, maxTokens));
  let yielded = 0;
  for await (const ev of stream) {
    if (ev.type === "content_block_delta" && ev.delta.type === "text_delta" && ev.delta.text) {
      yielded += ev.delta.text.length;
      yield ev.delta.text;
    }
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") {
    yield `${yielded ? "\n\n" : ""}(Claude 가 이 질문에는 답하지 않았습니다. 질문을 바꿔 보세요.)`;
    return;
  }
  if (!yielded) throw new Error(final.stop_reason === "max_tokens" ? "답변 길이 상한에 걸려 본문이 비었습니다. 설정에서 답변 길이 상한을 늘려 보세요." : "Claude 가 빈 답을 돌려줬습니다.");
  if (final.stop_reason === "max_tokens") yield "\n\n…(답변 길이 상한에 걸려 여기서 끊겼습니다)";
}

// ── 공용 ───────────────────────────────────────────────

/** 외부 AI 로 답변 스트리밍 */
export function streamExternal(env: Bindings, s: Settings, messages: ProviderMessage[]): AsyncGenerator<string> {
  const max = externalMaxTokens(s);
  return providerOf(s.chatModel) === "openai" ? streamOpenAI(env, s, messages, max) : streamClaude(env, s, messages, max);
}

/** 설정 화면의 "시험" 버튼: 짧은 질문 하나를 보내 키·모델이 맞는지 확인합니다. */
export async function testExternal(env: Bindings, model: string): Promise<string> {
  const s = { chatModel: model, thinking: false, maxTokens: 256 } as Settings;
  const messages: ProviderMessage[] = [{ role: "user", content: "'좋아요' 한 단어로만 답하세요." }];
  if (providerOf(model) === "openai") {
    let out = "";
    for await (const p of streamOpenAI(env, s, messages, 1024)) out += p;
    return out;
  }
  const client = await claudeClient(env);
  const res = await client.beta.messages.create(claudeParams(s, messages, 1024));
  if (res.stop_reason === "refusal") return "(거절됨)";
  return res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

/** 외부 AI 오류를 알기 쉬운 문구로 */
export function explainExternalError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const status = e instanceof Anthropic.APIError ? e.status : Number(/오류 (\d{3})/.exec(msg)?.[1]);
  if (status === 401) return `API 키가 맞지 않습니다(401). 비밀 값을 다시 넣어 보세요. ${msg}`;
  if (status === 403) return `이 키로는 이 모델을 쓸 수 없습니다(403). ${msg}`;
  if (status === 404) return `모델 이름을 찾지 못했습니다(404). 모델 ID 를 확인하세요. ${msg}`;
  if (status === 429) return `요청이 너무 많거나 크레딧이 부족합니다(429). ${msg}`;
  return msg;
}
