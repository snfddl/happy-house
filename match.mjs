// match.mjs — UserProfile(profile.json) × NoticeRequirements(임대 derived/lh + 분양 derived/applyhome)
//   매칭 로직은 match-core.mjs(단일 소스, 웹페이지와 공유). 여기선 파일 IO·CLI·출력만.
//   결정론·외부 LLM API 미사용. 확정 가능한 것만 판정, 불확실은 "확인필요"·"참고"(추측 금지).
//   분양: 가점 84점(민영 일반공급)·청약순위·지역우선·특공해당(공공분양=순차제). SCHEMA §6.
// 사용:
//   node match.mjs                      접수가능 공고만, 지원가능 우선 정렬
//   node match.mjs --all                마감 포함 전체
//   node match.mjs --profile=other.json 다른 프로필
//   node match.mjs --type=민영분양        유형 필터(행복주택/민영분양/공공분양 등)
//   node match.mjs --supply=분양          공급형태 필터(지원형|실물|분양)
//   node match.mjs --possible            지원가능만
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { createMatcher } from './match-core.mjs';

const ROOT = new URL('./data/', import.meta.url);
const DERIVED = new URL('derived/lh/', ROOT);
const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const opt = (n, d) => { const a = argv.find(x => x.startsWith(`${n}=`)); return a ? a.split('=')[1] : d; };
const TODAY = new Date().toISOString().slice(0, 10);

const P = JSON.parse(readFileSync(new URL(opt('--profile', 'profile.json'), import.meta.url), 'utf8'));
const matcher = createMatcher(P, TODAY);
const won = n => (n == null ? '?' : (n / 1e4).toLocaleString() + '만');

// ── 수집: 임대(lh·myhome·sh·gh) + 분양(applyhome) — build-site.mjs와 동일 소스셋 ──
const SOURCES = ['lh', 'applyhome', 'myhome', 'sh', 'gh'].map(s => new URL(`derived/${s}/`, ROOT));
let reqs = [];
for (const dir of SOURCES) {
  if (!existsSync(dir)) continue;
  for (const n of readdirSync(dir)) {
    const f = new URL(`${n}/requirements.json`, dir);
    if (existsSync(f)) reqs.push(JSON.parse(readFileSync(f, 'utf8')));
  }
}
let results = reqs.map(r => matcher.evaluate(r));

// ── 필터 ──────────────────────────────────────────────────────
const ACTIVE = new Set(['접수중', '공고중', '정정공고중', '접수예정']);
const typeFilter = opt('--type', null);
if (!flag('--all')) results = results.filter(r => ACTIVE.has(r.상태) && (r.dday == null || r.dday >= 0));
if (typeFilter) results = results.filter(r => r.유형 === typeFilter);
if (flag('--possible')) results = results.filter(r => r.판정 === '지원가능');
const supplyFilter = opt('--supply', null);
if (supplyFilter) results = results.filter(r => r.공급형태 === supplyFilter);
if (flag('--conversion')) results = results.filter(r => r.분양전환);
const regionOnly = flag('--region-only');
if (regionOnly) results = results.filter(r => r.희망지역매칭 === true);

const order = { 지원가능: 0, 확인필요: 1, 지원불가: 2 };
results.sort((a, b) => (order[a.판정] - order[b.판정])
  || ((b.희망지역매칭 === true) - (a.희망지역매칭 === true))
  || ((a.dday ?? 9999) - (b.dday ?? 9999)));

// ── 출력 ──────────────────────────────────────────────────────
const icon = { 지원가능: '✅', 확인필요: '⚠️', 지원불가: '❌' };
const cnt = { 지원가능: 0, 확인필요: 0, 지원불가: 0 };
for (const r of results) cnt[r.판정]++;
const inRegion = results.filter(r => r.희망지역매칭 === true && r.판정 !== '지원불가').length;
console.log(`\n프로필: ${matcher.age}세·세대${P.세대원수}인·소득${won(P.월평균소득)}·${P.거주지?.시도} ${P.거주지?.시군구}·${P.무주택 ? '무주택' : '유주택'}`);
console.log(`대상 ${results.length}건 → ✅지원가능 ${cnt.지원가능} / ⚠️확인필요 ${cnt.확인필요} / ❌불가 ${cnt.지원불가}`);
console.log(`희망지역(${(P.희망?.지역 || []).join('·')}) 내 지원가능·확인필요: ${inRegion}건`);
const sf = results.reduce((a, r) => (a[r.공급형태] = (a[r.공급형태] || 0) + 1, a), {});
console.log(`공급형태: 실물 ${sf.실물 || 0} / 지원형 ${sf.지원형 || 0} / 분양 ${sf.분양 || 0}${sf.불명 ? ` / 불명 ${sf.불명}` : ''}  (필터: --supply=지원형|실물|분양, --conversion)\n`);
for (const r of results) {
  const dd = r.dday == null ? '' : r.dday === 0 ? ' [D-DAY]' : r.dday > 0 ? ` [D-${r.dday}]` : ` [마감]`;
  const tag = r.공급형태 === '지원형' ? ' 〔지원형〕' : r.공급형태 === '분양' ? ' 〔분양〕' : '';
  const conv = r.분양전환 ? ' 〔분양전환〕' : '';
  console.log(`${icon[r.판정]} ${r.유형}${tag}${conv} | ${(r.공고명 || '').slice(0, 40)} | ${r.지역}${dd}`);
  if (r.실격사유.length) console.log(`     실격: ${r.실격사유.join(' / ')}`);
  if (r.확인필요.length) console.log(`     확인: ${r.확인필요.join(' / ')}`);
  if (r.참고?.length) console.log(`     참고: ${r.참고.join(' / ')}`);
  const sub = [r.공급형태설명, r.거주지순위, r.예상배점, r.면적, r.지역희망].filter(Boolean);
  if (r.판정 !== '지원불가' && sub.length) console.log(`     ${sub.join(' · ')}`);
}
writeFileSync(new URL('match-result.json', ROOT), JSON.stringify({ 프로필: P, 계산시각: TODAY, 요약: cnt, 결과: results }, null, 2));
console.log(`\n전체 결과: data/match-result.json`);
