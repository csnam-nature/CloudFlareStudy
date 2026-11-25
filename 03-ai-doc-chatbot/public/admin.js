// 문서 관리 화면: 업로드 · 목록 · 원본 열기 · 이름 수정 · 다시 색인 · 삭제
import { $, esc, fmtBytes, fmtTime, showMode, toast } from "./common.js";

const TOKEN_KEY = "docChatbotAdminToken";
const VECTORIZE_FREE_CHUNKS = Math.floor(5_000_000 / 1024); // 무료 저장 한도 ≈ 4,882개(1024차원 기준)
const STATUS = { queued: "대기", indexing: "색인 중", ready: "완료", failed: "실패" };

const tokenInput = $("#token");
tokenInput.value = localStorage.getItem(TOKEN_KEY) ?? "";
const auth = () => ({ authorization: `Bearer ${localStorage.getItem(TOKEN_KEY) ?? ""}` });

let docs = [];
let editingId = null;
let pollTimer;

// ── 토큰 ──────────────────────────────────────────────

async function checkToken() {
  const me = await showMode($("#mode"), auth());
  if (!me) return;
  $("#maxMb").textContent = me.maxUploadMb;
  const has = !!localStorage.getItem(TOKEN_KEY);
  $("#tokenState").textContent = me.admin ? "✅ 관리자 확인됨" : has ? "❌ 토큰이 맞지 않습니다" : "토큰을 입력하세요";
}

$("#tokenForm").addEventListener("submit", (e) => {
  e.preventDefault();
  localStorage.setItem(TOKEN_KEY, tokenInput.value.trim());
  checkToken();
});
$("#clearToken").onclick = () => {
  localStorage.removeItem(TOKEN_KEY);
  tokenInput.value = "";
  checkToken();
};

// ── 업로드 ────────────────────────────────────────────

const drop = $("#drop");
$("#file").addEventListener("change", (e) => uploadFiles([...e.target.files]).then(() => (e.target.value = "")));
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  uploadFiles([...e.dataTransfer.files]);
});

async function uploadFiles(files) {
  const log = $("#uploadLog");
  for (const f of files) {
    log.textContent = `올리는 중: ${f.name} (${fmtBytes(f.size)})`;
    const form = new FormData();
    form.append("file", f);
    const res = await fetch("/api/documents", { method: "POST", headers: auth(), body: form });
    const data = await res.json().catch(() => ({}));
    if (res.ok) toast(`올렸습니다: ${f.name} → 색인 대기`);
    else toast(`${f.name}: ${data.error ?? res.status}`);
  }
  log.textContent = "";
  await load();
}

// ── 목록 ──────────────────────────────────────────────

async function load() {
  try {
    const data = await (await fetch("/api/documents")).json();
    docs = data.documents;
    render(data.totalChunks);
  } catch {
    toast("목록을 불러오지 못했습니다.");
  }
  // 색인 중인 문서가 있으면 3초마다 상태를 다시 읽습니다.
  clearTimeout(pollTimer);
  if (docs.some((d) => d.status === "queued" || d.status === "indexing")) pollTimer = setTimeout(load, 3000);
}

function render(totalChunks) {
  const pct = Math.min(100, (totalChunks / VECTORIZE_FREE_CHUNKS) * 100);
  $("#summary").textContent = `문서 ${docs.length}개 · 청크 ${totalChunks.toLocaleString()}개 (무료 저장 한도의 ${pct.toFixed(1)}%)`;
  $("#meterBar").style.width = `${pct}%`;

  const rows = $("#rows");
  if (!docs.length) {
    rows.innerHTML = `<tr><td colspan="6" class="muted">아직 문서가 없습니다. 위에서 올려 보세요.</td></tr>`;
    return;
  }
  rows.innerHTML = docs
    .map((d) => {
      const nameCell =
        editingId === d.id
          ? `<div class="row"><input type="text" class="rename" value="${esc(d.name)}" style="flex:1;min-width:120px" />
               <button data-act="save" data-id="${d.id}" class="primary">저장</button>
               <button data-act="cancel">취소</button></div>`
          : `<div class="name">${esc(d.name)}</div>`;
      return `<tr>
        <td>${nameCell}<div class="file">${esc(d.filename)}</div>${d.error ? `<div class="err">${esc(d.error)}</div>` : ""}</td>
        <td class="num hide-sm">${fmtBytes(d.size)}</td>
        <td class="num">${d.chunkCount}</td>
        <td><span class="badge ${d.status}">${STATUS[d.status]}</span></td>
        <td class="hide-sm muted">${fmtTime(d.createdAt)}</td>
        <td><div class="actions">
          <a href="/api/documents/${d.id}/file" target="_blank" rel="noopener">열기</a>
          <button data-act="edit" data-id="${d.id}">이름 수정</button>
          <button data-act="reindex" data-id="${d.id}">다시 색인</button>
          <button data-act="delete" data-id="${d.id}" class="danger">삭제</button>
        </div></td>
      </tr>`;
    })
    .join("");
  rows.querySelector(".rename")?.focus();
}

// 표 안 버튼은 한곳에서 처리합니다(이벤트 위임).
$("#rows").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const doc = docs.find((d) => d.id === id);
  switch (btn.dataset.act) {
    case "edit":
      editingId = id;
      return load();
    case "cancel":
      editingId = null;
      return load();
    case "save": {
      const name = $("#rows .rename").value.trim();
      const res = await api("PATCH", `/api/documents/${id}`, { name });
      if (res) (editingId = null), toast("이름을 바꿨습니다.");
      return load();
    }
    case "reindex":
      if (await api("POST", `/api/documents/${id}/reindex`)) toast(`다시 색인합니다: ${doc?.name}`);
      return load();
    case "delete":
      if (!confirm(`'${doc?.name}' 문서를 삭제할까요?\n원본, 청크, 벡터가 모두 지워집니다.`)) return;
      if (await api("DELETE", `/api/documents/${id}`)) toast("삭제했습니다.");
      return load();
  }
});

$("#rows").addEventListener("keydown", (e) => {
  if (e.target.classList.contains("rename") && e.key === "Enter" && !e.isComposing)
    $("#rows button[data-act=save]").click();
  if (e.key === "Escape") (editingId = null), load();
});

/** 관리자 API 호출. 실패하면 알림을 띄우고 null 을 돌려줍니다. */
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

$("#refresh").onclick = load;
checkToken();
load();
