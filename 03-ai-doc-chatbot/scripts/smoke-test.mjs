// 로컬 동작 확인용 스모크 테스트 (연습 모드 기준)
// 사용법: (창 1) npm run dev:mock   (창 2) npm run smoke
// 진짜 AI 모드(npm run dev)에서도 돌릴 수 있지만 Workers AI·Vectorize 무료 한도를 조금 씁니다.
//   PowerShell: $env:BASE_URL="http://localhost:8787"; $env:ADMIN_TOKEN="<토큰>"; npm run smoke
//
// samples/charger-error-codes.md 를 올려 색인을 기다린 뒤, WebSocket 으로 질문 → 근거·답변 확인 →
// 이름 수정 → 다시 색인 → 삭제까지 확인하고, 만든 데이터는 마지막에 모두 지웁니다.
// Node.js 22 이상(내장 WebSocket)이 필요합니다.
// 한 번에 질문을 8번 보내므로, Rate Limiting(IP당 60초 10번) 때문에 1분 안에 1번 넘게 연달아 돌리면 채팅 항목이 실패합니다.
// "모두 삭제"도 확인하므로 연습 모드 로컬 DB 의 문서가 모두 지워집니다.

import { readFile } from "node:fs/promises";
import { strToU8, zipSync } from "fflate";

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
    const { documents } = await (await fetch(`${BASE}/api/documents`, { headers: auth })).json();
    const d = documents.find((x) => x.id === id);
    if (d && (d.status === "ready" || d.status === "failed")) return d;
    await sleep(500);
  }
  return null;
}

/** WebSocket 으로 질문 하나를 보내고 done(또는 error)까지 받은 메시지를 돌려줍니다. */
/** 질문 하나. 분당 질문 제한(Rate Limiting)에 걸리면 1분 기다렸다가 한 번 더 보냅니다. */
async function ask(session, text, docId, opts = {}) {
  const got = await askOnce(session, text, docId, opts);
  if (!/너무 잦습니다/.test(got.error ?? "")) return got;
  console.log("   (분당 질문 제한에 걸려 61초 기다립니다)");
  await new Promise((r) => setTimeout(r, 61000));
  return askOnce(session, text, docId, opts);
}

function askOnce(session, text, docId, opts = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/agents/chat-agent/${session}`);
    const got = { history: null, sources: null, answer: "", done: false, error: null, user: null, notice: null };
    const timer = setTimeout(() => (ws.close(), reject(new Error("응답 시간 초과"))), 30000);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "history" && got.history === null) {
        got.history = m.messages;
        ws.send(JSON.stringify({ type: "ask", text, docId, ...opts }));
      } else if (m.type === "user") got.user = m.message;
      else if (m.type === "notice") got.notice = m.message;
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

// 3-0. 이미지: 연습 모드는 비전 모델이 없어 실패로 표시, 너무 큰 이미지는 업로드 거절
if (me.mock) {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
  up = await upload(png, "오류 코드 사진.png");
  const r = await waitIndexed(up.data.id);
  check("연습 모드 이미지 → 실패 + 비전 모델 안내", r?.status === "failed" && /비전 모델/.test(r.error ?? ""), r?.error);
  await fetch(`${BASE}/api/documents/${up.data.id}`, { method: "DELETE", headers: auth });
  up = await upload(Buffer.alloc(5 * 1024 * 1024), "big.jpg");
  check("4MB 넘는 이미지 → 413", up.res.status === 413, up.data.error);
}

// 3-1. CSV(엑셀에서 저장한 표): 머리글 + 여러 행 → 표 청크마다 머리글이 다시 붙음
const csvRows = ["코드,이름,조치"];
for (let i = 1; i <= 40; i++) csvRows.push(`P-${100 + i},"부품 ${i}, 교체 필요",${i % 2 ? "현장 점검" : "원격 재부팅"}`);
up = await upload(Buffer.from(csvRows.join("\r\n")), "부품 코드표.csv");
const csvDoc = up.data;
const csvIndexed = await waitIndexed(csvDoc.id);
check("CSV 색인 완료, 큰 표는 여러 청크", csvIndexed?.status === "ready" && csvIndexed.chunkCount > 1, `청크 ${csvIndexed?.chunkCount}개`);

// 3-2. 한글 HWPX: ZIP 안의 section XML 에서 문단·표를 직접 읽음(AI 불필요) / 예전 HWP 는 400
// 공문서에 흔한 모양으로 만듭니다: 칸 하나짜리 제목 상자 + 두 줄로 병합된 머리글 + 세로 병합된 제조사 칸 + 맨 아래 ※ 비고 행
const hp = (t) => `<hp:p><hp:run><hp:t>${t}</hp:t></hp:run></hp:p>`;
const htc = (t, r, c, rs = 1, cs = 1) =>
  `<hp:tc><hp:subList>${hp(t)}</hp:subList><hp:cellAddr colAddr="${c}" rowAddr="${r}"/><hp:cellSpan colSpan="${cs}" rowSpan="${rs}"/></hp:tc>`;
const htbl = (rows) => `<hp:p><hp:run><hp:tbl>${rows.map((r) => `<hp:tr>${r}</hp:tr>`).join("")}</hp:tbl></hp:run></hp:p>`;
const hrows = [htc("연번", 0, 0, 2) + htc("제조사", 0, 1, 2) + htc("충전기", 0, 2, 1, 2), htc("모델명", 1, 2) + htc("용량(kW)", 1, 3)];
let hr = 2;
for (const m of ["대영채비", "이브이시스", "중앙제어", "SK시그넷", "에바", "피엔이시스템즈", "클린일렉스", "티비유", "와이어블", "차지비"])
  for (let i = 0; i < 4; i++, hr++) hrows.push((i ? "" : htc(m, hr, 1, 4)) + htc(String(hr - 1), hr, 0) + htc(`M${hr}-${i}`, hr, 2) + htc(String(50 * (i + 1)), hr, 3));
hrows.push(htc("※ 선정 목록은 고시에 따라 바뀔 수 있음 &amp; 확인 필요", hr, 0, 1, 4));
const hwpx = zipSync({
  mimetype: strToU8("application/hwp+zip"),
  "Contents/content.hpf": strToU8('<opf:package><opf:manifest><opf:item id="s0" href="Contents/section0.xml"/></opf:manifest><opf:spine><opf:itemref idref="s0"/></opf:spine></opf:package>'),
  "Contents/section0.xml": strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><hs:sec xmlns:hs="s" xmlns:hp="p">${htbl([htc("「2026년 충전시설 보조사업」 충전기 모델 선정 목록", 0, 0)])}${htbl(hrows)}</hs:sec>`,
  ),
});
up = await upload(Buffer.from(hwpx), "충전기 모델 선정 목록.hwpx");
const hwpxDoc = up.data;
const hwpxIndexed = await waitIndexed(hwpxDoc.id);
check("HWPX 색인 완료", hwpxIndexed?.status === "ready", hwpxIndexed?.error);
const ah = await ask(`smoke-hwpx-${Date.now()}`, "SK시그넷 모델은?");
check("HWPX 병합 머리글이 열마다 합쳐짐", ah.sources?.some((s) => s.text.includes("| 연번 | 제조사 | 충전기 모델명 | 충전기 용량(kW) |")), ah.sources?.[0]?.text.slice(0, 120));
check("HWPX 질문 → 제목 상자가 아니라 SK시그넷 행이 답으로", (ah.answer.match(/\| SK시그넷 \|/g) ?? []).length === 4 && !ah.answer.includes("선정 목록 |"), ah.answer);
// 연습 모드의 가짜 검색은 엉성해서, 남겨 두면 아래 E-21 질문의 근거 순위를 흔듭니다. 확인했으니 바로 지웁니다.
await fetch(`${BASE}/api/documents/${hwpxDoc.id}`, { method: "DELETE", headers: auth });
up = await upload(Buffer.from("HWP Document File"), "옛날 문서.hwp");
check("HWP(예전 형식) → 400 + HWPX 로 저장 안내", up.res.status === 400 && up.data.error?.includes("HWPX"), up.data.error);

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

// 4-1. 답변 생성 중에 다른 탭이 연결해도 이어서 받음 (재연결 대비)
{
  const url = `${BASE.replace(/^http/, "ws")}/agents/chat-agent/${session}`;
  const result = await new Promise((resolve, reject) => {
    const a = new WebSocket(url);
    let b;
    const timer = setTimeout(() => reject(new Error("시간 초과")), 30000);
    a.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "history") a.send(JSON.stringify({ type: "ask", text: "E-23 비상 정지 해제 방법" }));
      if (m.type === "delta" && !b) {
        // 첫 조각을 받은 뒤 두 번째 연결을 엽니다.
        b = new WebSocket(url);
        const got = { history: null, done: null };
        b.onmessage = (ev) => {
          const x = JSON.parse(ev.data);
          if (x.type === "history") got.history = x;
          if (x.type === "done") (got.done = x), clearTimeout(timer), a.close(), b.close(), resolve(got);
        };
      }
    };
  });
  const active = result.history?.messages.find((m) => m.id === result.history.activeId);
  check("생성 중 연결하면 activeId 와 지금까지의 답변을 받음", !!active && active.content.length > 0, `activeId=${result.history?.activeId}`);
  check("done 에 완성된 답변이 들어 있음", result.done?.content.includes("E-23"));
}

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
{
  const csvAnswer = await ask(`smoke-csv-${Date.now()}`, "P-137 조치", csvDoc.id);
  const srcs = csvAnswer.sources ?? [];
  check(
    "CSV 조각마다 머리글(코드 | 이름 | 조치)이 붙어 있음",
    srcs.length > 1 && srcs.every((x) => x.text.startsWith("| 코드 | 이름 | 조치 |\n| --- | --- | --- |")),
    `${srcs.length}개 조각`,
  );
  check("따옴표 안 쉼표는 한 칸으로 읽음", srcs.some((x) => x.text.includes("| 부품 1, 교체 필요 |") || x.text.includes("교체 필요 | 원격")));
}
for (const d of [doc, pdfDoc, csvDoc].filter(Boolean)) {
  res = await fetch(`${BASE}/api/documents/${d.id}`, { method: "DELETE", headers: auth });
  check(`문서 삭제 ${d.id}`, res.status === 200);
}
res = await fetch(`${BASE}/api/documents/${doc.id}/file`);
check("삭제 후 원본 → 404", res.status === 404);
const a3 = await ask(session, "E-21 오류는 무엇인가요?", doc.id);
check("삭제한 문서의 근거는 더 이상 나오지 않음", a3.done && (a3.sources?.length ?? 0) === 0);

// 8-1. 모두 삭제: confirm 없음 → 400, 토큰 없음 → 401, 정상 → 전부 사라짐
for (const name of ["a.md", "b.md"]) await upload(sample, name);
res = await fetch(`${BASE}/api/documents`, { method: "DELETE", headers: auth });
check("모두 삭제: confirm=all 없으면 → 400", res.status === 400);
res = await fetch(`${BASE}/api/documents?confirm=all`, { method: "DELETE" });
check("모두 삭제: 토큰 없으면 → 401", res.status === 401);
res = await fetch(`${BASE}/api/documents?confirm=all`, { method: "DELETE", headers: auth });
const delAll = await res.json();
check("모두 삭제 → 200", res.status === 200 && delAll.deleted >= 2, `${delAll.deleted}개`);
await sleep(3000); // 색인 중이던 작업이 끝나도 되살아나지 않는지 확인
const after = await (await fetch(`${BASE}/api/documents`)).json();
check("모두 삭제 후 목록·청크 0", after.documents.length === 0 && after.totalChunks === 0);
const a4 = await ask(session, "E-21 오류는 무엇인가요?");
check("모두 삭제 후 근거 없음", a4.done && (a4.sources?.length ?? 0) === 0);

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

// 10. 대화 목록·폴더 (사이드바 API)
{
  const client = crypto.randomUUID();
  const other = crypto.randomUUID();
  const capi = async (path, method = "GET", body, who = client) => {
    const res = await fetch(`${BASE}/api/conversations${path}`, {
      method,
      headers: { "x-client-id": who, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  check("X-Client-Id 없으면 400", (await fetch(`${BASE}/api/conversations`)).status === 400);
  const folder = (await capi("/folders", "POST", { name: "충전기 A/S" })).data;
  check("폴더 만들기", folder.id > 0 && folder.name === "충전기 A/S");
  const convId = crypto.randomUUID();
  let r = await capi("", "POST", { id: convId, folderId: folder.id, title: "E-21 오류는 무엇인가요?" });
  check("폴더 안에 대화 만들기", r.status === 201 && r.data.folderId === folder.id);
  // 그 대화(에이전트)에 질문하면 목록 시각이 갱신되고 기록이 남음
  const before = r.data.updatedAt;
  await new Promise((res) => setTimeout(res, 1100));
  const ac = await ask(convId, "E-21 오류는 무엇인가요?");
  check("대화 id 로 질문·답변", ac.done);
  let list = (await capi("")).data;
  const c1 = list.conversations.find((c) => c.id === convId);
  check("목록에 폴더·대화가 보이고 시각 갱신", list.folders.length === 1 && c1?.folderId === folder.id && c1.updatedAt > before);
  check("다른 브라우저 id 에는 안 보임", (await capi("", "GET", undefined, other)).data.conversations.length === 0);
  check("남의 대화는 못 바꿈", (await capi(`/${convId}`, "PATCH", { title: "x" }, other)).status === 404);
  r = await capi(`/${convId}`, "PATCH", { title: "E-21 정리", folderId: null });
  list = (await capi("")).data;
  check("이름 바꾸기 + 폴더 밖으로 옮기기", r.status === 200 && list.conversations[0].title === "E-21 정리" && list.conversations[0].folderId === null);
  await capi(`/${convId}`, "PATCH", { folderId: folder.id });
  r = await capi(`/folders/${folder.id}`, "PATCH", { name: "A/S 기록" });
  check("폴더 이름 바꾸기", r.status === 200);
  r = await capi(`/folders/${folder.id}`, "DELETE");
  list = (await capi("")).data;
  check("폴더만 삭제하면 대화는 폴더 없음으로", r.status === 200 && list.folders.length === 0 && list.conversations[0].folderId === null);
  r = await capi(`/${convId}`, "DELETE");
  const h2 = await history(convId);
  check("대화 삭제: 목록과 기록 모두 지움", r.status === 200 && (await capi("")).data.conversations.length === 0 && h2.length === 0, `기록 ${h2.length}개`);
}

// 11. 답변 모드 (문서만 · 문서 우선 + 일반 지식 · 일반 질문) 와 웹 검색 요청
{
  const s11 = crypto.randomUUID();
  const g = await ask(s11, "전기차 완속 충전과 급속 충전 차이는?", null, { mode: "general" });
  check("일반 질문: 문서 검색 없이 답함", g.done && g.sources?.length === 0 && g.answer.includes("일반 질문"));
  const mx = await ask(s11, "등록 문서에 전혀 없는 질문 zzqq", null, { mode: "mixed" });
  check("문서 우선 + 일반 지식: 근거가 없으면 일반 정보 표시", mx.done && mx.answer.includes("※ 등록 문서에 없는 일반 정보입니다"));
  const w = await ask(s11, "오늘 날씨", null, { mode: "general", web: true });
  check("웹 검색 요청: 못 쓰면 이유를 알리고 답은 계속", w.done && /웹 검색 없이 답합니다/.test(w.notice ?? ""), w.notice ?? "");
  const me = await (await fetch(`${BASE}/api/me`)).json();
  check("/api/me 에 웹 검색 가능 여부", me.webSearch && me.webSearch.available === false && !!me.webSearch.reason);
  const st = await (await fetch(`${BASE}/api/settings`, { headers: auth })).json();
  check("설정 API 에 기본 프롬프트·모드 규칙", st.defaultSystemPrompt?.includes("네이처텍") && !!st.modeRules?.mixed && st.settings.allowWebSearch === true);
}

// 12. 그룹별 문서 공개 범위 (관리자 토큰 방식: 토큰 없는 사람 = 익명 직원 = 전 직원 문서만)
//     계정·역할(Access·개발용 로그인)은 scripts/smoke-auth.mjs 에서 따로 확인합니다.
{
  const json = async (path, method = "GET", body, headers = auth) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  check("사용자 API: 토큰 없으면 401", (await json("/api/users", "GET", null, {})).status === 401);
  const g = await json("/api/groups", "POST", { name: `스모크팀-${Date.now()}` });
  check("그룹 만들기", g.status === 201 && g.data.id > 0);
  const secret = new TextEncoder().encode("# 스모크 비공개\n\n비밀코드ZQX 는 기술지원팀 전용 점검 절차입니다.\n");
  const form = new FormData();
  form.append("file", new Blob([secret], { type: "text/markdown" }), "group-only.md");
  form.append("groupId", String(g.data.id));
  const gu = await fetch(`${BASE}/api/documents`, { method: "POST", headers: auth, body: form });
  const gdoc = await gu.json();
  check("그룹 전용 문서 올리기", gu.status === 201 && gdoc.groupId === g.data.id, JSON.stringify(gdoc).slice(0, 120));
  await waitIndexed(gdoc.id);
  const anonList = (await json("/api/documents", "GET", null, {})).data.documents;
  const adminList = (await json("/api/documents")).data.documents;
  check("익명에게는 그룹 문서가 목록에 안 보임", !anonList.some((d) => d.id === gdoc.id) && adminList.some((d) => d.id === gdoc.id));
  check("익명은 그룹 문서 원본 404", (await fetch(`${BASE}/api/documents/${gdoc.id}/file`)).status === 404);
  const ga = await ask(crypto.randomUUID(), "비밀코드ZQX 는 무엇인가요?");
  check("익명 채팅 검색에서도 그룹 문서는 빠짐", ga.done && !ga.sources.some((x) => x.docId === gdoc.id), JSON.stringify(ga.sources.map((x) => x.docName)));
  check("문서가 있는 그룹은 삭제 거절(409)", (await json(`/api/groups/${g.data.id}`, "DELETE")).status === 409);
  const pub = await json(`/api/documents/${gdoc.id}`, "PATCH", { groupId: null });
  const ga2 = await ask(crypto.randomUUID(), "비밀코드ZQX 는 무엇인가요?");
  check("전 직원 공개로 바꾸면 검색됨", pub.status === 200 && pub.data.groupId === null && ga2.sources.some((x) => x.docId === gdoc.id));
  await fetch(`${BASE}/api/documents/${gdoc.id}`, { method: "DELETE", headers: auth });
  check("빈 그룹 삭제", (await json(`/api/groups/${g.data.id}`, "DELETE")).status === 200);
}

console.log(failed ? `\n${failed}개 실패` : "\n모두 통과");
process.exit(failed ? 1 : 0);
