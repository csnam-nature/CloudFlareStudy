// 채팅 화면
//
// 1. 대화마다 UUID 가 있고, 이 id 가 곧 ChatAgent 인스턴스 이름입니다. 대화 목록·폴더는 왼쪽 사이드바(sidebar.js)가 다룹니다.
// 2. 대화를 열면 ws(s)://<호스트>/agents/chat-agent/<대화id> 로 WebSocket 을 엽니다. 다른 대화를 열면 연결을 바꿉니다.
// 3. 질문을 { type: "ask" } 로 보내고, 서버가 보내는 start → sources → delta… → done 을 받아 화면에 그립니다.
//    새 대화는 첫 질문을 보낼 때 목록에 등록되고(제목 = 첫 질문), 그다음 연결해서 질문을 보냅니다.
// 서버 쪽 메시지 형식은 src/agent.ts 맨 위 주석에 있습니다.

import { $, esc, showMode, toast } from "./common.js";
import { blocksToHtml, exportItems, parseBlocks } from "./export.js";
import { createSidebar } from "./sidebar.js";

const OLD_SESSION_KEY = "docChatbotSession"; // 폴더 기능 전의 "브라우저당 대화 하나" id
const CURRENT_KEY = "docChatbotCurrent"; // 마지막으로 연 대화

const list = $("#list");
const scroller = $("#messages");
const form = $("#askForm");
const input = $("#question");
const sendBtn = $("#sendBtn");
const conn = $("#conn");
const docFilter = $("#docFilter");

/** id → { el, content, sources, question } : 화면에 그린 답변들 (Map 은 넣은 순서를 유지 = 대화 순서) */
const answers = new Map();
let lastQuestion = ""; // 바로 앞 질문 (답변 저장 때 함께 넣음)
let appTitle = "네이처텍 문서 챗봇";
let ws;
let retry = 0;
let answering = false;
let currentId = null; // 열린 대화 id (null = 아직 질문 전인 새 대화)
let newFolderId = null; // 새 대화를 시작한 폴더
let pendingAsk = null; // 새 대화: 연결되면 보낼 첫 질문
let viewSeq = 0; // 대화를 바꿀 때마다 1씩 늘림(늦게 끝난 새 대화 등록이 화면을 덮어쓰지 않게)
const queuedAsks = new Map(); // 등록 중에 다른 대화로 옮겨 가 못 보낸 첫 질문 (대화 id → 질문)

// ── 연결 ──────────────────────────────────────────────

/** 대화 id 로 연결. 다른 대화로 바꾸면 이전 연결은 닫고 다시 연결하지 않습니다. */
function connect(id) {
  if (ws) {
    ws.onclose = null;
    ws.close();
  }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const sock = new WebSocket(`${proto}://${location.host}/agents/chat-agent/${id}`);
  ws = sock;
  sock.onopen = () => {
    retry = 0;
    setConn(true);
    if (pendingAsk) send(pendingAsk), (pendingAsk = null);
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    setConn(false);
    // 끊기면 1초, 2초, 4초… 최대 15초 간격으로 다시 연결
    setTimeout(() => ws === sock && currentId === id && connect(id), Math.min(15000, 1000 * 2 ** retry++));
  };
  sock.onmessage = (e) => {
    if (ws !== sock) return;
    let m;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    handle(m);
  };
}

function setConn(on) {
  conn.textContent = on ? "● 연결됨" : "● 연결 끊김, 다시 연결 중…";
  conn.classList.toggle("off", !on);
  sendBtn.disabled = !on || answering;
}

// ── 대화 열기 · 새 대화 ────────────────────────────────

function resetView() {
  list.innerHTML = "";
  answers.clear();
  lastQuestion = "";
  setAnswering(false);
}

function openConversation(id) {
  if (id === currentId) return closeSidebarOnMobile();
  viewSeq++;
  currentId = id;
  pendingAsk = queuedAsks.get(id) ?? null; // 등록만 되고 못 보낸 첫 질문이 있으면 열 때 보냅니다.
  queuedAsks.delete(id);
  localStorage.setItem(CURRENT_KEY, id);
  resetView();
  list.innerHTML = '<div class="empty"><p>불러오는 중…</p></div>';
  sidebar.setActive(id);
  connect(id);
  closeSidebarOnMobile();
}

/** 새 대화 (folderId 폴더 안에서). 첫 질문을 보낼 때 목록에 등록됩니다. */
function newConversation(folderId = null) {
  if (ws) (ws.onclose = null), ws.close(), (ws = null);
  viewSeq++;
  currentId = null;
  newFolderId = folderId;
  pendingAsk = null;
  localStorage.removeItem(CURRENT_KEY);
  resetView();
  showEmpty();
  conn.textContent = "● 새 대화";
  conn.classList.remove("off");
  sendBtn.disabled = false;
  sidebar.setActive(null, folderId);
  closeSidebarOnMobile();
  input.focus();
}

function closeSidebarOnMobile() {
  if (matchMedia("(max-width: 800px)").matches) $("#sidebar").classList.add("hidden");
}

const sidebar = createSidebar({
  onOpen: openConversation,
  onNew: newConversation,
  onDeleted: (id) => {
    queuedAsks.delete(id);
    if (id === currentId) newConversation(null);
  },
  // 새 대화를 시작한 폴더가 지워지면 폴더 없이 이어서 쓰도록 합니다.
  onFolderDeleted: (folderId) => {
    if (currentId === null && newFolderId === folderId) {
      newFolderId = null;
      const note = list.querySelector(".folder-note");
      if (note) note.hidden = true;
    }
  },
});

function send(obj) {
  if (ws?.readyState !== WebSocket.OPEN) return toast("서버에 연결되지 않았습니다.");
  if (obj.type === "ask" && currentId) sidebar.touch(currentId);
  ws.send(JSON.stringify(obj));
}

// ── 서버 메시지 처리 ──────────────────────────────────

function handle(m) {
  switch (m.type) {
    case "history":
      list.innerHTML = "";
      answers.clear();
      for (const msg of m.messages) {
        if (msg.role === "user") addUser(msg.content);
        // 생성 중인 답변(activeId)은 지금까지의 내용으로 그리고, 이어지는 delta 를 받습니다.
        else if (msg.id === m.activeId) addAnswer(msg.id, msg.content, msg.sources, true);
        else if (msg.content) addAnswer(msg.id, msg.content, msg.sources, false);
      }
      if (!m.messages.length) showEmpty();
      setAnswering(m.activeId != null);
      scrollDown(true);
      break;
    case "user":
      $(".empty", list)?.remove();
      addUser(m.message.content);
      break;
    case "start":
      setAnswering(true);
      addAnswer(m.id, "", [], true);
      break;
    case "sources": {
      const a = answers.get(m.id);
      if (a) (a.sources = m.sources), renderAnswer(a, true);
      break;
    }
    case "delta": {
      const a = answers.get(m.id);
      if (a) (a.content += m.text), renderAnswer(a, true);
      break;
    }
    case "done": {
      const a = answers.get(m.id);
      if (!a) addAnswer(m.id, m.content, m.sources, false);
      else (a.content = m.content), (a.sources = m.sources), renderAnswer(a, false);
      setAnswering(false);
      break;
    }
    case "error":
      toast(m.message);
      setAnswering(false);
      break;
  }
  scrollDown();
}

function setAnswering(on) {
  answering = on;
  sendBtn.disabled = on || ws?.readyState !== WebSocket.OPEN;
}

// ── 그리기 ────────────────────────────────────────────

function showEmpty() {
  list.append($("#emptyTpl").content.cloneNode(true));
  // 폴더 안에서 시작한 새 대화면 어느 폴더인지 알려 줍니다.
  const fname = currentId === null && newFolderId != null ? sidebar.folderName(newFolderId) : null;
  const note = list.querySelector(".folder-note");
  if (note && fname) (note.hidden = false), (note.textContent = `📁 ${fname} 폴더에 새 대화를 만듭니다`);
  for (const b of list.querySelectorAll(".examples button"))
    b.onclick = () => {
      input.value = b.textContent;
      form.requestSubmit();
    };
}

function addUser(text) {
  lastQuestion = text;
  const div = document.createElement("div");
  div.className = "msg user";
  div.innerHTML = `<div class="bubble">${esc(text)}</div>`;
  list.append(div);
}

function addAnswer(id, content, sources, typing) {
  const div = document.createElement("div");
  div.className = "msg bot";
  div.innerHTML = `<div class="bubble"></div>`;
  list.append(div);
  const a = { el: div.firstElementChild, content, sources, question: lastQuestion };
  answers.set(id, a);
  renderAnswer(a, typing);
}

function renderAnswer(a, typing) {
  const body = a.content ? formatAnswer(a.content, a.sources.length) : typing ? "<p>근거를 찾는 중…</p>" : "";
  const src = a.sources.length
    ? `<details class="sources"><summary>근거 ${a.sources.length}개 보기</summary>${a.sources
        .map(
          (s, i) => `<div class="source" data-n="${i + 1}">
            <div class="head"><b>[${i + 1}]</b><span>${esc(s.docName)} · 조각 ${s.seq + 1}</span>
              <span class="muted">유사도 ${s.score}</span>
              <a href="/api/documents/${s.docId}/file" target="_blank" rel="noopener">원본 열기</a></div>
            <div class="text">${esc(s.text)}</div></div>`,
        )
        .join("")}</details>`
    : "";
  // 다 만든 답변 아래에 저장 버튼 (MD · Word · PDF)
  const save =
    !typing && a.content
      ? `<div class="save"><span class="muted">저장</span><button type="button" data-f="md">MD</button><button type="button" data-f="docx">Word</button><button type="button" data-f="pdf">PDF</button></div>`
      : "";
  const open = a.el.querySelector("details")?.open;
  a.el.innerHTML = `<div class="${typing ? "typing" : ""}">${body}</div>${src}${save}`;
  for (const b of a.el.querySelectorAll(".save button"))
    b.onclick = () => {
      exportItems(b.dataset.f, appTitle, [{ question: a.question, answer: a.content, sources: a.sources }]);
      if (b.dataset.f === "pdf") toast('인쇄 창에서 대상(프린터)을 "PDF로 저장"으로 고르세요.');
    };
  if (open) a.el.querySelector("details").open = true;
  // 본문의 [1] 을 누르면 근거 목록을 펼치고 해당 근거를 강조
  for (const c of a.el.querySelectorAll(".cite"))
    c.onclick = () => {
      const d = a.el.querySelector("details");
      if (!d) return;
      d.open = true;
      const s = d.querySelector(`.source[data-n="${c.dataset.n}"]`);
      s?.classList.add("flash");
      s?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      setTimeout(() => s?.classList.remove("flash"), 1200);
    };
}

/** 답변 Markdown → HTML: 제목·문단·목록·표·**굵게**·`코드` (export.js 와 같은 변환) + [1] 근거 표시 */
function formatAnswer(text, nSources) {
  return blocksToHtml(parseBlocks(text)).replace(/\[(\d+)\]/g, (m, n) =>
    Number(n) >= 1 && Number(n) <= nSources ? `<span class="cite" data-n="${n}">${n}</span>` : m,
  );
}

function scrollDown(force = false) {
  const near = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
  if (force || near) scroller.scrollTop = scroller.scrollHeight;
}

// ── 입력 ──────────────────────────────────────────────

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || answering) return;
  const ask = { type: "ask", text, docId: docFilter.value ? Number(docFilter.value) : null };
  input.value = "";
  autoGrow();
  if (currentId) return send(ask);

  // 새 대화: 목록에 등록(제목 = 첫 질문)한 뒤 연결하고, 연결되면 질문을 보냅니다.
  const id = crypto.randomUUID();
  const seq = viewSeq;
  setAnswering(true);
  try {
    await sidebar.create(id, newFolderId, text);
  } catch (err) {
    if (seq !== viewSeq) return toast(`대화를 만들지 못했습니다: ${err.message}`);
    setAnswering(false);
    input.value = text;
    return toast(`대화를 만들지 못했습니다: ${err.message}`);
  }
  // 등록을 기다리는 사이 다른 대화로 옮겨 갔으면 화면은 그대로 두고, 그 대화를 열 때 질문을 보냅니다.
  if (seq !== viewSeq) return queuedAsks.set(id, ask), sidebar.touch(id);
  currentId = id;
  localStorage.setItem(CURRENT_KEY, id);
  sidebar.setActive(id);
  pendingAsk = ask;
  connect(id);
});

input.addEventListener("keydown", (e) => {
  // 한글 입력 중(조합 중) Enter 는 무시해야 마지막 글자가 두 번 보내지지 않습니다.
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    form.requestSubmit();
  }
});

function autoGrow() {
  input.style.height = "auto";
  input.style.height = `${Math.min(160, input.scrollHeight)}px`;
}
input.addEventListener("input", autoGrow);

$("#sideToggle").onclick = () => $("#sidebar").classList.toggle("hidden");

// 검색 범위: 색인이 끝난 문서만 고를 수 있습니다.
async function loadDocs() {
  try {
    const { documents } = await (await fetch("/api/documents")).json();
    const keep = docFilter.value;
    docFilter.innerHTML =
      `<option value="">모든 문서</option>` +
      documents
        .filter((d) => d.status === "ready")
        .map((d) => `<option value="${d.id}">${esc(d.name)}</option>`)
        .join("");
    docFilter.value = keep;
  } catch {
    /* 목록을 못 읽어도 채팅은 됩니다 */
  }
}

showMode($("#mode")).then((me) => me?.appTitle && (appTitle = me.appTitle));

// 대화 전체 저장
$("#saveAll").addEventListener("change", (e) => {
  const format = e.target.value;
  e.target.value = "";
  const items = [...answers.values()].filter((a) => a.content).map((a) => ({ question: a.question, answer: a.content, sources: a.sources }));
  if (!items.length) return toast("저장할 답변이 없습니다.");
  exportItems(format, appTitle, items);
  if (format === "pdf") toast('인쇄 창에서 대상(프린터)을 "PDF로 저장"으로 고르세요.');
});
loadDocs();
docFilter.addEventListener("focus", loadDocs);
closeSidebarOnMobile();
start();

/** 처음 열 때: 목록을 읽고, 마지막에 보던 대화(없으면 가장 최근 대화, 그것도 없으면 새 대화)를 엽니다. */
async function start() {
  await sidebar.load();
  // 폴더 기능 전에 쓰던 "브라우저당 대화 하나"가 있으면 목록에 "이전 대화"로 한 번 넣어 줍니다.
  const old = localStorage.getItem(OLD_SESSION_KEY);
  if (old) {
    try {
      if (!sidebar.has(old)) await sidebar.create(old, null, "이전 대화");
      localStorage.removeItem(OLD_SESSION_KEY);
    } catch {
      /* 다음에 다시 시도 */
    }
  }
  const last = localStorage.getItem(CURRENT_KEY);
  const id = last && sidebar.has(last) ? last : sidebar.mostRecent();
  if (id) openConversation(id);
  else newConversation(null);
}
