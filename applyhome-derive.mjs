// 청약홈 매퍼 — raw(detail.json+models.json+meta.json) → requirements.json
// 사용: node applyhome-derive.mjs
// 결정론 매핑만(LLM 미사용). meta.kind/type 기준 3분기:
//   ① APT 분양(가점/순차·특공·지역우선)  ② 추첨 분양(오피스텔/무순위/임의공급)  ③ 임대(공공지원민간임대·APT임대)
// API 미제공 항목은 _갭(분양)/_검증노트(임대)에 → 매칭시 "확인필요". 스펙: SCHEMA.md §5·§6
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { makePanId } from './collect-util.mjs';

const ROOT = new URL('./data/', import.meta.url);
const RAW = new URL('raw/applyhome/', ROOT);
const DERIVED = new URL('derived/applyhome/', ROOT);
const TODAY = new Date().toISOString().slice(0, 10);

const num = v => (v == null || v === '' ? 0 : Number(String(v).replace(/,/g, '')));   // API 금액은 "125,000" 천단위 쉼표 문자열 → 쉼표 제거 후 Number(미제거 시 NaN→분양가 null)
const pf = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }; // "059.9928A"→59.9928 / "37.8000"→37.8
const amt = m => num(m.LTTOT_TOP_AMOUNT ?? m.SUPLY_AMOUNT);   // 분양가/공급금액(만원). 임대는 보증금
const 형명 = m => m.HOUSE_TY || m.TP || null;
// 건물유형(상품 종류) — API 직제공분. 무순위/임의/재공급은 공급방식이라 null(inject-applyhome-notice가 공고문서 보강)
const bldgFromApi = d => {
  const x = d.HOUSE_DTL_SECD_NM;
  if (x === '오피스텔') return '오피스텔';
  if (x === '도시형생활주택') return '도시형생활주택';
  if (x === '민영' || x === '국민' || d.HOUSE_SECD_NM === 'APT') return '아파트';
  return null;
};
const 전용 = m => pf(m.HOUSE_TY) ?? pf(m.EXCLUSE_AR);          // APT는 HOUSE_TY 접두숫자, 오피스텔/임대는 EXCLUSE_AR

// 지역우선 tier(해당/기타경기/기타) × 청약순위 — APT만 GNRL_RNK 일정 제공
function rankRules(d) {
  const tiers = [];
  const add = (cond, r1, r2) => { if (r1 || r2) tiers.push({ 순위: 1, 기준: '지역우선', 조건: [cond], 접수일: { '1순위': r1 || null, '2순위': r2 || null } }); };
  add('해당지역', d.GNRL_RNK1_CRSPAREA_RCPTDE, d.GNRL_RNK2_CRSPAREA_RCPTDE);
  add('기타경기/광역', d.GNRL_RNK1_ETC_GG_RCPTDE, d.GNRL_RNK2_ETC_GG_RCPTDE);
  add('기타지역', d.GNRL_RNK1_ETC_AREA_RCPTDE, d.GNRL_RNK2_ETC_AREA_RCPTDE);
  return tiers;
}

// ── ① APT 분양 ─────────────────────────────────────────────
function supplyTypesApt(models) {
  return models.map(m => ({
    형명: 형명(m), 전용면적: 전용(m), 공급면적: pf(m.SUPLY_AR),
    금회모집호수: num(m.SUPLY_HSHLDCO) + num(m.SPSPLY_HSHLDCO),
    분양가만원: amt(m), 일반공급호수: num(m.SUPLY_HSHLDCO),
    특별공급: {
      합계: num(m.SPSPLY_HSHLDCO),
      다자녀: num(m.MNYCH_HSHLDCO), 신혼부부: num(m.NWWDS_HSHLDCO), 신생아: num(m.NWBB_HSHLDCO),
      생애최초: num(m.LFE_FRST_HSHLDCO), 노부모부양: num(m.OLD_PARNTS_SUPORT_HSHLDCO),
      기관추천: num(m.INSTT_RECOMEND_HSHLDCO), 청년: num(m.YGMN_HSHLDCO),
      이전기관: num(m.TRANSR_INSTT_ENFSN_HSHLDCO), 기타: num(m.ETC_HSHLDCO),
    },
  }));
}
function deriveApt(no, d, models, meta) {
  const 유형 = (d.HOUSE_DTL_SECD_NM || '').includes('민영') ? '민영분양' : (d.HOUSE_DTL_SECD_NM || '').includes('국민') ? '공공분양' : (d.HOUSE_DTL_SECD_NM || '분양');
  const 민영 = 유형 === '민영분양';
  const 갭 = ['전매제한', '실거주의무', '특공자격컷'];
  if (민영) 갭.unshift('가점추첨비율');
  return {
    panId: makePanId('applyhome', no), source: 'applyhome', 상품군: '분양', 공고명: d.HOUSE_NM, 상품구조: '분양', 유형, 건물유형: '아파트',
    지역: meta.region ? `${meta.region} ${(d.HSSPLY_ADRES || '').split(' ')[1] || ''}`.trim() : meta.region,
    공고일: meta.모집공고일, 접수시작: meta.청약접수?.[0] || null, 마감일: meta.청약접수?.[1] || null, 상태: meta.상태,
    특별공급접수: meta.특별공급접수 || [null, null], 당첨자발표: meta.당첨발표일, 입주예정: meta.입주예정월,
    단지: [{ 단지명: d.HOUSE_NM, 주소: d.HSSPLY_ADRES, 총공급세대: num(d.TOT_SUPLY_HSHLDCO) }],
    공급형: supplyTypesApt(models),
    선정방식: 민영 ? '혼합' : '순차',
    선정방식상세: 민영 ? '민영 일반공급: 가점제+추첨제 혼합(면적·규제지역별 비율 상이 — 공고문 확인). 가점 84점 로직 적용대상.'
      : '공공분양(국민주택): 순차제(무주택기간·저축총액·납입인정횟수). 가점제 미적용.',
    가점추첨비율: null,
    규제: { 조정대상지역: d.MDAT_TRGET_AREA_SECD === 'Y', 투기과열지구: d.SPECLT_RDN_EARTH_AT === 'Y', 분양가상한제: d.PARCPRC_ULS_AT === 'Y' },
    자격요건: {
      무주택: 민영 ? '가점제=무주택세대구성원(추첨 일부 1주택 허용 가능)' : '무주택세대구성원',
      청약통장: 민영 ? '주택청약종합저축 — 지역·면적별 예치금 충족' : '주택청약종합저축 — 가입기간·납입인정횟수 순차',
      거주요건: '해당지역 우선(거주기간 컷은 공고문 확인)', 소득자산: '특별공급·공공분양 일부 적용(소득·자산 컷은 공고문 확인)',
    },
    순위규칙: rankRules(d), 전매제한: null, 실거주의무: null,
    원문링크: { 상세페이지: d.PBLANC_URL || null }, _갭: 갭,
  };
}

// ── ② 추첨 분양 (오피스텔/도시형 · 무순위/잔여 · 임의공급) ──
function deriveChoo(no, d, models, meta) {
  const t = meta.type;
  const 무순위 = t === '무순위/잔여';
  const 무주택 = 무순위 ? '무주택세대구성원(해당지역 거주자 우선일 수 있음 — 공고문 확인)' : '제한없음(만 19세 이상 추첨, 무주택·청약통장 무관)';
  return {
    panId: makePanId('applyhome', no), source: 'applyhome', 상품군: '분양', 공고명: d.HOUSE_NM, 상품구조: '분양', 유형: t, 건물유형: bldgFromApi(d),
    지역: meta.region ? `${meta.region} ${(d.HSSPLY_ADRES || '').split(' ')[1] || ''}`.trim() : meta.region,
    공고일: meta.모집공고일, 접수시작: meta.청약접수?.[0] || null, 마감일: meta.청약접수?.[1] || null, 상태: meta.상태,
    당첨자발표: meta.당첨발표일, 입주예정: meta.입주예정월,
    단지: [{ 단지명: d.HOUSE_NM, 주소: d.HSSPLY_ADRES, 총공급세대: num(d.TOT_SUPLY_HSHLDCO) }],
    공급형: models.map(m => ({
      형명: 형명(m), 전용면적: 전용(m), 공급면적: pf(m.SUPLY_AR),
      금회모집호수: num(m.SUPLY_HSHLDCO) + num(m.SPSPLY_HSHLDCO), 분양가만원: amt(m),
      일반공급호수: num(m.SUPLY_HSHLDCO), 특별공급: { 합계: num(m.SPSPLY_HSHLDCO) },
    })),
    선정방식: '추첨',
    선정방식상세: 무순위 ? '무순위/잔여세대 — 추첨제(청약통장 무관). 해당지역 무주택 요건·재당첨제한 등은 공고문 확인.'
      : `${t} — 추첨제. 만 19세 이상 신청 가능(무주택·청약통장 무관). 재당첨제한·실거주 등은 공고문 확인.`,
    규제: { 조정대상지역: d.MDAT_TRGET_AREA_SECD === 'Y', 투기과열지구: d.SPECLT_RDN_EARTH_AT === 'Y', 분양가상한제: d.PARCPRC_ULS_AT === 'Y' },
    자격요건: { 무주택, 청약통장: '없음', 거주요건: '공고문 확인', 소득자산: '공고문 확인' },
    순위규칙: [], 전매제한: null, 실거주의무: null,
    원문링크: { 상세페이지: d.PBLANC_URL || null }, _갭: ['청약자격세부', '재당첨제한', '전매제한'],
  };
}

// ── ③ 임대 (공공지원민간임대 · APT임대) ────────────────────
function deriveRent(no, d, models, meta) {
  const 특공 = {
    청년: models.reduce((s, m) => s + num(m.SPSPLY_YGMN_HSHLDCO), 0),
    신혼부부: models.reduce((s, m) => s + num(m.SPSPLY_NEW_MRRG_HSHLDCO), 0),
    고령자: models.reduce((s, m) => s + num(m.SPSPLY_AGED_HSHLDCO), 0),
  };
  const 대상계층 = Object.entries(특공).filter(([, v]) => v > 0).map(([k]) => k);
  return {
    panId: makePanId('applyhome', no), source: 'applyhome', 상품군: '임대', 공고명: d.HOUSE_NM, 유형: meta.type, 상품구조: meta.type, 분양전환: '해당없음',
    지역: meta.region ? `${meta.region} ${(d.HSSPLY_ADRES || '').split(' ')[1] || ''}`.trim() : meta.region,
    공고일: meta.모집공고일 || '공고문미기재', 접수시작: meta.청약접수?.[0] || null, 마감일: meta.청약접수?.[1] || null, 상태: meta.상태,
    당첨자발표: meta.당첨발표일, 입주예정: meta.입주예정월,
    단지: [{ 단지명: d.HOUSE_NM, 주소: d.HSSPLY_ADRES, 총공급세대: num(d.TOT_SUPLY_HSHLDCO) }],
    공급형: models.map(m => ({
      형명: 형명(m), 전용면적: 전용(m), 공급면적: pf(m.SUPLY_AR ?? m.CNTRCT_AR),
      금회모집호수: num(m.SUPLY_HSHLDCO) + num(m.SPSPLY_HSHLDCO),
      임대료: [{ 구분: '기본', 임대보증금: amt(m) * 10000, 월임대료: 0 }],   // 보증금만원→원. 월임대료 API 미제공
    })),
    선정방식: '추첨',
    선정방식상세: '공공지원 민간임대 — 추첨제(청약통장 무관). 청년·신혼·고령 등 특별공급 자격·소득·자산 컷은 공고문 확인.',
    자격요건: {
      무주택: '무주택세대구성원(유형별 상이 — 공고문 확인)',
      소득기준: { 종류: '공고문미기재', 기본퍼센트: null, 가구원수별: null, 가산규칙: '', 비고: '공공지원 민간임대 소득기준은 청약홈 API 미제공 — 공고문 PDF 확인 필요' },
      자산상한: '공고문미기재', 자동차상한: '공고문미기재', 청약요건: '없음',
      대상계층: 대상계층.length ? 대상계층 : ['일반'], 계층별: null,
    },
    순위규칙: [], 배점표: [], 우선배정: [],
    원문링크: { 상세페이지: d.PBLANC_URL || null },
    _검증노트: ['소득기준 API미제공(공고문 확인)', '자산/자동차 상한 미기재', '월임대료 미제공(보증금만 표기)'],
  };
}

// ── 실행 ───────────────────────────────────────────────────
let dirs = [];
try { dirs = readdirSync(RAW, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); }
catch { console.error('❌ data/raw/applyhome 없음 — 먼저 node applyhome-collect.mjs'); process.exit(1); }

let cnt = { APT: 0, 추첨: 0, 임대: 0, skip: 0 };
for (const no of dirs) {
  const dDir = new URL(`${no}/`, RAW);
  const dp = new URL('detail.json', dDir), mp = new URL('models.json', dDir), metap = new URL('meta.json', dDir);
  if (!existsSync(dp) || !existsSync(metap)) { cnt.skip++; continue; }
  const d = JSON.parse(readFileSync(dp, 'utf8'));
  const models = existsSync(mp) ? JSON.parse(readFileSync(mp, 'utf8')) : [];
  const meta = JSON.parse(readFileSync(metap, 'utf8'));

  let req, bucket;
  if (meta.kind === 'rent') { req = deriveRent(no, d, models, meta); bucket = '임대'; }
  else if (meta.type === 'APT') { req = deriveApt(no, d, models, meta); bucket = 'APT'; }
  else { req = deriveChoo(no, d, models, meta); bucket = '추첨'; }

  const outDir = new URL(`${no}/`, DERIVED);
  mkdirSync(outDir, { recursive: true });
  // ⚠️ 주입필드 보존 — derive는 raw서 통째 재생성하므로, 후속 inject 단계가 채운 '파생 불가' 필드(참고분석[LLM·비커밋]·
  //    전매/실거주/재당첨[공고문 PDF]·건물유형[무순위/임의]·공고문PDF링크·네이버부동산[resolve-naver]·마감시각)를 기존 파일서 이월. 로컬 단독 재실행 데이터유실 방지. 멱등.
  const outFile = new URL('requirements.json', outDir);
  if (existsSync(outFile)) {
    try {
      const prev = JSON.parse(readFileSync(outFile, 'utf8'));
      if (prev.참고분석) req.참고분석 = prev.참고분석;
      if (prev.네이버부동산) req.네이버부동산 = prev.네이버부동산;   // resolve-naver 결정론 주입분 이월(재실행 유실 방지)
      if (prev.마감시각) req.마감시각 = prev.마감시각;
      for (const k of ['전매제한', '실거주의무', '재당첨제한']) if (prev[k] && typeof prev[k] === 'object') req[k] = prev[k];
      if (prev.건물유형 && !req.건물유형) req.건물유형 = prev.건물유형;
      if (prev.원문링크?.공고문PDF) req.원문링크 = { ...(req.원문링크 || {}), 공고문PDF: prev.원문링크.공고문PDF };
    } catch { /* 손상 파일이면 새로 씀 */ }
  }
  writeFileSync(outFile, JSON.stringify(req, null, 2));
  cnt[bucket]++;
}
console.log(`분양 requirements 생성 — APT ${cnt.APT} · 추첨(오피스텔/무순위/임의) ${cnt.추첨} · 임대 ${cnt.임대} (skip ${cnt.skip})`);
console.log('→ data/derived/applyhome/<no>/requirements.json');
