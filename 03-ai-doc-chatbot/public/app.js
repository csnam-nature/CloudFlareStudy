// 채팅 화면
//
// 1. 브라우저마다 세션 id 를 하나 만들어 localStorage 에 둡니다. 이 id 가 곧 ChatAgent 인스턴스 이름입니다.
// 2. ws(s)://<호스트>/agents/chat-agent/<세션id> 로 WebSocket 을 엽니다.
// 3. 질문을 { type: "ask" } 로 보내고, 서버가 보내는 start → sources → delta… → done 을 받아 화면에 그립니다.
// 서버 쪽 메시지 형식은 src/agent.ts 맨 위 주석에 있습니다.

import { $, esc, showMode, toast } from "./common.js";

const SESSION_KEY = "docChatbotSession";
let sessionId = localStorage.getItem(SESSION_KEY);
if (!sessionId) {
  sessionId = crypto.randomUUID();
  localStorage.setItem(SESSION_KEY, sessionId);
}

const list = $("#list");
const scroller = $("#messages");
const form = $("#askForm");
const input = $("#question");
const sendBtn = $("#sendBtn");
const conn = $("#conn");
const docFilter = $("#docFilter");

/** id → { el, content, sources } : 화면에 그린 답변들 */
const answers = new Map();
let ws;
let retry = 0;
let answering = false;

// ── 연결 ──────────────────────────────────────────────

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/agents/chat-agent/${sessionId}`);
  ws.onopen = () => {
    retry = 0;
    setConn(true);
  };
  ws.onclose = () => {
    setConn(false);
    // 끊기면 1초, 2초, 4초… 최대 15초 간격으로 다시 연결
    setTimeout(connect, Math.min(15000, 1000 * 2 ** retry++));
  };
  ws.onmessage = (e) => {
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

function send(obj) {
  if (ws?.readyState !== WebSocket.OPEN) return toast("서버에 연결되지 않았습니다.");
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
        else if (msg.content) addAnswer(msg.id, msg.content, msg.sources, false);
      }
      if (!m.messages.length) showEmpty();
      setAnswering(false);
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
      if (a) renderAnswer(a, false);
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
  for (const b of list.querySelectorAll(".examples button"))
    b.onclick = () => {
      input.value = b.textContent;
      form.requestSubmit();
    };
}

function addUser(text) {
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
  const a = { el: div.firstElementChild, content, sources };
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
  const open = a.el.querySelector("details")?.open;
  a.el.innerHTML = `<div class="${typing ? "typing" : ""}">${body}</div>${src}`;
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

/** 아주 작은 마크다운 변환: 문단, 목록, **굵게**, `코드`, [1] 근거 표시 */
function formatAnswer(text, nSources) {
  const inline = (s) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[(\d+)\]/g, (m, n) => (Number(n) >= 1 && Number(n) <= nSources ? `<span class="cite" data-n="${n}">${n}</span>` : m));
  const out = [];
  let listTag = null;
  for (const line of text.split("\n")) {
    const li = line.match(/^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/);
    if (li) {
      const tag = li[1] ? "ol" : "ul";
      if (listTag !== tag) {
        if (listTag) out.push(`</${listTag}>`);
        out.push(`<${tag}>`);
        listTag = tag;
      }
      out.push(`<li>${inline(li[2])}</li>`);
      continue;
    }
    if (listTag) out.push(`</${listTag}>`), (listTag = null);
    if (line.trim()) out.push(`<p>${inline(line.replace(/^#+\s*/, ""))}</p>`);
  }
  if (listTag) out.push(`</${listTag}>`);
  return out.join("");
}

function scrollDown(force = false) {
  const near = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
  if (force || near) scroller.scrollTop = scroller.scrollHeight;
}

// ── 입력 ──────────────────────────────────────────────

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || answering) return;
  send({ type: "ask", text, docId: docFilter.value ? Number(docFilter.value) : null });
  input.value = "";
  autoGrow();
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

$("#resetBtn").onclick = () => {
  if (confirm("대화 기록을 지우고 새로 시작할까요?")) send({ type: "reset" });
};

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

showMode($("#mode"));
loadDocs();
docFilter.addEventListener("focus", loadDocs);
connect();
