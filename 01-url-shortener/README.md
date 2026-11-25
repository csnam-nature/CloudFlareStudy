# 01. URL 단축기 (Workers + KV + D1)

긴 URL 을 `https://<내 도메인>/abc123` 처럼 짧게 바꾸고, 클릭 수를 국가·리퍼러·날짜별로 집계하는 서비스입니다.
목표는 **"같은 데이터를 왜 KV 와 D1 두 곳에 두는가"** 를 몸으로 익히는 것입니다.

- **KV**: 키 하나로 읽는 초고속 조회 → `코드 → 원래 URL` (리다이렉트 경로)
- **D1**: 조건 검색·집계가 필요한 데이터 → 링크 목록, 클릭 로그, 통계

## 구조

```
01-url-shortener/
├── wrangler.jsonc            # Worker 설정 + 바인딩(KV, D1, Rate Limit, Cron)
├── migrations/
│   └── 0001_init.sql         # D1 스키마 (links, clicks, 인덱스)
├── src/
│   ├── index.ts              # 라우터(Hono) + scheduled(Cron) 핸들러
│   ├── code.ts               # 단축 코드 생성, URL 검증
│   └── page.ts               # 루트(/)의 간단한 HTML 폼
├── scripts/smoke-test.mjs    # 로컬 동작 확인 스크립트
└── .dev.vars.example         # 로컬 비밀 값 예시 (ADMIN_TOKEN)
```

## 동작 흐름

```
[POST /api/links] ──► D1 links INSERT (PRIMARY KEY 로 중복 검사) ──► KV put(코드 → URL)
[GET /:code]      ──► KV get ──(없으면)──► D1 조회 ──► 302 리다이렉트
                                   └─ ctx.waitUntil(D1 clicks INSERT)  ← 사용자는 기다리지 않음
[GET /api/stats/:code] ──► D1 batch(COUNT, GROUP BY country/referer/day)
[Cron 매일 03:00 KST]  ──► D1 에서 만료 링크 삭제 (KV 는 expirationTtl 로 자동 만료)
```

## API

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/` | 웹 폼 (브라우저로 열어 보세요) |
| POST | `/api/links` | 링크 생성. 본문: `{ "url": "...", "title"?: "...", "code"?: "my-alias", "ttlDays"?: 7 }` |
| GET | `/api/links?limit=20` | 최근 링크 목록 + 클릭 수 |
| GET | `/api/stats/:code` | 총 클릭, 국가별, 리퍼러별, 최근 30일 일별 |
| DELETE | `/api/links/:code` | 링크 삭제. 헤더 `Authorization: Bearer <ADMIN_TOKEN>` 필요 |
| GET | `/:code` | 원래 URL 로 302 리다이렉트 |

## 로컬에서 실행하기 (Cloudflare 계정 불필요)

`wrangler dev` 는 KV·D1·Rate Limit 를 `.wrangler/state` 폴더에 로컬로 에뮬레이션합니다.
그래서 `wrangler.jsonc` 의 `id` 값이 임시값(0000…)이어도 로컬에서는 그대로 동작합니다.

```bash
cd 01-url-shortener
npm install                    # 의존성 설치 + wrangler types 로 Env 타입 자동 생성
cp .dev.vars.example .dev.vars # 로컬 관리자 토큰 (Windows: copy .dev.vars.example .dev.vars)
npm run db:migrate:local       # 로컬 D1 에 테이블 생성
npm run dev                    # http://localhost:8787
```

다른 터미널에서 확인합니다.

```bash
npm run smoke                  # 생성 → 리다이렉트 → 통계 → 삭제까지 자동 확인

# 직접 호출해 보기
curl -X POST http://localhost:8787/api/links \
  -H "content-type: application/json" \
  -d '{"url":"https://developers.cloudflare.com/kv/","title":"KV 문서"}'
curl -i http://localhost:8787/<받은 코드>
curl http://localhost:8787/api/stats/<받은 코드>
```

> Windows PowerShell 에서는 `curl` 이 `Invoke-WebRequest` 별칭이므로 `curl.exe` 로 쓰거나, 브라우저에서 `http://localhost:8787` 폼을 쓰세요.

Cron(만료 정리)을 로컬에서 바로 실행해 보려면 `npm run dev` 가 켜진 상태에서:

```bash
curl "http://localhost:8787/cdn-cgi/local/scheduled"
```

로컬 D1 내용을 SQL 로 직접 보려면:

```bash
npx wrangler d1 execute url-shortener-db --local --command "SELECT * FROM clicks ORDER BY id DESC LIMIT 10"
```

로컬 데이터를 초기화하려면 `.wrangler` 폴더를 지우고 `npm run db:migrate:local` 을 다시 실행합니다.

## Cloudflare 에 배포하기

```bash
npx wrangler login                                # 브라우저로 계정 인증 (최초 1회)

npx wrangler kv namespace create LINKS            # 출력된 id 를 wrangler.jsonc 의 kv_namespaces[0].id 에 붙여넣기
npx wrangler d1 create url-shortener-db           # 출력된 database_id 를 wrangler.jsonc 에 붙여넣기

npm run db:migrate:remote                         # 원격 D1 에 테이블 생성
npx wrangler secret put ADMIN_TOKEN               # 삭제 API 용 토큰 입력 (원격 비밀 값)
npm run deploy                                    # https://url-shortener.<계정>.workers.dev 로 배포
```

배포 후 같은 스모크 테스트를 원격에 돌려 볼 수 있습니다.

```bash
BASE_URL=https://url-shortener.<계정>.workers.dev ADMIN_TOKEN=<입력한 토큰> npm run smoke
```

짧은 도메인(예: `go.example.com`)을 쓰려면 대시보드 Workers → url-shortener → Settings → Domains & Routes 에서
Custom Domain 을 추가합니다(도메인이 Cloudflare 에 등록되어 있어야 함).

## 학습 포인트

1. **KV 는 최종 일관성**: 쓴 값이 다른 지역에 반영되는 데 최대 약 60초가 걸립니다.
   그래서 코드 중복 검사는 강한 일관성을 가진 D1 의 `PRIMARY KEY` 로 하고, 리다이렉트에서 KV 에 값이 없으면 D1 을 한 번 더 확인합니다(`src/index.ts` 의 ②).
2. **`ctx.waitUntil()`**: 응답을 먼저 보내고 클릭 로그는 뒤에서 기록합니다. 리다이렉트 지연이 늘지 않습니다.
3. **`request.cf`**: Cloudflare 가 요청마다 붙여 주는 국가·도시·ASN 정보. 로컬에서는 가짜 값(예: `US`)이 들어옵니다.
4. **D1 `batch()`**: 통계 쿼리 4개를 한 번의 왕복으로 보냅니다.
5. **인덱스**: D1 무료 플랜은 하루 읽은 행 수 한도(500만)를 넘으면 쿼리가 실패합니다. `clicks(code, clicked_at)` 인덱스로 전체 스캔을 피합니다.
6. **KV `expirationTtl`**: 만료가 있는 링크는 KV 가 알아서 지우고, D1 쪽은 Cron 으로 정리합니다.
7. **Rate Limiting 바인딩**: `env.CREATE_LIMITER.limit({ key: ip })` 한 줄로 IP 별 생성 횟수를 제한합니다.

## 더 해 볼 것

- 링크 생성 API 에도 토큰 인증 붙이기 (지금은 Rate Limit 만 있음)
- QR 코드 생성 (`/api/qr/:code`)
- 통계 화면을 HTML 차트로 만들기 → 미니 프로젝트 2 의 정적 자산 배포와 연결
- 충전기 단말기 로그 수집에 응용: `POST /api/logs` → D1 저장 → 국가/기기별 집계
