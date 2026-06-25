// 정적 조회 페이지 빌더 — requirements + 프로필 + match-core(매칭 단일소스)를 인라인 → 자체완결 site/index.html
//   브라우저가 createMatcher(P)로 직접 매칭 → 프로필 수정 시 실시간 재계산. 서버 불필요(더블클릭 실행).
//   템플릿=site/_template.html (placeholder: /*__DATA__*/ , /*__CORE__*/)
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// 빌드 전 드리프트 가드 — 계층 캐논 함수(match-core canonTier ↔ normalize canonTierKey) 본문 동일성 assert.
//   match-core는 브라우저 인라인용이라 import 불가 → 코드 공유 대신 빌드 게이트로 차단(드리프트 시 빌드 실패).
execFileSync(process.execPath, ['check-canon-drift.mjs'], { cwd: new URL('./', import.meta.url), stdio: 'inherit' });

const ROOT = new URL('./data/', import.meta.url);
const SRC = [['lh', new URL('derived/lh/', ROOT)], ['applyhome', new URL('derived/applyhome/', ROOT)], ['myhome', new URL('derived/myhome/', ROOT)], ['sh', new URL('derived/sh/', ROOT)], ['gh', new URL('derived/gh/', ROOT)]];
// 수집기가 index에 최신 상태·마감일을 갱신하는 소스(빌드때 liveIdx[r.panId]로 덮어쓰기).
//   ★ 키 규약: liveIdx 키 === r.panId (전 소스 불변식, collect-util makePanId 보장). 과거 applyhome만 panId=bare vs key='ah:…'라
//     overlay에 넣으면 조용히 실패했음 → 규약 일원화로 해소. 이제 어느 소스든 안전히 추가 가능(추가는 별도 판단).
const LIVE_OVERLAY = new Set(['lh', 'gh']);
const TODAY = new Date().toISOString().slice(0, 10);

// 빌드시 신선도 결정론 재계산. 마감일이 지났으면 '접수마감'으로(수집/추출 후 시간이 흘러도 빌드 TODAY가 권위).
//   보수적: 마감 외에는 기존 상태 보존 → '정정공고중'·'공고중' 같은 활성 뉘앙스를 '접수중'으로 평탄화하지 않음.
const ACTIVE = new Set(['접수중', '공고중', '정정공고중', '접수예정']);
function freshStatus(b, e, prev) {
  if (e && TODAY > e) return '접수마감';        // 마감일 경과 → 마감(유일한 결정론 강등)
  return prev ?? (e ? '접수중' : null);           // 그 외엔 기존 상태 보존
}

// 수집기(lh-collect)가 매 실행 갱신하는 최신 상태/마감일. 빌드 때 requirements에 덮어써 신선도 유지(접수중 필터·D-day).
const idxPath = new URL('index.json', ROOT);
const liveIdx = existsSync(idxPath) ? JSON.parse(readFileSync(idxPath, 'utf8')) : {};

// 1) requirements 수집(원문 그대로 + source/id 태깅)
const reqs = [];
for (const [src, base] of SRC) {
  if (!existsSync(base)) continue;
  for (const n of readdirSync(base)) {
    const f = new URL(`${n}/requirements.json`, base);
    if (!existsSync(f)) continue;
    const r = JSON.parse(readFileSync(f, 'utf8'));
    if (r.원문링크) delete r.원문링크.로컬PDF; // 개인 절대경로(/Users/…) 공개 site 유출 방지
    const li = LIVE_OVERLAY.has(src) ? liveIdx[r.panId] : null;
    if (li) { if (li.상태) r.상태 = li.상태; if ('마감일' in li) r.마감일 = li.마감일; }
    // 마감일 지난 건은 TODAY 기준 '접수마감'으로 강등(오버레이 없는 applyhome/myhome/sh도 신선도 유지).
    r.상태 = freshStatus(r.접수시작, r.마감일, r.상태);
    // SH 등 날짜 자체가 없는 활성건: 거짓 '공고중' 대신 '마감일 미상'으로 정직 표시(수시모집은 접수시작이 있어 제외).
    if (!r.마감일 && !r.접수시작 && ACTIVE.has(r.상태)) r.마감일미상 = true;
    r.__src = src; r.__id = `${src}:${r.panId || r.no || n}`;
    reqs.push(r);
  }
}

// 2) 프로필 — 기본은 빈 스켈레톤(공유용: 방문자가 직접 입력). --seed 면 내 profile.json 주입(개인용)
const EMPTY_PROFILE = {
  생년월일: null, 무주택: null, 세대원수: null, 월평균소득: null, 총자산: null, 자동차가액: null,
  거주지: { 시도: null, 시군구: null }, 거주개월: null,
  혼인상태: '미혼', 혼인신고일: null, 맞벌이: false, 자녀: [],
  청약저축: { 가입: null, 종류: '주택청약종합저축', 가입개월: null, 납입횟수: null, 저축총액: null, 예치금: null },
  무주택기간개월: null, 부양가족: { 직계존속: 0 }, 수급자: '해당없음', 특수자격: [], 공급계층선택: [],
  희망: { 지역: [], 전용면적: { min: null, max: null } },
};
const seed = process.argv.includes('--seed');
const P = seed ? JSON.parse(readFileSync(new URL('profile.json', import.meta.url), 'utf8')) : EMPTY_PROFILE;
const meta = { 기준일: TODAY, 건수: reqs.length, seed };

// 3) match-core 인라인용 소스(export 제거 → createMatcher 전역)
const core = readFileSync(new URL('match-core.mjs', import.meta.url), 'utf8').replace(/\bexport\s+/g, '');

// 4) 템플릿 주입
const tpl = readFileSync(new URL('site/_template.html', import.meta.url), 'utf8');
const html = tpl
  .replace('/*__CORE__*/', core)
  .replace('/*__DATA__*/ {meta:{},profile:{},reqs:[]}', JSON.stringify({ meta, profile: P, reqs }));
writeFileSync(new URL('site/index.html', import.meta.url), html);

const kb = Math.round(Buffer.byteLength(html) / 1024);
console.log(`✅ site/index.html 생성 — 공고 ${reqs.length}건 인라인, ${kb}KB · 기본프로필=${seed ? '내 profile.json(개인용)' : '빈값(공유용·방문자 입력)'}`);
console.log(`   매칭은 브라우저에서 match-core로 계산(프로필 수정→실시간 재계산, localStorage 저장).`);
console.log(`   공유용 빌드: node build-site.mjs   /   개인용(내 조건 미리채움): node build-site.mjs --seed`);
