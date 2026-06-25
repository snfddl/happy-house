// check-canon-drift.mjs — 계층 캐논 함수 드리프트 가드.
//   `match-core.mjs`의 canonTier 와 `normalize-requirements.mjs`의 canonTierKey 는 본문이 동일해야 한다.
//   계층 enum은 도메인 규칙이라 한쪽만 고치면 매처와 정규화가 어긋나 조용한 매칭 오류가 난다.
//   match-core는 브라우저 인라인용이라 import 금지(CLAUDE.md §4) → 코드 공유 불가 → 본문 동일성 assert 로 드리프트 차단.
//   사용: node check-canon-drift.mjs  (드리프트 시 exit 1). build-site.mjs가 빌드 전 호출 → CI/로컬 모두 차단.
import { readFileSync } from 'node:fs';

// 함수 본문을 추출(시그니처 줄의 여는 '{'부터 중괄호 깊이 0까지) → 정규화.
//   정규화: 줄별 trim, 빈 줄·줄주석(//…) 제거. 시그니처 줄(함수명 상이)은 본문에서 제외.
//   따라서 이름·들여쓰기·주석 차이는 무시하고 '규칙 본문'만 비교 → 의도된 차이엔 안 깨지고 실제 규칙 변경만 잡는다.
function extractBody(src, fnName) {
  const decl = new RegExp(`function\\s+${fnName}\\s*\\(`);
  const m = decl.exec(src);
  if (!m) throw new Error(`함수 ${fnName} 을(를) 찾지 못함`);
  let i = src.indexOf('{', m.index);
  if (i < 0) throw new Error(`함수 ${fnName} 본문 여는 괄호 없음`);
  const start = i + 1;
  let depth = 1;
  for (i = start; i < src.length && depth > 0; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
  }
  if (depth !== 0) throw new Error(`함수 ${fnName} 본문 괄호 불일치`);
  const body = src.slice(start, i - 1);
  return body
    .split('\n')
    .map(l => l.replace(/\/\/.*$/, '').trim())   // 줄주석 제거 + trim
    .filter(Boolean)
    .join('\n');
}

const here = new URL('./', import.meta.url);
const matchCore = readFileSync(new URL('match-core.mjs', here), 'utf8');
const normalize = readFileSync(new URL('normalize-requirements.mjs', here), 'utf8');

const a = extractBody(matchCore, 'canonTier');
const b = extractBody(normalize, 'canonTierKey');

if (a !== b) {
  console.error('✗ canonTier 드리프트 감지 — 두 함수 본문이 다릅니다.');
  console.error('  match-core.mjs canonTier  ↔  normalize-requirements.mjs canonTierKey');
  console.error('  계층 enum은 도메인 규칙입니다. 한쪽만 고치면 매칭이 조용히 깨집니다. 두 본문을 일치시키세요.\n');
  console.error('--- match-core.mjs canonTier ---\n' + a);
  console.error('\n--- normalize-requirements.mjs canonTierKey ---\n' + b);
  process.exit(1);
}

console.log('✓ canonTier 동일성 OK (match-core ↔ normalize-requirements)');
