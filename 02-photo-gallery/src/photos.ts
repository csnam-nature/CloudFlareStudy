// 사진 API (R2 + D1)
//
//   GET    /api/photos?album=&q=&cursor=&limit=   목록 (촬영일 최신순, 커서 페이지 나눔)
//   GET    /api/photos/:id                        사진 한 장의 정보
//   POST   /api/photos                            업로드 (multipart/form-data, 관리자)
//   PATCH  /api/photos/:id                        제목·앨범·촬영일 수정 (관리자)
//   DELETE /api/photos/:id                        삭제: D1 행 + R2 원본·썸네일 (관리자)
//
// 핵심: 파일(바이너리)은 R2, 파일에 대한 정보는 D1. 둘은 R2 키 = "originals/<사진 id>" 로 연결됩니다.

import { Hono } from "hono";
import { type AppEnv, nowSec, requireAdmin } from "./auth";
import { originalKey, thumbKey, THUMB_WIDTHS } from "./images";

export const photos = new Hono<AppEnv>();

// 사진 id: 영문·숫자 12자. URL·R2 키에 그대로 쓰므로 형식을 엄격히 검사합니다.
export const ID_PATTERN = "[A-Za-z0-9]{12}";
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

/**
 * 파일 앞부분 바이트(매직 넘버)로 이미지 형식을 판별합니다.
 * 브라우저가 보낸 Content-Type 은 믿지 않습니다(확장자만 바꾼 파일도 걸러 냄).
 */
function sniffImageType(b: Uint8Array): string | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(4, 8) === "ftyp" && ["avif", "avis"].includes(ascii(8, 12))) return "image/avif";
  return null;
}

// 목록·단건 조회에서 공통으로 쓰는 SELECT (앨범 이름은 LEFT JOIN 으로)
const PHOTO_COLUMNS = `
  p.id, p.title, p.filename, p.content_type AS contentType, p.size, p.width, p.height,
  p.album_id AS albumId, a.name AS albumName,
  p.taken_at AS takenAt, p.created_at AS createdAt, p.sort_at AS sortAt`;
const PHOTO_FROM = "FROM photos p LEFT JOIN albums a ON a.id = p.album_id";

type PhotoRow = { id: string; sortAt: number; [k: string]: unknown };

const getPhoto = (db: D1Database, id: string) =>
  db.prepare(`SELECT ${PHOTO_COLUMNS} ${PHOTO_FROM} WHERE p.id = ?1`).bind(id).first<PhotoRow>();

/** 촬영 시각: Unix 초(정수) 또는 null. 1970~2100 범위만 허용 */
function parseTakenAt(v: unknown): number | null | undefined {
  if (v === undefined || v === "") return undefined;
  if (v === null || v === "null") return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 4102444800 ? n : NaN;
}

/** 앨범 id: 양의 정수 또는 null(앨범 없음) */
function parseAlbumId(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "" || v === "null") return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : NaN;
}

// ─────────────────────────────────────────────────────────────
// 목록: 커서(cursor) 방식 페이지 나눔
// ─────────────────────────────────────────────────────────────
// OFFSET 방식은 뒤 페이지로 갈수록 앞의 행을 모두 읽고 버리므로 D1 "읽은 행 수"가 늘어납니다.
// 커서 방식은 "마지막으로 본 (sort_at, id) 보다 작은 것"을 인덱스로 바로 찾아 필요한 행만 읽습니다.
photos.get("/", async (c) => {
  const rawLimit = Number(c.req.query("limit"));
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 60) : 30;

  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, ...values: unknown[]) => {
    // ?1, ?2 … 번호를 순서대로 붙입니다.
    let s = sql;
    for (const v of values) {
      params.push(v);
      s = s.replace(/\?(?!\d)/, `?${params.length}`); // 아직 번호가 없는 첫 ? 만
    }
    where.push(s);
  };

  const album = c.req.query("album");
  if (album === "none") add("p.album_id IS NULL");
  else if (album) {
    const id = Number(album);
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "album 은 앨범 id 또는 none 입니다." }, 400);
    add("p.album_id = ?", id);
  }

  const q = c.req.query("q")?.trim();
  if (q) {
    // LIKE 는 인덱스를 못 쓰지만, 정렬 인덱스 순서로 읽다가 LIMIT 을 채우면 멈추므로 소규모 갤러리에선 충분합니다.
    const pattern = `%${q.slice(0, 50).replace(/[\\%_]/g, (m) => "\\" + m)}%`;
    add("(p.title LIKE ? ESCAPE '\\' OR p.filename LIKE ? ESCAPE '\\')", pattern, pattern);
  }

  const cursor = c.req.query("cursor");
  if (cursor) {
    const m = /^(\d+)_([A-Za-z0-9]{12})$/.exec(cursor);
    if (!m) return c.json({ error: "cursor 형식이 올바르지 않습니다." }, 400);
    add("(p.sort_at < ? OR (p.sort_at = ? AND p.id < ?))", Number(m[1]), Number(m[1]), m[2]);
  }

  params.push(limit + 1); // 한 개 더 읽어서 다음 페이지가 있는지 확인
  const sql = `SELECT ${PHOTO_COLUMNS} ${PHOTO_FROM}
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY p.sort_at DESC, p.id DESC
    LIMIT ?${params.length}`;
  const { results } = await c.env.DB.prepare(sql).bind(...params).all<PhotoRow>();

  const hasMore = results.length > limit;
  const page = hasMore ? results.slice(0, limit) : results;
  const last = page[page.length - 1];
  return c.json({ photos: page, nextCursor: hasMore && last ? `${last.sortAt}_${last.id}` : null });
});

photos.get(`/:id{${ID_PATTERN}}`, async (c) => {
  const photo = await getPhoto(c.env.DB, c.req.param("id"));
  if (!photo) return c.json({ error: "사진을 찾을 수 없습니다." }, 404);
  return c.json(photo);
});

// ─────────────────────────────────────────────────────────────
// 업로드: 브라우저 → Worker → R2 (+ D1 메타데이터)
// ─────────────────────────────────────────────────────────────
photos.post("/", requireAdmin, async (c) => {
  const maxBytes = (Number(c.env.MAX_UPLOAD_MB) || 20) * 1024 * 1024;

  // Content-Length 로 먼저 걸러 큰 파일을 끝까지 받지 않도록 합니다.
  const declared = Number(c.req.header("content-length"));
  if (declared > maxBytes + 64 * 1024) return c.json({ error: `파일은 ${c.env.MAX_UPLOAD_MB}MB 이하만 올릴 수 있습니다.` }, 413);

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "multipart/form-data 본문이 필요합니다." }, 400);
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return c.json({ error: "file 필드에 사진을 넣어 주세요." }, 400);
  if (file.size > maxBytes) return c.json({ error: `파일은 ${c.env.MAX_UPLOAD_MB}MB 이하만 올릴 수 있습니다.` }, 413);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const contentType = sniffImageType(bytes);
  if (!contentType) return c.json({ error: "JPEG, PNG, GIF, WebP, AVIF 사진만 올릴 수 있습니다." }, 400);

  const albumId = parseAlbumId(form.get("albumId") ?? undefined);
  const takenAt = parseTakenAt(form.get("takenAt") ?? undefined);
  if (Number.isNaN(albumId)) return c.json({ error: "albumId 가 올바르지 않습니다." }, 400);
  if (Number.isNaN(takenAt)) return c.json({ error: "takenAt 은 Unix 초 단위 정수여야 합니다." }, 400);

  const filename = (file.name || "photo").slice(0, 200);
  const titleField = form.get("title");
  const title = typeof titleField === "string" && titleField.trim() ? titleField.trim().slice(0, 200) : null;

  // Images 바인딩 info() 로 가로·세로 크기를 읽습니다. (실패해도 업로드는 계속)
  let width: number | null = null;
  let height: number | null = null;
  try {
    const info = await c.env.IMAGES.info(new Blob([bytes]).stream());
    if ("width" in info) ({ width, height } = info);
  } catch (err) {
    console.warn("이미지 크기 읽기 실패", err);
  }

  const id = newId();
  const createdAt = nowSec();

  // ① R2 에 원본 저장. httpMetadata 는 나중에 GET 할 때 Content-Type 등으로 그대로 돌려받습니다.
  await c.env.PHOTOS.put(originalKey(id), bytes, {
    httpMetadata: { contentType },
    customMetadata: { filename },
  });

  // ② D1 에 메타데이터 저장. R2 와 D1 은 하나의 트랜잭션으로 묶을 수 없으므로,
  //    D1 저장이 실패하면 방금 올린 R2 파일을 지워 "주인 없는 파일"이 남지 않게 합니다(보상 처리).
  try {
    await c.env.DB.prepare(
      `INSERT INTO photos (id, album_id, title, filename, content_type, size, width, height, taken_at, created_at, sort_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    )
      .bind(id, albumId ?? null, title, filename, contentType, bytes.byteLength, width, height, takenAt ?? null, createdAt, takenAt ?? createdAt)
      .run();
  } catch (err) {
    await c.env.PHOTOS.delete(originalKey(id));
    if (String(err).includes("FOREIGN KEY constraint failed")) return c.json({ error: "없는 앨범입니다." }, 400);
    throw err;
  }

  return c.json(await getPhoto(c.env.DB, id), 201);
});

// ─────────────────────────────────────────────────────────────
// 수정: 제목, 앨범, 촬영일 (파일 자체는 바꾸지 않음)
// ─────────────────────────────────────────────────────────────
photos.patch(`/:id{${ID_PATTERN}}`, requireAdmin, async (c) => {
  const id = c.req.param("id");
  const body = await c.req
    .json<{ title?: string | null; albumId?: number | null; takenAt?: number | null }>()
    .catch(() => null);
  if (!body) return c.json({ error: "JSON 본문이 필요합니다." }, 400);

  const current = await c.env.DB.prepare("SELECT title, album_id, taken_at FROM photos WHERE id = ?1")
    .bind(id)
    .first<{ title: string | null; album_id: number | null; taken_at: number | null }>();
  if (!current) return c.json({ error: "사진을 찾을 수 없습니다." }, 404);

  const albumId = parseAlbumId(body.albumId);
  const takenAt = parseTakenAt(body.takenAt);
  if (Number.isNaN(albumId)) return c.json({ error: "albumId 가 올바르지 않습니다." }, 400);
  if (Number.isNaN(takenAt)) return c.json({ error: "takenAt 은 Unix 초 단위 정수여야 합니다." }, 400);

  // 보내지 않은 항목은 그대로, null·빈 문자열은 지우기
  const title = body.title === undefined ? current.title : body.title?.trim() ? body.title.trim().slice(0, 200) : null;
  const nextAlbum = albumId === undefined ? current.album_id : albumId;
  const nextTaken = takenAt === undefined ? current.taken_at : takenAt;

  try {
    // 촬영일이 바뀌면 정렬 기준(sort_at)도 함께 바뀝니다. 촬영일을 지우면 업로드 시각으로 돌아갑니다.
    await c.env.DB.prepare(
      "UPDATE photos SET title = ?1, album_id = ?2, taken_at = ?3, sort_at = COALESCE(?3, created_at) WHERE id = ?4",
    )
      .bind(title, nextAlbum, nextTaken, id)
      .run();
  } catch (err) {
    if (String(err).includes("FOREIGN KEY constraint failed")) return c.json({ error: "없는 앨범입니다." }, 400);
    throw err;
  }
  return c.json(await getPhoto(c.env.DB, id));
});

// ─────────────────────────────────────────────────────────────
// 삭제: D1 행을 먼저 지우고(목록에서 바로 사라짐) R2 원본·썸네일을 지웁니다.
// ─────────────────────────────────────────────────────────────
photos.delete(`/:id{${ID_PATTERN}}`, requireAdmin, async (c) => {
  const id = c.req.param("id");
  const { meta } = await c.env.DB.prepare("DELETE FROM photos WHERE id = ?1").bind(id).run();
  if (meta.changes === 0) return c.json({ error: "사진을 찾을 수 없습니다." }, 404);
  // R2 delete() 는 키 배열을 받아 한 번에 지웁니다(최대 1000개). 없는 키는 그냥 무시됩니다.
  await c.env.PHOTOS.delete([originalKey(id), ...THUMB_WIDTHS.map((w) => thumbKey(id, w))]);
  return c.json({ deleted: id });
});
