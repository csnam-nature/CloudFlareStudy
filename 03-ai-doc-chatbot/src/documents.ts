// 문서 API: /api/documents
//
//   GET    /api/documents              목록 + 합계(누구나: 채팅 화면의 "문서 고르기"에도 씀)
//   POST   /api/documents              업로드(관리자) → R2 저장 → D1 기록 → 큐에 색인 작업
//   GET    /api/documents/:id/file     원본 열기·내려받기(누구나)
//   PATCH  /api/documents/:id          이름 수정(관리자)
//   POST   /api/documents/:id/reindex  다시 색인(관리자)
//   DELETE /api/documents/:id          삭제(관리자): R2 원본, D1 행·청크, Vectorize 벡터 모두

import { Hono } from "hono";
import { deleteVectors, extOf, SUPPORTED_EXT } from "./ai";
import { type AppEnv, type Bindings, nowSec, requireAdmin } from "./auth";

export const documents = new Hono<AppEnv>();

type DocRow = {
  id: number;
  name: string;
  filename: string;
  r2_key: string;
  content_type: string;
  size: number;
  status: "queued" | "indexing" | "ready" | "failed";
  error: string | null;
  chunk_count: number;
  char_count: number;
  created_at: number;
  updated_at: number;
  indexed_at: number | null;
};

/** DB 행을 화면에 보낼 모양(camelCase)으로 바꿉니다. */
const toJson = (d: DocRow) => ({
  id: d.id,
  name: d.name,
  filename: d.filename,
  contentType: d.content_type,
  size: d.size,
  status: d.status,
  error: d.error,
  chunkCount: d.chunk_count,
  charCount: d.char_count,
  createdAt: d.created_at,
  updatedAt: d.updated_at,
  indexedAt: d.indexed_at,
});

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
};

export async function getDoc(env: Bindings, id: number) {
  return env.DB.prepare("SELECT * FROM documents WHERE id = ?").bind(id).first<DocRow>();
}

const parseId = (s: string) => (/^\d+$/.test(s) ? Number(s) : NaN);

// 목록
documents.get("/", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM documents ORDER BY created_at DESC, id DESC LIMIT 500").all<DocRow>();
  const totalChunks = results.reduce((s, d) => s + d.chunk_count, 0);
  return c.json({ documents: results.map(toJson), totalChunks });
});

// 업로드 (multipart/form-data: file, name?)
documents.post("/", requireAdmin, async (c) => {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return c.json({ error: "file 필드에 파일을 넣어 주세요." }, 400);

  const ext = extOf(file.name);
  if (!(SUPPORTED_EXT as readonly string[]).includes(ext))
    return c.json({ error: `지원하는 형식은 ${SUPPORTED_EXT.join(", ").toUpperCase()} 입니다.` }, 400);
  const maxMb = Number(c.env.MAX_UPLOAD_MB) || 10;
  if (file.size === 0) return c.json({ error: "빈 파일입니다." }, 400);
  if (file.size > maxMb * 1024 * 1024) return c.json({ error: `파일은 ${maxMb}MB 까지 올릴 수 있습니다.` }, 413);

  const name = String(form?.get("name") ?? "").trim() || file.name.replace(/\.[^.]+$/, "");
  const now = nowSec();
  const contentType = CONTENT_TYPES[ext];

  // 1) D1 에 먼저 기록해 id 를 받고, 그 id 로 R2 키를 정합니다.
  const row = await c.env.DB.prepare(
    `INSERT INTO documents (name, filename, r2_key, content_type, size, status, created_at, updated_at)
     VALUES (?, ?, '', ?, ?, 'queued', ?, ?) RETURNING id`,
  )
    .bind(name.slice(0, 200), file.name.slice(0, 255), contentType, file.size, now, now)
    .first<{ id: number }>();
  const id = row!.id;
  const key = `docs/${id}.${ext}`;

  // 2) 원본을 R2 에 저장
  await c.env.FILES.put(key, file.stream(), { httpMetadata: { contentType } });
  await c.env.DB.prepare("UPDATE documents SET r2_key = ? WHERE id = ?").bind(key, id).run();

  // 3) 색인은 큐에 맡기고 바로 응답합니다. (업로드 응답이 무거운 AI 작업을 기다리지 않음)
  await c.env.INDEX_QUEUE.send({ docId: id });

  return c.json(toJson((await getDoc(c.env, id))!), 201);
});

// 원본 열기 (?download=1 이면 내려받기)
documents.get("/:id/file", async (c) => {
  const doc = await getDoc(c.env, parseId(c.req.param("id")));
  if (!doc) return c.json({ error: "문서를 찾을 수 없습니다." }, 404);
  const obj = await c.env.FILES.get(doc.r2_key);
  if (!obj) return c.json({ error: "원본 파일이 없습니다." }, 404);
  const disposition = c.req.query("download") ? "attachment" : "inline";
  return new Response(obj.body, {
    headers: {
      "content-type": doc.content_type,
      // 한글 파일 이름이 깨지지 않도록 RFC 5987 형식(filename*)을 씁니다.
      "content-disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(doc.filename)}`,
      "cache-control": "private, max-age=60",
    },
  });
});

// 이름 수정
documents.patch("/:id", requireAdmin, async (c) => {
  const id = parseId(c.req.param("id"));
  const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
  const name = String(body.name ?? "").trim();
  if (!name) return c.json({ error: "이름을 입력해 주세요." }, 400);
  const res = await c.env.DB.prepare("UPDATE documents SET name = ?, updated_at = ? WHERE id = ?")
    .bind(name.slice(0, 200), nowSec(), id)
    .run();
  if (!res.meta.changes) return c.json({ error: "문서를 찾을 수 없습니다." }, 404);
  return c.json(toJson((await getDoc(c.env, id))!));
});

// 다시 색인 (청크 크기를 바꿨거나, 실패한 문서를 다시 시도할 때)
documents.post("/:id/reindex", requireAdmin, async (c) => {
  const id = parseId(c.req.param("id"));
  const res = await c.env.DB.prepare("UPDATE documents SET status = 'queued', error = NULL, updated_at = ? WHERE id = ?")
    .bind(nowSec(), id)
    .run();
  if (!res.meta.changes) return c.json({ error: "문서를 찾을 수 없습니다." }, 404);
  await c.env.INDEX_QUEUE.send({ docId: id });
  return c.json(toJson((await getDoc(c.env, id))!));
});

// 삭제
documents.delete("/:id", requireAdmin, async (c) => {
  const id = parseId(c.req.param("id"));
  const doc = await getDoc(c.env, id);
  if (!doc) return c.json({ error: "문서를 찾을 수 없습니다." }, 404);
  await removeChunks(c.env, id);
  await c.env.FILES.delete(doc.r2_key);
  await c.env.DB.prepare("DELETE FROM documents WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

/** 문서의 청크를 D1 과 Vectorize(또는 mock_vectors)에서 모두 지웁니다. */
export async function removeChunks(env: Bindings, docId: number) {
  const { results } = await env.DB.prepare("SELECT id FROM chunks WHERE doc_id = ?").bind(docId).all<{ id: string }>();
  await deleteVectors(env, results.map((r) => r.id));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM chunks WHERE doc_id = ?").bind(docId),
    env.DB.prepare("DELETE FROM mock_vectors WHERE doc_id = ?").bind(docId),
  ]);
}
