// 큐 소비자: 문서 색인
//
// 업로드 API 가 큐에 넣은 { docId } 메시지를 받아 아래 순서로 처리합니다.
//   R2 원본 읽기 → 텍스트 추출(toMarkdown) → 청크 분할 → 임베딩 → Vectorize 저장 + D1 에 청크 원문 저장
// 실패하면 큐가 자동으로 다시 시도하고(wrangler.jsonc 의 max_retries), 마지막 시도까지 실패하면 '실패'로 표시합니다.

import { embed, extractText, upsertVectors } from "./ai";
import { type Bindings, type IndexJob, nowSec } from "./auth";
import { chunkText } from "./chunk";
import { getDoc, removeChunks } from "./documents";
import { getSettings } from "./settings";

const MAX_ATTEMPTS = 3; // max_retries(2) + 처음 1번

export async function handleIndexBatch(batch: MessageBatch<IndexJob>, env: Bindings) {
  for (const msg of batch.messages) {
    const { docId } = msg.body;
    try {
      const n = await indexDocument(env, docId);
      console.log(`색인 완료: 문서 ${docId}, 청크 ${n}개`);
      msg.ack();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`색인 실패: 문서 ${docId} (${msg.attempts}/${MAX_ATTEMPTS}번째)`, message);
      if (msg.attempts < MAX_ATTEMPTS && !(err instanceof PermanentError)) {
        // 잠시 뒤 다시 시도 (일시적인 AI 호출 실패 대비)
        await setStatus(env, docId, "queued", `다시 시도 대기 중: ${message}`);
        msg.retry({ delaySeconds: 10 * msg.attempts });
      } else {
        await setStatus(env, docId, "failed", message);
        msg.ack();
      }
    }
  }
}

/** 다시 시도해도 소용없는 오류(형식 불가, 너무 큰 문서 등) */
class PermanentError extends Error {}

async function indexDocument(env: Bindings, docId: number): Promise<number> {
  const doc = await getDoc(env, docId);
  if (!doc) return 0; // 색인 전에 삭제된 문서
  await setStatus(env, docId, "indexing", null);

  // 관리 화면 설정(OCR 모델, 청크 크기·겹침, 조각 수 한도)
  const settings = await getSettings(env);

  // 1) 원본 읽기
  const obj = await env.FILES.get(doc.r2_key);
  if (!obj) throw new PermanentError("R2 에 원본 파일이 없습니다.");
  const bytes = await obj.arrayBuffer();
  // 올릴 때 기록한 크기와 R2 에서 읽은 크기가 다르면 저장 중에 잘린 것이므로 다시 올려야 합니다.
  if (doc.size && bytes.byteLength !== doc.size)
    throw new PermanentError(`R2 에 저장된 원본 크기(${bytes.byteLength}바이트)가 올린 파일 크기(${doc.size}바이트)와 다릅니다. 파일을 삭제하고 다시 올려 주세요.`);

  // 2) 텍스트 추출
  let text: string;
  try {
    text = await extractText(env, doc.filename, bytes, doc.content_type, settings.ocrModel);
  } catch (e) {
    throw new PermanentError(e instanceof Error ? e.message : String(e));
  }
  if (!text.trim()) throw new PermanentError("문서에서 텍스트를 찾지 못했습니다. (스캔 이미지 PDF 는 지원하지 않습니다. 페이지를 JPG·PNG 로 저장해 올리면 OCR 로 읽습니다)");

  // 3) 청크 분할
  const chunks = chunkText(text, { size: settings.chunkSize, overlap: settings.chunkOverlap });
  const max = settings.maxChunksPerDoc;
  if (chunks.length > max)
    throw new PermanentError(`청크가 ${chunks.length}개로 한도(${max}개)를 넘습니다. 문서를 나눠 올리거나 MAX_CHUNKS_PER_DOC 를 늘리세요.`);

  // 4) 임베딩: 문서 이름을 앞에 붙여 "어느 문서의 내용인지"도 검색에 반영되게 합니다.
  const vectors = await embed(env, chunks.map((t) => `${doc.name}\n${t}`));

  // 5) 이전 색인을 지우고 새로 저장 (다시 색인일 때)
  await removeChunks(env, docId);
  const ids = chunks.map((_, i) => `${docId}:${i}`);
  await upsertVectors(env, ids.map((id, i) => ({ id, docId, values: vectors[i] })));
  const stmt = env.DB.prepare("INSERT INTO chunks (id, doc_id, seq, text) VALUES (?, ?, ?, ?)");
  for (let i = 0; i < chunks.length; i += 50)
    await env.DB.batch(chunks.slice(i, i + 50).map((t, j) => stmt.bind(ids[i + j], docId, i + j, t)));

  // 색인하는 사이에 문서가 삭제됐다면 방금 넣은 청크·벡터도 지웁니다(삭제/모두 삭제와 동시에 일어난 경우).
  if (!(await getDoc(env, docId))) {
    await removeChunks(env, docId);
    return 0;
  }

  const now = nowSec();
  await env.DB.prepare(
    "UPDATE documents SET status = 'ready', error = NULL, chunk_count = ?, char_count = ?, indexed_at = ?, updated_at = ? WHERE id = ?",
  )
    .bind(chunks.length, text.length, now, now, docId)
    .run();
  return chunks.length;
}

async function setStatus(env: Bindings, docId: number, status: string, error: string | null) {
  await env.DB.prepare("UPDATE documents SET status = ?, error = ?, updated_at = ? WHERE id = ?")
    .bind(status, error, nowSec(), docId)
    .run();
}
