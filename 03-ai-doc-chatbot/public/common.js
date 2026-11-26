// 채팅·관리 화면이 함께 쓰는 작은 도구들

/** HTML 특수문자를 바꿔 사용자 입력이 태그로 해석되지 않게 합니다. */
export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const $ = (sel, root = document) => root.querySelector(sel);

/** 관리자 토큰(문서 관리·설정 화면이 같이 씀). 이 브라우저의 localStorage 에만 저장합니다. */
export const TOKEN_KEY = "docChatbotAdminToken";
export const auth = () => ({ authorization: `Bearer ${localStorage.getItem(TOKEN_KEY) ?? ""}` });

let toastTimer;
/** 화면 아래에 잠깐 알림을 띄웁니다. */
export function toast(msg) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3000);
}

export const fmtBytes = (n) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

export const fmtTime = (sec) =>
  new Date(sec * 1000).toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

/** /api/me 로 현재 모드(연습/진짜)와 모델 이름을 읽어 배지에 표시합니다. */
export async function showMode(el, headers = {}) {
  try {
    const res = await fetch("/api/me", { headers });
    const me = await res.json();
    if (!res.ok) {
      // 로그인 만료(401)·사용 중지(403) 등: 이유를 배지에 보여 줍니다.
      el.textContent = res.status === 401 ? "로그인 필요" : "접근 불가";
      el.title = me.error ?? "";
      // 미등록·사용 중지 계정이면 다른 계정으로 바꿀 수 있게 로그아웃만 보여 줍니다.
      const who = $("#who");
      if (who && me.logoutUrl) {
        who.hidden = false;
        who.innerHTML = `<span class="who-name muted">${esc(me.error ?? "")}</span>` + logoutButton(me.logoutUrl);
      }
      toast(me.error ?? `서버 확인 실패 (${res.status})`);
      return null;
    }
    el.textContent = me.mock ? "연습 모드 (가짜 AI)" : `${me.chatModel.split("/").pop()}${me.gateway ? " · AI Gateway" : ""}`;
    el.title = me.mock ? "MOCK_AI=1: 로그인 없이 흐름만 확인하는 모드입니다." : `답변 ${me.chatModel} / 임베딩 ${me.embedModel}`;
    el.classList.toggle("mock", me.mock);
    // 화면 제목(관리 화면 설정의 "화면 제목")
    if (me.appTitle) {
      const t = $("#appTitle");
      if (t) t.textContent = me.appTitle;
      document.title = document.title.replace(/[^·]*$/, (m) => (document.title.includes("·") ? ` ${me.appTitle}` : me.appTitle));
    }
    applyUser(me);
    return me;
  } catch {
    el.textContent = "서버 확인 실패";
    return null;
  }
}

const RANK = { employee: 0, manager: 1, admin: 2 };
/** 계정 로그인(Access·개발용)인지. 관리자 토큰 방식이면 false */
export const isAccount = (me) => me?.authMode === "access" || me?.authMode === "dev";
export const hasRole = (me, min) => (RANK[me?.role] ?? 0) >= RANK[min];

/**
 * 머리줄에 "누구로 로그인했는지"와 로그아웃 버튼을 보여 주고, 역할에 맞지 않는 메뉴를 숨깁니다.
 *   data-role="manager|admin"  그 역할 이상에게만 보임(계정 로그인일 때만. 토큰 방식은 토큰을 넣으러 가야 하므로 그대로 둠)
 *   data-auth="token"          관리자 토큰 방식일 때만 보임(토큰 입력 칸)
 *
 * 로그아웃은 방식마다 다릅니다.
 *   access : Cloudflare Access 로그아웃(/cdn-cgi/access/logout) → 첫 화면으로 돌아오면 다시 로그인 화면
 *   token  : 이 브라우저에 저장한 관리자 토큰을 지움
 *   dev    : 로컬 개발용(.dev.vars 의 DEV_AUTH)이라 로그아웃이 없음
 */
function applyUser(me) {
  const account = isAccount(me);
  for (const el of document.querySelectorAll("[data-role]")) el.hidden = account && !hasRole(me, el.dataset.role);
  for (const el of document.querySelectorAll("[data-auth=token]")) el.hidden = me.authMode !== "token";
  const who = $("#who");
  if (!who) return;
  who.hidden = false;

  if (account && me.user) {
    const label = me.user.name ? `${me.user.name} (${me.user.email})` : me.user.email;
    who.innerHTML =
      `<span class="who-name" title="${esc(me.user.email)}">👤 ${esc(label)}</span> <span class="badge role-${esc(me.user.role)}">${esc(me.user.roleLabel)}</span>` +
      (me.authMode === "dev"
        ? ` <span class="badge mock" title="DEV_AUTH=1 (localhost 전용). 로그아웃 없이 x-dev-user-email·DEV_USER_EMAIL 로 사람을 바꿉니다.">개발용 로그인</span>`
        : "") +
      logoutButton(me.logoutUrl);
    return;
  }

  // Access 는 적용됐는데 Worker 설정값이 빠진 경우: 이메일은 보이지만 권한은 아직 예전 토큰 방식
  if (me.accessUnconfigured) {
    who.innerHTML =
      `<span class="who-name" title="${esc(me.accessUnconfigured.email)}">👤 ${esc(me.accessUnconfigured.email)}</span>` +
      ` <span class="badge failed" title="Access 로그인은 됐지만 Worker 에 ACCESS_TEAM_DOMAIN·ACCESS_AUD 가 없어 역할을 적용하지 못했습니다. wrangler.jsonc 에 넣고 다시 배포하세요(README 참고).">역할 미적용</span>` +
      logoutButton(me.logoutUrl);
    return;
  }

  // 관리자 토큰 방식(예전): 토큰을 저장했으면 "관리자 토큰", 아니면 익명
  if (localStorage.getItem(TOKEN_KEY)) {
    who.innerHTML =
      `<span class="who-name" title="이 브라우저에 저장된 관리자 토큰으로 접속 중">🔑 관리자 토큰</span>` +
      (me.admin ? ` <span class="badge role-admin">관리자</span>` : "") +
      ` <button type="button" class="logout" data-clear-token>로그아웃</button>`;
    who.querySelector("[data-clear-token]").addEventListener("click", () => {
      if (!confirm("이 브라우저에 저장된 관리자 토큰을 지우고 로그아웃할까요?")) return;
      localStorage.removeItem(TOKEN_KEY);
      location.reload();
    });
  } else {
    who.innerHTML = `<span class="who-name muted" title="로그인하지 않아 '전 직원' 공개 문서만 볼 수 있습니다">👤 로그인 안 함</span>`;
  }
}

/** Access 로그아웃 버튼(주소가 있을 때만) */
const logoutButton = (url) =>
  url ? ` <a class="logout" href="${esc(url)}" title="Cloudflare Access 에서 로그아웃합니다. 다시 들어오면 로그인(인증 코드)을 새로 해야 합니다.">로그아웃</a>` : "";

/** 권한이 없는 화면에 들어왔을 때 안내 문구를 보여 줍니다. 볼 수 있으면 true */
export function guardPage(me, min, mainSel = "main") {
  if (!me || !isAccount(me) || hasRole(me, min)) return true;
  const main = $(mainSel);
  if (main)
    main.innerHTML = `<section class="card"><h2>권한이 없습니다</h2><p class="muted">이 화면은 ${min === "admin" ? "관리자" : "매니저 이상"}만 쓸 수 있습니다. 필요하면 관리자에게 역할 변경을 요청하세요.</p><p><a href="/">← 채팅으로</a></p></section>`;
  return false;
}
