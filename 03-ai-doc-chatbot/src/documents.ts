// 문서 API: /api/documents
//
//   GET    /api/documents              목록 + 합계(로그인한 사람: 자기가 볼 수 있는 문서만. 채팅 화면의 "검색 범위"에도 씀)
//   POST   /api/documents              업로드(매니저 이상) → R2 저장 → D1 기록 → 큐에 색인 작업
//   GET    /api/documents/:id/file     원본 열기·내려받기(볼 수 있는 문서만)
//   PATCH  /api/documents/:id          이름·공개 범위(그룹) 수정(매니저 이상)
//   POST   /api/documents/:id/reindex  다시 색인(매니저 이상)
//   DELETE /api/documents/:id          삭제(매니저 이상): R2 원본, D1 행·청크, Vectorize 벡터 모두
//   DELETE /api/documents?confirm=all  모두 삭제(관리자): 실수로 부르지 않도록 confirm=all 이 있어야 합니다
//
// 공개 범위: documents.group_id 가 NULL 이면 전 직원, 숫자면 그 그룹 사람만 봅니다(매니저·관리자는 전부).
// 직원에게 안 보이는 문서는 목록·원본 열기뿐 아니라 채팅 검색(src/rag.ts retrieve)에서도 빠집니다.

import { Hono } from "hono";
import { deleteVectors, extOf, isImageExt, SUPPORTED_EXT } from "./ai";
import { type AppEnv, type Bindings, canSeeDoc, docScope, nowSec, requireAdmin, requireRole, scopeSql } from "./auth";

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
  group_id: number | null;
  group_name: string | null; // groups 표와 JOIN 한 값
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
  groupId: d.group_id,
  groupName: d.group_name,
});

const requireManager = requireRole("manager");

/** 그룹 id 입력 확인: 빈 값·null = 전 직원(null), 없는 그룹이면 undefined */
async function parseGroup(env: Bindings, v: unknown): Promise<number | null | undefined> {
  if (v === null || v === undefined || v === "") return null;
  const id = Number(v);
  if (!Number.isInteger(id) || id <= 0) return undefined;
  return (await env.DB.prepare("SELECT 1 FROM groups WHERE id = ?").bind(id).first()) ? id : undefined;
}

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  hwpx: "application/hwp+zip",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroenabled.12",
  xls: "application/vnd.ms-excel",
  csv: "text/csv",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
};

export async function getDoc(env: Bindings, id: number) {
  return env.DB.prepare("SELECT d.*, g.name AS group_name FROM documents d LEFT JOIN groups g ON g.id = d.group_id WHERE d.id = ?")
    .bind(id)
    .first<DocRow>();
}

const parseId = (s: string) => (/^\d+$/.test(s) ? Number(s) : NaN);

// 목록
documents.get("/", async (c) => {
  const vis = scopeSql(docScope(c.get("user")), "d");
  const { results } = await c.env.DB.prepare(
    `SELECT d.*, g.name AS group_name FROM documents d LEFT JOIN groups g ON g.id = d.group_id
      WHERE 1 = 1${vis.sql} ORDER BY d.created_at DESC, d.id DESC LIMIT 500`,
  )
    .bind(...vis.args)
    .all<DocRow>();
  const totalChunks = results.reduce((s, d) => s + d.chunk_count, 0);
  return c.json({ documents: results.map(toJson), totalChunks });
});

// 업로드 (multipart/form-data: file, name?, groupId?)
documents.post("/", requireManager, async (c) => {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return c.json({ error: "file 필드에 파일을 넣어 주세요." }, 400);

  const ext = extOf(file.name);
  // 예전 한글 바이너리 형식(.hwp)은 구조가 공개 XML 이 아니라 읽지 않습니다.
  if (ext === "hwp")
    return c.json({ error: "HWP(예전 한글 형식)는 지원하지 않습니다. 한글에서 [다른 이름으로 저장] → HWPX 또는 PDF 로 저장해 올려 주세요." }, 400);
  if (!(SUPPORTED_EXT as readonly string[]).includes(ext))
    return c.json({ error: `지원하는 형식은 ${SUPPORTED_EXT.join(", ").toUpperCase()} 입니다.` }, 400);
  const maxMb = Number(c.env.MAX_UPLOAD_MB) || 10;
  if (file.size === 0) return c.json({ error: "빈 파일입니다." }, 400);
  if (file.size > maxMb * 1024 * 1024) return c.json({ error: `파일은 ${maxMb}MB 까지 올릴 수 있습니다.` }, 413);
  // 이미지는 base64 로 모델에 통째로 보내므로 더 작게 제한합니다. 사진은 글자가 읽히는 정도로 줄여서 올리세요.
  const maxImageMb = Number(c.env.MAX_IMAGE_MB) || 4;
  if (isImageExt(ext) && file.size > maxImageMb * 1024 * 1024)
    return c.json({ error: `이미지는 ${maxImageMb}MB 까지 올릴 수 있습니다. 해상도를 줄여서 올려 주세요.` }, 413);

  const groupId = await parseGroup(c.env, form?.get("groupId"));
  if (groupId === undefined) return c.json({ error: "없는 그룹입니다. 사용자·그룹 화면에서 확인하세요." }, 400);
  const name = String(form?.get("name") ?? "").trim() || file.name.replace(/\.[^.]+$/, "");
  const now = nowSec();
  const contentType = CONTENT_TYPES[ext];

  // 1) D1 에 먼저 기록해 id 를 받고, 그 id 로 R2 키를 정합니다.
  const row = await c.env.DB.prepare(
    `INSERT INTO documents (name, filename, r2_key, content_type, size, status, created_at, updated_at, group_id)
     VALUES (?, ?, '', ?, ?, 'queued', ?, ?, ?) RETURNING id`,
  )
    .bind(name.slice(0, 200), file.name.slice(0, 255), contentType, file.size, now, now, groupId)
    .first<{ id: number }>();
  const id = row!.id;
  const key = `docs/${id}.${ext}`;

  // 2) 원본을 R2 에 저장
  // 스트림 대신 바이트로 넣습니다. 최대 10MB 라 메모리 부담이 작고, 길이를 아는 상태로 저장되어 잘릴 걱정이 없습니다.
  await c.env.FILES.put(key, await file.arrayBuffer(), { httpMetadata: { contentType } });
  await c.env.DB.prepare("UPDATE documents SET r2_key = ? WHERE id = ?").bind(key, id).run();

  // 3) 색인은 큐에 맡기고 바로 응답합니다. (업로드 응답이 무거운 AI 작업을 기다리지 않음)
  await c.env.INDEX_QUEUE.send({ docId: id });

  return c.json(toJson((await getDoc(c.env, id))!), 201);
});

// 원본 열기 (?download=1 이면 내려받기)
documents.get("/:id/file", async (c) => {
  const doc = await getDoc(c.env, parseId(c.req.param("id")));
  // 볼 수 없는 문서는 "없는 문서"와 똑같이 답합니다(있다는 사실도 알리지 않음).
  if (!doc || !canSeeDoc(docScope(c.get("user")), doc.group_id)) return c.json({ error: "문서를 찾을 수 없습니다." }, 404);
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

// 이름·공개 범위 수정 ({ name?, groupId? }, groupId: null = 전 직원)
documents.patch("/:id", requireManager, async (c) => {
  const id = parseId(c.req.param("id"));
  const body = await c.req.json<{ name?: string; groupId?: number | null }>().catch(() => ({}) as { name?: string; groupId?: number | null });
  const sets: string[] = [];
  const args: unknown[] = [];
  if (body.name !== undefined) {
    const name = String(body.name ?? "").trim();
    if (!name) return c.json({ error: "이름을 입력해 주세요." }, 400);
    sets.push("name = ?"), args.push(name.slice(0, 200));
  }
  if (body.groupId !== undefined) {
    const g = await parseGroup(c.env, body.groupId);
    if (g === undefined) return c.json({ error: "없는 그룹입니다." }, 400);
    sets.push("group_id = ?"), args.push(g);
  }
  if (!sets.length) return c.json({ error: "바꿀 내용이 없습니다." }, 400);
  const res = await c.env.DB.prepare(`UPDATE documents SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`)
    .bind(...args, nowSec(), id)
    .run();
  if (!res.meta.changes) return c.json({ error: "문서를 찾을 수 없습니다." }, 404);
  return c.json(toJson((await getDoc(c.env, id))!));
});

// 다시 색인 (청크 크기를 바꿨거나, 실패한 문서를 다시 시도할 때)
documents.post("/:id/reindex", requireManager, async (c) => {
  const id = parseId(c.req.param("id"));
  const res = await c.env.DB.prepare("UPDATE documents SET status = 'queued', error = NULL, updated_at = ? WHERE id = ?")
    .bind(nowSec(), id)
    .run();
  if (!res.meta.changes) return c.json({ error: "문서를 찾을 수 없습니다." }, 404);
  await c.env.INDEX_QUEUE.send({ docId: id });
  return c.json(toJson((await getDoc(c.env, id))!));
});

// 삭제
documents.delete("/:id", requireManager, async (c) => {
  const id = parseId(c.req.param("id"));
  const doc = await getDoc(c.env, id);
  if (!doc) return c.json({ error: "문서를 찾을 수 없습니다." }, 404);
  await removeChunks(c.env, id);
  await c.env.FILES.delete(doc.r2_key);
  await c.env.DB.prepare("DELETE FROM documents WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

// 모두 삭제: 문서마다 벡터·청크·원본을 지운 뒤 행을 지웁니다.
documents.delete("/", requireAdmin, async (c) => {
  if (c.req.query("confirm") !== "all") return c.json({ error: "모두 삭제하려면 ?confirm=all 을 붙여 주세요." }, 400);
  const { results } = await c.env.DB.prepare("SELECT id, r2_key FROM documents").all<{ id: number; r2_key: string }>();
  for (const d of results) {
    await removeChunks(c.env, d.id);
    if (d.r2_key) await c.env.FILES.delete(d.r2_key);
    await c.env.DB.prepare("DELETE FROM documents WHERE id = ?").bind(d.id).run();
  }
  // 혹시 남은 연습 모드 벡터도 정리
  await c.env.DB.prepare("DELETE FROM mock_vectors").run();
  return c.json({ ok: true, deleted: results.length });
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
