// 사진 갤러리 화면 (빌드 도구 없이 쓰는 순수 JavaScript 모듈)
//
// 서버 API 는 src/*.ts 에 있고, 이 파일은 fetch 로 부르기만 합니다.
// 사용자 입력은 모두 textContent 로 넣어 HTML 로 해석되지 않게 합니다(XSS 방지).

import { readTakenAt } from "./exif.js";

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "photo-gallery.adminToken";

const state = {
  token: localStorage.getItem(TOKEN_KEY) ?? "",
  admin: false,
  maxMb: 20,
  albums: [],
  total: 0,
  unassigned: 0,
  album: "", // "" = 전체, "none" = 앨범 없음, 숫자 문자열 = 앨범 id
  q: "",
  photos: [],
  nextCursor: null,
  loading: false,
  viewer: -1, // 라이트박스에 열린 사진의 인덱스
  queue: [], // 업로드 대기 목록
};

// ─────────────────────────────────────────────────────────────
// 공통: API 호출
// ─────────────────────────────────────────────────────────────
async function api(path, { method = "GET", json, headers = {} } = {}) {
  const h = { ...headers };
  if (state.token) h.authorization = `Bearer ${state.token}`;
  if (json !== undefined) h["content-type"] = "application/json";
  const res = await fetch(path, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `요청 실패 (${res.status})`);
  return data;
}

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) node.append(c);
  return node;
};

const fmtDate = (sec) => (sec ? new Date(sec * 1000).toLocaleString("ko-KR") : "-");
const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const pad = (n) => String(n).padStart(2, "0");
/** Unix 초 → <input type="datetime-local"> 값 (브라우저 시간대) */
function toLocalInput(sec) {
  if (!sec) return "";
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const fromLocalInput = (v) => (v ? Math.floor(new Date(v).getTime() / 1000) : null);
const setStatus = (text) => ($("status").textContent = text);

// ─────────────────────────────────────────────────────────────
// 관리자 토큰
// ─────────────────────────────────────────────────────────────
async function checkAdmin() {
  try {
    const me = await api("/api/me");
    state.admin = me.admin;
    state.maxMb = me.maxUploadMb;
  } catch {
    state.admin = false;
  }
  document.body.classList.toggle("admin", state.admin);
  $("adminBadge").hidden = !state.admin;
  $("maxMb").textContent = state.maxMb;
  $("tokenInput").value = state.token ? "••••••••" : "";
  updateAlbumButtons();
}

$("tokenForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = $("tokenInput").value.trim();
  if (!v || v === "••••••••") return;
  state.token = v;
  localStorage.setItem(TOKEN_KEY, v);
  await checkAdmin();
  setStatus(state.admin ? "관리자 모드입니다. 업로드·수정·삭제를 할 수 있습니다." : "토큰이 맞지 않습니다.");
});
$("tokenClear").addEventListener("click", async () => {
  state.token = "";
  localStorage.removeItem(TOKEN_KEY);
  await checkAdmin();
  setStatus("관리자 토큰을 지웠습니다.");
});

// ─────────────────────────────────────────────────────────────
// 앨범
// ─────────────────────────────────────────────────────────────
async function loadAlbums() {
  const data = await api("/api/albums");
  state.albums = data.albums;
  state.total = data.total;
  state.unassigned = data.unassigned;
  // 지금 보고 있던 앨범이 지워졌으면 전체로
  if (state.album && state.album !== "none" && !state.albums.some((a) => String(a.id) === state.album)) state.album = "";
  renderAlbums();
}

function renderAlbums() {
  const tab = (key, label, count) =>
    el("button", {
      type: "button",
      className: state.album === key ? "active" : "",
      onclick: () => selectAlbum(key),
    }, label, el("span", { className: "count", textContent: count }));

  $("albumTabs").replaceChildren(
    tab("", "전체", state.total),
    ...state.albums.map((a) => tab(String(a.id), a.name, a.photoCount)),
    ...(state.unassigned ? [tab("none", "앨범 없음", state.unassigned)] : []),
  );

  // 업로드·수정 화면의 앨범 선택 상자
  const options = () => [
    el("option", { value: "", textContent: "(앨범 없음)" }),
    ...state.albums.map((a) => el("option", { value: String(a.id), textContent: a.name })),
  ];
  const up = $("uploadAlbum");
  const keep = up.value;
  up.replaceChildren(...options());
  up.value = state.album && state.album !== "none" ? state.album : keep && state.albums.some((a) => String(a.id) === keep) ? keep : "";
  const editSelect = $("editForm").albumId;
  const editValue = editSelect.value; // 옵션을 다시 그리면 선택값이 사라지므로 보관했다가 되돌립니다.
  editSelect.replaceChildren(...options());
  editSelect.value = editValue;
  updateAlbumButtons();
}

function updateAlbumButtons() {
  const isAlbum = state.album !== "" && state.album !== "none";
  $("albumRename").hidden = !isAlbum;
  $("albumDelete").hidden = !isAlbum;
}

function selectAlbum(key) {
  state.album = key;
  renderAlbums();
  loadPhotos(true);
}

const currentAlbum = () => state.albums.find((a) => String(a.id) === state.album);

$("albumNew").addEventListener("click", async () => {
  const name = prompt("새 앨범 이름");
  if (!name?.trim()) return;
  try {
    const created = await api("/api/albums", { method: "POST", json: { name } });
    state.album = String(created.id);
    await loadAlbums();
    await loadPhotos(true);
    setStatus(`앨범 "${created.name}" 을 만들었습니다.`);
  } catch (e) {
    setStatus(e.message);
  }
});

$("albumRename").addEventListener("click", async () => {
  const album = currentAlbum();
  if (!album) return;
  const name = prompt("앨범 이름 바꾸기", album.name);
  if (!name?.trim() || name.trim() === album.name) return;
  try {
    await api(`/api/albums/${album.id}`, { method: "PATCH", json: { name } });
    await loadAlbums();
    setStatus("앨범 이름을 바꿨습니다.");
  } catch (e) {
    setStatus(e.message);
  }
});

$("albumDelete").addEventListener("click", async () => {
  const album = currentAlbum();
  if (!album) return;
  if (!confirm(`앨범 "${album.name}" 을 지울까요?\n안의 사진 ${album.photoCount}장은 지워지지 않고 "앨범 없음"으로 옮겨집니다.`)) return;
  try {
    await api(`/api/albums/${album.id}`, { method: "DELETE" });
    state.album = "";
    await loadAlbums();
    await loadPhotos(true);
    setStatus("앨범을 지웠습니다.");
  } catch (e) {
    setStatus(e.message);
  }
});

// ─────────────────────────────────────────────────────────────
// 사진 목록 (커서 페이지 나눔)
// ─────────────────────────────────────────────────────────────
async function loadPhotos(reset = false) {
  if (state.loading) return;
  state.loading = true;
  if (reset) {
    state.photos = [];
    state.nextCursor = null;
  }
  const params = new URLSearchParams({ limit: "30" });
  if (state.album) params.set("album", state.album);
  if (state.q) params.set("q", state.q);
  if (state.nextCursor) params.set("cursor", state.nextCursor);
  try {
    const data = await api(`/api/photos?${params}`);
    state.photos.push(...data.photos);
    state.nextCursor = data.nextCursor;
    renderGrid();
    const EMPTY = ["검색 결과가 없습니다.", "아직 사진이 없습니다."];
    if (state.photos.length === 0) setStatus(state.q ? EMPTY[0] : EMPTY[1]);
    else if (EMPTY.includes($("status").textContent)) setStatus("");
  } catch (e) {
    setStatus(e.message);
  } finally {
    state.loading = false;
  }
}

function renderGrid() {
  $("grid").replaceChildren(
    ...state.photos.map((p, i) =>
      el("button", { type: "button", className: "card", title: p.title ?? p.filename, onclick: () => openViewer(i) },
        el("img", {
          // 화면 크기에 맞는 썸네일을 브라우저가 고르게 합니다. (200·400 은 서버가 허용한 폭)
          src: `/img/${p.id}?w=400`,
          srcset: `/img/${p.id}?w=200 200w, /img/${p.id}?w=400 400w`,
          sizes: "(max-width: 600px) 50vw, 240px",
          loading: "lazy",
          alt: p.title ?? p.filename,
        }),
        el("span", { className: "cap", textContent: p.title ?? p.filename }),
      ),
    ),
  );
  $("loadMore").hidden = !state.nextCursor;
}

$("loadMore").addEventListener("click", () => loadPhotos());

let searchTimer;
$("search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = e.target.value.trim();
    loadPhotos(true);
  }, 300);
});

// ─────────────────────────────────────────────────────────────
// 크게 보기 (라이트박스) + 수정·삭제
// ─────────────────────────────────────────────────────────────
const viewer = $("viewer");

function openViewer(index) {
  state.viewer = index;
  renderViewer();
  if (!viewer.open) viewer.showModal();
}

function renderViewer() {
  const p = state.photos[state.viewer];
  if (!p) return viewer.close();
  $("viewerImg").src = `/img/${p.id}?w=1600`;
  $("viewerImg").alt = p.title ?? p.filename;
  $("infoTitle").textContent = p.title ?? p.filename;
  const rows = [
    ["앨범", p.albumName ?? "(앨범 없음)"],
    ["촬영일", fmtDate(p.takenAt)],
    ["올린 날", fmtDate(p.createdAt)],
    ["크기", p.width ? `${p.width} × ${p.height}` : "-"],
    ["용량", fmtSize(p.size)],
    ["형식", p.contentType],
    ["파일", p.filename],
  ];
  $("infoList").replaceChildren(...rows.flatMap(([k, v]) => [el("dt", { textContent: k }), el("dd", { textContent: v })]));
  $("openOriginal").href = `/img/${p.id}/original`;
  $("downloadOriginal").href = `/img/${p.id}/original?download=1`;
  $("prevBtn").disabled = state.viewer === 0;
  $("nextBtn").disabled = state.viewer >= state.photos.length - 1 && !state.nextCursor;

  const f = $("editForm");
  f.title.value = p.title ?? "";
  f.albumId.value = p.albumId ? String(p.albumId) : "";
  f.takenAt.value = toLocalInput(p.takenAt);
  $("editMsg").textContent = "";
}

async function move(delta) {
  const next = state.viewer + delta;
  if (next < 0) return;
  if (next >= state.photos.length) {
    if (!state.nextCursor) return;
    await loadPhotos(); // 마지막 사진에서 "다음" → 다음 페이지를 불러와 이어서 봅니다.
    if (next >= state.photos.length) return;
  }
  state.viewer = next;
  renderViewer();
}

$("prevBtn").addEventListener("click", () => move(-1));
$("nextBtn").addEventListener("click", () => move(1));
$("closeBtn").addEventListener("click", () => viewer.close());
viewer.addEventListener("click", (e) => e.target === viewer && viewer.close()); // 바깥 클릭으로 닫기
viewer.addEventListener("keydown", (e) => {
  if (e.target.closest("form")) return; // 입력 중에는 화살표를 가로채지 않음
  if (e.key === "ArrowLeft") move(-1);
  if (e.key === "ArrowRight") move(1);
});

$("editForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const p = state.photos[state.viewer];
  const f = e.target;
  try {
    const updated = await api(`/api/photos/${p.id}`, {
      method: "PATCH",
      json: { title: f.title.value, albumId: f.albumId.value ? Number(f.albumId.value) : null, takenAt: fromLocalInput(f.takenAt.value) },
    });
    state.photos[state.viewer] = updated;
    renderViewer();
    renderGrid();
    $("editMsg").textContent = "저장했습니다.";
    await loadAlbums(); // 앨범별 사진 수 갱신
  } catch (err) {
    $("editMsg").textContent = err.message;
  }
});

$("deletePhoto").addEventListener("click", async () => {
  const p = state.photos[state.viewer];
  if (!confirm(`"${p.title ?? p.filename}" 사진을 지울까요?\nR2 의 원본과 썸네일도 함께 지워지며 되돌릴 수 없습니다.`)) return;
  try {
    await api(`/api/photos/${p.id}`, { method: "DELETE" });
    state.photos.splice(state.viewer, 1);
    renderGrid();
    if (state.photos.length === 0) viewer.close();
    else {
      state.viewer = Math.min(state.viewer, state.photos.length - 1);
      renderViewer();
    }
    setStatus("사진을 지웠습니다.");
    await loadAlbums();
  } catch (err) {
    $("editMsg").textContent = err.message;
  }
});

// ─────────────────────────────────────────────────────────────
// 업로드: 여러 장을 한 장씩 차례로 보냅니다 (진행률은 XMLHttpRequest 로)
// ─────────────────────────────────────────────────────────────
// fetch() 는 업로드 진행률을 알려 주지 않아서 여기서만 XMLHttpRequest 를 씁니다.
function uploadOne(item, albumId) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", item.file);
    if (albumId) form.append("albumId", albumId);
    if (item.takenAt) form.append("takenAt", String(item.takenAt));
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/photos");
    xhr.setRequestHeader("authorization", `Bearer ${state.token}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && (item.progress.value = e.loaded / e.total);
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      xhr.status === 201 ? resolve(data) : reject(new Error(data.error ?? `실패 (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("네트워크 오류"));
    xhr.send(form);
  });
}

async function addFiles(files) {
  for (const file of files) {
    const item = {
      file,
      takenAt: await readTakenAt(file),
      done: false,
      progress: el("progress", { max: 1, value: 0 }),
      result: el("span", { textContent: "대기" }),
    };
    if (file.size > state.maxMb * 1048576) {
      item.done = true;
      item.result.textContent = `${state.maxMb}MB 초과`;
      item.result.className = "err";
    }
    item.row = el("li", {},
      el("span", { className: "name", textContent: file.name, title: file.name }),
      el("span", { className: "taken", textContent: item.takenAt ? `촬영 ${fmtDate(item.takenAt)}` : "촬영일 없음" }),
      item.progress,
      item.result,
    );
    state.queue.push(item);
    $("queue").append(item.row);
  }
  $("uploadStart").disabled = !state.queue.some((i) => !i.done);
}

$("uploadStart").addEventListener("click", async () => {
  $("uploadStart").disabled = true;
  const albumId = $("uploadAlbum").value;
  let ok = 0;
  for (const item of state.queue.filter((i) => !i.done)) {
    item.result.textContent = "올리는 중";
    try {
      await uploadOne(item, albumId);
      item.result.textContent = "완료";
      item.result.className = "ok";
      item.progress.value = 1;
      ok++;
    } catch (err) {
      item.result.textContent = err.message;
      item.result.className = "err";
    }
    item.done = true;
  }
  setStatus(`${ok}장을 올렸습니다.`);
  await loadAlbums();
  await loadPhotos(true);
});

$("uploadClear").addEventListener("click", () => {
  state.queue = [];
  $("queue").replaceChildren();
  $("uploadStart").disabled = true;
});

$("fileInput").addEventListener("change", (e) => {
  addFiles([...e.target.files]);
  e.target.value = "";
});
const drop = $("dropZone");
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  addFiles([...e.dataTransfer.files].filter((f) => f.type.startsWith("image/")));
});

// ─────────────────────────────────────────────────────────────
// 시작
// ─────────────────────────────────────────────────────────────
await checkAdmin();
await loadAlbums();
await loadPhotos(true);
