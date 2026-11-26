// 계정·역할·문서 공개 범위 시험 (개발용 로그인 우회로 여러 사람 흉내)
//
// Zero Trust Access 는 로컬에서 흉내 낼 수 없으므로, localhost 에서만 동작하는 개발용 우회(DEV_AUTH=1)로
// x-dev-user-email 헤더를 바꿔 가며 관리자·매니저·직원 역할을 확인합니다. 진짜 Access 토큰 검증은 배포 후 브라우저로 확인하세요(README).
//
// 실행 (PowerShell, 터미널 두 개)
//   1) npm run db:migrate:mock
//      npx wrangler dev --env mock --var DEV_AUTH:1 --var ADMIN_EMAILS:boss@naturetec.kr
//   2) npm run smoke:auth
//   (주소가 다르면 $env:BASE_URL="http://localhost:8787")

const BASE = process.env.BASE_URL ?? "http://localhost:8787";
const BOSS = "boss@naturetec.kr"; // ADMIN_EMAILS 에 넣은 사람 = 고정 관리자
const t = Date.now();
const MGR = `mgr-${t}@naturetec.kr`;
const EMP1 = `emp1-${t}@naturetec.kr`; // 그룹 없음
const EMP2 = `emp2-${t}@naturetec.kr`; // 그룹 소속
let failed = 0;

function check(name, cond, extra = "") {
  console.log(`${cond ? "✅" : "❌"} ${name}${extra ? `  ${extra}` : ""}`);
  if (!cond) failed++;
}
const as = (email) => ({ "x-dev-user-email": email });
async function api(email, path, method = "GET", body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...as(email), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

/** 대화 하나에 질문하고 done/error 까지 받기 (WebSocket 에도 개발용 헤더를 붙임) */
function ask(email, conv, text) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/agents/chat-agent/${conv}`, { headers: as(email) });
    const got = { opened: false, sources: [], done: false, error: null };
    const timer = setTimeout(() => (ws.close(), resolve(got)), 20000);
    ws.onopen = () => (got.opened = true);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "history") ws.send(JSON.stringify({ type: "ask", text }));
      else if (m.type === "sources") got.sources = m.sources;
      else if (m.type === "done" || m.type === "error") {
        got.done = m.type === "done";
        got.error = m.message ?? null;
        clearTimeout(timer);
        ws.close();
        resolve(got);
      }
    };
    ws.onerror = () => (clearTimeout(timer), resolve(got));
  });
}

async function waitIndexed(id) {
  for (let i = 0; i < 60; i++) {
    const { data } = await api(BOSS, "/api/documents");
    const d = data.documents?.find((x) => x.id === id);
    if (d && (d.status === "ready" || d.status === "failed")) return d;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

// 0. 개발용 로그인이 켜져 있는지
const me = await api(BOSS, "/api/me");
if (me.data.authMode !== "dev") {
  console.log("개발용 로그인(DEV_AUTH=1)이 꺼져 있어 건너뜁니다. 맨 위 주석의 실행 방법을 보세요.");
  process.exit(0);
}
check("ADMIN_EMAILS 의 사람은 관리자", me.data.user?.email === BOSS && me.data.role === "admin" && me.data.admin === true);

// 1. 처음 온 사람은 직원으로 자동 등록, 관리자 화면 API 는 거절
const e1 = await api(EMP1, "/api/me");
check("처음 온 사람은 직원으로 자동 등록", e1.data.role === "employee" && e1.data.canManageDocs === false);
check("직원: 설정 API 403", (await api(EMP1, "/api/settings")).status === 403);
check("직원: 사용자 API 403", (await api(EMP1, "/api/users")).status === 403);
const form = new FormData();
form.append("file", new Blob(["x"], { type: "text/plain" }), "x.txt");
const up403 = await fetch(`${BASE}/api/documents`, { method: "POST", headers: as(EMP1), body: form });
check("직원: 문서 올리기 403", up403.status === 403);

// 2. 관리자가 그룹을 만들고 역할·그룹을 정함
const g = await api(BOSS, "/api/groups", "POST", { name: `기술지원팀-${t}` });
check("관리자: 그룹 만들기", g.status === 201);
await api(MGR, "/api/me"); // 자동 등록
await api(EMP2, "/api/me");
check("관리자: 매니저로 바꾸기", (await api(BOSS, `/api/users/${encodeURIComponent(MGR)}`, "PATCH", { role: "manager" })).status === 200);
check("관리자: 직원2 를 그룹에 넣기", (await api(BOSS, `/api/users/${encodeURIComponent(EMP2)}`, "PATCH", { groups: [g.data.id] })).status === 200);
check("자기 역할은 못 바꿈", (await api(BOSS, `/api/users/${encodeURIComponent(BOSS)}`, "PATCH", { role: "employee" })).status === 400);
check("매니저: 사용자 API 403", (await api(MGR, "/api/users")).status === 403);
check("매니저: 그룹 목록은 읽음(문서 공개 범위 고르기용)", (await api(MGR, "/api/groups")).status === 200);

// 3. 매니저가 그룹 전용 문서를 올림
const f2 = new FormData();
f2.append("file", new Blob(["# 기술지원 전용\n\n비밀코드QWZ 는 기술지원팀만 보는 점검 절차입니다.\n"], { type: "text/markdown" }), "tech-only.md");
f2.append("groupId", String(g.data.id));
const up = await fetch(`${BASE}/api/documents`, { method: "POST", headers: as(MGR), body: f2 });
const doc = await up.json();
check("매니저: 그룹 전용 문서 올리기", up.status === 201 && doc.groupId === g.data.id);
await waitIndexed(doc.id);

const l1 = (await api(EMP1, "/api/documents")).data.documents ?? [];
const l2 = (await api(EMP2, "/api/documents")).data.documents ?? [];
check("그룹 밖 직원에게는 안 보임", !l1.some((d) => d.id === doc.id));
check("그룹 안 직원에게는 보임", l2.some((d) => d.id === doc.id));
check("그룹 밖 직원: 원본 404", (await fetch(`${BASE}/api/documents/${doc.id}/file`, { headers: as(EMP1) })).status === 404);
check("그룹 안 직원: 원본 200", (await fetch(`${BASE}/api/documents/${doc.id}/file`, { headers: as(EMP2) })).status === 200);

// 4. 대화는 사람별, 검색은 공개 범위 안에서만
const c1 = crypto.randomUUID();
const c2 = crypto.randomUUID();
await api(EMP1, "/api/conversations", "POST", { id: c1, title: "직원1 대화" });
await api(EMP2, "/api/conversations", "POST", { id: c2, title: "직원2 대화" });
const list1 = (await api(EMP1, "/api/conversations")).data.conversations ?? [];
check("대화 목록은 사람별(헤더 X-Client-Id 없이도)", list1.some((c) => c.id === c1) && !list1.some((c) => c.id === c2));
const a1 = await ask(EMP1, c1, "비밀코드QWZ 는 무엇인가요?");
check("그룹 밖 직원의 검색에는 그룹 문서가 없음", a1.done && !a1.sources.some((s) => s.docId === doc.id), a1.error ?? "");
const a2 = await ask(EMP2, c2, "비밀코드QWZ 는 무엇인가요?");
check("그룹 안 직원의 검색에는 그룹 문서가 나옴", a2.done && a2.sources.some((s) => s.docId === doc.id), a2.error ?? "");
const steal = await ask(EMP1, c2, "남의 대화 열기");
check("남의 대화에는 연결할 수 없음", !steal.opened && !steal.done);

// 5. 사용 중지
check("관리자: 직원1 사용 중지", (await api(BOSS, `/api/users/${encodeURIComponent(EMP1)}`, "PATCH", { active: false })).status === 200);
check("사용 중지된 사람은 403", (await api(EMP1, "/api/me")).status === 403);

// 정리
await fetch(`${BASE}/api/documents/${doc.id}`, { method: "DELETE", headers: as(MGR) });
await api(BOSS, `/api/groups/${g.data.id}`, "DELETE");
for (const e of [MGR, EMP1, EMP2]) await api(BOSS, `/api/users/${encodeURIComponent(e)}`, "DELETE");

console.log(failed ? `\n${failed}개 실패` : "\n모두 통과");
process.exit(failed ? 1 : 0);
