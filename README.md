# CloudFlareStudy

Cloudflare 개발자 플랫폼을 미니 프로젝트로 익히는 학습 저장소입니다.
프로젝트마다 하위 폴더 하나를 쓰며, 각 폴더는 독립된 Worker 프로젝트입니다(`npm install` 도 폴더별로).

| 폴더 | 프로젝트 | 핵심 서비스 | 상태 |
| --- | --- | --- | --- |
| [01-url-shortener](./01-url-shortener) | URL 단축기 | Workers, KV, D1, Cron Triggers, Rate Limiting | 완료 |
| 02-photo-gallery | 사진 갤러리 | Workers Static Assets, R2, D1, Images | 예정 |
| [03-ai-doc-chatbot](./03-ai-doc-chatbot) | 사내 문서 AI 챗봇 | Workers AI, Vectorize, Queues, Agents SDK(Durable Objects), AI Gateway, Rate Limiting | 완료 |

## 공통 준비물

- Node.js 20 이상 (LTS 권장)
- Cloudflare 계정 (무료 플랜으로 충분) — 배포할 때만 필요, 로컬 실행에는 필요 없음
- Wrangler CLI 는 각 프로젝트의 `devDependencies` 에 들어 있으므로 따로 전역 설치할 필요가 없습니다. `npx wrangler ...` 로 실행합니다.

## 새 프로젝트 추가 방법

```bash
npm create cloudflare@latest 02-photo-gallery   # 템플릿 생성
```

폴더 이름은 `번호-이름` 형식으로 맞추고, 위 표에 한 줄 추가합니다.
