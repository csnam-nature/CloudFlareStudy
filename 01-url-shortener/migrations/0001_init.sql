-- 최초 스키마
-- 적용: npm run db:migrate:local  (원격은 db:migrate:remote)
-- D1 은 SQLite 문법을 그대로 씁니다.

-- 링크 메타데이터 (원본 URL 은 KV 에도 있지만, 목록·검색·통계를 위해 D1 에도 둡니다)
CREATE TABLE IF NOT EXISTS links (
  code        TEXT PRIMARY KEY,          -- 단축 코드 (예: abc12X)
  url         TEXT NOT NULL,             -- 원래 URL
  title       TEXT,                      -- 사람이 알아보기 위한 제목 (선택)
  created_at  INTEGER NOT NULL,          -- 생성 시각 (Unix epoch, 초)
  expires_at  INTEGER                    -- 만료 시각 (NULL 이면 무기한)
);

-- 클릭 로그: 리다이렉트할 때마다 한 줄씩 쌓입니다.
CREATE TABLE IF NOT EXISTS clicks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL,
  clicked_at  INTEGER NOT NULL,          -- Unix epoch, 초
  country     TEXT,                      -- request.cf.country (예: KR)
  referer     TEXT,                      -- Referer 헤더의 호스트만 저장
  FOREIGN KEY (code) REFERENCES links(code) ON DELETE CASCADE
);

-- 인덱스: D1 무료 플랜은 "읽은 행 수" 한도가 있으므로 전체 스캔을 피해야 합니다.
-- 통계 쿼리는 항상 code 로 거르므로 (code, clicked_at) 복합 인덱스를 둡니다.
CREATE INDEX IF NOT EXISTS idx_clicks_code_time ON clicks (code, clicked_at);
-- 만료 정리(Cron)용 인덱스
CREATE INDEX IF NOT EXISTS idx_links_expires ON links (expires_at);
