// 단축 코드 생성과 입력 검증 유틸리티

// 헷갈리기 쉬운 문자(0/O, 1/l/I)를 뺀 base56 문자 집합
const ALPHABET = "23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";

/**
 * 암호학적 난수로 단축 코드를 만듭니다.
 * Workers 런타임은 Web 표준 crypto.getRandomValues 를 기본 제공합니다.
 */
export function generateCode(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const b of bytes) {
    // 바이트(0~255)를 문자 집합 크기로 나눈 나머지 → 약간의 편향이 있지만 학습용으로 충분
    code += ALPHABET[b % ALPHABET.length];
  }
  return code;
}

/** 사용자가 직접 지정하는 코드(custom alias) 형식: 영문·숫자·-·_ 3~32자 */
const CUSTOM_CODE_RE = /^[A-Za-z0-9_-]{3,32}$/;

/** /api, /favicon.ico 처럼 라우트와 겹치는 코드는 쓸 수 없게 막습니다. */
const RESERVED = new Set(["api", "favicon.ico", "robots.txt"]);

export function isValidCustomCode(code: string): boolean {
  return CUSTOM_CODE_RE.test(code) && !RESERVED.has(code.toLowerCase());
}

/** http/https URL 만 허용합니다. (javascript: 같은 스킴으로 악용되는 것을 막기 위해) */
export function normalizeUrl(input: string): string | null {
  try {
    const u = new URL(input);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Referer 헤더에서 호스트만 꺼냅니다. 개인정보가 담긴 전체 경로는 저장하지 않습니다. */
export function refererHost(referer: string | null): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).host || null;
  } catch {
    return null;
  }
}
