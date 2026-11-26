// RAG(검색 증강 생성)의 "검색"과 "프롬프트 만들기"
//
//   질문 → 임베딩 → Vectorize 에서 가까운 청크 topK 개 → D1 에서 원문 → 프롬프트에 근거로 넣기
// LLM 은 학습 때 본 적 없는 사내 문서를 모르므로, 찾은 근거를 프롬프트에 넣어 "이것만 보고 답하라"고 시킵니다.

import { type ChatMessage, embed, queryVectors } from "./ai";
import { type Bindings, scopeSql } from "./auth";
import type { Settings } from "./settings";

export type Source = { id: string; docId: number; docName: string; seq: number; score: number; text: string };

// 이 점수보다 낮은 청크는 관련 없다고 보고 버립니다(코사인 유사도, 1에 가까울수록 비슷).
// 진짜 모드(bge-m3)와 연습 모드(글자 해시)는 점수 분포가 달라 기준도 다르게 둡니다.
// 단, 질문 단어가 그대로 들어 있는 조각(키워드 검색에 걸린 조각)은 이 기준과 상관없이 후보에 남깁니다.
// 진짜 모드 기준은 관리 화면 설정(minScore, 기본 0.35), 연습 모드는 0.05 고정.
const MOCK_MIN_SCORE = 0.05;
// 벡터 검색에서 먼저 뽑는 후보 수. 여기서 키워드 점수를 더해 다시 줄을 세운 뒤 설정의 topK 개만 씁니다.
const CANDIDATES = { real: 20, mock: 50 };
// 키워드 검색으로 더하는 후보 수(단어마다)
const KEYWORD_LIMIT = 20;
// 한 쿼리에 넣을 청크 id 수(D1 바인딩 한도 100 아래로)
const SQL_BATCH = 90;

/**
 * 하이브리드 검색 = 벡터 검색(뜻이 비슷한 조각) + 키워드 검색(질문 단어가 그대로 들어 있는 조각).
 *
 * 왜 키워드도 쓰나? "SK시그넷"처럼 짧은 회사명·모델명·코드만 물으면, 수십 행짜리 표 조각과의 벡터 유사도는
 * 낮게 나와(문장 뜻이 거의 없으므로) 기준(minScore) 아래로 떨어지기 쉽습니다. 그러면 근거가 0개가 되어
 * 모델은 "등록된 문서에서 찾지 못했습니다"라고 답합니다. 이름·번호 같은 것은 글자 그대로 찾는 편이 정확합니다.
 *
 * scope: 질문한 사람이 볼 수 있는 문서 범위(src/auth.ts docScope). null = 전부, 배열 = 전 직원 공개 + 그 그룹들.
 * 벡터 검색은 범위를 모르고 뽑으므로, 원문을 D1 에서 꺼낼 때 범위 밖 문서를 뺍니다. 그래서 범위가 있으면 후보를 두 배로 뽑습니다.
 */
export async function retrieve(
  env: Bindings,
  s: Settings,
  question: string,
  mock: boolean,
  docId?: number,
  scope: number[] | null = null,
): Promise<Source[]> {
  const minScore = mock ? MOCK_MIN_SCORE : s.minScore;
  const mode = mock ? "mock" : "real";
  const words = queryWords(question);
  const vis = scopeSql(scope, "d");
  const [qvec] = await embed(env, [question]);
  const candidates = Math.min(100, Math.max(CANDIDATES[mode], s.topK * 2) * (scope === null ? 1 : 2));
  const [vecMatches, keywordIds] = await Promise.all([
    queryVectors(env, qvec, candidates, docId),
    keywordSearch(env, words, docId, vis),
  ]);

  const vecScore = new Map(vecMatches.map((m) => [m.id, m.score]));
  const ids = new Set([...vecMatches.filter((m) => m.score >= minScore).map((m) => m.id), ...keywordIds]);
  if (!ids.size) {
    console.log(`검색: 근거 없음 (벡터 최고 점수 ${vecMatches[0]?.score.toFixed(3) ?? "-"}, 기준 ${minScore}, 키워드 ${JSON.stringify(words)})`);
    return [];
  }

  // Vectorize 는 벡터만 돌려주므로 원문은 D1 에서 같은 id 로 꺼냅니다.
  // D1 은 쿼리 하나에 바인딩 값을 100개까지만 받으므로, 후보가 많으면(벡터 + 키워드) 나눠서 꺼냅니다.
  const list = [...ids];
  const per = SQL_BATCH - vis.args.length;
  const stmts = [];
  for (let i = 0; i < list.length; i += per) {
    const part = list.slice(i, i + per);
    stmts.push(
      env.DB.prepare(
        `SELECT c.id, c.doc_id, c.seq, c.text, d.name
           FROM chunks c JOIN documents d ON d.id = c.doc_id
          WHERE c.id IN (${part.map(() => "?").join(",")})${vis.sql}`,
      ).bind(...part, ...vis.args),
    );
  }
  const results = (await env.DB.batch<{ id: string; doc_id: number; seq: number; text: string; name: string }>(stmts)).flatMap(
    (r) => r.results,
  );

  // 최종 점수 = 벡터 점수 + 키워드 점수(질문 단어가 들어 있는 비율 × 0.5). 그 사이 삭제된 청크는 결과에 없으므로 빠집니다.
  const sources = results
    .map((r) => {
      const score = (vecScore.get(r.id) ?? 0) + keywordBoost(r.text, words);
      return { id: r.id, docId: r.doc_id, docName: r.name, seq: r.seq, score: Math.round(score * 1000) / 1000, text: r.text };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, s.topK);
  console.log(`검색: ${sources.map((s) => `${s.docName}#${s.seq + 1}(${s.score}${vecScore.has(s.id) ? "" : ", 키워드"})`).join(", ")}`);
  return sources;
}

/** 질문 단어가 그대로 들어 있는 청크 id (D1 에서 글자 검색). 단어마다 최대 KEYWORD_LIMIT 개. */
async function keywordSearch(env: Bindings, words: string[], docId: number | undefined, vis: { sql: string; args: number[] }): Promise<string[]> {
  // 너무 흔한 짧은 말은 빼고, 긴 단어(회사명·코드일 가능성이 큼)부터 최대 4개만 찾습니다.
  const terms = [...words].sort((a, b) => b.length - a.length).slice(0, 4);
  if (!terms.length) return [];
  const stmts = terms.map((w) =>
    env.DB.prepare(
      `SELECT c.id FROM chunks c JOIN documents d ON d.id = c.doc_id
        WHERE instr(lower(c.text), ?) > 0 ${docId ? "AND c.doc_id = ?" : ""}${vis.sql}
        ORDER BY c.doc_id DESC, c.seq LIMIT ${KEYWORD_LIMIT}`,
    ).bind(...(docId ? [w, docId] : [w]), ...vis.args),
  );
  const res = await env.DB.batch<{ id: string }>(stmts);
  return [...new Set(res.flatMap((r) => r.results.map((x) => x.id)))];
}

// 질문에 자주 붙는, 검색어로는 쓸모없는 말
const STOP_WORDS = new Set(["알려줘", "알려", "주세요", "무엇", "무엇인가요", "뭐야", "어떤", "어떻게", "있나요", "있어", "목록", "관련", "대해", "대한", "내용"]);

/** 질문에서 검색어로 쓸 단어(두 글자 이상). "SK시그넷 모델은?" → ["sk시그넷", "모델은", "모델"] 처럼 끝의 조사도 떼어 봅니다. */
function queryWords(question: string): string[] {
  const out = new Set<string>();
  for (const w of question.toLowerCase().match(/[\p{L}\p{N}-]{2,}/gu) ?? []) {
    out.add(w);
    const stem = w.replace(/(은|는|이|가|을|를|의|에|에서|으로|로|과|와|도|만|요)$/u, "");
    if (stem.length >= 2) out.add(stem);
  }
  return [...out].filter((w) => !STOP_WORDS.has(w));
}

/** 질문 단어가 조각에 들어 있는 비율만큼 점수를 더합니다(0~0.5). */
function keywordBoost(text: string, words: string[]): number {
  if (!words.length) return 0;
  const lower = text.toLowerCase();
  return (0.5 * words.filter((w) => lower.includes(w)).length) / words.length;
}

/**
 * 기본 시스템 프롬프트(설정 화면의 "기본값 불러오기"로 불러와 고칠 수 있음).
 * "문서만 쓸지, 일반 지식도 쓸지" 같은 답변 방식 규칙은 여기에 넣지 않고 MODE_RULES 에서 자동으로 덧붙입니다.
 * 그래서 프롬프트를 직접 고쳐도 질문창 옆 답변 모드가 그대로 동작합니다.
 */
export const SYSTEM_PROMPT = `당신은 네이처텍 사내 문서를 근거로 답하는 도우미입니다. 한국어로 답하세요.
규칙:
- [근거]에 Markdown 표가 있으면 첫 줄(머리글)로 각 열의 뜻을 알고 행을 읽으세요.
- 질문이 회사명·모델명·코드처럼 짧은 낱말뿐이면, 근거에서 그 낱말이 들어 있는 행·문장을 찾아 정리해 보여 주세요.
- [근거]를 쓴 부분 뒤에 [1], [2]처럼 근거 번호를 붙이세요.
- 짧고 정확하게, 필요하면 목록으로 정리하세요.`;

/** 질문창 옆에서 고르는 답변 모드 */
export type AnswerMode = "docs" | "mixed" | "general";
export const ANSWER_MODES: AnswerMode[] = ["docs", "mixed", "general"];
export const toMode = (v: unknown): AnswerMode => (ANSWER_MODES.includes(v as AnswerMode) ? (v as AnswerMode) : "docs");

/** 일반 정보(문서에 없는 내용)를 표시하는 문구. 화면·저장 파일에서도 이 문구로 구분합니다. */
export const GENERAL_LABEL = "※ 등록 문서에 없는 일반 정보입니다.";

/** 답변 모드별 규칙. 시스템 프롬프트(기본 또는 직접 고친 것) 뒤에 붙습니다. */
export const MODE_RULES: Record<AnswerMode, string> = {
  docs: `[답변 방식: 문서만] (위 규칙과 다르면 이 규칙을 따르세요)
- [근거] 안의 내용만 사용하세요. 일반 지식이나 추측을 섞지 마세요.
- 근거에 답이 없으면 지어내지 말고 "등록된 문서에서 찾지 못했습니다."라고 답하세요.`,
  mixed: `[답변 방식: 문서 우선 + 일반 지식] (위 규칙과 다르면 이 규칙을 따르세요)
- [근거]에 답이 있으면 근거를 먼저 쓰고 근거 번호를 붙이세요.
- 근거에 없거나 부족한 내용은 일반 지식으로 보충해도 됩니다. 그 부분은 새 문단으로 시작하고 맨 앞에 "${GENERAL_LABEL}"라고 적으세요.
- 근거(사내 문서)와 일반 지식이 다르면 근거를 따르고 차이를 알려 주세요.`,
  general: `[답변 방식: 일반 질문] (위 규칙과 다르면 이 규칙을 따르세요)
- 사내 문서 검색 없이 일반 지식으로 답하세요. 근거 번호는 붙이지 마세요.
- 확실하지 않은 내용은 확실하지 않다고 말하세요.`,
};

/** 웹 검색을 켰을 때 덧붙이는 규칙 (Claude·OpenAI 의 자체 웹 검색 도구를 씀) */
export const WEB_RULE = `[웹 검색]
- 최신 정보가 필요하거나 [근거]와 일반 지식으로 부족하면 웹 검색 도구를 쓸 수 있습니다.
- 웹에서 가져온 내용은 문장 앞에 "🌐"를 붙이고 [사이트 제목](URL) 형식으로 출처 링크를 적으세요.
- 사내 문서 근거와 웹 내용이 다르면 사내 문서를 따르세요.`;

/**
 * 그래프 규칙 (설정의 "답변에 그래프·도식 허용"이 켜져 있으면 덧붙음)
 * 화면(public/charts.js)이 ```chart 블록은 Chart.js 그래프로, ```mermaid 블록은 도식으로 그립니다.
 * 형식이 틀린 블록은 화면에 글로 보이므로, 표도 함께 쓰게 해서 숫자는 항상 남게 합니다.
 */
export const CHART_RULE = `[그래프·도식]
- 숫자를 비교·추이·비율로 보여 주면 이해가 쉬운 답이면, 표 아래에 그래프 블록을 하나 덧붙일 수 있습니다. 숫자가 2개 미만이면 그리지 마세요.
- 그래프 블록 형식(JSON 한 개, 숫자는 따옴표 없이, 근거에 있는 숫자만):
\`\`\`chart
{"type":"bar","title":"제목","labels":["항목1","항목2"],"datasets":[{"label":"계열 이름","data":[10,20]}],"unit":"단위"}
\`\`\`
- type: bar(막대, 항목 비교) · line(선, 시간에 따른 변화) · pie(원, 전체 중 비율) · doughnut. 계열(datasets)은 여러 개도 됩니다(pie·doughnut 은 1개).
- 절차·흐름·구성은 Mermaid 도식으로 그릴 수 있습니다. 예:
\`\`\`mermaid
flowchart TD
  A[충전 시작] --> B[카드 태그]
\`\`\`
- 그래프·도식을 쓰더라도 숫자와 내용은 글이나 표로도 적고, 근거 번호는 블록 밖 문장·표에 붙이세요.`;

export type PromptOptions = { systemPrompt?: string; mode?: AnswerMode; web?: boolean; charts?: boolean };

/** 시스템 메시지 = (직접 고친 프롬프트 또는 기본) + 답변 모드 규칙 + (웹 검색 규칙) + (그래프 규칙) */
export function buildSystem(o: PromptOptions = {}): string {
  return [o.systemPrompt?.trim() || SYSTEM_PROMPT, MODE_RULES[o.mode ?? "docs"], o.web ? WEB_RULE : "", o.charts ? CHART_RULE : ""]
    .filter(Boolean)
    .join("\n\n");
}

/** LLM 에 보낼 메시지 목록: 시스템 규칙 + 최근 대화 몇 턴 + (근거 + 질문) */
export function buildMessages(question: string, sources: Source[], history: ChatMessage[], o: PromptOptions = {}): ChatMessage[] {
  const system = { role: "system" as const, content: buildSystem(o) };
  // 일반 질문 모드는 검색을 하지 않으므로 질문만 보냅니다.
  if (o.mode === "general") return [system, ...history, { role: "user", content: question }];
  const context = sources.length
    ? sources.map((s, i) => `[${i + 1}] (${s.docName}, 조각 ${s.seq + 1})\n${s.text}`).join("\n\n")
    : "(관련 근거를 찾지 못했습니다)";
  return [system, ...history, { role: "user", content: `[근거]\n${context}\n\n[질문]\n${question}` }];
}

/**
 * 연습 모드의 가짜 답변: 찾은 근거들에서 질문과 가장 많이 겹치는 문단을 그대로 보여 줍니다.
 * 그 문단이 표이면 머리글과 질문 단어가 들어 있는 행만 골라 보여 줍니다(큰 표 전체를 늘어놓지 않도록).
 * (진짜 모드에서는 이 자리에서 LLM 이 근거를 읽고 문장으로 답합니다.)
 */
export function mockAnswer(question: string, sources: Source[]): string {
  if (!sources.length) return "(연습 모드) 등록된 문서에서 찾지 못했습니다.";
  const grams = (t: string) => {
    const s = t.toLowerCase().replace(/\s+/g, "");
    return new Set(Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2)));
  };
  const q = grams(question);
  // "E-21", "SK시그넷" 같은 코드·단어가 통째로 들어 있으면 가산점
  const words = queryWords(question);
  const hits = (t: string) => {
    const lower = t.toLowerCase();
    return words.filter((w) => lower.includes(w)).length;
  };
  // 그래프를 물으면 표 문단만, 순서도를 물으면 번호 목록 문단만 후보로 봅니다(그런 문단이 있을 때).
  const want = /그래프|차트|chart/i.test(question) ? "chart" : /순서도|흐름도|도식|flow/i.test(question) ? "flow" : "";
  const paras = (t: string) => t.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  const fits = (p: string) => (want === "chart" ? p.startsWith("|") : want === "flow" ? /^\s*\d+[.)]\s/m.test(p) : true);
  const onlyFit = want !== "" && sources.some((src) => paras(src.text).some(fits));
  let best = { text: "", n: 1, score: -1 };
  sources.forEach((src, i) => {
    for (const p of paras(src.text).filter((x) => !onlyFit || fits(x))) {
      // 표 문단은 머리글을 뺀 행만으로 겹침을 셉니다(머리글은 어느 조각에나 붙어 있으므로).
      const body = p.startsWith("|") ? p.split("\n").slice(2).join("\n") : p;
      const g = grams(body);
      // 앞쪽(더 비슷한) 근거를 조금 우대
      const score = [...q].filter((x) => g.has(x)).length + 5 * hits(body) - i * 0.5;
      if (score > best.score) best = { text: p, n: i + 1, score };
    }
  });
  let text = best.text;
  const lines = text.split("\n");
  if (lines.length > 3 && lines.every((l) => l.trim().startsWith("|"))) {
    const rows = lines.slice(2).filter((l) => hits(l) > 0);
    if (rows.length) text = [lines[0], lines[1], ...rows.slice(0, 15)].join("\n");
  }
  // 표는 끝에 근거 번호를 붙이면 표 줄이 깨지므로 다음 줄에 둡니다.
  const cite = text.startsWith("|") ? `\n\n(근거 [${best.n}])` : ` [${best.n}]`;
  // "그래프·차트"를 물으면 표의 숫자 열로, "순서도·흐름도"를 물으면 번호 목록으로 도식 블록을 덧붙여 화면 그리기를 확인합니다.
  const extra = want === "chart" ? mockChart(text) : want === "flow" ? mockFlow(text) : "";
  return `(연습 모드: AI 가 답을 쓰지 않고, 가장 비슷한 근거 문단을 그대로 보여 줍니다)\n\n${text.replace(/^#+\s*/, "")}${cite}${extra}`;
}

/** 연습 모드: Markdown 표에서 숫자 열을 찾아 ```chart 블록을 만듭니다(첫 열 = 항목 이름). 없으면 "" */
export function mockChart(table: string): string {
  const rows = table
    .split("\n")
    .filter((l) => l.trim().startsWith("|") && !/^\s*\|?\s*:?-{3,}/.test(l))
    .map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
  if (rows.length < 3) return "";
  const [head, ...body] = rows;
  const num = (c: string | undefined) => Number(String(c ?? "").replace(/[,\s%]|[^\d.-]+$/g, ""));
  const cols = head.map((_, i) => i).filter((i) => i > 0 && body.every((r) => r[i] != null && r[i] !== "" && Number.isFinite(num(r[i]))));
  if (!cols.length) return "";
  const spec = {
    type: cols.length > 1 || body.length > 6 ? "line" : "bar",
    title: `${head[0]}별 ${cols.map((i) => head[i]).join("·")}`,
    labels: body.map((r) => r[0]),
    datasets: cols.slice(0, 4).map((i) => ({ label: head[i], data: body.map((r) => num(r[i])) })),
  };
  return `\n\n\`\`\`chart\n${JSON.stringify(spec)}\n\`\`\``;
}

/** 연습 모드: "1. …" 번호 목록을 Mermaid 순서도로 바꿉니다. 없으면 "" */
export function mockFlow(text: string): string {
  const steps = [...text.matchAll(/^\s*\d+[.)]\s+(.+)$/gm)].map((m) => m[1].replace(/["\[\]{}()<>|]/g, "").slice(0, 30));
  if (steps.length < 2) return "";
  const lines = steps.map((t, i) => `  S${i}["${t}"]`);
  const links = steps.slice(1).map((_, i) => `  S${i} --> S${i + 1}`);
  return `\n\n\`\`\`mermaid\nflowchart TD\n${[...lines, ...links].join("\n")}\n\`\`\``;
}
