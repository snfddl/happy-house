// 단지형 공공임대 'AI 참고 분석' 생성 큐 — 결정론적으로 대상만 추린다(생성은 에이전트, 외부 API 0).
// 사용: node build-lease-analysis-queue.mjs  → data/lease-analysis-queue.json
// 대상: 접수중·접수예정 '단지형'(행복/국민/영구/통합공공/공공/50년) 임대 중 참고분석 없는 건.
//   단지형만(매입/전세는 호별 산재라 단일 시세비교 불가 → 제외). 생성=Sonnet 에이전트 → Opus 적대검증 → inject-analysis 주입.
// 포커스: 분양과 달리 '시세 대비 임대 메리트 + 입지 트레이드오프 + (분양전환형) 전환 전망'. 공공임대 "싸다"는 자명하므로 '얼마나·어디가 약점'이 가치.
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

const ROOT = new URL('./data/', import.meta.url);
const SOURCES = ['lh', 'sh', 'gh', 'myhome'];
const 단지형 = new Set(['행복주택', '행복주택(신혼희망)', '국민임대', '영구임대', '통합공공임대', '공공임대', '50년공공임대']);
const 모집중 = new Set(['접수중', '접수예정']);
const man = w => Math.round(w / 1e4).toLocaleString() + '만';

const PROMPT = (r, 단지명, addr, 보증, 월세, 전환) => `너는 임대주택 보조 분석가다. 아래 공공임대 단지를 웹검색해 사실 위주로 분석하라.

단지: ${단지명}
주소: ${addr}
유형: ${r.유형}${전환 ? ' (분양전환형)' : ''}
임대조건: 보증금 ${보증}${월세 ? ` · 월세 ${월세}` : ' (월세 정보 없음)'}

아래 JSON만 출력(코드블록·다른 텍스트 금지, 한국어):
{"요약":"4~5줄. ①주변 전·월세 시세 범위(같은 지역 유사 면적)와 이 임대조건 비교 — 체감 저렴도를 숫자 사실로(주관 단정 금지) ②입지: 교통·생활편의 및 트레이드오프(공공임대는 외곽·신축지구 많음 — 약점도 사실로) ③${전환 ? '분양전환형이므로 전환시점·전환가 산정방식·향후 시세 전망' : '거주 안정성(임대기간·재계약·대상계층)'} ④알려진 경우 경쟁률·대기 참고. 줄바꿈은 \\\\n 로","확신도":"상|중|하","출처":["사이트명 또는 URL", ...]}

규칙: 추측 금지(확인 안 된 항목은 '확인 안 됨'). '싸다/비싸다/적정' 같은 주관 단정 금지 — 시세는 숫자 범위 사실로만. 모든 수치에 출처. 근거 빈약하면 확신도 '하'. JSON 외 어떤 텍스트도 출력하지 마라.`;

const queue = [];
for (const src of SOURCES) {
  const DER = new URL(`derived/${src}/`, ROOT);
  if (!existsSync(DER)) continue;
  for (const no of readdirSync(DER)) {
    const rp = new URL(`${no}/requirements.json`, DER);
    if (!existsSync(rp)) continue;
    const r = JSON.parse(readFileSync(rp, 'utf8'));
    if (r.상품군 !== '임대' || !단지형.has(r.유형)) continue;
    if (!모집중.has(r.상태)) continue;            // 접수중·접수예정만(공고중 상시모집은 1차 제외)
    if (r.참고분석) continue;                       // 이미 생성됨(멱등)
    const fees = (r.공급형 || []).flatMap(f => f.임대료 || []);
    const deps = fees.map(f => f.임대보증금).filter(v => v > 0);
    const rents = fees.map(f => f.월임대료).filter(v => v > 0);
    const 보증 = deps.length ? (deps.length > 1 ? `${man(Math.min(...deps))}~${man(Math.max(...deps))}원` : `${man(deps[0])}원`) : '확인 안 됨';
    const 월세 = rents.length ? (rents.length > 1 ? `${man(Math.min(...rents))}~${man(Math.max(...rents))}원` : `${man(rents[0])}원`) : '';
    const 전환 = r.분양전환 === '분양전환형';
    const 단지명 = r.단지?.[0]?.단지명 || r.공고명;
    const addr = r.단지?.[0]?.주소 || r.지역 || '';
    queue.push({ no, source: src, 유형: r.유형, reqPath: `data/derived/${src}/${no}/requirements.json`, 단지명, 주소: addr,
      임대조건: { 보증금: 보증, 월세: 월세 || null, 분양전환형: 전환 },
      prompt: PROMPT(r, 단지명, addr, 보증, 월세, 전환) });
  }
}
writeFileSync(new URL('lease-analysis-queue.json', ROOT), JSON.stringify(queue, null, 2));
console.log(`임대 분석 큐 ${queue.length}건 → data/lease-analysis-queue.json (접수중·접수예정 단지형·참고분석 없음).`);
if (queue.length) console.log('  생성: /update가 Sonnet 에이전트로 각 prompt 실행 → Opus 적대검증 → inject-analysis.mjs로 주입.');
