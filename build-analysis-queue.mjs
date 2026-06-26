// 무순위/잔여 분양 'AI 참고 분석' 생성 큐 — 결정론적으로 대상만 추린다(생성은 에이전트, 외부 API 0).
// 사용: node build-analysis-queue.mjs  → data/analysis-queue.json
// 대상: 활성(마감 전) '무순위/잔여' 분양 중 참고분석이 없는 건. (생성은 /update가 Sonnet 에이전트로 수행 후 inject-analysis로 주입.)
// 범위 한정 이유: 무순위/잔여는 '미달·이탈 사유'가 사용자 가치 크고 사실성 높음. 민영 일반분양 시세코멘트는 책임·신뢰도 이슈로 제외.
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

const ROOT = new URL('./data/', import.meta.url);
const DER = new URL('derived/applyhome/', ROOT);
const idx = existsSync(new URL('index.json', ROOT)) ? JSON.parse(readFileSync(new URL('index.json', ROOT), 'utf8')) : {};
const TODAY = new Date().toISOString().slice(0, 10);
const eok = w => (w / 10000).toFixed(2).replace(/\.?0+$/, '') + '억';

const PROMPT = (nm, addr, lo, hi) => `너는 부동산 분양 보조 분석가다. 아래 '무순위/잔여세대' 분양을 웹검색해 사실 위주로 분석하라.
무순위/잔여세대 = 정식 청약 후 미계약·미달분을 통장·순위 무관 추첨으로 재공급하는 물량.

단지: ${nm}
주소: ${addr}
분양가: ${lo === hi ? eok(lo) : `${eok(lo)} ~ ${eok(hi)}`}

아래 JSON만 출력(코드블록·다른 텍스트 금지, 한국어):
{"요약":"4~5줄. ①무순위/잔여 발생 사유(청약 경쟁률·미달·미계약 규모 등 구체 수치) ②세대수·브랜드·입주예정 ③전매제한·실거주의무(찾으면) ④인근 비교아파트 시세 범위. 줄바꿈은 \\\\n 로","확신도":"상|중|하","출처":["사이트명 또는 URL", ...]}

규칙: 추측 금지(확인 안 된 항목은 '확인 안 됨'). '분양가 적정/저렴/비싸다' 같은 주관 단정 금지 — 시세는 숫자 범위 사실로만. 모든 수치에 출처. 근거 빈약하면 확신도 '하'. JSON 외 어떤 텍스트도 출력하지 마라.`;

const queue = [];
for (const no of readdirSync(DER)) {
  const rp = new URL(`${no}/requirements.json`, DER);
  if (!existsSync(rp)) continue;
  const r = JSON.parse(readFileSync(rp, 'utf8'));
  if (r.유형 !== '무순위/잔여') continue;
  if (r.참고분석) continue;                                  // 이미 생성됨(멱등)
  const due = idx[r.panId]?.마감일 ?? r.마감일;
  if (due && /^\d{4}-\d{2}-\d{2}$/.test(due) && due < TODAY) continue;   // 마감 지난 건 제외
  const a = (r.공급형 || []).map(f => f.분양가만원).filter(Boolean);
  const nm = r.단지?.[0]?.단지명 || r.공고명;
  const addr = r.단지?.[0]?.주소 || r.지역 || '';
  queue.push({ no, reqPath: `data/derived/applyhome/${no}/requirements.json`, 단지명: nm, 주소: addr,
    분양가범위: a.length ? [Math.min(...a), Math.max(...a)] : null,
    prompt: PROMPT(nm, addr, a.length ? Math.min(...a) : 0, a.length ? Math.max(...a) : 0) });
}
writeFileSync(new URL('analysis-queue.json', ROOT), JSON.stringify(queue, null, 2));
console.log(`분석 큐 ${queue.length}건 → data/analysis-queue.json (활성 무순위/잔여·참고분석 없음).`);
if (queue.length) console.log('  생성: /update가 Sonnet 에이전트로 각 prompt 실행 → JSON → inject-analysis.mjs로 requirements 주입.');
