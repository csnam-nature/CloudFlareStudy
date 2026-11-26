// 직원 계정·역할·그룹 관리 API (사용자·그룹 화면 users.html)
//
//   GET    /api/users              사용자 목록(관리자)
//   POST   /api/users              미리 등록 { email, name?, role?, groups? } (관리자)
//   PATCH  /api/users/:email       { name?, role?, active?, groups? } (관리자)
//   DELETE /api/users/:email       계정 삭제(관리자). 자동 등록이 켜져 있으면 다음 로그인 때 '직원'으로 다시 생깁니다.
//
//   GET    /api/groups             그룹 목록(매니저 이상: 문서 공개 범위를 고를 때 씀)
//   POST   /api/groups             { name } (관리자)
//   PATCH  /api/groups/:id         { name } (관리자)
//   DELETE /api/groups/:id         (관리자) 그 그룹에만 공개된 문서가 있으면 거절합니다(지우면 전 직원에게 공개되는 사고를 막기 위해).
//
// 잠김 방지: ADMIN_EMAILS 에 적힌 사람은 항상 관리자이고, 자기 자신의 역할·사용 여부는 바꿀 수 없습니다.

import { Hono } from "hono";
import { type AppEnv, type Bindings, fixedAdmins, normEmail, nowSec, requireAdmin, requireRole, type Role, ROLES } from "./auth";

const MAX_GROUPS = 200;

type UserRow = { email: string; name: string; role: Role; active: number; created_at: number; last_seen: number | null };

const cleanName = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const parseId = (s: string) => (/^\d+$/.test(s) ? Number(s) : NaN);

/** 그룹 id 목록 확인: 숫자 배열이고 모두 있는 그룹이어야 함. 틀리면 null */
async function validGroups(env: Bindings, v: unknown): Promise<number[] | null> {
  if (!Array.isArray(v)) return null;
  const ids = [...new Set(v.map(Number))];
  if (ids.some((x) => !Number.isInteger(x) || x <= 0)) return null;
  if (!ids.length) return [];
  const { results } = await env.DB.prepare(`SELECT id FROM groups WHERE id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids)
    .all<{ id: number }>();
  return results.length === ids.length ? ids : null;
}

function setGroupsStmts(env: Bindings, email: string, groups: number[]) {
  return [
    env.DB.prepare("DELETE FROM user_groups WHERE email = ?").bind(email),
    ...groups.map((g) => env.DB.prepare("INSERT INTO user_groups (email, group_id) VALUES (?, ?)").bind(email, g)),
  ];
}

// ── 사용자 ────────────────────────────────────────────────

export const usersApi = new Hono<AppEnv>();
usersApi.use("*", requireAdmin);

usersApi.get("/", async (c) => {
  const [u, ug] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT * FROM users ORDER BY role = 'admin' DESC, role = 'manager' DESC, email"),
    c.env.DB.prepare("SELECT email, group_id FROM user_groups"),
  ]);
  const fixed = fixedAdmins(c.env);
  const groupsOf = new Map<string, number[]>();
  for (const r of ug.results as { email: string; group_id: number }[]) groupsOf.set(r.email, [...(groupsOf.get(r.email) ?? []), r.group_id]);
  const me = c.get("user").email;
  return c.json({
    users: (u.results as UserRow[]).map((r) => ({
      email: r.email,
      name: r.name,
      role: fixed.includes(r.email) ? "admin" : r.role,
      active: !!r.active || fixed.includes(r.email),
      fixedAdmin: fixed.includes(r.email),
      me: r.email === me,
      groups: groupsOf.get(r.email) ?? [],
      createdAt: r.created_at,
      lastSeen: r.last_seen,
    })),
    autoSignup: String(c.env.ACCESS_AUTO_SIGNUP) !== "0",
  });
});

usersApi.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { email?: string; name?: string; role?: Role; groups?: number[] };
  const email = normEmail(body.email);
  if (!email) return c.json({ error: "이메일 형식이 아닙니다." }, 400);
  const role = body.role ?? "employee";
  if (!ROLES.includes(role)) return c.json({ error: "역할은 admin·manager·employee 중 하나입니다." }, 400);
  const groups = await validGroups(c.env, body.groups ?? []);
  if (!groups) return c.json({ error: "없는 그룹이 들어 있습니다." }, 400);
  const r = await c.env.DB.prepare(
    "INSERT INTO users (email, name, role, active, created_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT(email) DO NOTHING",
  )
    .bind(email, cleanName(body.name, 60), role, nowSec())
    .run();
  if (!r.meta.changes) return c.json({ error: "이미 등록된 이메일입니다." }, 409);
  if (groups.length) await c.env.DB.batch(setGroupsStmts(c.env, email, groups));
  return c.json({ ok: true, email }, 201);
});

usersApi.patch("/:email", async (c) => {
  const email = normEmail(c.req.param("email"));
  const body = (await c.req.json().catch(() => ({}))) as { name?: string; role?: Role; active?: boolean; groups?: number[] };
  const exists = await c.env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first();
  if (!email || !exists) return c.json({ error: "없는 사용자입니다." }, 404);
  const self = email === c.get("user").email;
  const fixed = fixedAdmins(c.env).includes(email);
  const sets: string[] = [];
  const args: unknown[] = [];
  if (body.name !== undefined) sets.push("name = ?"), args.push(cleanName(body.name, 60));
  if (body.role !== undefined) {
    if (!ROLES.includes(body.role)) return c.json({ error: "역할은 admin·manager·employee 중 하나입니다." }, 400);
    if (self) return c.json({ error: "자기 자신의 역할은 바꿀 수 없습니다(다른 관리자에게 부탁하세요)." }, 400);
    if (fixed && body.role !== "admin") return c.json({ error: "ADMIN_EMAILS 에 적힌 사람은 항상 관리자입니다(wrangler.jsonc 에서 빼야 바뀝니다)." }, 400);
    sets.push("role = ?"), args.push(body.role);
  }
  if (body.active !== undefined) {
    if (self && !body.active) return c.json({ error: "자기 자신을 사용 중지할 수 없습니다." }, 400);
    if (fixed && !body.active) return c.json({ error: "ADMIN_EMAILS 에 적힌 사람은 사용 중지할 수 없습니다." }, 400);
    sets.push("active = ?"), args.push(body.active ? 1 : 0);
  }
  const stmts = sets.length ? [c.env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE email = ?`).bind(...args, email)] : [];
  if (body.groups !== undefined) {
    const groups = await validGroups(c.env, body.groups);
    if (!groups) return c.json({ error: "없는 그룹이 들어 있습니다." }, 400);
    stmts.push(...setGroupsStmts(c.env, email, groups));
  }
  if (!stmts.length) return c.json({ error: "바꿀 내용이 없습니다." }, 400);
  await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

usersApi.delete("/:email", async (c) => {
  const email = normEmail(c.req.param("email"));
  if (email === c.get("user").email) return c.json({ error: "자기 자신은 삭제할 수 없습니다." }, 400);
  if (fixedAdmins(c.env).includes(email)) return c.json({ error: "ADMIN_EMAILS 에 적힌 사람은 삭제할 수 없습니다." }, 400);
  const [r] = await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM users WHERE email = ?").bind(email),
    c.env.DB.prepare("DELETE FROM user_groups WHERE email = ?").bind(email),
  ]);
  if (!r.meta.changes) return c.json({ error: "없는 사용자입니다." }, 404);
  return c.json({ ok: true });
});

// ── 그룹 ──────────────────────────────────────────────────

export const groupsApi = new Hono<AppEnv>();

groupsApi.get("/", requireRole("manager"), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT g.id, g.name,
            (SELECT COUNT(*) FROM user_groups ug WHERE ug.group_id = g.id) AS members,
            (SELECT COUNT(*) FROM documents d WHERE d.group_id = g.id) AS docs
       FROM groups g ORDER BY g.name COLLATE NOCASE`,
  ).all<{ id: number; name: string; members: number; docs: number }>();
  return c.json({ groups: results });
});

groupsApi.post("/", requireAdmin, async (c) => {
  const name = cleanName(((await c.req.json().catch(() => ({}))) as { name?: string }).name, 40);
  if (!name) return c.json({ error: "그룹 이름을 적어 주세요." }, 400);
  const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM groups").first<number>("n");
  if ((n ?? 0) >= MAX_GROUPS) return c.json({ error: `그룹은 ${MAX_GROUPS}개까지 만들 수 있습니다.` }, 400);
  const row = await c.env.DB.prepare("INSERT INTO groups (name, created_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING RETURNING id, name")
    .bind(name, nowSec())
    .first<{ id: number; name: string }>();
  if (!row) return c.json({ error: "같은 이름의 그룹이 있습니다." }, 409);
  return c.json(row, 201);
});

groupsApi.patch("/:id", requireAdmin, async (c) => {
  const id = parseId(c.req.param("id"));
  const name = cleanName(((await c.req.json().catch(() => ({}))) as { name?: string }).name, 40);
  if (!name) return c.json({ error: "그룹 이름을 적어 주세요." }, 400);
  const dup = await c.env.DB.prepare("SELECT 1 FROM groups WHERE name = ? AND id != ?").bind(name, id).first();
  if (dup) return c.json({ error: "같은 이름의 그룹이 있습니다." }, 409);
  const r = await c.env.DB.prepare("UPDATE groups SET name = ? WHERE id = ?").bind(name, id).run();
  if (!r.meta.changes) return c.json({ error: "없는 그룹입니다." }, 404);
  return c.json({ id, name });
});

groupsApi.delete("/:id", requireAdmin, async (c) => {
  const id = parseId(c.req.param("id"));
  const docs = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM documents WHERE group_id = ?").bind(id).first<number>("n");
  if (docs) return c.json({ error: `이 그룹에만 공개된 문서가 ${docs}개 있습니다. 문서 관리에서 공개 범위를 먼저 바꾸세요.` }, 409);
  const [r] = await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM groups WHERE id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM user_groups WHERE group_id = ?").bind(id),
  ]);
  if (!r.meta.changes) return c.json({ error: "없는 그룹입니다." }, 404);
  return c.json({ ok: true });
});
