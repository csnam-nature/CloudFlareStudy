// 사진 갤러리 Worker 진입점
//
// 요청이 들어오면 Cloudflare 가 먼저 경로를 봅니다.
//   /api/*, /img/*   → 이 Worker 코드가 처리 (wrangler.jsonc 의 assets.run_worker_first)
//   그 밖의 경로      → public/ 폴더의 정적 파일 (Worker 를 거치지 않음, 무료·무제한)
//
// 라우트 요약
//   /api/albums   앨범 목록·관리        → src/albums.ts  (D1)
//   /api/photos   사진 목록·업로드·수정·삭제 → src/photos.ts  (R2 + D1)
//   /img/:id      썸네일·원본          → src/images.ts  (R2 + Images)
//   /api/me       관리자 토큰 확인

import { Hono } from "hono";
import { albums } from "./albums";
import { type AppEnv, isAdmin } from "./auth";
import { images, THUMB_WIDTHS } from "./images";
import { photos } from "./photos";

const app = new Hono<AppEnv>();

app.route("/api/albums", albums);
app.route("/api/photos", photos);
app.route("/img", images);

// 화면에서 "관리자 토큰 저장"을 누를 때 토큰이 맞는지 확인하는 용도
app.get("/api/me", (c) =>
  c.json({ admin: isAdmin(c), maxUploadMb: Number(c.env.MAX_UPLOAD_MB) || 20, thumbWidths: THUMB_WIDTHS }),
);

app.notFound((c) => c.json({ error: "없는 경로입니다." }, 404));
app.onError((err, c) => {
  console.error("처리 중 오류", c.req.method, c.req.path, err);
  return c.json({ error: "서버 오류가 발생했습니다." }, 500);
});

export default app satisfies ExportedHandler<AppEnv["Bindings"]>;
