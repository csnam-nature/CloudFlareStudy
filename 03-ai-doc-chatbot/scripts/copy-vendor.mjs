// 화면에서 쓰는 그래프 라이브러리를 node_modules 에서 public/vendor/ 로 복사합니다.
// npm install 이 끝나면 자동으로 실행됩니다(package.json 의 postinstall).
//
// 왜 CDN 이 아니라 직접 올리나?
//   - 회사망·방화벽에서 CDN 이 막혀도 그래프가 그려지고, 버전이 package-lock.json 에 고정됩니다.
//   - Worker 정적 자산으로 같이 배포되므로 따로 설정할 것이 없습니다.
// public/vendor/ 는 .gitignore 에 있어 저장소에는 올라가지 않습니다.

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "vendor");
mkdirSync(out, { recursive: true });

const files = [
  ["chart.js/dist/chart.umd.min.js", "chart.umd.min.js"], // 막대·선·원 그래프 (약 200KB)
  ["mermaid/dist/mermaid.min.js", "mermaid.min.js"], // 순서도 등 도식 (약 3.5MB, 도식이 나올 때만 불러옴)
];
for (const [from, to] of files) {
  copyFileSync(join(root, "node_modules", from), join(out, to));
  console.log(`vendor: ${from} → public/vendor/${to}`);
}
