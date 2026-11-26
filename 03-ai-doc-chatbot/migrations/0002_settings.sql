-- 관리 화면의 "설정" 값. 키 하나에 JSON 값 하나를 저장합니다.
-- 저장하지 않은 항목은 wrangler.jsonc(또는 .dev.vars)의 vars 가 기본값으로 쓰입니다.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
