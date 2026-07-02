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

// 2) 금액 필드 동의어 드리프트 — match-core TIER_ALIAS ↔ normalize FIELD_SYN(자산상한·자동차상한).
//    normalize가 새 동의어를 배우고 매처가 못 배우면 비정규화 데이터에서 자산 게이트가 조용히 새는(#6) 재발 경로 — 목록 동일성 assert.
function extractAliasArr(src, blockName, key) {
  const bi = src.indexOf(blockName);
  if (bi < 0) throw new Error(`${blockName} 을(를) 찾지 못함`);
  const seg = src.slice(bi, src.indexOf('};', bi) + 2);
  const m = new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`).exec(seg);
  if (!m) throw new Error(`${blockName}.${key} 배열을 찾지 못함`);
  return m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).join('|');
}
for (const key of ['자산상한', '자동차상한']) {
  const ma = extractAliasArr(matchCore, 'TIER_ALIAS', key);
  const nb = extractAliasArr(normalize, 'FIELD_SYN', key);
  if (ma !== nb) {
    console.error(`✗ 금액 동의어 드리프트 감지 — ${key}`);
    console.error(`  match-core TIER_ALIAS : ${ma}`);
    console.error(`  normalize FIELD_SYN   : ${nb}`);
    console.error('  두 목록(순서 포함)을 일치시키세요 — 한쪽만 배우면 비정규화 데이터에서 자산/자동차 게이트가 조용히 샙니다.');
    process.exit(1);
  }
}

console.log('✓ canonTier·금액동의어 동일성 OK (match-core ↔ normalize-requirements)');
