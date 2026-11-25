// 로컬 동작 확인용 스모크 테스트
// 사용법: (터미널 1) npm run dev   (터미널 2) npm run smoke
// 다른 주소를 시험하려면: BASE_URL=https://url-shortener.<계정>.workers.dev npm run smoke

const BASE = process.env.BASE_URL ?? "http://localhost:8787";
const ADMIN = process.env.ADMIN_TOKEN ?? "local-admin-token";
let failed = 0;

function check(name, cond, extra = "") {
  console.log(`${cond ? "✅" : "❌"} ${name}${extra ? "  " + extra : ""}`);
  if (!cond) failed++;
}

// 1. 링크 생성 (자동 코드)
let res = await fetch(`${BASE}/api/links`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ url: "https://developers.cloudflare.com/workers/", title: "Workers 문서" }),
});
const created = await res.json();
check("POST /api/links → 201", res.status === 201, JSON.stringify(created));
const code = created.code;

// 2. 잘못된 URL 거부
res = await fetch(`${BASE}/api/links`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ url: "javascript:alert(1)" }),
});
check("javascript: URL 거부 → 400", res.status === 400);

// 3. 사용자 지정 코드 + 중복
const custom = `test-${Date.now()}`;
res = await fetch(`${BASE}/api/links`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ url: "https://example.com", code: custom, ttlDays: 7 }),
});
check("사용자 지정 코드 생성 → 201", res.status === 201);
res = await fetch(`${BASE}/api/links`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ url: "https://example.org", code: custom }),
});
check("중복 코드 → 409", res.status === 409);

// 4. 리다이렉트 (redirect: "manual" 로 302 를 직접 확인)
for (let i = 0; i < 3; i++) {
  res = await fetch(`${BASE}/${code}`, { redirect: "manual", headers: { referer: "https://blog.example.kr/post/1" } });
}
check("GET /:code → 302", res.status === 302, res.headers.get("location") ?? "");

res = await fetch(`${BASE}/no-such-code`, { redirect: "manual" });
check("없는 코드 → 404", res.status === 404);

// 5. 통계 (클릭 로그는 waitUntil 로 비동기 기록되므로 잠깐 기다림)
await new Promise((r) => setTimeout(r, 500));
res = await fetch(`${BASE}/api/stats/${code}`);
const stats = await res.json();
check("GET /api/stats/:code 클릭 3회", stats.totalClicks === 3, JSON.stringify(stats));

// 6. 목록
res = await fetch(`${BASE}/api/links`);
const list = await res.json();
check("GET /api/links 에 새 링크 포함", list.links.some((l) => l.code === code));

// 7. 삭제 (토큰 없이 401, 토큰으로 200)
res = await fetch(`${BASE}/api/links/${custom}`, { method: "DELETE" });
check("토큰 없는 삭제 → 401", res.status === 401);
res = await fetch(`${BASE}/api/links/${custom}`, { method: "DELETE", headers: { authorization: `Bearer ${ADMIN}` } });
check("토큰 삭제 → 200", res.status === 200);
res = await fetch(`${BASE}/${custom}`, { redirect: "manual" });
check("삭제 후 리다이렉트 → 404", res.status === 404);

console.log(failed ? `\n${failed}개 실패` : "\n모두 통과");
process.exit(failed ? 1 : 0);
