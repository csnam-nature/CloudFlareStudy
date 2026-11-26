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
    const me = await (await fetch("/api/me", { headers })).json();
    el.textContent = me.mock ? "연습 모드 (가짜 AI)" : `${me.chatModel.split("/").pop()}${me.gateway ? " · AI Gateway" : ""}`;
    el.title = me.mock ? "MOCK_AI=1: 로그인 없이 흐름만 확인하는 모드입니다." : `답변 ${me.chatModel} / 임베딩 ${me.embedModel}`;
    el.classList.toggle("mock", me.mock);
    // 화면 제목(관리 화면 설정의 "화면 제목")
    if (me.appTitle) {
      const t = $("#appTitle");
      if (t) t.textContent = me.appTitle;
      document.title = document.title.replace(/[^·]*$/, (m) => (document.title.includes("·") ? ` ${me.appTitle}` : me.appTitle));
    }
    return me;
  } catch {
    el.textContent = "서버 확인 실패";
    return null;
  }
}
