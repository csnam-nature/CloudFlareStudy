// 이미지 제공: 썸네일(Images 바인딩 + R2 저장)과 원본
//
//   GET /img/:id?w=400       썸네일 (WebP). w 는 200·400·800·1600 중 하나
//   GET /img/:id/original    원본 (?download=1 이면 파일로 내려받기)
//
// 썸네일 흐름
//   ① R2 에서 thumbs/<w>/<id>.webp 를 찾는다            → 있으면 바로 응답 (X-Thumb: HIT)
//   ② 없으면 R2 원본을 Images 바인딩으로 줄여 WebP 변환 → R2 에 저장 후 응답 (X-Thumb: MISS)
//   ③ 변환이 실패하면 원본을 그대로 보낸다               → 화면은 깨지지 않음 (X-Thumb: FALLBACK)
//
// 왜 Cache API 가 아니라 R2 에 저장하나?
//   Cache API 는 workers.dev 주소에서는 동작하지 않습니다(커스텀 도메인에서만 동작).
//   R2 에 한 번 저장해 두면 주소와 상관없이 "사진 한 장·크기 하나당 변환 1번"이 보장되어
//   Images 무료 한도(월 5,000건)를 아낄 수 있습니다.

import { Hono } from "hono";
import type { AppEnv } from "./auth";

export const images = new Hono<AppEnv>();

/** 허용하는 썸네일 폭. 마음대로 폭을 받으면 변환 종류가 무한히 늘어 무료 한도를 금방 씁니다. */
export const THUMB_WIDTHS = [200, 400, 800, 1600] as const;

export const originalKey = (id: string) => `originals/${id}`;
export const thumbKey = (id: string, w: number) => `thumbs/${w}/${id}.webp`;

// 사진 id 는 바뀌지 않고 같은 id 의 내용도 바뀌지 않으므로 브라우저가 1년 동안 캐시해도 됩니다.
const IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * R2 객체를 HTTP 응답으로 바꿉니다.
 * get() 에 onlyIf: 요청 헤더를 넘기면 If-None-Match 등을 R2 가 직접 비교해 주고,
 * 조건이 맞지 않으면 본문 없는 객체를 돌려줍니다 → 304 Not Modified.
 */
function r2Response(obj: R2Object | R2ObjectBody, extra: Record<string, string> = {}): Response {
  const headers = new Headers(extra);
  obj.writeHttpMetadata(headers); // 저장할 때 넣은 Content-Type 등
  headers.set("etag", obj.httpEtag);
  headers.set("cache-control", IMMUTABLE);
  if (!("body" in obj)) return new Response(null, { status: 304, headers });
  headers.set("content-length", String(obj.size));
  return new Response(obj.body, { headers });
}

images.get("/:id{[A-Za-z0-9]{12}}/original", async (c) => {
  const id = c.req.param("id");
  const obj = await c.env.PHOTOS.get(originalKey(id), { onlyIf: c.req.raw.headers });
  if (!obj) return c.json({ error: "사진을 찾을 수 없습니다." }, 404);

  const extra: Record<string, string> = {};
  if (c.req.query("download")) {
    const name = obj.customMetadata?.filename ?? `${id}`;
    // 한글 파일 이름은 filename* (RFC 5987) 으로 인코딩해야 깨지지 않습니다.
    extra["content-disposition"] = `attachment; filename="photo"; filename*=UTF-8''${encodeURIComponent(name)}`;
  }
  return r2Response(obj, extra);
});

images.get("/:id{[A-Za-z0-9]{12}}", async (c) => {
  const id = c.req.param("id");
  const w = Number(c.req.query("w") ?? 400);
  if (!(THUMB_WIDTHS as readonly number[]).includes(w)) {
    return c.json({ error: `w 는 ${THUMB_WIDTHS.join(", ")} 중 하나여야 합니다.` }, 400);
  }

  // ① 이미 만든 썸네일이 R2 에 있으면 그대로 응답
  const cached = await c.env.PHOTOS.get(thumbKey(id, w), { onlyIf: c.req.raw.headers });
  if (cached) return r2Response(cached, { "x-thumb": "HIT" });

  const original = await c.env.PHOTOS.get(originalKey(id));
  if (!original) return c.json({ error: "사진을 찾을 수 없습니다." }, 404);

  // 원본 바이트를 한 번 읽어 두면 변환 실패 시 그대로 돌려줄 수 있습니다. (최대 20MB)
  const bytes = await original.arrayBuffer();

  try {
    // ② Images 바인딩: 입력 스트림 → transform(크기) → output(형식)
    //    fit: "scale-down" 은 원본보다 크게 늘리지 않습니다.
    const result = await c.env.IMAGES.input(new Blob([bytes]).stream())
      .transform({ width: w, fit: "scale-down" })
      .output({ format: "image/webp", quality: 80 });
    const thumb = await result.response().arrayBuffer();

    // 만든 썸네일을 R2 에 저장 (다음부터는 ① 에서 끝남)
    const saved = await c.env.PHOTOS.put(thumbKey(id, w), thumb, {
      httpMetadata: { contentType: result.contentType() },
    });
    return new Response(thumb, {
      headers: {
        "content-type": result.contentType(),
        "cache-control": IMMUTABLE,
        etag: saved?.httpEtag ?? "",
        "x-thumb": "MISS",
      },
    });
  } catch (err) {
    // ③ 변환 실패(무료 한도 초과, 로컬 환경 제약 등) → 원본을 짧게만 캐시해서 보냅니다.
    console.warn("썸네일 변환 실패, 원본으로 대체", id, w, err);
    return new Response(bytes, {
      headers: {
        "content-type": original.httpMetadata?.contentType ?? "application/octet-stream",
        "cache-control": "public, max-age=60",
        "x-thumb": "FALLBACK",
      },
    });
  }
});
