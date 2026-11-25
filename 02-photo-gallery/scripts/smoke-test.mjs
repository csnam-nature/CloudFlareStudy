// 로컬 동작 확인용 스모크 테스트
// 사용법: (창 1) npm run dev   (창 2) npm run smoke
// 배포한 주소를 시험하려면 (PowerShell):
//   $env:BASE_URL="https://photo-gallery.<계정>.workers.dev"; $env:ADMIN_TOKEN="<토큰>"; npm run smoke
//
// 외부 라이브러리 없이 작은 PNG 를 직접 만들어 올린 뒤, 목록 → 썸네일 → 원본 → 수정 → 삭제를 확인하고
// 만든 데이터는 마지막에 모두 지웁니다.

import { deflateSync } from "node:zlib";

const BASE = process.env.BASE_URL ?? "http://localhost:8787";
const ADMIN = process.env.ADMIN_TOKEN ?? "local-admin-token";
const auth = { authorization: `Bearer ${ADMIN}` };
let failed = 0;

function check(name, cond, extra = "") {
  console.log(`${cond ? "✅" : "❌"} ${name}${extra ? "  " + extra : ""}`);
  if (!cond) failed++;
}

/** width×height 단색 PNG 를 만듭니다. */
function makePng(width, height, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 비트 깊이
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).map((_, i) => [r, g, b][i % 3])]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function upload(bytes, filename, fields = {}, headers = auth) {
  const form = new FormData();
  form.append("file", new Blob([bytes]), filename);
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  const res = await fetch(`${BASE}/api/photos`, { method: "POST", headers, body: form });
  return { res, data: await res.json() };
}

const json = (method, path, body) =>
  fetch(`${BASE}${path}`, { method, headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });

// 1. 앨범 만들기
const albumName = `스모크-${Date.now()}`;
let res = await json("POST", "/api/albums", { name: albumName });
const album = await res.json();
check("POST /api/albums → 201", res.status === 201, JSON.stringify(album));
res = await json("POST", "/api/albums", { name: albumName });
check("같은 이름 앨범 → 409", res.status === 409);

// 2. 업로드: 토큰 없음 / 사진 아님 / 정상
const png = makePng(640, 480, [243, 128, 32]);
let up = await upload(png, "noauth.png", {}, {});
check("토큰 없이 업로드 → 401", up.res.status === 401);
up = await upload(Buffer.from("this is not an image"), "fake.jpg");
check("사진이 아닌 파일 → 400", up.res.status === 400, up.data.error);

const takenAt = 1735700000; // 2025-01-01 전후
up = await upload(png, "주황 사진.png", { albumId: album.id, takenAt, title: "스모크 테스트" });
const photo = up.data;
check("POST /api/photos → 201", up.res.status === 201, JSON.stringify(photo));
check("형식은 바이트로 판별 (image/png)", photo.contentType === "image/png");
check("크기는 Images info() 로 읽음 (640×480)", photo.width === 640 && photo.height === 480, `${photo.width}×${photo.height}`);
check("촬영일이 정렬 기준", photo.sortAt === takenAt);

const up2 = await upload(makePng(320, 240, [40, 120, 220]), "파랑.png");
const photo2 = up2.data;
check("앨범 없이 업로드 → 201", up2.res.status === 201);

// 3. 목록
res = await fetch(`${BASE}/api/photos?album=${album.id}`);
let list = await res.json();
check("앨범으로 거르기", list.photos.length === 1 && list.photos[0].id === photo.id);
res = await fetch(`${BASE}/api/photos?q=${encodeURIComponent("스모크")}`);
list = await res.json();
check("제목 검색", list.photos.some((p) => p.id === photo.id));
res = await fetch(`${BASE}/api/photos?limit=1`);
list = await res.json();
check("limit=1 이면 nextCursor 가 있음", list.photos.length === 1 && !!list.nextCursor, list.nextCursor);
res = await fetch(`${BASE}/api/photos?limit=1&cursor=${list.nextCursor}`);
const page2 = await res.json();
check("다음 페이지는 다른 사진", page2.photos.length === 1 && page2.photos[0].id !== list.photos[0].id);
res = await fetch(`${BASE}/api/albums`);
const albums = await res.json();
check("앨범 목록에 사진 수", albums.albums.find((a) => a.id === album.id)?.photoCount === 1);

// 4. 썸네일: 처음엔 변환(MISS), 두 번째는 R2 에서(HIT)
res = await fetch(`${BASE}/img/${photo.id}?w=200`);
const thumb = Buffer.from(await res.arrayBuffer());
const first = res.headers.get("x-thumb");
check("썸네일 200 응답", res.status === 200, `x-thumb=${first} type=${res.headers.get("content-type")} ${thumb.length}B`);
check("썸네일은 WebP 로 변환", res.headers.get("content-type") === "image/webp" && thumb.subarray(8, 12).toString() === "WEBP");
res = await fetch(`${BASE}/img/${photo.id}?w=200`);
check("두 번째 요청은 R2 에 저장된 썸네일 (HIT)", res.headers.get("x-thumb") === "HIT");
const etag = res.headers.get("etag");
res = await fetch(`${BASE}/img/${photo.id}?w=200`, { headers: { "if-none-match": etag } });
check("ETag 가 같으면 304", res.status === 304);
res = await fetch(`${BASE}/img/${photo.id}?w=333`);
check("허용하지 않은 폭 → 400", res.status === 400);

// 5. 원본
res = await fetch(`${BASE}/img/${photo.id}/original`);
const orig = Buffer.from(await res.arrayBuffer());
check("원본은 올린 바이트 그대로", res.status === 200 && orig.equals(png) && res.headers.get("content-type") === "image/png");
res = await fetch(`${BASE}/img/${photo.id}/original?download=1`);
check("다운로드는 한글 파일 이름 유지", (res.headers.get("content-disposition") ?? "").includes(encodeURIComponent("주황 사진.png")));

// 6. 수정: 제목, 앨범 이동, 촬영일 지우기
res = await json("PATCH", `/api/photos/${photo2.id}`, { title: "파랑", albumId: album.id });
const edited = await res.json();
check("PATCH 제목·앨범", res.status === 200 && edited.title === "파랑" && edited.albumName === albumName);
res = await json("PATCH", `/api/photos/${photo.id}`, { takenAt: null });
const cleared = await res.json();
check("촬영일을 지우면 업로드 시각으로 정렬", cleared.takenAt === null && cleared.sortAt === cleared.createdAt);
res = await json("PATCH", `/api/photos/${photo.id}`, { albumId: 99999999 });
check("없는 앨범으로 이동 → 400", res.status === 400);

// 7. 앨범 삭제 → 사진은 "앨범 없음"으로
res = await json("PATCH", `/api/albums/${album.id}`, { name: `${albumName}-바뀜` });
check("앨범 이름 바꾸기", res.status === 200);
res = await fetch(`${BASE}/api/albums/${album.id}`, { method: "DELETE", headers: auth });
check("앨범 삭제", res.status === 200);
res = await fetch(`${BASE}/api/photos/${photo.id}`);
check("앨범을 지워도 사진은 남음 (albumId=null)", (await res.json()).albumId === null);

// 8. 사진 삭제 → D1 과 R2 모두에서 사라짐
for (const p of [photo, photo2]) {
  res = await fetch(`${BASE}/api/photos/${p.id}`, { method: "DELETE", headers: auth });
  check(`사진 삭제 ${p.id}`, res.status === 200);
}
res = await fetch(`${BASE}/api/photos/${photo.id}`);
check("삭제 후 정보 → 404", res.status === 404);
res = await fetch(`${BASE}/img/${photo.id}/original`);
check("삭제 후 원본 → 404", res.status === 404);
res = await fetch(`${BASE}/img/${photo.id}?w=200`);
check("삭제 후 썸네일 → 404", res.status === 404);

console.log(failed ? `\n${failed}개 실패` : "\n모두 통과");
process.exit(failed ? 1 : 0);
