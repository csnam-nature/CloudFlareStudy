// 사용자·그룹 화면 (관리자): 역할 바꾸기 · 사용 중지 · 그룹 넣고 빼기 · 미리 등록 · 그룹 만들기/이름 바꾸기/삭제
import { $, auth, esc, fmtTime, guardPage, isAccount, showMode, TOKEN_KEY, toast } from "./common.js";

let users = [];
let groups = [];

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { ...auth(), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    toast(data.error ?? `요청 실패 (${res.status})`);
    return null;
  }
  return data;
}

async function init() {
  const me = await showMode($("#mode"), auth());
  if (!me) return;
  if (!guardPage(me, "admin")) return;
  $("#modeNote").hidden = isAccount(me);
  if (me.authMode === "token") {
    $("#token").value = localStorage.getItem(TOKEN_KEY) ?? "";
    $("#tokenState").textContent = me.admin ? "✅ 관리자 확인됨" : "관리자 토큰을 넣어야 보입니다";
  }
  await load();
}

$("#tokenForm").addEventListener("submit", (e) => {
  e.preventDefault();
  localStorage.setItem(TOKEN_KEY, $("#token").value.trim());
  init();
});

async function load() {
  const [u, g] = await Promise.all([
    fetch("/api/users", { headers: auth() }).then((r) => (r.ok ? r.json() : null)),
    fetch("/api/groups", { headers: auth() }).then((r) => (r.ok ? r.json() : null)),
  ]);
  if (!u || !g) {
    $("#userRows").innerHTML = `<tr><td colspan="6" class="muted">불러오지 못했습니다(관리자만 볼 수 있습니다).</td></tr>`;
    $("#groupList").innerHTML = "";
    return;
  }
  users = u.users;
  groups = g.groups;
  $("#signupNote").textContent = u.autoSignup
    ? "Access 를 통과한 사람은 처음 접속할 때 '직원'으로 자동 등록됩니다. 미리 등록하면 첫 접속부터 정한 역할·그룹이 적용됩니다."
    : "자동 등록이 꺼져 있습니다(ACCESS_AUTO_SIGNUP=0). 여기서 미리 등록한 사람만 쓸 수 있습니다.";
  renderGroups();
  renderUsers();
}

function renderGroups() {
  $("#groupList").innerHTML = groups.length
    ? groups
        .map(
          (g) => `<span class="badge" style="padding:4px 10px">👥 ${esc(g.name)} <span class="muted">· ${g.members}명 · 문서 ${g.docs}개</span>
            <button type="button" data-gact="rename" data-id="${g.id}" title="이름 바꾸기">✏️</button>
            <button type="button" data-gact="delete" data-id="${g.id}" class="danger" title="삭제">✕</button></span>`,
        )
        .join("")
    : `<span class="muted">아직 그룹이 없습니다.</span>`;
}

const ROLE_OPTS = [
  ["admin", "관리자"],
  ["manager", "매니저"],
  ["employee", "직원"],
];

function renderUsers() {
  const active = users.filter((u) => u.active).length;
  $("#userSummary").textContent = `${users.length}명 (사용 중 ${active}명)`;
  if (!users.length) {
    $("#userRows").innerHTML = `<tr><td colspan="6" class="muted">아직 아무도 접속하지 않았습니다.</td></tr>`;
    return;
  }
  $("#userRows").innerHTML = users
    .map((u) => {
      const locked = u.fixedAdmin || u.me;
      const lockTip = u.fixedAdmin ? "ADMIN_EMAILS 에 적힌 고정 관리자" : "자기 자신";
      return `<tr class="${u.active ? "" : "inactive"}" data-email="${esc(u.email)}">
        <td><div class="name">${esc(u.email)}${u.fixedAdmin ? " 🔒" : ""}${u.me ? ' <span class="muted">(나)</span>' : ""}</div>
          <input type="text" class="uname" value="${esc(u.name)}" maxlength="60" placeholder="이름" style="margin-top:4px;width:100%" /></td>
        <td><select class="urole" ${locked ? `disabled title="${lockTip}"` : ""}>${ROLE_OPTS.map(
          ([v, l]) => `<option value="${v}" ${u.role === v ? "selected" : ""}>${l}</option>`,
        ).join("")}</select></td>
        <td><input type="checkbox" class="uactive" ${u.active ? "checked" : ""} ${locked ? `disabled title="${lockTip}"` : ""} /></td>
        <td><div class="chips">${
          groups.length
            ? groups
                .map((g) => `<label><input type="checkbox" class="ugroup" value="${g.id}" ${u.groups.includes(g.id) ? "checked" : ""} />${esc(g.name)}</label>`)
                .join("")
            : '<span class="muted">그룹 없음</span>'
        }</div></td>
        <td class="hide-sm muted">${u.lastSeen ? fmtTime(u.lastSeen) : "접속 전"}</td>
        <td>${locked ? "" : `<button type="button" class="udel danger" title="계정 삭제">삭제</button>`}</td>
      </tr>`;
    })
    .join("");
}

const enc = (email) => `/api/users/${encodeURIComponent(email)}`;

$("#userRows").addEventListener("change", async (e) => {
  const tr = e.target.closest("tr");
  const email = tr?.dataset.email;
  if (!email) return;
  const t = e.target;
  let body;
  if (t.classList.contains("urole")) body = { role: t.value };
  else if (t.classList.contains("uactive")) body = { active: t.checked };
  else if (t.classList.contains("uname")) body = { name: t.value };
  else if (t.classList.contains("ugroup")) body = { groups: [...tr.querySelectorAll(".ugroup:checked")].map((x) => Number(x.value)) };
  else return;
  if (await api("PATCH", enc(email), body)) toast(`저장했습니다: ${email}`);
  load();
});

$("#userRows").addEventListener("click", async (e) => {
  if (!e.target.classList.contains("udel")) return;
  const email = e.target.closest("tr").dataset.email;
  if (!confirm(`${email} 계정을 삭제할까요?\n자동 등록이 켜져 있으면 다음 접속 때 '직원'으로 다시 생깁니다. 막으려면 삭제 대신 '사용'을 끄세요.`)) return;
  if (await api("DELETE", enc(email))) toast("삭제했습니다.");
  load();
});

$("#userForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#newEmail").value.trim();
  if (!email) return toast("이메일을 적어 주세요.");
  if (await api("POST", "/api/users", { email, name: $("#newName").value, role: $("#newRole").value })) {
    toast(`등록했습니다: ${email}`);
    $("#newEmail").value = "";
    $("#newName").value = "";
  }
  load();
});

$("#groupForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#groupName").value.trim();
  if (!name) return;
  if (await api("POST", "/api/groups", { name })) ($("#groupName").value = ""), toast(`그룹을 만들었습니다: ${name}`);
  load();
});

$("#groupList").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const g = groups.find((x) => x.id === Number(btn.dataset.id));
  if (!g) return;
  if (btn.dataset.gact === "rename") {
    const name = prompt("그룹 이름", g.name);
    if (!name?.trim() || name.trim() === g.name) return;
    if (await api("PATCH", `/api/groups/${g.id}`, { name })) toast("이름을 바꿨습니다.");
  } else {
    if (!confirm(`'${g.name}' 그룹을 삭제할까요? 구성원 ${g.members}명의 소속이 풀립니다.`)) return;
    if (await api("DELETE", `/api/groups/${g.id}`)) toast("삭제했습니다.");
  }
  load();
});

init();
