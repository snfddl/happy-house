// AI 참고분석 주입 — 에이전트가 생성한 JSON({no:{요약,확신도,출처}})을 requirements.json의 '참고분석'에 기록.
// 사용: node inject-analysis.mjs [--file=data/analysis-results.json] [--date=YYYY-MM-DD]
// 멱등. 생성일은 신선도 표기·재생성 판단용. (생성은 외부 API 0 — /update의 Sonnet 에이전트가 수행.)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const argv = process.argv.slice(2);
const getArg = (k, d) => { const a = argv.find(s => s.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const FILE = getArg('file', 'data/analysis-results.json');
const DATE = getArg('date', new Date().toISOString().slice(0, 10));

const ROOT = new URL('./data/derived/applyhome/', import.meta.url);
if (!existsSync(FILE)) { console.error(`❌ 결과 파일 없음: ${FILE}`); process.exit(1); }
const results = JSON.parse(readFileSync(FILE, 'utf8'));

let ok = 0, miss = 0;
for (const [no, a] of Object.entries(results)) {
  const rp = new URL(`${no}/requirements.json`, ROOT);
  if (!existsSync(rp)) { console.warn(`  ⚠️ ${no} requirements 없음 — 건너뜀`); miss++; continue; }
  if (!a || !a.요약) { console.warn(`  ⚠️ ${no} 요약 비어있음 — 건너뜀`); miss++; continue; }
  const r = JSON.parse(readFileSync(rp, 'utf8'));
  r.참고분석 = { 요약: a.요약, 확신도: a.확신도 || '하', 출처: a.출처 || [], 생성일: DATE };
  writeFileSync(rp, JSON.stringify(r, null, 2));
  ok++;
}
console.log(`AI 참고분석 주입: ${ok}건${miss ? ` · 건너뜀 ${miss}` : ''} (생성일 ${DATE})`);
