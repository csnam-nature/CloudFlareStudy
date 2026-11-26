// 왼쪽 사이드바: 폴더와 대화 목록 (ChatGPT·Claude 대화창처럼)
//
// - 폴더 만들기 · 이름 바꾸기 · 삭제(안의 대화는 "폴더 없음"으로 옮기거나 함께 삭제)
// - 대화 이름 바꾸기 · 다른 폴더로 옮기기(⋯ 메뉴 또는 끌어다 놓기) · 삭제
// - 폴더의 [+] 로 그 폴더 안에서 새 대화 시작
// 목록은 D1(/api/conversations)에 저장되고, 대화 내용은 대화마다 하나인 ChatAgent 에 있습니다.

import { $, esc, toast } from "./common.js";

const CLIENT_KEY = "docChatbotClient";
const COLLAPSED_KEY = "docChatbotCollapsed";

/** 이 브라우저의 id (로그인이 없어 "내 목록"을 이것으로 구분) */
export const clientId = (() => {
  let id = localStorage.getItem(CLIENT_KEY);
  if (!id) localStorage.setItem(CLIENT_KEY, (id = crypto.randomUUID()));
  return id;
})();

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api/conversations${path}`, {
    method,
    headers: { "x-client-id": clientId, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

/**
 * 사이드바를 만듭니다.
 * handlers: { onOpen(id), onNew(folderId), onDeleted(id) }
 */
export function createSidebar(handlers) {
  const tree = $("#tree");
  const search = $("#convSearch");
  let folders = [];
  let convs = [];
  let activeId = null;
  let pendingFolder = undefined; // 아직 질문 전인 새 대화가 어느 폴더에 있는지 (undefined = 없음)
  const collapsed = new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]"));

  async function load() {
    try {
      ({ folders, conversations: convs } = await api(""));
    } catch (e) {
      tree.innerHTML = `<div class="muted side-empty">목록을 불러오지 못했습니다: ${esc(e.message)}</div>`;
      return;
    }
    render();
  }

  function convItem(c) {
    return `<div class="conv${c.id === activeId ? " active" : ""}" draggable="true" data-conv="${esc(c.id)}" title="${esc(c.title)}">
      <span class="conv-title">${esc(c.title)}</span>
      <button type="button" class="more" data-conv-menu="${esc(c.id)}" title="메뉴">⋯</button></div>`;
  }

  function render() {
    const q = search.value.trim().toLowerCase();
    const shown = q ? convs.filter((c) => c.title.toLowerCase().includes(q)) : convs;
    const pendingRow = (fid) =>
      activeId === null && pendingFolder === fid ? `<div class="conv active pending"><span class="conv-title">새 대화</span></div>` : "";
    const folderHtml = folders
      .map((f) => {
        const list = shown.filter((c) => c.folderId === f.id);
        if (q && !list.length) return "";
        const open = q || !collapsed.has(f.id);
        return `<div class="folder" data-drop="${f.id}">
          <div class="folder-head" data-folder="${f.id}">
            <span class="caret">${open ? "▾" : "▸"}</span>
            <span class="folder-name">📁 ${esc(f.name)}</span>
            <span class="count">${convs.filter((c) => c.folderId === f.id).length}</span>
            <button type="button" class="more" data-folder-new="${f.id}" title="이 폴더에서 새 대화">＋</button>
            <button type="button" class="more" data-folder-menu="${f.id}" title="메뉴">⋯</button>
          </div>
          ${open ? `<div class="folder-body">${pendingRow(f.id)}${list.map(convItem).join("") || (pendingFolder === f.id && activeId === null ? "" : '<div class="muted side-empty">비어 있음 · 대화를 끌어다 놓으세요</div>')}</div>` : ""}
        </div>`;
      })
      .join("");
    const loose = shown.filter((c) => c.folderId == null);
    tree.innerHTML = `${folderHtml}
      <div class="folder loose" data-drop="">
        <div class="folder-head plain"><span class="folder-name">대화${folders.length ? " (폴더 없음)" : ""}</span></div>
        <div class="folder-body">${pendingRow(null)}${loose.map(convItem).join("") || (q ? '<div class="muted side-empty">찾는 대화가 없습니다</div>' : "")}</div>
      </div>`;
  }

  // ── 클릭 ──
  tree.addEventListener("click", (e) => {
    const t = e.target.closest("[data-conv-menu],[data-folder-menu],[data-folder-new],[data-folder],[data-conv]");
    if (!t) return;
    if (t.dataset.convMenu) return convMenu(t, t.dataset.convMenu);
    if (t.dataset.folderMenu) return folderMenu(t, Number(t.dataset.folderMenu));
    if (t.dataset.folderNew) return handlers.onNew(Number(t.dataset.folderNew));
    if (t.dataset.folder) {
      const id = Number(t.dataset.folder);
      collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id);
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
      return render();
    }
    if (t.dataset.conv) handlers.onOpen(t.dataset.conv);
  });
  search.addEventListener("input", render);

  // ── 끌어다 놓기로 폴더 옮기기 ──
  tree.addEventListener("dragstart", (e) => {
    const c = e.target.closest("[data-conv]");
    if (c) e.dataTransfer.setData("text/conv", c.dataset.conv);
  });
  tree.addEventListener("dragover", (e) => {
    const f = e.target.closest("[data-drop]");
    if (!f || !e.dataTransfer.types.includes("text/conv")) return;
    e.preventDefault();
    for (const x of tree.querySelectorAll(".drop-over")) x.classList.remove("drop-over");
    f.classList.add("drop-over");
  });
  tree.addEventListener("dragleave", (e) => e.target.closest("[data-drop]")?.classList.remove("drop-over"));
  tree.addEventListener("drop", (e) => {
    const f = e.target.closest("[data-drop]");
    const id = e.dataTransfer.getData("text/conv");
    for (const x of tree.querySelectorAll(".drop-over")) x.classList.remove("drop-over");
    if (!f || !id) return;
    e.preventDefault();
    move(id, f.dataset.drop === "" ? null : Number(f.dataset.drop));
  });

  // ── 작은 메뉴 ──
  const menu = $("#sideMenu");
  function openMenu(anchor, items) {
    menu.innerHTML = items
      .map((it, i) => (it === "-" ? "<hr />" : it.label ? `<button type="button" data-i="${i}" class="${it.danger ? "danger" : ""}" ${it.disabled ? "disabled" : ""}>${esc(it.label)}</button>` : `<div class="menu-label">${esc(it.title)}</div>`))
      .join("");
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${Math.min(r.bottom + 4, innerHeight - 20)}px`;
    menu.style.left = `${Math.min(r.left, innerWidth - 220)}px`;
    menu.hidden = false;
    menu.onclick = (e) => {
      const b = e.target.closest("button[data-i]");
      if (!b) return;
      menu.hidden = true;
      items[Number(b.dataset.i)].run();
    };
    // 화면 아래로 넘치면 위로 올림
    const mr = menu.getBoundingClientRect();
    if (mr.bottom > innerHeight - 8) menu.style.top = `${Math.max(8, r.top - mr.height - 4)}px`;
  }
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !e.target.closest(".more")) menu.hidden = true;
  });

  function convMenu(anchor, id) {
    const c = convs.find((x) => x.id === id);
    if (!c) return;
    openMenu(anchor, [
      { label: "이름 바꾸기", run: () => renameConv(c) },
      "-",
      { title: "폴더로 옮기기" },
      ...folders.map((f) => ({ label: `📁 ${f.name}`, disabled: c.folderId === f.id, run: () => move(id, f.id) })),
      { label: "폴더 없음", disabled: c.folderId == null, run: () => move(id, null) },
      { label: "＋ 새 폴더 만들어 옮기기", run: async () => (await newFolder()) && move(id, folders.at(-1).id) },
      "-",
      { label: "삭제", danger: true, run: () => deleteConv(c) },
    ]);
  }

  function folderMenu(anchor, id) {
    const f = folders.find((x) => x.id === id);
    if (!f) return;
    openMenu(anchor, [
      { label: "이 폴더에서 새 대화", run: () => handlers.onNew(id) },
      { label: "이름 바꾸기", run: () => renameFolder(f) },
      "-",
      { label: "폴더만 삭제 (대화는 남김)", danger: true, run: () => deleteFolder(f, false) },
      { label: "폴더와 대화 모두 삭제", danger: true, run: () => deleteFolder(f, true) },
    ]);
  }

  // ── 동작 ──
  async function newFolder() {
    const name = prompt("새 폴더 이름");
    if (!name?.trim()) return false;
    try {
      const f = await api("/folders", { method: "POST", body: { name } });
      folders.push(f);
      render();
      return true;
    } catch (e) {
      toast(e.message);
      return false;
    }
  }

  async function renameFolder(f) {
    const name = prompt("폴더 이름", f.name);
    if (!name?.trim() || name === f.name) return;
    try {
      await api(`/folders/${f.id}`, { method: "PATCH", body: { name } });
      f.name = name.trim();
      render();
    } catch (e) {
      toast(e.message);
    }
  }

  async function deleteFolder(f, withConversations) {
    const n = convs.filter((c) => c.folderId === f.id).length;
    const msg = withConversations
      ? `"${f.name}" 폴더와 안의 대화 ${n}개를 모두 삭제할까요? 되돌릴 수 없습니다.`
      : `"${f.name}" 폴더를 삭제할까요? 안의 대화 ${n}개는 "폴더 없음"으로 옮겨집니다.`;
    if (!confirm(msg)) return;
    try {
      await api(`/folders/${f.id}${withConversations ? "?withConversations=1" : ""}`, { method: "DELETE" });
      const removed = withConversations ? convs.filter((c) => c.folderId === f.id).map((c) => c.id) : [];
      folders = folders.filter((x) => x.id !== f.id);
      convs = withConversations ? convs.filter((c) => c.folderId !== f.id) : convs.map((c) => (c.folderId === f.id ? { ...c, folderId: null } : c));
      if (pendingFolder === f.id) pendingFolder = null;
      render();
      for (const id of removed) handlers.onDeleted(id);
    } catch (e) {
      toast(e.message);
    }
  }

  async function renameConv(c) {
    const title = prompt("대화 이름", c.title);
    if (!title?.trim() || title === c.title) return;
    try {
      await api(`/${c.id}`, { method: "PATCH", body: { title } });
      c.title = title.trim();
      render();
    } catch (e) {
      toast(e.message);
    }
  }

  async function move(id, folderId) {
    const c = convs.find((x) => x.id === id);
    if (!c || c.folderId === folderId) return;
    try {
      await api(`/${id}`, { method: "PATCH", body: { folderId } });
      c.folderId = folderId;
      if (folderId != null) collapsed.delete(folderId);
      render();
      toast(folderId == null ? "폴더 밖으로 옮겼습니다" : `"${folders.find((f) => f.id === folderId)?.name}" 폴더로 옮겼습니다`);
    } catch (e) {
      toast(e.message);
    }
  }

  async function deleteConv(c) {
    if (!confirm(`"${c.title}" 대화를 삭제할까요? 질문·답변 기록도 지워집니다.`)) return;
    try {
      await api(`/${c.id}`, { method: "DELETE" });
      convs = convs.filter((x) => x.id !== c.id);
      render();
      handlers.onDeleted(c.id);
    } catch (e) {
      toast(e.message);
    }
  }

  $("#newFolder").onclick = () => newFolder();
  $("#newChat").onclick = () => handlers.onNew(null);

  return {
    load,
    clientId,
    has: (id) => convs.some((c) => c.id === id),
    mostRecent: () => convs[0]?.id ?? null,
    folderName: (id) => folders.find((f) => f.id === id)?.name ?? null,
    /** 지금 열린 대화(없으면 null = 질문 전 새 대화, 그때 folderId 는 새 대화의 폴더) */
    setActive(id, folderId) {
      activeId = id;
      pendingFolder = id ? undefined : folderId ?? null;
      if (pendingFolder != null) collapsed.delete(pendingFolder);
      render();
    },
    /** 첫 질문을 보낼 때 대화를 목록에 등록 */
    async create(id, folderId, title) {
      const c = await api("", { method: "POST", body: { id, folderId, title: title.replace(/\s+/g, " ").slice(0, 60) } });
      convs.unshift(c);
      return c;
    },
    /** 질문을 보냈으면 목록 맨 위로 */
    touch(id) {
      const i = convs.findIndex((c) => c.id === id);
      if (i > 0) convs.unshift(...convs.splice(i, 1));
      render();
    },
  };
}
