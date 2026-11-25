// URL 단축기 Worker 진입점
//
// 라우트 요약
//   GET    /                    간단한 웹 폼 (HTML)
//   POST   /api/links           단축 링크 생성        → D1 에 메타데이터, KV 에 코드→URL
//   GET    /api/links           최근 링크 목록 + 클릭 수 (D1)
//   GET    /api/stats/:code     클릭 통계 (D1 GROUP BY)
//   DELETE /api/links/:code     링크 삭제 (ADMIN_TOKEN 필요)
//   GET    /:code               302 리다이렉트 (KV 조회) + 클릭 로그 기록 (waitUntil)
//
// 그리고 Cron Trigger 가 호출하는 scheduled() 핸들러로 만료 링크를 정리합니다.

import { Hono } from "hono";
import { generateCode, isValidCustomCode, normalizeUrl, refererHost } from "./code";
import { HOME_HTML } from "./page";

// Env 타입은 `npm run types`(wrangler types)가 wrangler.jsonc 를 읽어
// worker-configuration.d.ts 에 자동 생성합니다. 비밀 값(secret)만 여기서 보충합니다.
type Bindings = Env & {
  /** 삭제 API 용 관리자 토큰. 로컬은 .dev.vars, 배포는 `wrangler secret put ADMIN_TOKEN` */
  ADMIN_TOKEN?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

const nowSec = () => Math.floor(Date.now() / 1000);

// ─────────────────────────────────────────────────────────────
// 홈 화면
// ─────────────────────────────────────────────────────────────
app.get("/", (c) => c.html(HOME_HTML));

// ─────────────────────────────────────────────────────────────
// 1) 링크 생성
// ─────────────────────────────────────────────────────────────
app.post("/api/links", async (c) => {
  // (선택) Rate Limiting 바인딩: IP 별로 60초에 10회까지만 허용
  const ip = c.req.header("cf-connecting-ip") ?? "local";
  const { success } = await c.env.CREATE_LIMITER.limit({ key: ip });
  if (!success) return c.json({ error: "요청이 너무 많습니다. 잠시 후 다시 시도하세요." }, 429);

  // 요청 본문 파싱
  let body: { url?: string; title?: string; code?: string; ttlDays?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "JSON 본문이 필요합니다." }, 400);
  }

  const url = normalizeUrl(body.url ?? "");
  if (!url) return c.json({ error: "http(s) URL 을 입력하세요." }, 400);

  if (body.code !== undefined && !isValidCustomCode(body.code)) {
    return c.json({ error: "코드는 영문·숫자·-·_ 3~32자만 쓸 수 있습니다." }, 400);
  }

  const ttlDays = body.ttlDays;
  if (ttlDays !== undefined && !(Number.isInteger(ttlDays) && ttlDays > 0 && ttlDays <= 3650)) {
    return c.json({ error: "ttlDays 는 1~3650 사이 정수여야 합니다." }, 400);
  }

  const createdAt = nowSec();
  const expiresAt = ttlDays ? createdAt + ttlDays * 86400 : null;
  const title = body.title?.slice(0, 200) ?? null;

  // 코드 중복 검사는 D1 의 PRIMARY KEY 제약으로 합니다.
  // KV 는 최종 일관성(다른 지역 반영에 최대 ~60초)이라 "있는지 먼저 읽고 쓰기" 방식은 경쟁 상태에 약합니다.
  // → 강한 일관성을 가진 D1 을 "정답(source of truth)", KV 를 "빠른 조회용 사본"으로 씁니다.
  const length = Number(c.env.CODE_LENGTH) || 6;
  const maxTries = body.code ? 1 : 5;
  let code = "";
  for (let i = 0; i < maxTries; i++) {
    code = body.code ?? generateCode(length);
    try {
      await c.env.DB.prepare(
        "INSERT INTO links (code, url, title, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)",
      )
        .bind(code, url, title, createdAt, expiresAt)
        .run();
      break; // 성공
    } catch (err) {
      const isDuplicate = String(err).includes("UNIQUE constraint failed");
      if (!isDuplicate) throw err;
      if (body.code) return c.json({ error: `이미 사용 중인 코드입니다: ${code}` }, 409);
      if (i === maxTries - 1) return c.json({ error: "코드 생성에 실패했습니다. 다시 시도하세요." }, 500);
      // 자동 생성 코드가 우연히 겹치면 새 코드로 재시도
    }
  }

  // KV 에 코드 → URL 저장. 만료가 있으면 expirationTtl(초)로 KV 가 알아서 지웁니다.
  await c.env.LINKS.put(code, url, expiresAt ? { expirationTtl: expiresAt - createdAt } : undefined);

  const shortUrl = new URL(`/${code}`, c.req.url).toString();
  return c.json({ code, url, title, shortUrl, createdAt, expiresAt }, 201);
});

// ─────────────────────────────────────────────────────────────
// 2) 최근 링크 목록 (D1)
// ─────────────────────────────────────────────────────────────
app.get("/api/links", async (c) => {
  const limit = Math.min(Number(c.req.query("limit")) || 20, 100);
  // 상관 서브쿼리의 COUNT 는 idx_clicks_code_time 인덱스를 타므로 전체 스캔하지 않습니다.
  const { results } = await c.env.DB.prepare(
    `SELECT l.code, l.url, l.title, l.created_at AS createdAt, l.expires_at AS expiresAt,
            (SELECT COUNT(*) FROM clicks k WHERE k.code = l.code) AS clicks
       FROM links l
      ORDER BY l.created_at DESC
      LIMIT ?1`,
  )
    .bind(limit)
    .all();
  return c.json({ links: results });
});

// ─────────────────────────────────────────────────────────────
// 3) 클릭 통계 (D1 SQL 집계)
// ─────────────────────────────────────────────────────────────
app.get("/api/stats/:code", async (c) => {
  const code = c.req.param("code");
  const link = await c.env.DB.prepare(
    "SELECT code, url, title, created_at AS createdAt, expires_at AS expiresAt FROM links WHERE code = ?1",
  )
    .bind(code)
    .first();
  if (!link) return c.json({ error: "링크를 찾을 수 없습니다." }, 404);

  // batch() 는 여러 쿼리를 한 번의 왕복으로 보냅니다. (D1 은 Worker 와 다른 위치에 있을 수 있으므로 왕복 수를 줄이는 게 중요)
  const [total, byCountry, byReferer, byDay] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM clicks WHERE code = ?1").bind(code),
    c.env.DB.prepare(
      `SELECT COALESCE(country, 'unknown') AS country, COUNT(*) AS clicks
         FROM clicks WHERE code = ?1
        GROUP BY country ORDER BY clicks DESC`,
    ).bind(code),
    c.env.DB.prepare(
      `SELECT COALESCE(referer, 'direct') AS referer, COUNT(*) AS clicks
         FROM clicks WHERE code = ?1
        GROUP BY referer ORDER BY clicks DESC LIMIT 10`,
    ).bind(code),
    // 최근 30일 일별 클릭 수 (UTC 기준 날짜)
    c.env.DB.prepare(
      `SELECT date(clicked_at, 'unixepoch') AS day, COUNT(*) AS clicks
         FROM clicks WHERE code = ?1 AND clicked_at >= ?2
        GROUP BY day ORDER BY day`,
    ).bind(code, nowSec() - 30 * 86400),
  ]);

  return c.json({
    link,
    totalClicks: (total.results[0] as { n: number }).n,
    byCountry: byCountry.results,
    byReferer: byReferer.results,
    byDay: byDay.results,
  });
});

// ─────────────────────────────────────────────────────────────
// 4) 링크 삭제 (관리자 전용)
// ─────────────────────────────────────────────────────────────
app.delete("/api/links/:code", async (c) => {
  const token = c.env.ADMIN_TOKEN;
  if (!token || c.req.header("authorization") !== `Bearer ${token}`) {
    return c.json({ error: "권한이 없습니다." }, 401);
  }
  const code = c.req.param("code");
  // clicks 는 FOREIGN KEY ... ON DELETE CASCADE 로 함께 지워집니다.
  const { meta } = await c.env.DB.prepare("DELETE FROM links WHERE code = ?1").bind(code).run();
  await c.env.LINKS.delete(code);
  if (meta.changes === 0) return c.json({ error: "링크를 찾을 수 없습니다." }, 404);
  return c.json({ deleted: code });
});

// ─────────────────────────────────────────────────────────────
// 5) 리다이렉트 (가장 많이 호출되는 경로 → KV 로 빠르게)
// ─────────────────────────────────────────────────────────────
app.get("/:code", async (c) => {
  const code = c.req.param("code");

  // ① KV 에서 먼저 찾습니다. (엣지 캐시 덕분에 매우 빠름)
  //    cacheTtl: 이 엣지 위치에서 값을 캐시할 시간(초, 최소 60)
  let url = await c.env.LINKS.get(code, { cacheTtl: 300 });

  // ② KV 에 없으면 D1 에서 한 번 더 찾습니다.
  //    방금 만든 링크가 다른 지역 KV 에 아직 반영되지 않았을 수 있기 때문입니다(최종 일관성).
  if (!url) {
    const row = await c.env.DB.prepare(
      "SELECT url FROM links WHERE code = ?1 AND (expires_at IS NULL OR expires_at > ?2)",
    )
      .bind(code, nowSec())
      .first<{ url: string }>();
    if (!row) return c.json({ error: "링크를 찾을 수 없습니다." }, 404);
    url = row.url;
  }

  // ③ 클릭 로그는 응답을 막지 않도록 waitUntil 로 "응답 후"에 기록합니다.
  //    request.cf 에는 Cloudflare 가 붙여 주는 국가·도시·ASN 등의 정보가 들어 있습니다.
  const cf = c.req.raw.cf as { country?: string } | undefined;
  c.executionCtx.waitUntil(
    c.env.DB.prepare("INSERT INTO clicks (code, clicked_at, country, referer) VALUES (?1, ?2, ?3, ?4)")
      .bind(code, nowSec(), cf?.country ?? null, refererHost(c.req.header("referer") ?? null))
      .run()
      .catch((err) => console.error("클릭 기록 실패", code, err)),
  );

  return c.redirect(url, 302);
});

// ─────────────────────────────────────────────────────────────
// Worker 내보내기: fetch(HTTP) + scheduled(Cron)
// ─────────────────────────────────────────────────────────────
export default {
  fetch: app.fetch,

  // Cron Trigger: 만료된 링크를 D1 에서 정리 (KV 는 expirationTtl 로 이미 자동 삭제됨)
  async scheduled(_controller, env, ctx) {
    const now = nowSec();
    const { results } = await env.DB.prepare(
      "SELECT code FROM links WHERE expires_at IS NOT NULL AND expires_at <= ?1 LIMIT 500",
    )
      .bind(now)
      .all<{ code: string }>();

    if (results.length === 0) return;

    await env.DB.batch(results.map((r) => env.DB.prepare("DELETE FROM links WHERE code = ?1").bind(r.code)));
    // 혹시 남아 있을 KV 값도 지웁니다.
    ctx.waitUntil(Promise.all(results.map((r) => env.LINKS.delete(r.code))));
    console.log(`만료 링크 ${results.length}개 정리`);
  },
} satisfies ExportedHandler<Bindings>;
