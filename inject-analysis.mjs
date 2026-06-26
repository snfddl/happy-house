// AI 참고분석 주입 — 에이전트가 생성한 JSON({no:{요약,확신도,출처}})을 requirements.json의 '참고분석'에 기록.
// 사용: node inject-analysis.mjs [--file=data/analysis-results.json] [--date=YYYY-MM-DD]
// 멱등. 생성일은 신선도 표기·재생성 판단용. (생성은 외부 API 0 — /update의 Sonnet 에이전트가 수행.)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const argv = process.argv.slice(2);
const getArg = (k, d) => { const a = argv.find(s => s.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const FILE = getArg('file', 'data/analysis-results.json');
const DATE = getArg('date', new Date().toISOString().slice(0, 10));

// 소스 무관: panId(no)로 5개 derived 디렉터리를 탐색해 해당 requirements를 찾는다(분양 applyhome + 임대 lh/sh/gh/myhome 공용).
// 결과 항목에 source가 있으면 그 디렉터리만 본다(충돌 차단). 없으면 전 소스 탐색하되 다중매치 경고(panId 충돌 가드).
const SOURCES = ['applyhome', 'lh', 'sh', 'gh', 'myhome'];
const findReq = (no, src) => {
  if (src) { const p = new URL(`./data/derived/${src}/${no}/requirements.json`, import.meta.url); return existsSync(p) ? p : null; }
  const hits = SOURCES.map(s => new URL(`./data/derived/${s}/${no}/requirements.json`, import.meta.url)).filter(existsSync);
  if (hits.length > 1) console.warn(`  ⚠️ panId ${no} 다중 소스 매치(${hits.length}) — 첫 항목 사용. results에 source 명시 권장`);
  return hits[0] || null;
};
if (!existsSync(FILE)) { console.error(`❌ 결과 파일 없음: ${FILE}`); process.exit(1); }
const results = JSON.parse(readFileSync(FILE, 'utf8'));

let ok = 0, miss = 0;
for (const [no, a] of Object.entries(results)) {
  const rp = findReq(no, a?.source);   // results 항목에 source 있으면 그 소스만(충돌 차단)
  if (!rp) { console.warn(`  ⚠️ ${no} requirements 없음 — 건너뜀`); miss++; continue; }
  if (!a || !a.요약) { console.warn(`  ⚠️ ${no} 요약 비어있음 — 건너뜀`); miss++; continue; }
  const r = JSON.parse(readFileSync(rp, 'utf8'));
  r.참고분석 = { 요약: a.요약, 확신도: a.확신도 || '하', 출처: a.출처 || [], 생성일: DATE,
    검증: a.검증 || null, 검증노트: a.검증노트 || null };   // Opus 적대검증 결과(통과/수정 + 1줄 노트)
  writeFileSync(rp, JSON.stringify(r, null, 2));
  ok++;
}
console.log(`AI 참고분석 주입: ${ok}건${miss ? ` · 건너뜀 ${miss}` : ''} (생성일 ${DATE})`);
