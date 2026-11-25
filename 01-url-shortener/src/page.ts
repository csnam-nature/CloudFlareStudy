// 루트(/)에서 보여 줄 아주 간단한 HTML 폼.
// 프런트엔드 프레임워크 없이 fetch 로 API 를 호출합니다.
// (정적 자산 호스팅은 미니 프로젝트 2 에서 다룹니다.)
export const HOME_HTML = /* html */ `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>URL 단축기</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 16px; }
  input, button { font-size: 16px; padding: 8px; }
  input { width: 100%; box-sizing: border-box; margin-bottom: 8px; }
  #result { margin-top: 16px; word-break: break-all; }
  table { border-collapse: collapse; width: 100%; margin-top: 24px; }
  td, th { border-bottom: 1px solid #ddd; padding: 6px; text-align: left; font-size: 14px; }
</style>
</head>
<body>
<h1>URL 단축기</h1>
<p>Cloudflare Workers + KV + D1 학습용 미니 프로젝트</p>
<form id="f">
  <input name="url" placeholder="https://긴-주소를-입력하세요" required>
  <input name="title" placeholder="제목 (선택)">
  <input name="code" placeholder="원하는 코드 (선택, 영문·숫자 3~32자)">
  <input name="ttlDays" type="number" min="1" placeholder="유효 기간(일, 선택)">
  <button>단축하기</button>
</form>
<div id="result"></div>
<h2>최근 링크</h2>
<table id="list"><thead><tr><th>코드</th><th>원래 URL</th><th>클릭</th></tr></thead><tbody></tbody></table>
<script>
const f = document.getElementById("f");
const result = document.getElementById("result");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

async function loadList() {
  const res = await fetch("/api/links");
  const { links } = await res.json();
  document.querySelector("#list tbody").innerHTML = links.map((l) =>
    "<tr><td><a href='/api/stats/" + esc(l.code) + "'>" + esc(l.code) + "</a></td><td>" +
    esc(l.url) + "</td><td>" + l.clicks + "</td></tr>").join("");
}

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
  result.innerHTML = res.ok
    ? "단축 URL: <a href='" + esc(data.shortUrl) + "' target='_blank'>" + esc(data.shortUrl) + "</a>"
    : "오류: " + esc(data.error);
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
