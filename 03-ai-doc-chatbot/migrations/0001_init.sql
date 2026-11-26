-- 사내 문서 AI 챗봇 스키마
-- 적용: npm run db:migrate:local (연습 모드는 npm run db:migrate:mock, 배포 DB 는 npm run db:migrate:remote)

-- 올린 문서 한 건 = 한 행. 원본 파일은 R2 의 r2_key 에 있습니다.
CREATE TABLE documents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,              -- 화면에 보이는 이름(수정 가능)
  filename     TEXT    NOT NULL,              -- 올릴 때의 파일 이름(확장자로 형식 판단)
  r2_key       TEXT    NOT NULL,
  content_type TEXT    NOT NULL,
  size         INTEGER NOT NULL,
  -- queued(대기) → indexing(색인 중) → ready(완료) / failed(실패)
  status       TEXT    NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'indexing', 'ready', 'failed')),
  error        TEXT,                          -- 실패 이유
  chunk_count  INTEGER NOT NULL DEFAULT 0,
  char_count   INTEGER NOT NULL DEFAULT 0,    -- 추출한 텍스트 길이
  created_at   INTEGER NOT NULL,              -- unix 초
  updated_at   INTEGER NOT NULL,
  indexed_at   INTEGER
);
CREATE INDEX idx_documents_created ON documents (created_at DESC);

-- 청크 원문. Vectorize 에는 벡터만 넣고(같은 id), 답변에 넣을 원문은 여기서 꺼냅니다.
-- id 형식: "<문서id>:<순번>" 예) "12:0", "12:1"
CREATE TABLE chunks (
  id      TEXT    PRIMARY KEY,
  doc_id  INTEGER NOT NULL,
  seq     INTEGER NOT NULL,
  text    TEXT    NOT NULL
);
CREATE INDEX idx_chunks_doc ON chunks (doc_id, seq);

-- 연습 모드(MOCK_AI=1) 전용: Vectorize 대신 가짜 벡터를 여기에 둡니다. 진짜 AI 모드에서는 비어 있습니다.
CREATE TABLE mock_vectors (
  id      TEXT    PRIMARY KEY,
  doc_id  INTEGER NOT NULL,
  vec     TEXT    NOT NULL                    -- JSON 숫자 배열
);
CREATE INDEX idx_mock_vectors_doc ON mock_vectors (doc_id);
