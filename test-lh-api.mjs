// data.go.kr LH API 실호출 테스트 (Node 18+ 내장 fetch)
// 실행: node test-lh-api.mjs
import { readFileSync } from 'node:fs';

let KEY = process.env.DATA_GO_KR_SERVICE_KEY || '';
try {
  for (const line of readFileSync(new URL('.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^DATA_GO_KR_SERVICE_KEY=(.*)$/);
    if (m) KEY = m[1].trim();
  }
} catch {}
if (!KEY) { console.error('❌ .env 의 DATA_GO_KR_SERVICE_KEY 가 비어있음'); process.exit(1); }

// 인코딩키(%2F 포함)면 디코딩해서 URLSearchParams가 다시 인코딩하도록 통일
const decodedKey = /%[0-9A-Fa-f]{2}/.test(KEY) ? decodeURIComponent(KEY) : KEY;

async function call(name, base, params) {
  const qs = new URLSearchParams({ ServiceKey: decodedKey, ...params });
  console.log(`\n===== ${name} =====`);
  console.log('GET', base, JSON.stringify(params));
  try {
    const res = await fetch(`${base}?${qs}`, { headers: { Accept: 'application/json' } });
    const text = await res.text();
    console.log('HTTP', res.status, 'len', text.length);
    let preview = text;
    try { preview = JSON.stringify(JSON.parse(text), null, 2); } catch {}
    console.log(preview.slice(0, 3000));
  } catch (e) {
    console.error('요청 실패:', e.message);
  }
}

// 1) 분양임대공고문 조회 — 지역/유형/상태 필터 + 마감일 + 상세URL
//    CNP_CD=11(서울), UPP_AIS_TP_CD=06(임대주택), 기간 필수(PAN_NT_ST_DT~CLSG_DT, 점 구분)
await call(
  '분양임대공고문 조회 lhLeaseNoticeInfo1',
  'http://apis.data.go.kr/B552555/lhLeaseNoticeInfo1/lhLeaseNoticeInfo1',
  {
    PG_SZ: '5', PAGE: '1',
    PAN_NT_ST_DT: '2026.01.01', CLSG_DT: '2026.12.31',
    CNP_CD: '11', UPP_AIS_TP_CD: '06', PAN_SS: '공고중',
  }
);

// 2) 공급정보 조회 — 특정 공고의 주택형/면적/세대 (PAN_ID 필요. 1)의 응답으로 채울 것)
//    PAN_ID 미상 단계에선 호출 형태만 확인.
await call(
  '분양임대공고별 공급정보 조회 getLeaseNoticeSplInfo1',
  'http://apis.data.go.kr/B552555/lhLeaseNoticeSplInfo1/getLeaseNoticeSplInfo1',
  { PG_SZ: '5', PAGE: '1' }
);
