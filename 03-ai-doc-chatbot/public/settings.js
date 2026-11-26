// 설정 화면: 화면 제목 · 답변 모델(Workers AI · OpenAI · Claude) · 검색 · 색인 값
import { $, auth, esc, guardPage, showMode, TOKEN_KEY, toast } from "./common.js";

// ── 토큰 ──────────────────────────────────────────────

const tokenInput = $("#token");
tokenInput.value = localStorage.getItem(TOKEN_KEY) ?? "";

async function checkToken() {
  const me = await showMode($("#mode"), auth());
  if (!me) return false;
  if (!guardPage(me, "admin")) return false;
  const has = !!localStorage.getItem(TOKEN_KEY);
  $("#tokenState").textContent = me.admin ? "✅ 관리자 확인됨" : has ? "❌ 토큰이 맞지 않습니다" : "토큰을 입력하세요";
  return true;
}
$("#tokenForm").addEventListener("submit", (e) => {
  e.preventDefault();
  localStorage.setItem(TOKEN_KEY, tokenInput.value.trim());
  checkToken();
  loadSettings();
});
$("#clearToken").onclick = () => {
  localStorage.removeItem(TOKEN_KEY);
  tokenInput.value = "";
  checkToken();
  loadSettings();
};

// ── 설정 ──────────────────────────────────────────────

const form = $("#settingsForm");
const CUSTOM = "__custom__";
let settingsData = null;

const GROUPS = { "workers-ai": "Workers AI (무료 한도 안에서 사용)", anthropic: "Anthropic Claude (API 키 필요)", openai: "OpenAI (API 키 필요)" };

/** 모델 목록(회사별로 묶음) + 지금 값이 목록에 없으면 "직접 입력" 을 고른 상태로 */
function fillModelSelect(name, models, current) {
  const sel = form.elements[`${name}Pick`];
  const listed = models.some((m) => m.id === current);
  const ext = settingsData.external ?? {};
  const option = (m) => {
    const noKey = m.provider && !ext[m.provider] ? " (키 없음)" : "";
    return `<option value="${esc(m.id)}">${esc(m.id.replace(/^(@cf|openai|anthropic)\//, ""))} — ${esc(m.note)}${noKey}</option>`;
  };
  const groups = Object.entries(GROUPS)
    .map(([p, label]) => [label, models.filter((m) => (m.provider ?? "workers-ai") === p)])
    .filter(([, list]) => list.length);
  sel.innerHTML =
    (groups.length > 1 ? groups.map(([label, list]) => `<optgroup label="${esc(label)}">${list.map(option).join("")}</optgroup>`).join("") : models.map(option).join("")) +
    `<option value="${CUSTOM}">직접 입력…</option>`;
  sel.value = listed ? current : CUSTOM;
  form.elements[`${name}Custom`].value = listed ? "" : current;
  $(`#${name}CustomWrap`).hidden = listed;
}
const modelValue = (name) => {
  const v = form.elements[`${name}Pick`].value;
  return v === CUSTOM ? form.elements[`${name}Custom`].value.trim() : v;
};
for (const name of ["chatModel", "ocrModel"])
  form.elements[`${name}Pick`].addEventListener("change", (e) => ($(`#${name}CustomWrap`).hidden = e.target.value !== CUSTOM));

function showSettings(s) {
  fillModelSelect("chatModel", settingsData.chatModels, s.chatModel);
  fillModelSelect("ocrModel", settingsData.ocrModels, s.ocrModel);
  for (const k of ["appTitle", "temperature", "maxTokens", "topK", "minScore", "chunkSize", "chunkOverlap", "maxChunksPerDoc", "systemPrompt"])
    form.elements[k].value = s[k];
  form.elements.thinking.checked = s.thinking;
  form.elements.allowWebSearch.checked = s.allowWebSearch;
  const MODE_NAME = { docs: "📄 문서만", mixed: "📄+💡 문서 우선 + 일반 지식", general: "💡 일반 질문" };
  $("#modeRules").innerHTML = Object.entries(settingsData.modeRules ?? {})
    .map(([k, v]) => `<p><b>${esc(MODE_NAME[k] ?? k)}</b></p><pre>${esc(v)}</pre>`)
    .join("");
  form.elements.systemPrompt.placeholder = "(비워 두면 기본 규칙을 씁니다)";
  $("#embedModel").textContent = settingsData.embedModel;
  showExternal();
  $("#testResult").textContent = "";
}

/** 외부 AI 키가 들어 있는지 보여 줍니다(키 값은 서버가 보내지 않음). */
function showExternal() {
  const ext = settingsData.external ?? {};
  const row = (label, ok, name) =>
    `<div>${ok ? "✅" : "❌"} <b>${label}</b> ${ok ? "키 있음" : `키 없음 <span class="muted">— <code>${name}</code> 비밀 값을 넣으세요</span>`}</div>`;
  $("#extStatus").innerHTML =
    row("Anthropic Claude", ext.anthropic, "ANTHROPIC_API_KEY") +
    row("OpenAI", ext.openai, "OPENAI_API_KEY") +
    `<div class="muted">AI Gateway: ${ext.gateway ? `<code>${esc(ext.gateway)}</code> 를 거쳐 호출${ext.gatewayToken ? " (인증 토큰 있음)" : ""}` : "사용 안 함(회사 API 로 바로 호출)"}</div>`;
}

async function loadSettings() {
  const res = await fetch("/api/settings", { headers: auth() });
  if (!res.ok) {
    form.hidden = true;
    $("#settingsState").textContent = res.status === 401 ? "관리자 토큰이 필요합니다" : "불러오기 실패";
    return;
  }
  settingsData = await res.json();
  showSettings(settingsData.settings);
  form.hidden = false;
  $("#settingsState").textContent = settingsData.mock ? "연습 모드: 모델 설정은 npm run dev 에서 쓰입니다" : "";
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = form.elements;
  const body = {
    appTitle: f.appTitle.value,
    chatModel: modelValue("chatModel"),
    ocrModel: modelValue("ocrModel"),
    thinking: f.thinking.checked,
    allowWebSearch: f.allowWebSearch.checked,
    temperature: Number(f.temperature.value),
    maxTokens: Number(f.maxTokens.value),
    topK: Number(f.topK.value),
    minScore: Number(f.minScore.value),
    chunkSize: Number(f.chunkSize.value),
    chunkOverlap: Number(f.chunkOverlap.value),
    maxChunksPerDoc: Number(f.maxChunksPerDoc.value),
    systemPrompt: f.systemPrompt.value,
  };
  const res = await fetch("/api/settings", { method: "PUT", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return toast(`저장 실패: ${data.error ?? res.status}`);
  showSettings(data.settings);
  toast("설정을 저장했습니다");
  checkToken(); // 위쪽 배지·제목 갱신
  if (/^(openai|anthropic)\//.test(data.settings.chatModel)) toast("외부 AI 로 바꿨습니다. 질문과 문서 조각이 해당 회사로 보내집니다.");
});

$("#resetSettings").addEventListener("click", async () => {
  if (!confirm("설정을 모두 기본값(wrangler.jsonc 의 vars)으로 되돌릴까요?")) return;
  const res = await fetch("/api/settings", { method: "DELETE", headers: auth() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return toast(`실패: ${data.error ?? res.status}`);
  showSettings(data.settings);
  toast("기본값으로 되돌렸습니다");
  checkToken();
});

$("#testModel").addEventListener("click", async () => {
  const out = $("#testResult");
  out.textContent = "시험 중…";
  const res = await fetch("/api/settings/test", {
    method: "POST",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ model: modelValue("chatModel") }),
  });
  const r = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  out.textContent = r.ok ? `✅ 사용 가능 (${r.ms}ms, 답: ${r.sample})` : `❌ ${r.error}`;
});

checkToken().then((ok) => ok && loadSettings());

// 기본 시스템 프롬프트를 칸에 채워 고칠 수 있게 합니다(저장은 [설정 저장]으로).
$("#loadDefaultPrompt").addEventListener("click", () => {
  const ta = form.elements.systemPrompt;
  if (ta.value.trim() && ta.value.trim() !== settingsData.defaultSystemPrompt && !confirm("지금 칸의 내용을 기본 프롬프트로 바꿀까요?")) return;
  ta.value = settingsData.defaultSystemPrompt ?? "";
  ta.focus();
  toast("기본 프롬프트를 불러왔습니다. 고친 뒤 [설정 저장]을 누르세요.");
});
