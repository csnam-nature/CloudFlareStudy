// 네이처텍 문서 챗봇 Worker 진입점
//
// 이 Worker 하나가 세 가지 일을 합니다.
//   fetch  : 화면·API·채팅 WebSocket 요청 처리
//   queue  : 업로드된 문서 색인(큐 소비자) → src/indexer.ts
//   ChatAgent 클래스 export : 채팅 에이전트(Durable Object) → src/agent.ts
//
// 요청 경로
//   /agents/chat-agent/<세션id>  채팅 WebSocket   → routeAgentRequest 가 ChatAgent 인스턴스로 연결
//   /api/documents/...           문서 API         → src/documents.ts
//   /api/conversations/...       대화 목록·폴더(왼쪽 사이드바) → src/conversations.ts
//   /api/settings                관리 화면 설정(모델·검색·청크) → src/settings.ts
//   /api/users, /api/groups      직원 계정·역할·그룹(관리자) → src/users.ts
//   /api/me                      내가 누구인지(이메일·역할)·현재 모드·화면 제목
//
// 로그인·권한: 모든 /api 와 /agents 요청은 먼저 src/auth.ts 의 identifyRequest 로 "누구인지" 확인합니다.
//   그 밖의 경로                  public/ 정적 화면(index.html 채팅, admin.html 문서 관리, settings.html 설정)

import { routeAgentRequest } from "agents";
import { Hono } from "hono";
import { CHAT_USER_HEADER } from "./agent";
import {
  type AppEnv,
  authMode,
  type Bindings,
  hasRole,
  identify,
  identifyRequest,
  type IndexJob,
  isAuthError,
  isMock,
  logoutUrl,
  peekAccessEmail,
  ROLE_LABEL,
} from "./auth";
import { conversations } from "./conversations";
import { documents } from "./documents";
import { handleIndexBatch } from "./indexer";
import { getSettings, settingsApi, webSearchState } from "./settings";
import { groupsApi, usersApi } from "./users";

export { ChatAgent } from "./agent";

const app = new Hono<AppEnv>();

// 모든 API: 누구인지 확인 (Access 토큰 / 개발용 우회 / 관리자 토큰 / 익명)
app.use("/api/*", identify);

app.route("/api/documents", documents);
app.route("/api/users", usersApi);
app.route("/api/groups", groupsApi);
app.route("/api/settings", settingsApi);
app.route("/api/conversations", conversations);

app.get("/api/me", async (c) => {
  const s = await getSettings(c.env);
  const u = c.get("user");
  const mode = authMode(c.env, u);
  // Access 를 앱에 적용했는데 Worker 설정값(ACCESS_TEAM_DOMAIN·ACCESS_AUD)이 비어 있으면
  // 예전 토큰 방식으로 돌아가 계정이 안 보입니다. 그 경우를 화면에 알려 주려고 이메일만(검증 없이) 읽습니다.
  const accessEmail = mode === "token" ? peekAccessEmail(c.req.raw) : "";
  return c.json({
    // 로그인 방식: access(Zero Trust) · dev(로컬 개발용 우회) · token(관리자 토큰, 예전 방식)
    authMode: mode,
    user: u.via === "anonymous" || u.via === "token" ? null : { email: u.email, name: u.name, role: u.role, roleLabel: ROLE_LABEL[u.role] },
    role: u.role,
    admin: hasRole(u, "admin"),
    canManageDocs: hasRole(u, "manager"),
    // 로그아웃: Access 면 Access 로그아웃 주소, 토큰 방식은 화면에서 토큰을 지움, 개발용은 없음
    logoutUrl: mode === "access" || accessEmail ? logoutUrl(c.req.url) : null,
    // Access 는 켜져 있지만 Worker 설정값이 빠졌을 때만: { email } (안내용, 권한에는 안 씀)
    accessUnconfigured: accessEmail ? { email: accessEmail } : null,
    mock: isMock(c.env),
    appTitle: s.appTitle,
    chatModel: s.chatModel,
    embedModel: c.env.EMBED_MODEL,
    gateway: c.env.AI_GATEWAY_ID || null,
    maxUploadMb: Number(c.env.MAX_UPLOAD_MB) || 10,
    // 질문창의 🌐 웹 검색: 관리자가 허용했고 답변 모델이 Claude·OpenAI 일 때만 쓸 수 있음
    webSearch: webSearchState(c.env, s),
  });
});

app.notFound((c) => c.json({ error: "없는 경로입니다." }, 404));
app.onError((err, c) => {
  console.error("처리 중 오류", c.req.method, c.req.path, err);
  return c.json({ error: "서버 오류가 발생했습니다." }, 500);
});

/**
 * 채팅 WebSocket 앞의 문지기.
 * 1) 누구인지 확인(로그인 안 됐으면 401)
 * 2) 계정으로 로그인한 경우(Access·개발용) 그 대화의 주인인지 확인 → 남의 대화에는 연결할 수 없습니다(403)
 * 3) 확인한 사용자를 x-chat-user 헤더로 에이전트에 넘깁니다. 브라우저가 같은 헤더를 보내도 여기서 덮어씁니다.
 */
async function gateAgentRequest(request: Request, env: Bindings, url: URL): Promise<Request | Response> {
  const user = await identifyRequest(request, env);
  if (isAuthError(user)) return Response.json({ error: user.error }, { status: user.status });
  if (user.via === "access" || user.via === "dev") {
    const m = url.pathname.match(/^\/agents\/chat-agent\/([^/]+)\/?$/);
    if (!m) return Response.json({ error: "없는 경로입니다." }, { status: 404 });
    const convId = decodeURIComponent(m[1]);
    const row = await env.DB.prepare("SELECT owner FROM conversations WHERE id = ?").bind(convId).first<{ owner: string }>();
    if (!row || row.owner !== user.email) return Response.json({ error: "내 대화가 아닙니다." }, { status: 403 });
  }
  const headers = new Headers(request.headers);
  headers.set(CHAT_USER_HEADER, encodeURIComponent(JSON.stringify(user)));
  return new Request(request, { headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/agents/")) {
      const gated = await gateAgentRequest(request, env, url);
      if (gated instanceof Response) return gated;
      // /agents/... 요청이면 해당 에이전트로 넘기고, 아니면 null 이 돌아옵니다.
      const agentResponse = await routeAgentRequest(gated, env);
      if (agentResponse) return agentResponse;
    }
    return app.fetch(request, env, ctx);
  },
  async queue(batch, env) {
    await handleIndexBatch(batch, env);
  },
} satisfies ExportedHandler<Bindings, IndexJob>;
