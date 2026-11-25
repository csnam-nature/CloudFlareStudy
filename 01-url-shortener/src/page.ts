// 루트(/)에서 보여 줄 간단한 HTML 화면.
// 프런트엔드 프레임워크 없이 fetch 로 API 를 호출합니다.
// (정적 자산 호스팅은 미니 프로젝트 2 에서 다룹니다.)
//
// 기능
//  - 링크 생성 폼
//  - 생성된 링크 목록: 코드 클릭 → 단축 URL 열기(클릭 수 +1), 통계 / 수정 / 삭제 버튼
//  - 수정·삭제는 관리자 토큰(ADMIN_TOKEN)이 필요합니다. 화면 위쪽 "관리자 토큰" 칸에 한 번 입력하면
//    이 브라우저의 localStorage 에 저장되어 계속 쓰입니다. (공용 PC 에서는 "지우기"를 누르세요)
//  - 목록 자동 새로고침: 탭 복귀, 뒤로 가기 복원, 화면이 보이는 동안 15초마다 (수정 중에는 멈춤)
export const HOME_HTML = /* html */ `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>URL 단축기</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 900px; margin: 32px auto; padding: 0 16px; color: #222; }
  input, button { font-size: 15px; padding: 7px 9px; }
  form input { width: 100%; box-sizing: border-box; margin-bottom: 8px; }
  button { cursor: pointer; border: 1px solid #bbb; background: #f6f6f6; border-radius: 4px; }
  button.danger { color: #b00020; border-color: #e3a0a8; }
  .muted { color: #777; font-size: 13px; }
  #result, #msg { margin-top: 12px; word-break: break-all; }
  #admin { margin: 16px 0; padding: 10px 12px; background: #fafafa; border: 1px solid #eee; border-radius: 6px; }
  #admin input { width: 260px; }

  /* 목록 표: table-layout: fixed 로 열 너비를 고정하고, 긴 URL 은 말줄임(…) 처리해서
     클릭 수·버튼 열이 항상 보이게 합니다. 전체 URL 은 마우스를 올리면 보입니다. */
  table { border-collapse: collapse; width: 100%; margin-top: 12px; table-layout: fixed; }
  th, td { border-bottom: 1px solid #ddd; padding: 6px; text-align: left; font-size: 14px; vertical-align: middle; }
  th.code, td.code { width: 90px; }
  th.clicks, td.clicks { width: 56px; text-align: right; }
  th.actions, td.actions { width: 170px; }
  td.target { overflow: hidden; }
  td.target .title { font-weight: 600; }
  td.target .url { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #555; }
  td.actions button { padding: 3px 7px; font-size: 13px; }
  td.target input { width: 100%; box-sizing: border-box; margin: 2px 0; font-size: 13px; padding: 4px 6px; }
  #stats { margin-top: 16px; padding: 12px; border: 1px solid #ddd; border-radius: 6px; display: none; }
  #stats table { table-layout: auto; width: auto; margin-top: 6px; }
</style>
</head>
<body>
<h1>URL 단축기</h1>
<p class="muted">Cloudflare Workers + KV + D1 학습용 미니 프로젝트</p>

<form id="f">
  <input name="url" placeholder="https://긴-주소를-입력하세요" required>
  <input name="title" placeholder="제목 (선택)">
  <input name="code" placeholder="원하는 코드 (선택, 영문·숫자 3~32자)">
  <input name="ttlDays" type="number" min="1" placeholder="유효 기간(일, 선택)">
  <button>단축하기</button>
</form>
<div id="result"></div>

<div id="admin">
  <label>관리자 토큰 <input id="token" type="password" placeholder="수정·삭제할 때 필요 (ADMIN_TOKEN)"></label>
  <button type="button" id="saveToken">저장</button>
  <button type="button" id="clearToken">지우기</button>
  <span id="tokenState" class="muted"></span>
</div>

<h2>생성된 링크</h2>
<div id="msg" class="muted"></div>
<table id="list">
  <thead><tr><th class="code">코드</th><th>제목 / 원래 URL</th><th class="clicks">클릭</th><th class="actions">관리</th></tr></thead>
  <tbody></tbody>
</table>
<div id="stats"></div>

<script>
const $ = (sel) => document.querySelector(sel);
const TOKEN_KEY = "urlShortenerAdminToken";
let editing = null; // 수정 중인 코드. 수정 중에는 자동 새로고침을 멈춥니다.

// DOM 요소를 만드는 작은 도우미. textContent 를 쓰므로 HTML 이스케이프가 필요 없습니다.
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const ch of children) node.append(ch);
  return node;
}

// ── 관리자 토큰 (localStorage) ────────────────────────────
const getToken = () => localStorage.getItem(TOKEN_KEY) || "";
function showTokenState() {
  $("#tokenState").textContent = getToken() ? "저장됨" : "저장된 토큰 없음";
}
$("#saveToken").onclick = () => {
  localStorage.setItem(TOKEN_KEY, $("#token").value.trim());
  $("#token").value = "";
  showTokenState();
};
$("#clearToken").onclick = () => { localStorage.removeItem(TOKEN_KEY); showTokenState(); };
showTokenState();

// 관리자 API 호출: Authorization 헤더를 붙이고, 401 이면 안내 문구를 보여 줍니다.
async function adminFetch(path, options) {
  if (!getToken()) { $("#msg").textContent = "먼저 관리자 토큰을 저장하세요."; return null; }
  const res = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", authorization: "Bearer " + getToken() },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { $("#msg").textContent = "오류: " + (data.error || res.status); return null; }
  return data;
}

// ── 목록 ─────────────────────────────────────────────────
async function loadList() {
  if (editing) return;
  const res = await fetch("/api/links");
  const { links } = await res.json();
  const tbody = $("#list tbody");
  tbody.replaceChildren(...links.map(renderRow));
  if (links.length === 0) tbody.append(el("tr", {}, el("td", { colSpan: 4, className: "muted", textContent: "아직 만든 링크가 없습니다." })));
}

function renderRow(l) {
  const shortUrl = location.origin + "/" + l.code;

  // 코드를 누르면 새 탭에서 단축 URL 로 이동합니다 → 리다이렉트되면서 클릭 수가 1 올라갑니다.
  // 돌아오면 visibilitychange 로 목록이 갱신되지만, 같은 탭에 머무는 경우를 위해 잠시 뒤 한 번 더 불러옵니다.
  const link = el("a", { href: shortUrl, target: "_blank", rel: "noopener", textContent: l.code, title: shortUrl });
  link.onclick = () => setTimeout(loadList, 1500);

  const target = el("td", { className: "target" });
  if (l.title) target.append(el("div", { className: "title", textContent: l.title }));
  target.append(el("span", { className: "url", textContent: l.url, title: l.url }));

  const statsBtn = el("button", { type: "button", textContent: "통계", onclick: () => showStats(l.code) });
  const editBtn = el("button", { type: "button", textContent: "수정", onclick: () => startEdit(tr, l) });
  const delBtn = el("button", { type: "button", className: "danger", textContent: "삭제", onclick: () => removeLink(l.code) });

  const tr = el("tr", {},
    el("td", { className: "code" }, link),
    target,
    el("td", { className: "clicks", textContent: String(l.clicks) }),
    el("td", { className: "actions" }, statsBtn, " ", editBtn, " ", delBtn),
  );
  return tr;
}

// ── 수정 (행 안에서 바로 편집) ─────────────────────────────
function startEdit(tr, l) {
  editing = l.code;
  const urlInput = el("input", { value: l.url, placeholder: "원래 URL" });
  const titleInput = el("input", { value: l.title || "", placeholder: "제목 (비우면 삭제)" });
  tr.children[1].replaceChildren(titleInput, urlInput);

  const save = el("button", { type: "button", textContent: "저장" });
  const cancel = el("button", { type: "button", textContent: "취소" });
  save.onclick = async () => {
    const data = await adminFetch("/api/links/" + encodeURIComponent(l.code), {
      method: "PATCH",
      body: JSON.stringify({ url: urlInput.value.trim(), title: titleInput.value.trim() }),
    });
    if (!data) return; // 오류 메시지는 adminFetch 가 표시
    $("#msg").textContent = l.code + " 수정 완료 (다른 지역 반영까지 1~2분 걸릴 수 있음)";
    editing = null;
    loadList();
  };
  cancel.onclick = () => { editing = null; loadList(); };
  tr.children[3].replaceChildren(save, " ", cancel);
  urlInput.focus();
}

// ── 삭제 ─────────────────────────────────────────────────
async function removeLink(code) {
  if (!confirm(code + " 링크를 삭제할까요? 클릭 기록도 함께 지워집니다.")) return;
  const data = await adminFetch("/api/links/" + encodeURIComponent(code), { method: "DELETE" });
  if (!data) return;
  $("#msg").textContent = code + " 삭제 완료";
  $("#stats").style.display = "none";
  loadList();
}

// ── 통계 ─────────────────────────────────────────────────
async function showStats(code) {
  const res = await fetch("/api/stats/" + encodeURIComponent(code));
  const s = await res.json();
  const box = $("#stats");
  if (!res.ok) { box.replaceChildren(el("p", { textContent: "오류: " + s.error })); box.style.display = "block"; return; }

  const table = (head, rows, key) => el("table", {},
    el("tr", {}, el("th", { textContent: head }), el("th", { textContent: "클릭" })),
    ...rows.map((r) => el("tr", {}, el("td", { textContent: r[key] }), el("td", { textContent: String(r.clicks) }))));

  box.replaceChildren(
    el("strong", { textContent: code + " 통계 · 총 " + s.totalClicks + "회" }),
    " ", el("button", { type: "button", textContent: "닫기", onclick: () => (box.style.display = "none") }),
    el("div", { style: "display:flex; gap:32px; flex-wrap:wrap" },
      el("div", {}, table("국가", s.byCountry, "country")),
      el("div", {}, table("리퍼러", s.byReferer, "referer")),
      el("div", {}, table("날짜(UTC)", s.byDay, "day"))),
  );
  box.style.display = "block";
}

// ── 생성 폼 ──────────────────────────────────────────────
const f = $("#f");
f.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(f));
  if (!body.code) delete body.code;
  if (!body.title) delete body.title;
  if (body.ttlDays) body.ttlDays = Number(body.ttlDays); else delete body.ttlDays;
  const res = await fetch("/api/links", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  const result = $("#result");
  if (res.ok) {
    result.replaceChildren("단축 URL: ", el("a", { href: data.shortUrl, target: "_blank", rel: "noopener", textContent: data.shortUrl }));
    f.reset();
  } else {
    result.textContent = "오류: " + data.error;
  }
  loadList();
});

loadList();

// 목록 자동 새로고침
// - 다른 탭(예: 단축 URL 로 이동한 탭)에서 돌아오면 즉시 다시 불러옵니다.
// - 뒤로 가기로 돌아온 경우(브라우저가 페이지를 캐시에서 복원)에도 다시 불러옵니다.
// - 화면이 보이는 동안에는 15초마다 갱신합니다. 숨겨진 탭에서는 요청하지 않아 D1 읽기 한도를 아낍니다.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") loadList();
});
window.addEventListener("pageshow", (e) => { if (e.persisted) loadList(); });
setInterval(() => {
  if (document.visibilityState === "visible") loadList();
}, 15000);
</script>
</body>
</html>`;
