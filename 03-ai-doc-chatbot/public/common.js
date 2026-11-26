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
 * 머리줄에 "누구로 로그인했는지"를 보여 주고, 역할에 맞지 않는 메뉴를 숨깁니다.
 *   data-role="manager|admin"  그 역할 이상에게만 보임(계정 로그인일 때만. 토큰 방식은 토큰을 넣으러 가야 하므로 그대로 둠)
 *   data-auth="token"          관리자 토큰 방식일 때만 보임(토큰 입력 칸)
 */
function applyUser(me) {
  const account = isAccount(me);
  for (const el of document.querySelectorAll("[data-role]")) el.hidden = account && !hasRole(me, el.dataset.role);
  for (const el of document.querySelectorAll("[data-auth=token]")) el.hidden = me.authMode !== "token";
  const who = $("#who");
  if (!who) return;
  if (!account || !me.user) {
    who.hidden = true;
    return;
  }
  who.hidden = false;
  const label = me.user.name ? `${me.user.name} (${me.user.email})` : me.user.email;
  who.innerHTML =
    `<span class="who-name" title="${esc(me.user.email)}">👤 ${esc(label)}</span> <span class="badge role-${esc(me.user.role)}">${esc(me.user.roleLabel)}</span>` +
    (me.authMode === "dev" ? ` <span class="badge mock" title="DEV_AUTH=1 (localhost 전용)">개발용 로그인</span>` : "") +
    (me.logoutUrl ? ` <a href="${esc(me.logoutUrl)}">로그아웃</a>` : "");
}

/** 권한이 없는 화면에 들어왔을 때 안내 문구를 보여 줍니다. 볼 수 있으면 true */
export function guardPage(me, min, mainSel = "main") {
  if (!me || !isAccount(me) || hasRole(me, min)) return true;
  const main = $(mainSel);
  if (main)
    main.innerHTML = `<section class="card"><h2>권한이 없습니다</h2><p class="muted">이 화면은 ${min === "admin" ? "관리자" : "매니저 이상"}만 쓸 수 있습니다. 필요하면 관리자에게 역할 변경을 요청하세요.</p><p><a href="/">← 채팅으로</a></p></section>`;
  return false;
}
