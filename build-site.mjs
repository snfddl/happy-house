// 정적 조회 페이지 빌더 — requirements + 프로필 + match-core(매칭 단일소스)를 인라인 → 자체완결 site/index.html
//   브라우저가 createMatcher(P)로 직접 매칭 → 프로필 수정 시 실시간 재계산. 서버 불필요(더블클릭 실행).
//   템플릿=site/_template.html (placeholder: /*__DATA__*/ , /*__CORE__*/)
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadCache, normKey, regionOf } from './geo.mjs';
import { validateReq } from './validate-requirements.mjs';

// .env 로드(Node는 자동 로드 안 함) — SUPABASE_URL/ANON_KEY 등 주입용. 없으면(CI) 무시, 실제 env 우선.
try { process.loadEnvFile(new URL('.env', import.meta.url)); } catch { /* .env 없음 → 실제 env만 사용 */ }

// 빌드 전 드리프트 가드 — 계층 캐논 함수(match-core canonTier ↔ normalize canonTierKey) 본문 동일성 assert.
//   match-core는 브라우저 인라인용이라 import 불가 → 코드 공유 대신 빌드 게이트로 차단(드리프트 시 빌드 실패).
execFileSync(process.execPath, ['check-canon-drift.mjs'], { cwd: new URL('./', import.meta.url), stdio: 'inherit' });

const ROOT = new URL('./data/', import.meta.url);
const geo = loadCache();   // 좌표 사이드카(주소/지역 키) — 지도 핀용. 미존재 시 빈 객체(좌표목록 전부 [], 빌드 무결).

// 좌표 조인 — req → 단지별 핀 목록. 단지 주소 정밀좌표 우선, 미스 시 시군구 centroid 폴백, 둘 다 없으면 핀 없음.
//   build-site는 node라 geo.mjs import 가능(match-core처럼 브라우저 인라인 아님). normKey/regionOf로 seed·geocode와 키 일치.
function coordsFor(r) {
  const out = [];
  const 단지 = Array.isArray(r.단지) ? r.단지 : [];
  for (const d of 단지) {
    const addr = d.주소 || '';
    const hit = addr && geo[normKey(addr)];
    if (hit && hit.lat != null) { out.push({ 단지명: d.단지명 || r.공고명 || '', lat: hit.lat, lng: hit.lng, 확정도: hit.확정도 || '건물' }); continue; }
    const reg = geo[normKey(regionOf(addr))];
    if (reg && reg.lat != null) out.push({ 단지명: d.단지명 || r.공고명 || '', lat: reg.lat, lng: reg.lng, 확정도: '시군구' });
  }
  // 단지 없음 OR 단지 주소가 전부 placeholder("공고문미기재")로 핀 0 → 공고 지역 문자열로 시군구 폴백.
  if (!out.length) {
    const reg = geo[normKey(regionOf(r.지역 || ''))];
    if (reg && reg.lat != null) out.push({ 단지명: r.공고명 || '', lat: reg.lat, lng: reg.lng, 확정도: '시군구' });
  }
  return out;
}
const SRC = [['lh', new URL('derived/lh/', ROOT)], ['applyhome', new URL('derived/applyhome/', ROOT)], ['myhome', new URL('derived/myhome/', ROOT)], ['sh', new URL('derived/sh/', ROOT)], ['gh', new URL('derived/gh/', ROOT)]];
const TODAY = new Date().toISOString().slice(0, 10);

// 빌드시 신선도 결정론 재계산. 마감일 경과→접수마감, 접수시작 전→접수예정(거짓 '접수중'·'공고중' 방지, statusOf와 정렬).
//   그 외엔 기존 상태 보존(보수적) → '정정공고중' 등 활성 뉘앙스를 '접수중'으로 평탄화하지 않음.
const ACTIVE = new Set(['접수중', '공고중', '정정공고중', '접수예정']);
function freshStatus(b, e, prev) {
  if (e && TODAY > e) return '접수마감';        // 마감일 경과 → 마감(결정론 강등)
  if (b && TODAY < b) return '접수예정';         // 접수시작 전 → 예정(아직 안 열린 공고를 '접수중'으로 오표시 방지)
  return prev ?? (e ? '접수중' : null);           // 그 외엔 기존 상태 보존
}

// 수집기(lh-collect)가 매 실행 갱신하는 최신 상태/마감일. 빌드 때 requirements에 덮어써 신선도 유지(접수중 필터·D-day).
const idxPath = new URL('index.json', ROOT);
const liveIdx = existsSync(idxPath) ? JSON.parse(readFileSync(idxPath, 'utf8')) : {};

// 1) requirements 수집(원문 그대로 + source/id 태깅)
let reqs = [];
const gateDropped = [];   // 게이트 fail(필수필드 누락·enum 위반·JSON 깨짐)은 사이트에 싣지 않음 — 리포트-only 게이트의 노출 구멍 차단
for (const [src, base] of SRC) {
  if (!existsSync(base)) continue;
  for (const n of readdirSync(base)) {
    const f = new URL(`${n}/requirements.json`, base);
    if (!existsSync(f)) continue;
    let r;
    try { r = JSON.parse(readFileSync(f, 'utf8')); }
    catch { gateDropped.push(`${src}:${n} JSON 파싱 실패`); continue; }
    const gate = validateReq(r);
    if (gate.status === 'fail') { gateDropped.push(`${src}:${n} ${gate.사유}`); continue; }
    if (r.원문링크) delete r.원문링크.로컬PDF; // 개인 절대경로(/Users/…) 공개 site 유출 방지
    // index 신선도 오버레이 — 전 소스 일반화(panId 불변식으로 liveIdx[r.panId] 어느 소스든 해소; 과거 {lh,gh} 하드코딩은 CI refresh하는 sh 등 누락).
    //   수집/refresh가 매 실행 index의 상태·마감일을 갱신 → 빌드 때 requirements에 덮어 신선도 유지. 미존재 키는 freshStatus 백스톱만.
    const li = liveIdx[r.panId];
    if (li) { if (li.상태) r.상태 = li.상태; if ('마감일' in li) r.마감일 = li.마감일; }
    // 마감일 지난 건은 TODAY 기준 '접수마감'으로 강등(오버레이 없는/미존재 건도 신선도 유지).
    r.상태 = freshStatus(r.접수시작, r.마감일, r.상태);
    // SH 등 날짜 자체가 없는 활성건: 거짓 '공고중' 대신 '마감일 미상'으로 정직 표시(수시모집은 접수시작이 있어 제외).
    if (!r.마감일 && !r.접수시작 && ACTIVE.has(r.상태)) r.마감일미상 = true;
    r.__src = src; r.__id = `${src}:${r.panId || r.no || n}`;
    r.좌표목록 = coordsFor(r);   // 지도 핀(단지 단위). 빈 배열이면 '위치 표기 없음' 폴백.
    reqs.push(r);
  }
}

// 1.5) 정정공고 중복 제거 — LH는 정정 시 정정본을 새 panId로 발급하고 원본은 '정정공고중' 상태로 남겨
//   원본·정정본이 둘 다 수집된다(meta에 상호참조 없음). 동일 (소스·공고명·유형·지역) 그룹에 '정정공고중'
//   원본과 비-'정정공고중' 정정본이 함께 있으면 원본만 제외(정정본 표시). 차수만 다른 동일제목은 건드리지 않음(보수적).
const dupKey = r => `${r.__src}|${(r.공고명 || '').replace(/\s+/g, '')}|${r.유형 || ''}|${r.지역 || ''}`;
const dupGroups = new Map();
for (const r of reqs) { const k = dupKey(r); if (!dupGroups.has(k)) dupGroups.set(k, []); dupGroups.get(k).push(r); }
const dupDropped = [];
reqs = reqs.filter(r => {
  if (r.상태 !== '정정공고중') return true;
  const hasRevision = dupGroups.get(dupKey(r)).some(o => o !== r && o.상태 !== '정정공고중');
  if (hasRevision) { dupDropped.push(r.panId); return false; }
  return true;
});
if (dupDropped.length) console.log(`정정공고 원본 ${dupDropped.length}건 제외(정정본 존재): ${dupDropped.join(', ')}`);
if (gateDropped.length) console.log(`⚠️ 게이트 fail ${gateDropped.length}건 사이트 제외(리포트/원문 확인 필요):\n  ${gateDropped.join('\n  ')}`);

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
const geoOK = reqs.filter(r => (r.좌표목록 || []).length).length;   // 핀 있는 공고 수(지도 표시율)
const meta = { 기준일: TODAY, 건수: reqs.length, seed, 지도표시: geoOK, 지도미표시: reqs.length - geoOK };

// 알림 구독(Supabase) 공개설정 — env 있을 때만 주입. anon 키는 공개 의도(RLS로 INSERT만 허용).
//   미설정(CI·타인 빌드)이면 null → 템플릿이 '알림 받기' UI를 숨김(무결).
const notifyCfg = (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY)
  ? { url: process.env.SUPABASE_URL, anonKey: process.env.SUPABASE_ANON_KEY }
  : null;

// 3) match-core 인라인용 소스(export 제거 → createMatcher 전역)
const core = readFileSync(new URL('match-core.mjs', import.meta.url), 'utf8').replace(/\bexport\s+/g, '');

// 3.5) 인라인 페이로드 슬림 — 매처·템플릿이 읽지 않는 내부/감수 필드 제거(전수 grep 검증, ~27% 절감).
//   source(requirements.json)는 불변 보존, 빌드 산출(index.html)만 슬림. 새 표시필드 추가 시 깨지지 않도록 allowlist가 아닌 blocklist.
//   원문링크.로컬PDF는 절대경로(홈 디렉터리) 공개 누출 방지 겸 제거.
const STRIP_KEYS = ['특별공급접수', '선정방식상세', '우선배정', '_검증노트', '공급기관', '공고구분', '접수방법', '분양전환상세', '특이사항', 'files', '__pdf추출', '모집유형', '선정순서', '주택관리번호', '임대료체계', '우선공급_배정호수', '자격요건_원본주'];
for (const r of reqs) {
  for (const k of STRIP_KEYS) delete r[k];
  if (r.원문링크) { delete r.원문링크.로컬PDF; if (Array.isArray(r.원문링크.첨부)) r.원문링크.첨부.forEach(a => delete a.name); }
  if (r.참고분석) delete r.참고분석.검증노트;
}

// 4) 템플릿 주입 — Leaflet 벤더 인라인(자체완결 단일 HTML 철학: file:// 더블클릭서도 라이브러리 로드 네트워크 불필요, 타일만 네트워크).
//    함수형 replace로 $& 등 특수치환 회피(Leaflet 코드에 $ 다수).
const leafletJs = readFileSync(new URL('data/vendor/leaflet.js', import.meta.url), 'utf8');
const leafletCss = readFileSync(new URL('data/vendor/leaflet.css', import.meta.url), 'utf8');
const tpl = readFileSync(new URL('site/_template.html', import.meta.url), 'utf8');
const html = tpl
  .replace('/*__CORE__*/', () => core)
  .replace('/*__LEAFLET_CSS__*/', () => leafletCss)
  .replace('/*__LEAFLET_JS__*/', () => leafletJs)
  .replace('/*__DATA__*/ {meta:{},profile:{},reqs:[]}', () => JSON.stringify({ meta, profile: P, reqs, notify: notifyCfg }));
writeFileSync(new URL('site/index.html', import.meta.url), html);

// notify.mjs 소비용 — 신선도/슬림 반영된 최종 reqs(브라우저가 매칭하는 것과 동일). gitignore(재생성 가능).
writeFileSync(new URL('data/reqs-built.json', import.meta.url), JSON.stringify(reqs));

// 알림 해지 페이지 — notifyCfg 있을 때만 생성(공개설정 주입). 없으면 미생성(이메일 링크도 안 나감).
if (notifyCfg) {
  const ut = readFileSync(new URL('site/_unsubscribe.html', import.meta.url), 'utf8');
  writeFileSync(new URL('site/unsubscribe.html', import.meta.url), ut.replace('const NOTIFY=/*__NOTIFY__*/null;', () => `const NOTIFY=${JSON.stringify(notifyCfg)};`));
}

const kb = Math.round(Buffer.byteLength(html) / 1024);
console.log(`✅ site/index.html 생성 — 공고 ${reqs.length}건 인라인, ${kb}KB · 기본프로필=${seed ? '내 profile.json(개인용)' : '빈값(공유용·방문자 입력)'}`);
console.log(`   매칭은 브라우저에서 match-core로 계산(프로필 수정→실시간 재계산, localStorage 저장).`);
console.log(`   공유용 빌드: node build-site.mjs   /   개인용(내 조건 미리채움): node build-site.mjs --seed`);
