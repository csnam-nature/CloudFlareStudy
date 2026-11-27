// 답변 안의 그래프·도식 그리기
//
// AI 가 답변에 아래 블록을 넣으면(규칙은 src/rag.ts 의 CHART_RULE) 화면이 그림으로 바꿉니다.
//   ```chart   {"type":"bar","title":"…","labels":[…],"datasets":[{"label":"…","data":[…]}],"unit":"건"}   → Chart.js 그래프
//   ```mermaid flowchart TD …                                                                        → Mermaid 도식
// 라이브러리는 public/vendor/ 에 있습니다(npm install 때 scripts/copy-vendor.mjs 가 복사). 블록이 처음 나올 때만 불러옵니다.
// 형식이 틀린 블록은 그리지 않고 원래 글을 그대로 보여 줍니다.
// 저장(Word·PDF)용 그림은 chartImage / mermaidImage 가 PNG 로 만듭니다(export.js).

import { esc } from "./common.js";

// ── 라이브러리 불러오기 ───────────────────────────────────

const loading = {};
function loadScript(src, globalName) {
  if (window[globalName]) return Promise.resolve(window[globalName]);
  loading[src] ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => (window[globalName] ? resolve(window[globalName]) : reject(new Error(`${src} 를 불러왔지만 ${globalName} 가 없습니다.`)));
    s.onerror = () => {
      delete loading[src];
      reject(new Error(`${src} 를 불러오지 못했습니다. npm install(또는 npm run vendor) 후 다시 배포했는지 확인하세요.`));
    };
    document.head.append(s);
  });
  return loading[src];
}

const FONT = '"Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';

async function loadChart() {
  const Chart = await loadScript("/vendor/chart.umd.min.js", "Chart");
  Chart.defaults.font.family = FONT;
  return Chart;
}

let mermaidReady = false;
async function loadMermaid() {
  const mermaid = await loadScript("/vendor/mermaid.min.js", "mermaid");
  if (!mermaidReady) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict", // 도식 안의 링크·스크립트 막기
      theme: "default",
      fontFamily: FONT,
      // 글상자를 HTML 이 아닌 SVG 글자로: 그래야 Word·PDF 저장 때 PNG 로 바꿀 수 있습니다.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
    });
    mermaidReady = true;
  }
  return mermaid;
}

// ── ```chart 블록 읽기 ────────────────────────────────────

const TYPES = ["bar", "line", "pie", "doughnut"];

/**
 * ```chart 블록의 글 → 검사한 그래프 정보 { type, title, unit, labels, datasets: [{ label, data }] }.
 * Chart.js 원래 형식({ type, data: { labels, datasets } })도 받아 줍니다. 틀리면 이유를 담은 오류를 던집니다.
 */
export function parseChart(text) {
  let o;
  try {
    o = JSON.parse(text);
  } catch {
    throw new Error("그래프 데이터가 올바른 JSON 이 아닙니다.");
  }
  if (!o || typeof o !== "object") throw new Error("그래프 데이터가 비어 있습니다.");
  const src = o.data && typeof o.data === "object" && !Array.isArray(o.data) ? o.data : o;
  const type = String(o.type ?? "bar").toLowerCase();
  if (!TYPES.includes(type)) throw new Error(`모르는 그래프 종류입니다: ${type} (bar·line·pie·doughnut 만 됩니다)`);
  if (!Array.isArray(src.labels) || src.labels.length < 1 || src.labels.length > 100) throw new Error("labels(항목 이름)가 1~100개여야 합니다.");
  if (!Array.isArray(src.datasets) || !src.datasets.length) throw new Error("datasets(값)가 없습니다.");
  const datasets = src.datasets.slice(0, 8).map((d, i) => {
    const data = (Array.isArray(d?.data) ? d.data : []).map((v) => (v === null || v === "" ? null : Number(String(v).replace(/,/g, ""))));
    if (!data.length || data.some((v) => v !== null && !Number.isFinite(v))) throw new Error(`${i + 1}번째 계열의 값이 숫자가 아닙니다.`);
    return { label: String(d.label ?? `계열 ${i + 1}`).slice(0, 60), data: data.slice(0, src.labels.length) };
  });
  return {
    type,
    title: String(o.title ?? o.options?.plugins?.title?.text ?? "").slice(0, 120),
    unit: String(o.unit ?? "").slice(0, 20),
    labels: src.labels.map((l) => String(l).slice(0, 60)),
    datasets: type === "pie" || type === "doughnut" ? datasets.slice(0, 1) : datasets,
  };
}

// Okabe-Ito 계열 + 회사 주황: 색약에서도 구분이 잘 되는 색
const PALETTE = ["#f38020", "#0072b2", "#009e73", "#cc79a7", "#56b4e9", "#d55e00", "#e69f00", "#6b7280"];

const fmt = (v, unit) => (v == null ? "-" : `${Number(v).toLocaleString("ko-KR")}${unit ? ` ${unit}` : ""}`);

/** 그래프 정보 → Chart.js 설정 */
function chartConfig(spec, { forImage = false } = {}) {
  const round = spec.type === "pie" || spec.type === "doughnut";
  const datasets = spec.datasets.map((d, i) => {
    const color = PALETTE[i % PALETTE.length];
    if (round) return { ...d, backgroundColor: spec.labels.map((_, j) => PALETTE[j % PALETTE.length]), borderColor: "#fff", borderWidth: 2 };
    if (spec.type === "line") return { ...d, borderColor: color, backgroundColor: color, tension: 0.25, pointRadius: 3, spanGaps: true };
    return { ...d, backgroundColor: color, borderRadius: 3, maxBarThickness: 48 };
  });
  const many = spec.datasets.length > 1;
  // 계열끼리 크기가 10배 넘게 다르면(예: 건수와 kWh) 두 번째 계열부터 오른쪽 축을 씁니다. 안 그러면 작은 쪽이 바닥에 붙습니다.
  const peak = (d) => Math.max(...d.data.map((v) => Math.abs(v ?? 0)), 0);
  const dual = !round && many && peak(spec.datasets[0]) > 0 && spec.datasets.slice(1).some((d) => {
    const r = peak(d) / peak(spec.datasets[0]);
    return r > 10 || r < 0.1;
  });
  if (dual) datasets.forEach((d, i) => (d.yAxisID = i === 0 ? "y" : "y1"));
  return {
    type: spec.type,
    data: { labels: spec.labels, datasets },
    options: {
      responsive: !forImage,
      maintainAspectRatio: false,
      animation: forImage ? false : { duration: 400 },
      devicePixelRatio: forImage ? 2 : undefined,
      plugins: {
        title: { display: !!spec.title, text: spec.title, font: { size: 15, weight: "bold" }, color: "#1f2328" },
        legend: { display: round || many, position: round ? "right" : "bottom" },
        tooltip: { callbacks: { label: (c) => `${many || round ? `${round ? c.label : c.dataset.label}: ` : ""}${fmt(c.parsed?.y ?? c.parsed, spec.unit)}` } },
      },
      scales: round
        ? {}
        : {
            x: { grid: { display: false } },
            y: {
              beginAtZero: spec.type === "bar",
              title: { display: !!spec.unit, text: spec.unit },
              ticks: { callback: (v) => Number(v).toLocaleString("ko-KR") },
              ...(dual ? { title: { display: true, text: spec.datasets[0].label } } : {}),
            },
            ...(dual
              ? {
                  y1: {
                    position: "right",
                    beginAtZero: spec.type === "bar",
                    grid: { drawOnChartArea: false },
                    title: { display: true, text: spec.datasets.slice(1).map((d) => d.label).join(" · ") },
                    ticks: { callback: (v) => Number(v).toLocaleString("ko-KR") },
                  },
                }
              : {}),
          },
    },
    // 그림 파일은 배경이 투명하면 Word 에서 어둡게 보일 수 있어 흰색으로 채웁니다.
    plugins: forImage
      ? [{ id: "white", beforeDraw: (c) => ((c.ctx.save(), (c.ctx.fillStyle = "#fff")), c.ctx.fillRect(0, 0, c.width, c.height), c.ctx.restore()) }]
      : [],
  };
}

// ── 화면에 그리기 ─────────────────────────────────────────

/** HTML 속성에 넣을 글: 대괄호도 바꿔 둡니다(본문의 [1] 근거 번호 변환이 속성 안을 건드리지 않게). */
export const attr = (s) => esc(s).replace(/\[/g, "&#91;").replace(/\]/g, "&#93;");

let seq = 0;

/**
 * root 안의 아직 안 그린 그래프·도식 자리를 그립니다. (export.js 의 blocksToHtml 이 만든 .viz 자리)
 *   <div class="viz viz-chart" data-spec="{…}">   <div class="viz viz-mermaid" data-code="…">
 */
export async function renderVisuals(root) {
  const jobs = [];
  for (const el of root.querySelectorAll(".viz:not([data-done])")) {
    el.dataset.done = "1";
    jobs.push(el.classList.contains("viz-chart") ? drawChart(el) : drawMermaid(el));
  }
  await Promise.all(jobs);
}

async function drawChart(el) {
  try {
    const spec = JSON.parse(el.dataset.spec);
    const Chart = await loadChart();
    el.innerHTML = `<div class="viz-canvas"><canvas role="img" aria-label="${attr(spec.title || "그래프")}"></canvas></div>`;
    const chart = new Chart(el.querySelector("canvas"), chartConfig(spec));
    addDownload(el, "PNG", async () => {
      const { dataUrl } = await chartImage(spec);
      return { href: dataUrl, name: `${spec.title || "그래프"}.png` };
    });
    el._chart = chart;
  } catch (e) {
    showError(el, e, el.dataset.raw);
  }
}

async function drawMermaid(el) {
  const code = el.dataset.code;
  try {
    const svg = await mermaidSvg(code);
    el.innerHTML = `<div class="viz-svg">${svg}</div>`;
    addDownload(el, "SVG", async () => ({ href: URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })), name: "도식.svg" }));
  } catch (e) {
    showError(el, e, code);
  }
}

function showError(el, e, raw) {
  el.classList.add("viz-failed");
  el.innerHTML = `<p class="viz-error">그래프를 그리지 못해 원래 글을 보여 드립니다: ${esc(e?.message ?? e)}</p>${raw ? `<pre class="code"><code>${esc(raw)}</code></pre>` : ""}`;
}

function addDownload(el, label, make) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "viz-dl";
  b.textContent = `⬇ ${label}`;
  b.title = `그림 파일(${label})로 저장`;
  b.onclick = async () => {
    const { href, name } = await make();
    const a = document.createElement("a");
    a.href = href;
    a.download = name.replace(/[\\/:*?"<>|]/g, "");
    a.click();
    if (href.startsWith("blob:")) setTimeout(() => URL.revokeObjectURL(href), 10_000);
  };
  el.append(b);
}

/** Mermaid 글 → SVG 글. 틀리면 오류를 던집니다(Mermaid 가 문서에 남기는 오류 표시는 지움). */
async function mermaidSvg(code) {
  const mermaid = await loadMermaid();
  const id = `mmd-${Date.now().toString(36)}-${++seq}`;
  try {
    await mermaid.parse(code);
    const { svg } = await mermaid.render(id, code);
    return svg;
  } catch (e) {
    throw new Error(`도식 문법 오류 (${String(e?.message ?? e).split("\n")[0].slice(0, 120)})`);
  } finally {
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
}

// ── 저장용 그림(PNG) ──────────────────────────────────────

/** 그래프 정보 → { dataUrl(PNG), width, height } (width·height 는 화면 기준 크기, 실제 그림은 2배 해상도) */
export async function chartImage(spec, width = 760, height = 400) {
  const Chart = await loadChart();
  const canvas = document.createElement("canvas");
  canvas.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;height:${height}px`;
  canvas.width = width;
  canvas.height = height;
  document.body.append(canvas);
  try {
    const chart = new Chart(canvas, chartConfig(spec, { forImage: true }));
    chart.resize(width, height);
    const dataUrl = canvas.toDataURL("image/png");
    chart.destroy();
    return { dataUrl, width, height };
  } finally {
    canvas.remove();
  }
}

/** Mermaid 글 → { dataUrl(PNG), width, height, svg } */
export async function mermaidImage(code) {
  const svg = await mermaidSvg(code);
  const vb = svg.match(/viewBox="[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)"/);
  let width = vb ? Number(vb[1]) : 600;
  let height = vb ? Number(vb[2]) : 400;
  // 너무 크면 줄입니다(글자가 읽히는 범위에서)
  const k = Math.min(1, 900 / width);
  width = Math.round(width * k);
  height = Math.round(height * k);
  // 크기를 고정한 SVG 를 이미지로 읽어 캔버스에 그립니다.
  const sized = svg.replace(/<svg\b([^>]*)>/, (m, a) => `<svg${a.replace(/\s(width|height|style)="[^"]*"/g, "")} width="${width}" height="${height}">`);
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = width * 2;
  canvas.height = height * 2;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return { dataUrl: canvas.toDataURL("image/png"), width, height, svg };
}
