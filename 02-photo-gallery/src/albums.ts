// 앨범 API (D1 만 사용)
//
//   GET    /api/albums        앨범 목록 + 사진 수 + 대표 사진
//   POST   /api/albums        앨범 만들기            (관리자)
//   PATCH  /api/albums/:id    앨범 이름 바꾸기       (관리자)
//   DELETE /api/albums/:id    앨범 지우기, 사진은 "앨범 없음"으로 (관리자)

import { Hono } from "hono";
import { type AppEnv, nowSec, requireAdmin } from "./auth";

export const albums = new Hono<AppEnv>();

/** 앨범 이름: 앞뒤 공백 제거, 1~50자 */
function cleanName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  return trimmed.length >= 1 && trimmed.length <= 50 ? trimmed : null;
}

const isDuplicate = (err: unknown) => String(err).includes("UNIQUE constraint failed");

albums.get("/", async (c) => {
  // 사진 수·대표 사진은 상관 서브쿼리로 구합니다. idx_photos_album_sort 인덱스를 타므로 앨범마다 전체 스캔하지 않습니다.
  const [list, totals] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT a.id, a.name, a.created_at AS createdAt,
              (SELECT COUNT(*) FROM photos p WHERE p.album_id = a.id) AS photoCount,
              (SELECT p.id FROM photos p WHERE p.album_id = a.id ORDER BY p.sort_at DESC, p.id DESC LIMIT 1) AS coverId
         FROM albums a
        ORDER BY a.name`,
    ),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(album_id IS NULL), 0) AS unassigned FROM photos`,
    ),
  ]);
  const t = totals.results[0] as { total: number; unassigned: number };
  return c.json({ albums: list.results, total: t.total, unassigned: t.unassigned });
});

albums.post("/", requireAdmin, async (c) => {
  const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
  const name = cleanName(body.name);
  if (!name) return c.json({ error: "앨범 이름은 1~50자로 입력하세요." }, 400);
  try {
    const row = await c.env.DB.prepare("INSERT INTO albums (name, created_at) VALUES (?1, ?2) RETURNING id")
      .bind(name, nowSec())
      .first<{ id: number }>();
    return c.json({ id: row!.id, name }, 201);
  } catch (err) {
    if (isDuplicate(err)) return c.json({ error: `이미 있는 앨범입니다: ${name}` }, 409);
    throw err;
  }
});

albums.patch("/:id{[0-9]+}", requireAdmin, async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
  const name = cleanName(body.name);
  if (!name) return c.json({ error: "앨범 이름은 1~50자로 입력하세요." }, 400);
  try {
    const { meta } = await c.env.DB.prepare("UPDATE albums SET name = ?1 WHERE id = ?2").bind(name, id).run();
    if (meta.changes === 0) return c.json({ error: "앨범을 찾을 수 없습니다." }, 404);
    return c.json({ id, name });
  } catch (err) {
    if (isDuplicate(err)) return c.json({ error: `이미 있는 앨범입니다: ${name}` }, 409);
    throw err;
  }
});

albums.delete("/:id{[0-9]+}", requireAdmin, async (c) => {
  const id = Number(c.req.param("id"));
  // photos.album_id 는 FOREIGN KEY ... ON DELETE SET NULL 이라 사진은 남고 "앨범 없음"이 됩니다.
  const { meta } = await c.env.DB.prepare("DELETE FROM albums WHERE id = ?1").bind(id).run();
  if (meta.changes === 0) return c.json({ error: "앨범을 찾을 수 없습니다." }, 404);
  return c.json({ deleted: id });
});
