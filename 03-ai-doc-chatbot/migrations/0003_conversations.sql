-- 대화 목록과 폴더 (ChatGPT·Claude 의 왼쪽 사이드바처럼)
-- 로그인이 없으므로 "owner" 는 브라우저마다 만든 무작위 id 입니다(localStorage). 같은 브라우저에서만 목록이 보입니다.
-- 대화 내용(질문·답변)은 대화마다 하나씩 있는 ChatAgent(Durable Object)의 SQLite 에 있고, 여기에는 목록 정보만 둡니다.
CREATE TABLE IF NOT EXISTS folders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner      TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_folders_owner ON folders (owner);

CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT    PRIMARY KEY,           -- ChatAgent 인스턴스 이름(UUID)
  owner      TEXT    NOT NULL,
  folder_id  INTEGER,                       -- NULL = 폴더 없음
  title      TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_owner ON conversations (owner, updated_at DESC);
