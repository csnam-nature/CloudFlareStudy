// 로그인(누구인지)과 권한(무엇을 할 수 있는지)
//
// 누구인지 정하는 방법은 세 가지이고, 위에서부터 먼저 맞는 것을 씁니다.
//   1) 개발용 우회(dev)   : .dev.vars 의 DEV_AUTH=1 이고 주소가 localhost 일 때만. x-dev-user-email 헤더(없으면 DEV_USER_EMAIL)를 그 사람으로 봅니다.
//                          배포본에는 .dev.vars 가 올라가지 않고, localhost 가 아니면 무시되므로 운영에서는 켜질 수 없습니다.
//   2) Zero Trust Access  : ACCESS_TEAM_DOMAIN·ACCESS_AUD 를 넣으면 켜집니다. Access 가 붙여 주는 서명 토큰
//                          (Cf-Access-Jwt-Assertion 헤더 또는 CF_Authorization 쿠키)을 팀의 공개키로 검증해 이메일을 얻습니다.
//                          이 모드에서는 관리자 토큰(ADMIN_TOKEN)을 쓰지 않습니다.
//   3) 관리자 토큰(예전 방식): Access 를 켜기 전. Bearer ADMIN_TOKEN 이 맞으면 관리자, 아니면 "익명 직원"(전 직원 공개 문서만).
//
// 무엇을 할 수 있는지는 D1 users 표의 역할(role)로 정합니다. migrations/0004_users_access.sql 참고.
//   admin > manager > employee

import type { Context, MiddlewareHandler } from "hono";

// Env 타입은 `npm run types`(wrangler types)가 wrangler.jsonc 를 읽어
// worker-configuration.d.ts 에 자동 생성합니다. 비밀 값(secret)과 .dev.vars 전용 값만 여기서 보충합니다.
// AI·VECTORS 는 연습 모드(env.mock)에 없어서 선택(?) 속성으로 생성됩니다.
export type Bindings = Env & {
  /** 관리자 토큰(Access 를 켜기 전에만 씀). 로컬은 .dev.vars, 배포는 `wrangler secret put ADMIN_TOKEN` */
  ADMIN_TOKEN?: string;
  /** 외부 AI 키(선택). 설정에서 OpenAI·Claude 모델을 고를 때만 필요합니다. src/providers.ts 참고 */
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  /** 인증을 켠 AI Gateway 의 토큰(선택) */
  CF_AIG_TOKEN?: string;
  /** 개발용 로그인 우회. .dev.vars 에만 넣으세요(localhost 에서만 동작) */
  DEV_AUTH?: string;
  DEV_USER_EMAIL?: string;
};

export type Role = "admin" | "manager" | "employee";
export const ROLES: readonly Role[] = ["admin", "manager", "employee"];
export const ROLE_LABEL: Record<Role, string> = { admin: "관리자", manager: "매니저", employee: "직원" };
const RANK: Record<Role, number> = { employee: 0, manager: 1, admin: 2 };

/** 요청한 사람. via 는 어떻게 확인했는지(access·dev = 실제 계정, token = 관리자 토큰, anonymous = 확인 안 됨) */
export type User = { email: string; name: string; role: Role; groups: number[]; via: "access" | "dev" | "token" | "anonymous" };
type AuthError = { status: 400 | 401 | 403 | 500; error: string };

export type AppEnv = { Bindings: Bindings; Variables: { user: User } };

/** 큐 메시지 내용: 어떤 문서를 색인할지 */
export type IndexJob = { docId: number };

export const nowSec = () => Math.floor(Date.now() / 1000);

/** 연습 모드인지: MOCK_AI=1 이거나 AI 바인딩이 없으면 가짜 AI 를 씁니다. */
export const isMock = (env: Bindings) => env.MOCK_AI === "1" || !env.AI || !env.VECTORS;

export const normEmail = (v: unknown) => {
  const s = String(v ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(s) && s.length <= 254 ? s : "";
};

/** ADMIN_EMAILS(쉼표 구분)에 적힌 사람은 표의 내용과 상관없이 항상 관리자입니다(잠김 방지). */
export const fixedAdmins = (env: Bindings) =>
  String(env.ADMIN_EMAILS ?? "")
    .split(/[,\s]+/)
    .map(normEmail)
    .filter(Boolean);

/** "naturetec", "naturetec.cloudflareaccess.com", "https://naturetec.cloudflareaccess.com/" 모두 같은 값으로 */
export function teamDomain(env: Bindings) {
  const t = String(env.ACCESS_TEAM_DOMAIN ?? "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  if (!t) return "";
  return t.includes(".") ? t : `${t}.cloudflareaccess.com`;
}

/** Zero Trust Access 모드인지(둘 중 하나라도 넣으면 켜진 것으로 보고, 하나가 빠지면 모두 막습니다) */
export const accessEnabled = (env: Bindings) => !!(String(env.ACCESS_TEAM_DOMAIN ?? "").trim() || String(env.ACCESS_AUD ?? "").trim());

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const devAllowed = (env: Bindings, url: URL) => env.DEV_AUTH === "1" && LOCAL_HOSTS.has(url.hostname);

/** 화면에 보여 줄 로그인 방식 */
export function authMode(env: Bindings, user: User): "access" | "dev" | "token" {
  if (user.via === "dev") return "dev";
  return accessEnabled(env) ? "access" : "token";
}

// ── 누구인지 확인 ─────────────────────────────────────────

const ANONYMOUS: User = { email: "", name: "", role: "employee", groups: [], via: "anonymous" };

/** 요청 하나의 사용자를 확인합니다. Hono 미들웨어(identify)와 채팅 WebSocket(src/index.ts)이 함께 씁니다. */
export async function identifyRequest(req: Request, env: Bindings): Promise<User | AuthError> {
  const url = new URL(req.url);

  if (devAllowed(env, url)) {
    const email = normEmail(req.headers.get("x-dev-user-email") || env.DEV_USER_EMAIL || "dev@localhost");
    if (!email) return { status: 400, error: "x-dev-user-email 이 이메일 형식이 아닙니다." };
    return loadUser(env, email, "dev");
  }

  if (accessEnabled(env)) {
    const team = teamDomain(env);
    const aud = String(env.ACCESS_AUD ?? "").trim();
    if (!team || !aud) return { status: 500, error: "서버 설정 오류: ACCESS_TEAM_DOMAIN 과 ACCESS_AUD 를 둘 다 넣어야 합니다." };
    const token = req.headers.get("cf-access-jwt-assertion") || cookie(req, "CF_Authorization");
    if (!token) return { status: 401, error: "Cloudflare Access 로그인이 필요합니다. 페이지를 새로고침해 다시 로그인하세요." };
    let claims: AccessClaims;
    try {
      claims = await verifyAccessJwt(token, team, aud);
    } catch (e) {
      console.warn("Access 토큰 검증 실패", e instanceof Error ? e.message : e);
      return { status: 401, error: "로그인 정보가 올바르지 않거나 만료되었습니다. 페이지를 새로고침해 다시 로그인하세요." };
    }
    const email = normEmail(claims.email);
    if (!email) return { status: 403, error: "이메일이 없는 로그인입니다(서비스 토큰으로는 쓸 수 없습니다)." };
    return loadUser(env, email, "access");
  }

  const adminToken = env.ADMIN_TOKEN;
  if (adminToken && req.headers.get("authorization") === `Bearer ${adminToken}`)
    return { email: "", name: "관리자 토큰", role: "admin", groups: [], via: "token" };
  return ANONYMOUS;
}

type UserRow = { email: string; name: string; role: Role; active: number; last_seen: number | null };

/**
 * D1 users 표에서 사람을 읽습니다. 처음 온 사람은 ACCESS_AUTO_SIGNUP 이 "0" 이 아니면 '직원'으로 자동 등록합니다.
 * 마지막 접속 시각은 10분에 한 번만 고쳐 씁니다(요청마다 쓰기를 하지 않으려고).
 */
export async function loadUser(env: Bindings, email: string, via: "access" | "dev"): Promise<User | AuthError> {
  const now = nowSec();
  const fixed = fixedAdmins(env).includes(email);
  let row: UserRow | null;
  try {
    row = await env.DB.prepare("SELECT email, name, role, active, last_seen FROM users WHERE email = ?").bind(email).first<UserRow>();
  } catch (e) {
    if (/no such table/i.test(String(e)))
      return { status: 500, error: "DB 에 users 표가 없습니다. migrations 0004 를 적용하세요(npm run db:migrate:local / :remote)." };
    throw e;
  }
  if (!row) {
    if (!fixed && String(env.ACCESS_AUTO_SIGNUP) === "0")
      return { status: 403, error: `등록되지 않은 사용자입니다(${email}). 관리자에게 등록을 요청하세요.` };
    const role: Role = fixed ? "admin" : "employee";
    await env.DB.prepare("INSERT OR IGNORE INTO users (email, name, role, active, created_at, last_seen) VALUES (?, '', ?, 1, ?, ?)")
      .bind(email, role, now, now)
      .run();
    row = { email, name: "", role, active: 1, last_seen: now };
  } else if (!row.last_seen || now - row.last_seen > 600) {
    await env.DB.prepare("UPDATE users SET last_seen = ? WHERE email = ?").bind(now, email).run();
  }
  if (!row.active && !fixed) return { status: 403, error: "사용이 중지된 계정입니다. 관리자에게 문의하세요." };
  const { results } = await env.DB.prepare("SELECT group_id FROM user_groups WHERE email = ?").bind(email).all<{ group_id: number }>();
  return { email, name: row.name, role: fixed ? "admin" : row.role, groups: results.map((r) => r.group_id), via };
}

const isError = (u: User | AuthError): u is AuthError => "status" in u;
export { isError as isAuthError };

/** 모든 /api 요청 앞: 사용자를 확인해 c.get("user") 에 넣습니다. */
export const identify: MiddlewareHandler<AppEnv> = async (c, next) => {
  const u = await identifyRequest(c.req.raw, c.env);
  if (isError(u)) return c.json({ error: u.error }, u.status);
  c.set("user", u);
  await next();
};

export const hasRole = (u: User | undefined, min: Role) => !!u && RANK[u.role] >= RANK[min];

/** 역할이 min 이상이어야 통과합니다. 익명(토큰 없음)은 401, 계정은 있지만 역할이 낮으면 403. */
export const requireRole =
  (min: Role): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const u = c.get("user");
    if (hasRole(u, min)) return next();
    if (!u || u.via === "anonymous") return c.json({ error: "권한이 없습니다. 관리자 토큰을 확인하세요." }, 401);
    return c.json({ error: `권한이 없습니다. ${ROLE_LABEL[min]} 이상만 할 수 있습니다(지금: ${ROLE_LABEL[u.role]}).` }, 403);
  };

/** 관리자 전용 라우트 앞에 붙이는 미들웨어 */
export const requireAdmin = requireRole("admin");

/** 예전 코드 호환: 관리자인지 */
export const isAdmin = (c: Context<AppEnv>) => hasRole(c.get("user"), "admin");

// ── 문서 공개 범위 ────────────────────────────────────────

/** 볼 수 있는 문서 범위: null = 전부(매니저 이상), 배열 = 전 직원 공개 문서 + 이 그룹들의 문서 */
export const docScope = (u: User): number[] | null => (hasRole(u, "manager") ? null : u.groups);

/** SQL 조건 조각. alias 는 documents 표의 별칭. 예) AND (d.group_id IS NULL OR d.group_id IN (?, ?)) */
export function scopeSql(scope: number[] | null, alias: string): { sql: string; args: number[] } {
  if (scope === null) return { sql: "", args: [] };
  if (!scope.length) return { sql: ` AND ${alias}.group_id IS NULL`, args: [] };
  return { sql: ` AND (${alias}.group_id IS NULL OR ${alias}.group_id IN (${scope.map(() => "?").join(",")}))`, args: scope };
}

export const canSeeDoc = (scope: number[] | null, groupId: number | null) =>
  scope === null || groupId === null || scope.includes(groupId);

// ── Access 토큰(JWT) 검증 ─────────────────────────────────
// Access 는 RS256 으로 서명한 JWT 를 보냅니다. 공개키는 https://<팀>.cloudflareaccess.com/cdn-cgi/access/certs 에 있고
// 주기적으로 바뀌므로(키 회전), 모르는 kid 가 오면 다시 받아 옵니다.

type AccessClaims = { aud?: string | string[]; iss?: string; exp?: number; nbf?: number; email?: string };
type JwksCache = { team: string; keys: Map<string, CryptoKey>; at: number };
let jwks: JwksCache | null = null;

const b64urlBytes = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const b64urlJson = <T>(s: string) => JSON.parse(new TextDecoder().decode(b64urlBytes(s))) as T;

async function fetchKeys(team: string): Promise<JwksCache> {
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`공개키를 받지 못했습니다 (${res.status})`);
  const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
  const keys = new Map<string, CryptoKey>();
  for (const k of body.keys ?? []) {
    if (!k.kid || k.kty !== "RSA") continue;
    keys.set(k.kid, await crypto.subtle.importKey("jwk", k, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  }
  return { team, keys, at: Date.now() };
}

async function keyFor(team: string, kid: string): Promise<CryptoKey> {
  const stale = !jwks || jwks.team !== team || Date.now() - jwks.at > 3_600_000;
  if (stale) jwks = await fetchKeys(team);
  let key = jwks!.keys.get(kid);
  // 키가 막 바뀐 경우: 1분에 한 번까지만 다시 받아 봅니다.
  if (!key && Date.now() - jwks!.at > 60_000) {
    jwks = await fetchKeys(team);
    key = jwks.keys.get(kid);
  }
  if (!key) throw new Error(`모르는 키(kid=${kid})`);
  return key;
}

/** 서명·발급자(iss)·대상(aud)·만료(exp)를 확인하고 내용(claims)을 돌려줍니다. 하나라도 틀리면 오류. */
export async function verifyAccessJwt(token: string, team: string, aud: string): Promise<AccessClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("JWT 형식이 아닙니다");
  const [h, p, s] = parts;
  const header = b64urlJson<{ alg?: string; kid?: string }>(h);
  if (header.alg !== "RS256" || !header.kid) throw new Error(`지원하지 않는 서명 방식(${header.alg})`);
  const key = await keyFor(team, header.kid);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new Error("서명이 맞지 않습니다");
  const claims = b64urlJson<AccessClaims>(p);
  const now = nowSec();
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(aud)) throw new Error("다른 Access 애플리케이션의 토큰입니다(aud)");
  if (claims.iss !== `https://${team}`) throw new Error(`발급자가 다릅니다(iss=${claims.iss})`);
  if (typeof claims.exp !== "number" || claims.exp < now - 60) throw new Error("만료된 토큰입니다");
  if (typeof claims.nbf === "number" && claims.nbf > now + 60) throw new Error("아직 쓸 수 없는 토큰입니다");
  return claims;
}

/** 테스트용: 공개키 캐시 비우기 */
export const resetJwksCache = () => {
  jwks = null;
};

function cookie(req: Request, name: string) {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}
