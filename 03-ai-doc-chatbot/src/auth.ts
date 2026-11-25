// 관리자 토큰 확인과 공용 타입
//
// 질문(채팅)과 문서 목록·원본 열기는 누구나, 업로드·수정·삭제·다시 색인은 관리자 토큰이 있어야 합니다(1·2번과 같은 방식).
// 사내에서만 쓰게 하려면 코드 대신 Cloudflare Access(Zero Trust)를 앞에 두는 방법을 README 에 적어 두었습니다.

import type { Context, MiddlewareHandler } from "hono";

// Env 타입은 `npm run types`(wrangler types)가 wrangler.jsonc 를 읽어
// worker-configuration.d.ts 에 자동 생성합니다. 비밀 값(secret)만 여기서 보충합니다.
// AI·VECTORS 는 연습 모드(env.mock)에 없어서 선택(?) 속성으로 생성됩니다.
export type Bindings = Env & {
  /** 관리자 토큰. 로컬은 .dev.vars, 배포는 `wrangler secret put ADMIN_TOKEN` */
  ADMIN_TOKEN?: string;
};

export type AppEnv = { Bindings: Bindings };

/** 큐 메시지 내용: 어떤 문서를 색인할지 */
export type IndexJob = { docId: number };

/** Authorization: Bearer <ADMIN_TOKEN> 이 맞는지 확인합니다. 토큰이 설정되지 않았으면 항상 거부. */
export function isAdmin(c: Context<AppEnv>): boolean {
  const token = c.env.ADMIN_TOKEN;
  return !!token && c.req.header("authorization") === `Bearer ${token}`;
}

/** 관리자 전용 라우트 앞에 붙이는 미들웨어 */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!isAdmin(c)) return c.json({ error: "권한이 없습니다. 관리자 토큰을 확인하세요." }, 401);
  await next();
};

export const nowSec = () => Math.floor(Date.now() / 1000);

/** 연습 모드인지: MOCK_AI=1 이거나 AI 바인딩이 없으면 가짜 AI 를 씁니다. */
export const isMock = (env: Bindings) => env.MOCK_AI === "1" || !env.AI || !env.VECTORS;
