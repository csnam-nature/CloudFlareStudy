// 사내 문서 AI 챗봇 Worker 진입점
//
// 이 Worker 하나가 세 가지 일을 합니다.
//   fetch  : 화면·API·채팅 WebSocket 요청 처리
//   queue  : 업로드된 문서 색인(큐 소비자) → src/indexer.ts
//   ChatAgent 클래스 export : 채팅 에이전트(Durable Object) → src/agent.ts
//
// 요청 경로
//   /agents/chat-agent/<세션id>  채팅 WebSocket   → routeAgentRequest 가 ChatAgent 인스턴스로 연결
//   /api/documents/...           문서 API         → src/documents.ts
//   /api/me                      관리자 토큰 확인·현재 모드
//   그 밖의 경로                  public/ 정적 화면(index.html 채팅, admin.html 문서 관리)

import { routeAgentRequest } from "agents";
import { Hono } from "hono";
import { type AppEnv, type Bindings, type IndexJob, isAdmin, isMock } from "./auth";
import { documents } from "./documents";
import { handleIndexBatch } from "./indexer";

export { ChatAgent } from "./agent";

const app = new Hono<AppEnv>();

app.route("/api/documents", documents);

app.get("/api/me", (c) =>
  c.json({
    admin: isAdmin(c),
    mock: isMock(c.env),
    chatModel: c.env.CHAT_MODEL,
    embedModel: c.env.EMBED_MODEL,
    gateway: c.env.AI_GATEWAY_ID || null,
    maxUploadMb: Number(c.env.MAX_UPLOAD_MB) || 10,
  }),
);

app.notFound((c) => c.json({ error: "없는 경로입니다." }, 404));
app.onError((err, c) => {
  console.error("처리 중 오류", c.req.method, c.req.path, err);
  return c.json({ error: "서버 오류가 발생했습니다." }, 500);
});

export default {
  async fetch(request, env, ctx) {
    // /agents/... 요청이면 해당 에이전트로 넘기고, 아니면 null 이 돌아옵니다.
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;
    return app.fetch(request, env, ctx);
  },
  async queue(batch, env) {
    await handleIndexBatch(batch, env);
  },
} satisfies ExportedHandler<Bindings, IndexJob>;
