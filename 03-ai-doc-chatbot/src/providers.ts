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
  let streamError = "";
  while (!streamError) {
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
        const j = JSON.parse(data) as {
          error?: { message?: string };
          choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
        };
        // 200 으로 시작했어도 중간에 오류 이벤트가 올 수 있습니다. 끊긴 답을 정상 답처럼 저장하지 않도록 오류로 처리합니다.
        if (j.error) {
          streamError = j.error.message ?? JSON.stringify(j.error);
          break;
        }
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
  if (streamError) throw new Error(`OpenAI 오류: ${streamError.slice(0, 300)}`);
  // 끝 표시(finish_reason) 없이 끊긴 스트림은 답이 중간에 잘린 것입니다.
  if (yielded && !finish) throw new Error("OpenAI 답변이 끝나기 전에 연결이 끊겼습니다. 다시 질문해 보세요.");
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
function claudeParams(s: Settings, messages: ProviderMessage[], maxTokens: number, web = false) {
  return {
    model: bareModel(s.chatModel),
    max_tokens: maxTokens,
    ...splitSystem(messages),
    output_config: { effort: s.thinking ? ("medium" as const) : ("low" as const) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default" as const,
    ...(web ? { tools: [claudeWebTool(s.chatModel)] } : {}),
  };
}

/** 웹 검색 한 번에 쓸 수 있는 검색 횟수(검색 1회마다 요금이 붙습니다) */
const WEB_MAX_USES = 3;
const KOREA = { type: "approximate" as const, country: "KR", timezone: "Asia/Seoul" };

/**
 * Claude 의 자체 웹 검색 도구(Anthropic 서버에서 검색). Opus·Sonnet 5.x 는 결과를 걸러 주는 새 버전, 그 밖(Haiku 등)은 기본 버전.
 * Anthropic 콘솔의 조직 설정에서 웹 검색이 켜져 있어야 합니다.
 */
function claudeWebTool(model: string) {
  return /opus-5|sonnet-5|fable|mythos/.test(model)
    ? { type: "web_search_20260209" as const, name: "web_search" as const, max_uses: WEB_MAX_USES, user_location: KOREA }
    : { type: "web_search_20250305" as const, name: "web_search" as const, max_uses: WEB_MAX_USES, user_location: KOREA };
}

/** 웹 출처 목록을 답 끝에 붙일 Markdown 으로 */
function webSourcesMarkdown(list: Map<string, string>): string {
  if (!list.size) return "";
  const lines = [...list].slice(0, 8).map(([url, title]) => `- [${(title || url).replace(/[[\]]/g, "")}](${url})`);
  return `\n\n🌐 **웹 출처**\n${lines.join("\n")}`;
}

async function* streamClaude(env: Bindings, s: Settings, messages: ProviderMessage[], maxTokens: number, web = false): AsyncGenerator<string> {
  const client = await claudeClient(env);
  const params = claudeParams(s, messages, maxTokens, web);
  const webSources = new Map<string, string>();
  let yielded = 0;
  let final;
  // 웹 검색은 서버에서 여러 번 돌다가 "pause_turn"으로 잠시 멈출 수 있어, 그때는 이어서 요청합니다(최대 3번).
  for (let round = 0; ; round++) {
    const stream = client.beta.messages.stream(params);
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta" && ev.delta.text) {
        yielded += ev.delta.text.length;
        yield ev.delta.text;
      }
    }
    final = await stream.finalMessage();
    for (const b of final.content) {
      if (b.type !== "text") continue;
      for (const c of b.citations ?? []) if (c.type === "web_search_result_location") webSources.set(c.url, c.title ?? "");
    }
    if (final.stop_reason !== "pause_turn" || round >= 2) break;
    params.messages = [...params.messages, { role: "assistant", content: final.content as never }];
  }
  if (final.stop_reason === "refusal") {
    yield `${yielded ? "\n\n" : ""}(Claude 가 이 질문에는 답하지 않았습니다. 질문을 바꿔 보세요.)`;
    return;
  }
  if (!yielded) throw new Error(final.stop_reason === "max_tokens" ? "답변 길이 상한에 걸려 본문이 비었습니다. 설정에서 답변 길이 상한을 늘려 보세요." : "Claude 가 빈 답을 돌려줬습니다.");
  if (final.stop_reason === "max_tokens") yield "\n\n…(답변 길이 상한에 걸려 여기서 끊겼습니다)";
  const tail = webSourcesMarkdown(webSources);
  if (tail) yield tail;
}

// ── OpenAI 웹 검색 (Responses API) ─────────────────────

/**
 * OpenAI 는 웹 검색 도구를 Responses API 에서 씁니다. 스트림 이벤트:
 *   response.output_text.delta → 본문 조각, response.completed → 끝(출처는 url_citation 주석),
 *   response.failed · error → 오류, response.incomplete → 길이 상한 등으로 중단
 */
async function* streamOpenAIWeb(env: Bindings, s: Settings, messages: ProviderMessage[], maxTokens: number): AsyncGenerator<string> {
  const key = needKey(env, "openai");
  const instructions = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const input = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));
  const res = await fetch(`${await baseUrl(env, "openai")}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}`, ...gatewayHeaders(env) },
    body: JSON.stringify({
      model: bareModel(s.chatModel),
      instructions,
      input,
      stream: true,
      max_output_tokens: maxTokens,
      reasoning: { effort: s.thinking ? "medium" : "low" },
      tools: [{ type: "web_search", user_location: { type: "approximate", country: "KR", timezone: "Asia/Seoul" } }],
    }),
  });
  if (!res.ok || !res.body) throw new Error(`OpenAI 오류 ${res.status}: ${(await res.text()).slice(0, 300)}`);

  type Annot = { type?: string; url?: string; title?: string };
  type Ev = {
    type?: string;
    delta?: string;
    message?: string;
    error?: { message?: string };
    response?: {
      error?: { message?: string } | null;
      incomplete_details?: { reason?: string } | null;
      output?: { type?: string; content?: { type?: string; annotations?: Annot[] }[] }[];
    };
  };
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const webSources = new Map<string, string>();
  let buf = "";
  let yielded = 0;
  let end: "completed" | "incomplete" | "" = "";
  let incompleteReason = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      let ev: Ev;
      try {
        ev = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      if (ev.type === "response.output_text.delta" && ev.delta) {
        yielded += ev.delta.length;
        yield ev.delta;
      } else if (ev.type === "error" || ev.type === "response.failed") {
        throw new Error(`OpenAI 오류: ${(ev.message ?? ev.error?.message ?? ev.response?.error?.message ?? "알 수 없는 오류").slice(0, 300)}`);
      } else if (ev.type === "response.completed" || ev.type === "response.incomplete") {
        end = ev.type === "response.completed" ? "completed" : "incomplete";
        incompleteReason = ev.response?.incomplete_details?.reason ?? "";
        for (const item of ev.response?.output ?? [])
          for (const c of item.content ?? [])
            for (const a of c.annotations ?? []) if (a.type === "url_citation" && a.url) webSources.set(a.url, a.title ?? "");
      }
    }
  }
  if (!end) throw new Error("OpenAI 답변이 끝나기 전에 연결이 끊겼습니다. 다시 질문해 보세요.");
  if (!yielded) throw new Error(end === "incomplete" ? `답변이 중간에 멈췄습니다(${incompleteReason}). 설정에서 답변 길이 상한을 늘려 보세요.` : "OpenAI 가 빈 답을 돌려줬습니다.");
  if (end === "incomplete") yield "\n\n…(답변 길이 상한에 걸려 여기서 끊겼습니다)";
  const tail = webSourcesMarkdown(webSources);
  if (tail) yield tail;
}

// ── 공용 ───────────────────────────────────────────────

/** 외부 AI 로 답변 스트리밍. web 이면 그 회사의 자체 웹 검색 도구를 함께 씁니다. */
export function streamExternal(env: Bindings, s: Settings, messages: ProviderMessage[], web = false): AsyncGenerator<string> {
  const max = externalMaxTokens(s);
  if (providerOf(s.chatModel) === "openai") return web ? streamOpenAIWeb(env, s, messages, max) : streamOpenAI(env, s, messages, max);
  return streamClaude(env, s, messages, max, web);
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
