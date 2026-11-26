// 대화 목록·폴더 API (왼쪽 사이드바)
//
// 로그인이 없어서, 브라우저가 처음 열릴 때 만든 무작위 id 를 X-Client-Id 헤더로 보내 "내 목록"을 구분합니다.
// 같은 브라우저(같은 localStorage)에서만 목록이 보이고, 다른 PC 에서는 따로입니다.
// 사람별로 나누려면 Cloudflare Access 를 앞에 두고 Cf-Access-Authenticated-User-Email 헤더를 owner 로 쓰면 됩니다(README).
//
// 대화 내용 자체는 대화 id 를 이름으로 하는 ChatAgent(Durable Object)에 있습니다. 여기서는 제목·폴더·시각만 다룹니다.

import { getAgentByName } from "agents";
import { Hono, type Context } from "hono";
import type { ChatAgent } from "./agent";
import { type AppEnv, nowSec } from "./auth";

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FOLDERS = 100;
const MAX_CONVERSATIONS = 1000;

type FolderRow = { id: number; name: string; created_at: number };
type ConvRow = { id: string; folder_id: number | null; title: string; created_at: number; updated_at: number };

export const conversations = new Hono<AppEnv & { Variables: { owner: string } }>();

// 모든 요청: X-Client-Id 확인
conversations.use("*", async (c, next) => {
  const owner = c.req.header("x-client-id") ?? "";
  if (!ID_RE.test(owner)) return c.json({ error: "X-Client-Id 헤더(브라우저 id)가 필요합니다." }, 400);
  c.set("owner", owner);
  await next();
});

const cleanName = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const parseId = (s: string) => (/^\d+$/.test(s) ? Number(s) : NaN);

async function ownsFolder(c: Context<AppEnv & { Variables: { owner: string } }>, id: number) {
  return !!(await c.env.DB.prepare("SELECT 1 FROM folders WHERE id = ? AND owner = ?").bind(id, c.get("owner")).first());
}

// 사이드바 전체: 폴더 + 대화(최근 순)
conversations.get("/", async (c) => {
  const owner = c.get("owner");
  const [f, v] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT id, name, created_at FROM folders WHERE owner = ? ORDER BY name COLLATE NOCASE, id").bind(owner),
    c.env.DB.prepare(
      "SELECT id, folder_id, title, created_at, updated_at FROM conversations WHERE owner = ? ORDER BY updated_at DESC LIMIT 1000",
    ).bind(owner),
  ]);
  return c.json({
    folders: (f.results as FolderRow[]).map((r) => ({ id: r.id, name: r.name })),
    conversations: (v.results as ConvRow[]).map((r) => ({ id: r.id, folderId: r.folder_id, title: r.title, updatedAt: r.updated_at })),
  });
});

// ── 폴더 ──

conversations.post("/folders", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: string };
  const name = cleanName(body.name, 60);
  if (!name) return c.json({ error: "폴더 이름을 적어 주세요." }, 400);
  const owner = c.get("owner");
  const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM folders WHERE owner = ?").bind(owner).first<number>("n");
  if ((n ?? 0) >= MAX_FOLDERS) return c.json({ error: `폴더는 ${MAX_FOLDERS}개까지 만들 수 있습니다.` }, 400);
  const row = await c.env.DB.prepare("INSERT INTO folders (owner, name, created_at) VALUES (?, ?, ?) RETURNING id, name")
    .bind(owner, name, nowSec())
    .first<{ id: number; name: string }>();
  return c.json(row, 201);
});

conversations.patch("/folders/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  const name = cleanName(((await c.req.json().catch(() => ({}))) as { name?: string }).name, 60);
  if (!name) return c.json({ error: "폴더 이름을 적어 주세요." }, 400);
  const r = await c.env.DB.prepare("UPDATE folders SET name = ? WHERE id = ? AND owner = ?").bind(name, id, c.get("owner")).run();
  if (!r.meta.changes) return c.json({ error: "없는 폴더입니다." }, 404);
  return c.json({ id, name });
});

// 폴더 삭제: 안의 대화는 지우지 않고 "폴더 없음"으로 옮깁니다. ?withConversations=1 이면 대화도 함께 삭제.
conversations.delete("/folders/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  const owner = c.get("owner");
  if (!(await ownsFolder(c, id))) return c.json({ error: "없는 폴더입니다." }, 404);
  let deleted = 0;
  if (c.req.query("withConversations") === "1") {
    const { results } = await c.env.DB.prepare("SELECT id FROM conversations WHERE folder_id = ? AND owner = ?").bind(id, owner).all<{ id: string }>();
    for (const r of results) await clearAgent(c.env, r.id);
    deleted = results.length;
    await c.env.DB.prepare("DELETE FROM conversations WHERE folder_id = ? AND owner = ?").bind(id, owner).run();
  }
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE conversations SET folder_id = NULL WHERE folder_id = ? AND owner = ?").bind(id, owner),
    c.env.DB.prepare("DELETE FROM folders WHERE id = ? AND owner = ?").bind(id, owner),
  ]);
  return c.json({ ok: true, deletedConversations: deleted });
});

// ── 대화 ──

// 새 대화 등록 (브라우저가 만든 UUID 를 그대로 씀. 첫 질문을 보내기 직전에 부름)
conversations.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { id?: string; folderId?: number | null; title?: string };
  const owner = c.get("owner");
  const id = String(body.id ?? "");
  if (!ID_RE.test(id)) return c.json({ error: "대화 id 형식이 틀립니다." }, 400);
  const folderId = body.folderId == null ? null : Number(body.folderId);
  if (folderId != null && !(await ownsFolder(c, folderId))) return c.json({ error: "없는 폴더입니다." }, 400);
  const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM conversations WHERE owner = ?").bind(owner).first<number>("n");
  if ((n ?? 0) >= MAX_CONVERSATIONS) return c.json({ error: `대화는 ${MAX_CONVERSATIONS}개까지 저장됩니다. 오래된 대화를 지워 주세요.` }, 400);
  const now = nowSec();
  const title = cleanName(body.title, 80) || "새 대화";
  // 같은 id 가 이미 있으면(다른 브라우저가 쓰는 id 등) 덮어쓰지 않습니다.
  const r = await c.env.DB.prepare(
    "INSERT INTO conversations (id, owner, folder_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
  )
    .bind(id, owner, folderId, title, now, now)
    .run();
  if (!r.meta.changes) {
    const mine = await c.env.DB.prepare("SELECT 1 FROM conversations WHERE id = ? AND owner = ?").bind(id, owner).first();
    if (!mine) return c.json({ error: "이미 쓰이는 대화 id 입니다." }, 409);
  }
  return c.json({ id, folderId, title, updatedAt: now }, 201);
});

// 제목 바꾸기·폴더 옮기기 ({ title?, folderId? }, folderId: null = 폴더 없음)
conversations.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const owner = c.get("owner");
  const body = (await c.req.json().catch(() => ({}))) as { title?: string; folderId?: number | null };
  const sets: string[] = [];
  const args: unknown[] = [];
  if (body.title !== undefined) {
    const t = cleanName(body.title, 80);
    if (!t) return c.json({ error: "제목을 적어 주세요." }, 400);
    sets.push("title = ?"), args.push(t);
  }
  if (body.folderId !== undefined) {
    const f = body.folderId === null ? null : Number(body.folderId);
    if (f != null && !(await ownsFolder(c, f))) return c.json({ error: "없는 폴더입니다." }, 400);
    sets.push("folder_id = ?"), args.push(f);
  }
  if (!sets.length) return c.json({ error: "바꿀 내용이 없습니다." }, 400);
  const r = await c.env.DB.prepare(`UPDATE conversations SET ${sets.join(", ")} WHERE id = ? AND owner = ?`)
    .bind(...args, id, owner)
    .run();
  if (!r.meta.changes) return c.json({ error: "없는 대화입니다." }, 404);
  return c.json({ ok: true });
});

// 대화 삭제: 목록에서 빼고 에이전트의 대화 기록도 지웁니다.
conversations.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const r = await c.env.DB.prepare("DELETE FROM conversations WHERE id = ? AND owner = ?").bind(id, c.get("owner")).run();
  if (!r.meta.changes) return c.json({ error: "없는 대화입니다." }, 404);
  await clearAgent(c.env, id);
  return c.json({ ok: true });
});

/** 대화 id 의 ChatAgent 기록 지우기 (RPC) */
async function clearAgent(env: AppEnv["Bindings"], id: string) {
  try {
    const stub = await getAgentByName<AppEnv["Bindings"], ChatAgent>(env.ChatAgent as unknown as DurableObjectNamespace<ChatAgent>, id);
    await stub.clearHistory();
  } catch (e) {
    console.error("대화 기록 삭제 실패", id, e);
  }
}
