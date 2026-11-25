// 로컬 동작 확인용 스모크 테스트 (연습 모드 기준)
// 사용법: (창 1) npm run dev:mock   (창 2) npm run smoke
// 진짜 AI 모드(npm run dev)에서도 돌릴 수 있지만 Workers AI·Vectorize 무료 한도를 조금 씁니다.
//   PowerShell: $env:BASE_URL="http://localhost:8787"; $env:ADMIN_TOKEN="<토큰>"; npm run smoke
//
// samples/charger-error-codes.md 를 올려 색인을 기다린 뒤, WebSocket 으로 질문 → 근거·답변 확인 →
// 이름 수정 → 다시 색인 → 삭제까지 확인하고, 만든 데이터는 마지막에 모두 지웁니다.
// Node.js 22 이상(내장 WebSocket)이 필요합니다.
// 한 번에 질문을 3번 보내므로, Rate Limiting(IP당 60초 10번) 때문에 1분 안에 4번 넘게 연달아 돌리면 채팅 항목이 실패합니다.

import { readFile } from "node:fs/promises";

const BASE = process.env.BASE_URL ?? "http://localhost:8787";
const ADMIN = process.env.ADMIN_TOKEN ?? "local-admin-token";
const auth = { authorization: `Bearer ${ADMIN}` };
let failed = 0;

function check(name, cond, extra = "") {
  console.log(`${cond ? "✅" : "❌"} ${name}${extra ? "  " + extra : ""}`);
  if (!cond) failed++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function upload(bytes, filename, headers = auth) {
  const form = new FormData();
  form.append("file", new Blob([bytes]), filename);
  const res = await fetch(`${BASE}/api/documents`, { method: "POST", headers, body: form });
  return { res, data: await res.json() };
}

async function waitIndexed(id, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const { documents } = await (await fetch(`${BASE}/api/documents`)).json();
    const d = documents.find((x) => x.id === id);
    if (d && (d.status === "ready" || d.status === "failed")) return d;
    await sleep(500);
  }
  return null;
}

/** WebSocket 으로 질문 하나를 보내고 done(또는 error)까지 받은 메시지를 돌려줍니다. */
function ask(session, text, docId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/agents/chat-agent/${session}`);
    const got = { history: null, sources: null, answer: "", done: false, error: null, user: null };
    const timer = setTimeout(() => (ws.close(), reject(new Error("응답 시간 초과"))), 30000);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "history" && got.history === null) {
        got.history = m.messages;
        ws.send(JSON.stringify({ type: "ask", text, docId }));
      } else if (m.type === "user") got.user = m.message;
      else if (m.type === "sources") got.sources = m.sources;
      else if (m.type === "delta") got.answer += m.text;
      else if (m.type === "done" || m.type === "error") {
        if (m.type === "done") got.done = true;
        else got.error = m.message;
        clearTimeout(timer);
        ws.close();
        resolve(got);
      }
    };
    ws.onerror = () => (clearTimeout(timer), reject(new Error("WebSocket 연결 실패")));
  });
}

function history(session) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/agents/chat-agent/${session}`);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "history") ws.close(), resolve(m.messages);
    };
  });
}

// 0. 모드 확인
const me = await (await fetch(`${BASE}/api/me`, { headers: auth })).json();
check("GET /api/me 관리자 확인", me.admin === true, `mock=${me.mock}`);

// 1. 업로드: 토큰 없음 / 형식 불가 / 정상
const sample = await readFile(new URL("../samples/charger-error-codes.md", import.meta.url));
let up = await upload(sample, "noauth.md", {});
check("토큰 없이 업로드 → 401", up.res.status === 401);
up = await upload(Buffer.from("hello"), "virus.exe");
check("지원하지 않는 형식 → 400", up.res.status === 400, up.data.error);
up = await upload(sample, "충전기 오류 코드.md");
const doc = up.data;
check("POST /api/documents → 201, 대기 상태", up.res.status === 201 && doc.status === "queued", `id=${doc.id}`);

// 2. 큐 소비자가 색인할 때까지 기다리기
const indexed = await waitIndexed(doc.id);
check("큐 색인 완료(ready)", indexed?.status === "ready", indexed ? `${indexed.status} 청크 ${indexed.chunkCount}개 ${indexed.error ?? ""}` : "시간 초과");
check("청크가 1개 이상", indexed?.chunkCount > 0);

// 3. 연습 모드에서 PDF 는 실패로 표시 (진짜 모드면 건너뜀)
let pdfDoc;
if (me.mock) {
  up = await upload(Buffer.from("%PDF-1.4 fake"), "가짜.pdf");
  pdfDoc = up.data;
  const r = await waitIndexed(pdfDoc.id);
  check("연습 모드 PDF → 실패 + 이유 표시", r?.status === "failed" && /TXT/.test(r.error ?? ""), r?.error);
}

// 4. 채팅: 근거 검색 + 답변 스트리밍 + 기록 저장
const session = `smoke-${Date.now()}`;
const a1 = await ask(session, "E-21 오류는 무엇인가요?");
check("처음 연결하면 빈 기록", Array.isArray(a1.history) && a1.history.length === 0);
check("질문 확인(user) 메시지", a1.user?.content === "E-21 오류는 무엇인가요?");
check("근거를 찾음", a1.sources?.some((s) => s.docId === doc.id), a1.sources?.map((s) => `${s.seq}:${s.score}`).join(", "));
check("가장 가까운 근거에 E-21 내용", a1.sources?.[0]?.text.includes("E-21"));
check("답변 스트리밍 완료", a1.done && a1.answer.length > 0, a1.error ?? JSON.stringify(a1.answer.slice(0, 60)));

const a2 = await ask(session, "충전 시작 절차", doc.id);
check("문서를 골라 질문(docId 필터)", a2.done && a2.sources?.every((s) => s.docId === doc.id));
check("두 번째 연결엔 이전 대화 기록(질문+답변 2개)", a2.history?.length === 2, `${a2.history?.length}개`);
const h = await history(session);
check("기록에 근거도 저장됨", h.length === 4 && h[1].sources.length > 0);

// 5. 이름 수정 → 근거 표시 이름에 반영
let res = await fetch(`${BASE}/api/documents/${doc.id}`, {
  method: "PATCH",
  headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify({ name: "오류 코드표" }),
});
check("PATCH 이름 수정", res.status === 200 && (await res.json()).name === "오류 코드표");

// 6. 다시 색인
res = await fetch(`${BASE}/api/documents/${doc.id}/reindex`, { method: "POST", headers: auth });
check("다시 색인 요청 → 대기", res.status === 200 && (await res.json()).status === "queued");
const re = await waitIndexed(doc.id);
check("다시 색인 완료, 청크 수 같음", re?.status === "ready" && re.chunkCount === indexed?.chunkCount);

// 7. 원본 열기
res = await fetch(`${BASE}/api/documents/${doc.id}/file?download=1`);
const body = Buffer.from(await res.arrayBuffer());
check("원본은 올린 바이트 그대로", res.status === 200 && body.equals(sample));
check("한글 파일 이름 유지", (res.headers.get("content-disposition") ?? "").includes(encodeURIComponent("충전기 오류 코드.md")));

// 8. 삭제 → 검색에서도 사라짐
for (const d of [doc, pdfDoc].filter(Boolean)) {
  res = await fetch(`${BASE}/api/documents/${d.id}`, { method: "DELETE", headers: auth });
  check(`문서 삭제 ${d.id}`, res.status === 200);
}
res = await fetch(`${BASE}/api/documents/${doc.id}/file`);
check("삭제 후 원본 → 404", res.status === 404);
const a3 = await ask(session, "E-21 오류는 무엇인가요?", doc.id);
check("삭제한 문서의 근거는 더 이상 나오지 않음", a3.done && (a3.sources?.length ?? 0) === 0);

// 9. 새 대화(reset)
await new Promise((resolve) => {
  const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/agents/chat-agent/${session}`);
  let first = true;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type !== "history") return;
    if (first) (first = false), ws.send(JSON.stringify({ type: "reset" }));
    else check("새 대화로 기록 비우기", m.messages.length === 0), ws.close(), resolve();
  };
});

console.log(failed ? `\n${failed}개 실패` : "\n모두 통과");
process.exit(failed ? 1 : 0);
