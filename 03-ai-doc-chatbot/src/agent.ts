// 채팅 에이전트 (Agents SDK)
//
// Agent 클래스는 Durable Object 위에 만들어진 "상태를 가진 작은 서버"입니다.
//   - 이름(name)마다 인스턴스가 딱 하나 생깁니다. 브라우저가 만든 세션 id 를 이름으로 써서 "브라우저마다 내 대화방"이 됩니다.
//   - this.sql 로 인스턴스 전용 SQLite 에 대화 기록을 저장하므로, 새로고침하거나 다음 날 와도 대화가 남아 있습니다.
//   - WebSocket 연결을 직접 받아 답변을 조각조각 실시간으로 보낼 수 있습니다.
//
// 브라우저는 ws(s)://<호스트>/agents/chat-agent/<세션id> 로 연결합니다. (클래스 이름 ChatAgent → 경로 chat-agent)
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
import { type Bindings, isMock } from "./auth";
import { buildMessages, mockAnswer, retrieve, type Source } from "./rag";

type StoredMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
  sources: string | null; // JSON
  created_at: number;
};

type ClientMessage = { type: "ask"; text?: string; docId?: number | null } | { type: "reset" };

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

  // Agents SDK 는 연결 직후 상태 동기화용 "프로토콜 메시지"를 보냅니다. 우리 화면은 쓰지 않으므로 끕니다.
  shouldSendProtocolMessages() {
    return false;
  }

  onConnect(connection: Connection, ctx: ConnectionContext) {
    // Rate Limiting 키로 쓸 IP 를 연결 상태에 기억해 둡니다.
    const ip = ctx.request.headers.get("cf-connecting-ip") ?? "local";
    connection.setState({ ip });
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

    // 남용 방지: IP 하나당 60초에 N번 (wrangler.jsonc 의 ratelimits)
    const ip = (connection.state as { ip?: string } | null)?.ip ?? "local";
    const { success } = await this.env.CHAT_LIMITER.limit({ key: ip });
    if (!success) return this.sendError(connection, "질문이 너무 잦습니다. 1분 뒤에 다시 시도해 주세요.");

    this.busy = true;
    try {
      await this.answer(question, msg.docId ? Number(msg.docId) : undefined);
    } catch (err) {
      console.error("답변 실패", err);
      this.sendError(connection, `답변을 만들지 못했습니다: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.busy = false;
    }
  }

  private async answer(question: string, docId?: number) {
    // 직전 대화(최근 N턴)를 먼저 읽어 둡니다. "그럼 E-22 는?" 같은 이어지는 질문을 이해시키기 위해서입니다.
    const history = this.sql<StoredMessage>`SELECT * FROM messages ORDER BY id DESC LIMIT ${HISTORY_TURNS * 2}`
      .reverse()
      .map((m): ChatMessage => ({ role: m.role, content: m.content }));

    const now = Math.floor(Date.now() / 1000);
    const [user] = this.sql<StoredMessage>`INSERT INTO messages (role, content, created_at)
      VALUES ('user', ${question}, ${now}) RETURNING *`;
    this.broadcast(JSON.stringify({ type: "user", message: toClient(user) }));

    // 답변 자리를 먼저 만들고(id 확보), 다 만들어지면 내용을 채웁니다.
    const [draft] = this.sql<StoredMessage>`INSERT INTO messages (role, content, created_at)
      VALUES ('assistant', '', ${now}) RETURNING *`;
    const id = draft.id;
    this.broadcast(JSON.stringify({ type: "start", id }));

    // 1) 검색
    const mock = isMock(this.env);
    const sources = await retrieve(this.env, question, mock, docId);
    const shortSources = sources.map(shorten);
    this.current = { id, content: "", sources: shortSources };
    this.broadcast(JSON.stringify({ type: "sources", id, sources: shortSources }));

    // 2) 생성 (스트리밍)
    let content = "";
    try {
      for await (const piece of streamChat(this.env, buildMessages(question, sources, history), mockAnswer(question, sources))) {
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
    }
    // 끝날 때 전체 내용도 함께 보내, 중간 조각을 놓친 화면도 완성된 답을 그릴 수 있게 합니다.
    this.broadcast(JSON.stringify({ type: "done", id, content, sources: shortSources }));
  }

  private sendError(connection: Connection, message: string) {
    connection.send(JSON.stringify({ type: "error", message }));
  }
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
