// geocode.mjs — 전 소스 단지 주소·지역 문자열을 좌표로 변환해 geo-cache.json에 캐시(멱등·증분).
//   Kakao Local(로컬 전용 키 단계). 1회 실행 후 캐시 커밋 → CI/빌드는 캐시만 읽음(키-0 유지, 추출(LLM)과 동일 운영 모델).
//   2계층: (a) 단지[].주소 → 건물 수준  (b) 지역/주소의 '시도 시군구' → centroid 폴백(주소 미스·단지-less 공고용).
//   사용: node geocode.mjs            → 캐시에 없는 것만(증분)
//         node geocode.mjs --force     → 전체 재지오코딩
//         node geocode.mjs --limit 20  → 앞 20건만(테스트)
//   키: .env에 KAKAO_REST_KEY=... (developers.kakao.com REST 키, 무과금). 키 없으면 안내 후 종료(빌드는 캐시/폴백으로 진행).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { loadCache, saveCache, normKey, regionOf, geocodeOne, hasKey } from './geo.mjs';

if (!hasKey()) {
  console.error('⚠️  KAKAO_REST_KEY 없음 — 지오코딩 건너뜀.');
  console.error('   1) https://developers.kakao.com 앱 생성 → REST API 키 복사(무과금)');
  console.error('   2) 프로젝트 루트 .env에  KAKAO_REST_KEY=<키>  추가');
  console.error('   3) node geocode.mjs 재실행. (키는 커밋되지 않음 — geo-cache.json 결과만 커밋)');
  process.exit(1);
}

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const LIMIT = argv.includes('--limit') ? +argv[argv.indexOf('--limit') + 1] : Infinity;
const TODAY = new Date().toISOString().slice(0, 10);
const ROOT = new URL('./data/derived/', import.meta.url);
const SRC = ['lh', 'applyhome', 'myhome', 'sh', 'gh'];

// 1) 전 소스 requirements 순회 → 지오코딩 대상 수집(주소=건물, 지역=centroid)
const addrs = new Map();   // normKey(주소) → 원주소(질의용)
const regions = new Map(); // normKey(regionOf) → regionOf 문자열
for (const s of SRC) {
  const base = new URL(`${s}/`, ROOT);
  if (!existsSync(base)) continue;
  for (const no of readdirSync(base)) {
    const p = new URL(`${no}/requirements.json`, base);
    if (!existsSync(p)) continue;
    let r; try { r = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; }
    const 단지 = Array.isArray(r.단지) ? r.단지 : [];
    if (단지.length) {
      for (const d of 단지) {
        const a = d.주소 || '';
        if (a) { addrs.set(normKey(a), a); const rg = regionOf(a); if (rg) regions.set(normKey(rg), rg); }
      }
    } else {
      const rg = regionOf(r.지역 || '');
      if (rg) regions.set(normKey(rg), rg);
    }
  }
}

// 2) 지오코딩 — 주소(건물) 우선, 그다음 지역(centroid). 캐시에 없는 것만(증분). 증분 저장으로 중단 내성.
const geo = loadCache();
const jobs = [
  ...[...addrs].map(([k, q]) => ({ k, q, 확정도: '건물', src: 'kakao' })),
  ...[...regions].map(([k, q]) => ({ k, q, 확정도: '시군구', src: 'kakao-region' })),
].filter(j => FORCE || !geo[j.k]).slice(0, LIMIT);

console.log(`지오코딩 대상 ${jobs.length}건 (주소 ${addrs.size}·지역 ${regions.size}, 캐시 ${Object.keys(geo).length}) — Kakao Local\n`);
let ok = 0, miss = 0, n = 0;
for (const j of jobs) {
  const hit = geocodeOne(j.q);
  n++;
  if (hit) { geo[j.k] = { lat: hit.lat, lng: hit.lng, src: j.src, 확정도: j.확정도, ts: TODAY }; ok++; }
  else { miss++; console.log(`·  미스: ${j.q}`); }
  if (n % 40 === 0) { saveCache(geo); console.log(`   …${n}/${jobs.length} (적중 ${ok}·미스 ${miss})`); }
}
saveCache(geo);
console.log(`\n✅ 지오코딩 완료 — 적중 ${ok}·미스 ${miss}/${jobs.length}. 캐시 총 ${Object.keys(geo).length}건 → data/derived/geo-cache.json`);
console.log(`   미스는 build-site가 시군구 centroid로 폴백. 다음: node build-site.mjs`);
