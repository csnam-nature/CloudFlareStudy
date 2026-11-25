-- 최초 스키마
-- 적용: npm run db:migrate:local  (원격은 db:migrate:remote)
--
-- 역할 분리: 사진 파일(바이너리)은 R2 에, "사진에 대한 정보"는 여기 D1 에 둡니다.
-- R2 키는 사진 id 로 정해집니다:  originals/<id>,  thumbs/<폭>/<id>.webp

-- 앨범
CREATE TABLE IF NOT EXISTS albums (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,      -- 같은 이름의 앨범은 만들 수 없음
  created_at  INTEGER NOT NULL           -- Unix epoch, 초
);

-- 사진 메타데이터
CREATE TABLE IF NOT EXISTS photos (
  id            TEXT PRIMARY KEY,        -- 무작위 12자 (R2 키에도 사용)
  album_id      INTEGER,                 -- NULL 이면 "앨범 없음"
  title         TEXT,
  filename      TEXT NOT NULL,           -- 올릴 때의 원래 파일 이름 (다운로드용)
  content_type  TEXT NOT NULL,           -- image/jpeg 등 (파일 앞부분 바이트로 판별)
  size          INTEGER NOT NULL,        -- 바이트
  width         INTEGER,                 -- Images 바인딩 info() 로 읽은 크기 (실패하면 NULL)
  height        INTEGER,
  taken_at      INTEGER,                 -- 촬영 시각 (EXIF, 없으면 NULL)
  created_at    INTEGER NOT NULL,        -- 업로드 시각
  sort_at       INTEGER NOT NULL,        -- 정렬 기준 = 촬영 시각, 없으면 업로드 시각
  -- 앨범을 지우면 사진은 남기고 "앨범 없음"으로 돌립니다.
  FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE SET NULL
);

-- 인덱스: D1 무료 플랜은 하루 "읽은 행 수"(500만) 한도를 넘으면 쿼리가 실패합니다.
-- 목록은 항상 sort_at 최신순 + 커서로 읽으므로, 그 순서 그대로 인덱스를 둡니다.
CREATE INDEX IF NOT EXISTS idx_photos_sort ON photos (sort_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_photos_album_sort ON photos (album_id, sort_at DESC, id DESC);
