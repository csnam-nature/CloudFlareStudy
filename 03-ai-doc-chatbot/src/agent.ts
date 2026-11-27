// 채팅 에이전트 (Agents SDK)
//
// Agent 클래스는 Durable Object 위에 만들어진 "상태를 가진 작은 서버"입니다.
//   - 이름(name)마다 인스턴스가 딱 하나 생깁니다. 대화 id(UUID)를 이름으로 써서 "대화 하나 = 인스턴스 하나"가 됩니다.
//     대화 목록·폴더(제목, 어느 폴더인지)는 D1 conversations·folders 표에 따로 있습니다(src/conversations.ts).
//   - this.sql 로 인스턴스 전용 SQLite 에 대화 기록을 저장하므로, 새로고침하거나 다음 날 와도 대화가 남아 있습니다.
//   - WebSocket 연결을 직접 받아 답변을 조각조각 실시간으로 보낼 수 있습니다.
//
// 브라우저는 ws(s)://<호스트>/agents/chat-agent/<대화id> 로 연결합니다. (클래스 이름 ChatAgent → 경로 chat-agent)
// 연결 전에 src/index.ts 가 로그인·대화 주인을 확인하고, 누구인지를 x-chat-user 헤더로 넘겨 줍니다.
// 그 사람이 볼 수 있는 문서(그룹)만 검색합니다.
// React 없이 순수 WebSocket 으로 쓰려고, 메시지 형식을 아래처럼 직접 정했습니다.
//
//   브라우저 → 서버  { type: "ask", text, docId? }   질문
//                    { type: "reset" }               새 대화
//   서버 → 브라우저  { type: "history", messages, activeId }  지난 대화 (activeId = 생성 중인 답변)
//                    { type: "user", message }       (내가 보낸) 질문 확인
//                    { type: "start", id }           답변 시작
//                    { type: "sources", id, sources } 찾은 근거
//                    { type: "delta", id, text }      답변 조각
//                    { type: "done", id, content, sources }  답변 끝(완성본)
//                    { type: "error", message }

import { Agent, type Connection, type ConnectionContext, type WSMessage } from "agents";
import { type ChatMessage, streamChat } from "./ai";
import { type Bindings, docScope, isAuthError, isMock, loadUser, type User } from "./auth";
import { type AnswerMode, buildMessages, GENERAL_LABEL, mockAnswer, retrieve, type Source, toMode } from "./rag";
import { getSettings, webSearchState } from "./settings";

type StoredMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
  sources: string | null; // JSON
  created_at: number;
};

// mode: 답변 모드(문서만·문서 우선+일반 지식·일반 질문), web: 웹 검색 사용
type ClientMessage = { type: "ask"; text?: string; docId?: number | null; mode?: string; web?: boolean } | { type: "reset" };

const HISTORY_TURNS = 3; // LLM 에 함께 보낼 최근 대화(질문+답변) 쌍 수
const KEEP_MESSAGES = 200; // 인스턴스에 보관할 최대 메시지 수

export class ChatAgent extends Agent<Bindings> {
  private busy = false;
  /** 지금 만들고 있는 답변. 생성 중에 새로 연결한 탭(또는 재연결)에도 이어서 보여 주려고 메모리에 둡니다. */
  private current: { id: number; content: string; sources: ReturnType<typeof shorten>[] } | null = null;

  onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      role       TEXT    NOT NULL,
      content    TEXT    NOT NULL,
      sources    TEXT,
      created_at INTEGER NOT NULL
    )`;
  }

  /** 대화 삭제 때 API(src/conversations.ts)가 RPC 로 부릅니다. */
  async clearHistory() {
    this.sql`DELETE FROM messages`;
    this.broadcast(JSON.stringify({ type: "history", messages: [] }));
  }

  // Agents SDK 는 연결 직후 상태 동기화용 "프로토콜 메시지"를 보냅니다. 우리 화면은 쓰지 않으므로 끕니다.
  shouldSendProtocolMessages() {
    return false;
  }

  onConnect(connection: Connection, ctx: ConnectionContext) {
    // Rate Limiting 키로 쓸 IP 와, src/index.ts 가 확인해 넘겨 준 사용자를 연결 상태에 기억해 둡니다.
    const ip = ctx.request.headers.get("cf-connecting-ip") ?? "local";
    connection.setState({ ip, user: parseChatUser(ctx.request.headers.get(CHAT_USER_HEADER)) });
    const rows = this.sql<StoredMessage>`SELECT * FROM messages ORDER BY id DESC LIMIT 50`.reverse();
    const cur = this.current;
    // 생성 중인 답변은 DB 에 아직 빈 내용이므로, 메모리의 현재까지 내용으로 바꿔 보냅니다.
    const messages = rows.map((m) =>
      cur && m.id === cur.id ? { ...toClient(m), content: cur.content, sources: cur.sources } : toClient(m),
    );
    connection.send(JSON.stringify({ type: "history", messages, activeId: cur?.id ?? null }));
  }

  async onMessage(connection: Connection, raw: WSMessage) {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return this.sendError(connection, "잘못된 메시지 형식입니다.");
    }

    if (msg.type === "reset") {
      this.sql`DELETE FROM messages`;
      this.broadcast(JSON.stringify({ type: "history", messages: [] }));
      return;
    }
    if (msg.type !== "ask") return;

    const question = String(msg.text ?? "").trim().slice(0, 2000);
    if (!question) return this.sendError(connection, "질문을 입력해 주세요.");
    if (this.busy) return this.sendError(connection, "이전 답변을 만드는 중입니다. 잠시 뒤 다시 보내 주세요.");

    // 질문할 때마다 사용자를 다시 읽습니다. 연결 중에 역할·그룹이 바뀌거나 사용 중지되어도 바로 반영됩니다.
    const state = (connection.state ?? {}) as { ip?: string; user?: User };
    let user = state.user ?? ANONYMOUS_USER;
    if (user.via === "access" || user.via === "dev") {
      const fresh = await loadUser(this.env, user.email, user.via);
      if (isAuthError(fresh)) return this.sendError(connection, fresh.error);
      user = fresh;
    }

    // 남용 방지: 한 사람(로그인 전에는 IP 하나)당 60초에 N번 (wrangler.jsonc 의 ratelimits)
    const { success } = await this.env.CHAT_LIMITER.limit({ key: user.email || state.ip || "local" });
    if (!success) return this.sendError(connection, "질문이 너무 잦습니다. 1분 뒤에 다시 시도해 주세요.");

    this.busy = true;
    try {
      await this.answer(connection, question, msg.docId ? Number(msg.docId) : undefined, toMode(msg.mode), msg.web === true, docScope(user));
    } catch (err) {
      console.error("답변 실패", err);
      const text = err instanceof Error ? err.message : String(err);
      // 모델 접근 불가(5018)·지원 종료(5028)·유료 플랜 필요(5035)는 설정으로 고칠 수 있으므로 방법을 덧붙입니다.
      const hint = /\b(5018|5028|5035)\b/.test(text)
        ? ` (지금 답변 모델을 쓸 수 없습니다. 설정 화면에서 다른 모델을 고르고 [시험]으로 확인한 뒤 저장하세요)`
        : "";
      this.sendError(connection, `답변을 만들지 못했습니다: ${text}${hint}`);
    } finally {
      this.busy = false;
    }
  }

  private async answer(
    connection: Connection,
    question: string,
    docId: number | undefined,
    mode: AnswerMode,
    wantWeb: boolean,
    scope: number[] | null,
  ) {
    // 직전 대화(최근 N턴)를 먼저 읽어 둡니다. "그럼 E-22 는?" 같은 이어지는 질문을 이해시키기 위해서입니다.
    const history = this.sql<StoredMessage>`SELECT * FROM messages ORDER BY id DESC LIMIT ${HISTORY_TURNS * 2}`
      .reverse()
      .map((m): ChatMessage => ({ role: m.role, content: m.content }));

    const now = Math.floor(Date.now() / 1000);
    const [user] = this.sql<StoredMessage>`INSERT INTO messages (role, content, created_at)
      VALUES ('user', ${question}, ${now}) RETURNING *`;
    this.broadcast(JSON.stringify({ type: "user", message: toClient(user) }));
    // 대화 목록의 "최근 순" 정렬용 시각 갱신 (목록에 없는 대화면 아무 일도 없음)
    await this.env.DB.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").bind(now, this.name).run().catch(() => {});

    // 답변 자리를 먼저 만들고(id 확보), 다 만들어지면 내용을 채웁니다.
    const [draft] = this.sql<StoredMessage>`INSERT INTO messages (role, content, created_at)
      VALUES ('assistant', '', ${now}) RETURNING *`;
    const id = draft.id;
    this.broadcast(JSON.stringify({ type: "start", id }));

    // 1) 검색 (일반 질문 모드는 문서 검색을 건너뜀)
    const mock = isMock(this.env);
    const settings = await getSettings(this.env);
    const sources = mode === "general" ? [] : await retrieve(this.env, settings, question, mock, docId, scope);
    // 웹 검색은 쓸 수 있을 때만. 못 쓰면 이유를 알리고 웹 검색 없이 답합니다.
    let web = false;
    if (wantWeb) {
      const st = webSearchState(this.env, settings);
      if (st.available) web = true;
      else connection.send(JSON.stringify({ type: "notice", message: `웹 검색 없이 답합니다: ${st.reason}` }));
    }
    const shortSources = sources.map(shorten);
    this.current = { id, content: "", sources: shortSources };
    this.broadcast(JSON.stringify({ type: "sources", id, sources: shortSources }));

    // 2) 생성 (스트리밍)
    let content = "";
    try {
      const messages = buildMessages(question, sources, history, { systemPrompt: settings.systemPrompt, mode, web, charts: settings.allowCharts });
      for await (const piece of streamChat(this.env, settings, messages, mockForMode(mode, question, sources), web)) {
        content += piece;
        this.current.content = content;
        this.broadcast(JSON.stringify({ type: "delta", id, text: piece }));
      }
    } finally {
      this.current = null;
      // 중간에 실패해도 받은 데까지는 저장합니다.
      this.sql`UPDATE messages SET content = ${content || "(답변을 만들지 못했습니다)"}, sources = ${JSON.stringify(shortSources)}
        WHERE id = ${id}`;
      this.sql`DELETE FROM messages WHERE id <= (SELECT MAX(id) FROM messages) - ${KEEP_MESSAGES}`;
      // 끝날 때(실패해도) 전체 내용을 보내, 중간 조각을 놓친 화면이나 다른 탭도 말풍선을 마무리할 수 있게 합니다.
      this.broadcast(JSON.stringify({ type: "done", id, content: content || "(답변을 만들지 못했습니다)", sources: shortSources }));
    }
  }

  private sendError(connection: Connection, message: string) {
    connection.send(JSON.stringify({ type: "error", message }));
  }
}

/** src/index.ts 가 에이전트로 넘기는 사용자 정보 헤더 (브라우저가 보낸 같은 이름의 헤더는 index.ts 가 지우고 다시 씀) */
export const CHAT_USER_HEADER = "x-chat-user";
const ANONYMOUS_USER: User = { email: "", name: "", role: "employee", groups: [], via: "anonymous" };

function parseChatUser(v: string | null): User {
  try {
    const u = JSON.parse(decodeURIComponent(v ?? "")) as User;
    if (u && typeof u.role === "string" && Array.isArray(u.groups)) return u;
  } catch {
    /* 없거나 깨졌으면 익명 */
  }
  return ANONYMOUS_USER;
}

/** 연습 모드의 가짜 답변 (답변 모드별) */
function mockForMode(mode: AnswerMode, question: string, sources: Source[]): string {
  if (mode === "general") return "(연습 모드 · 일반 질문) 진짜 AI 모드(npm run dev)에서는 문서 검색 없이 일반 지식으로 답합니다.";
  if (mode === "mixed" && !sources.length)
    return `(연습 모드 · 문서 우선 + 일반 지식)\n\n${GENERAL_LABEL} 진짜 AI 모드에서는 여기서 일반 지식으로 답합니다.`;
  return mockAnswer(question, sources);
}

/** 화면에 보낼 근거: 원문은 앞부분만 */
const shorten = (s: Source) => ({
  docId: s.docId,
  docName: s.docName,
  seq: s.seq,
  score: Math.round(s.score * 1000) / 1000,
  text: s.text.length > 400 ? `${s.text.slice(0, 400)}…` : s.text,
});

const toClient = (m: StoredMessage) => ({
  id: m.id,
  role: m.role,
  content: m.content,
  sources: m.sources ? JSON.parse(m.sources) : [],
  createdAt: m.created_at,
});
