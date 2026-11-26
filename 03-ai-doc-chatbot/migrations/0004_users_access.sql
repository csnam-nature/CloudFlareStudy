-- 직원 계정·권한(역할)·문서 그룹 (Cloudflare Zero Trust Access 연동)
--
-- 로그인은 Cloudflare Access 가 맡습니다(회사 메일 OTP·Google·Microsoft 등). Worker 는 Access 가 붙여 주는
-- 서명된 토큰(Cf-Access-Jwt-Assertion)을 검증해 "누구인지(이메일)"만 받고, "무엇을 할 수 있는지"는 이 표로 정합니다.
--
-- 역할(role)
--   admin    : 전부 (설정, 사용자·그룹 관리, 문서 관리)
--   manager  : 문서 올리기·수정·다시 색인·삭제, 모든 문서 보기
--   employee : 채팅, 자기에게 공개된 문서만 보기·검색
CREATE TABLE IF NOT EXISTS users (
  email      TEXT    PRIMARY KEY,          -- 소문자로 저장
  name       TEXT    NOT NULL DEFAULT '',
  role       TEXT    NOT NULL DEFAULT 'employee' CHECK (role IN ('admin', 'manager', 'employee')),
  active     INTEGER NOT NULL DEFAULT 1,   -- 0 = 사용 중지(로그인해도 403)
  created_at INTEGER NOT NULL,
  last_seen  INTEGER
);

-- 문서 공개 범위용 그룹(부서·팀). 예) 영업팀, 기술지원팀, 경영지원
CREATE TABLE IF NOT EXISTS groups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- 사용자 ↔ 그룹 (한 사람이 여러 그룹에 속할 수 있음)
CREATE TABLE IF NOT EXISTS user_groups (
  email    TEXT    NOT NULL,
  group_id INTEGER NOT NULL,
  PRIMARY KEY (email, group_id)
);
CREATE INDEX IF NOT EXISTS idx_user_groups_group ON user_groups (group_id);

-- 문서의 공개 범위: NULL = 전 직원, 숫자 = 그 그룹 사람만(관리자·매니저는 항상 전부 봄)
ALTER TABLE documents ADD COLUMN group_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_documents_group ON documents (group_id);
