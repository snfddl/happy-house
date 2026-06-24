// 분양 requirements 매퍼 — 청약홈 raw(detail.json+models.json) → §6 requirements.json
// 사용: node applyhome-derive.mjs
// 결정론 매핑만(LLM 미사용). 소스가 구조화 JSON이라 추출 불필요. inject-links/parse-xlsx 계열.
// API 미제공 항목(가점추첨비율·전매제한·실거주의무·특공자격컷)은 _갭에 나열 → 매칭시 "확인필요".
// 스펙: SCHEMA.md §6 · schema-sale-v1.jsonc
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const ROOT = new URL('./data/', import.meta.url);
const RAW = new URL('raw/applyhome/', ROOT);
const DERIVED = new URL('derived/applyhome/', ROOT);
const TODAY = new Date().toISOString().slice(0, 10);

const num = v => (v == null || v === '' ? 0 : Number(v));
const pf = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }; // "059.9928A"→59.9928

// 접수일 기준 상태
function statusOf(d) {
  const b = d.RCEPT_BGNDE, e = d.RCEPT_ENDDE;
  if (b && TODAY < b) return '접수예정';
  if (e && TODAY > e) return '접수마감';
  if (b && e) return '접수중';
  return null;
}

// 유형: 민영/국민(공공분양) 도출
function typeOf(d) {
  const t = d.HOUSE_DTL_SECD_NM || '';
  if (t.includes('민영')) return '민영분양';
  if (t.includes('국민')) return '공공분양';
  return t || '분양';
}

// 지역우선 tier(해당/기타경기/기타) × 청약순위(1·2) — GNRL_RNK 일정 유무로 결정론 도출
function rankRules(d) {
  const tiers = [];
  const add = (cond, r1, r2) => { if (r1 || r2) tiers.push({ 순위: 1, 기준: '지역우선', 조건: [cond], 접수일: { '1순위': r1 || null, '2순위': r2 || null } }); };
  add('해당지역', d.GNRL_RNK1_CRSPAREA_RCPTDE, d.GNRL_RNK2_CRSPAREA_RCPTDE);
  add('기타경기/광역', d.GNRL_RNK1_ETC_GG_RCPTDE, d.GNRL_RNK2_ETC_GG_RCPTDE);
  add('기타지역', d.GNRL_RNK1_ETC_AREA_RCPTDE, d.GNRL_RNK2_ETC_AREA_RCPTDE);
  return tiers;
}

function supplyTypes(models) {
  return models.map(m => ({
    형명: m.HOUSE_TY,
    전용면적: pf(m.HOUSE_TY),       // 접두 숫자 = 전용면적
    공급면적: pf(m.SUPLY_AR),
    금회모집호수: num(m.SUPLY_HSHLDCO) + num(m.SPSPLY_HSHLDCO),
    분양가만원: num(m.LTTOT_TOP_AMOUNT),
    일반공급호수: num(m.SUPLY_HSHLDCO),
    특별공급: {
      합계: num(m.SPSPLY_HSHLDCO),
      다자녀: num(m.MNYCH_HSHLDCO), 신혼부부: num(m.NWWDS_HSHLDCO), 신생아: num(m.NWBB_HSHLDCO),
      생애최초: num(m.LFE_FRST_HSHLDCO), 노부모부양: num(m.OLD_PARNTS_SUPORT_HSHLDCO),
      기관추천: num(m.INSTT_RECOMEND_HSHLDCO), 청년: num(m.YGMN_HSHLDCO),
      이전기관: num(m.TRANSR_INSTT_ENFSN_HSHLDCO), 기타: num(m.ETC_HSHLDCO),
    },
  }));
}

function derive(no, d, models) {
  const 유형 = typeOf(d);
  const 민영 = 유형 === '민영분양';
  // 선정방식: 민영=가점제+추첨 혼합(비율은 갭) / 공공(국민)=순차제(저축총액·납입횟수). 가점84점은 민영 일반공급만.
  const 선정방식 = 민영 ? '혼합' : '순차';
  const 선정방식상세 = 민영
    ? '민영 일반공급: 가점제+추첨제 혼합(면적·규제지역별 비율 상이 — 공고문 확인). 가점 84점 로직 적용대상.'
    : '공공분양(국민주택): 순차제(무주택기간·저축총액·납입인정횟수). 가점제 미적용.';
  const 갭 = ['전매제한', '실거주의무', '특공자격컷'];
  if (민영) 갭.unshift('가점추첨비율');

  return {
    no, 공고명: d.HOUSE_NM, 상품구조: '분양', 유형,
    지역: [d.SUBSCRPT_AREA_CODE_NM, (d.HSSPLY_ADRES || '').split(' ')[1]].filter(Boolean).join(' '),
    공고일: d.RCRIT_PBLANC_DE,
    접수시작: d.RCEPT_BGNDE || null, 마감일: d.RCEPT_ENDDE || null, 상태: statusOf(d),
    특별공급접수: [d.SPSPLY_RCEPT_BGNDE || null, d.SPSPLY_RCEPT_ENDDE || null],
    당첨자발표: d.PRZWNER_PRESNATN_DE || null,
    계약기간: [d.CNTRCT_CNCLS_BGNDE || null, d.CNTRCT_CNCLS_ENDDE || null],
    입주예정: d.MVN_PREARNGE_YM || null,
    단지: [{ 단지명: d.HOUSE_NM, 주소: d.HSSPLY_ADRES, 총공급세대: num(d.TOT_SUPLY_HSHLDCO) }],
    공급형: supplyTypes(models),
    선정방식, 가점추첨비율: null, 선정방식상세,
    규제: {
      조정대상지역: d.MDAT_TRGET_AREA_SECD === 'Y',
      투기과열지구: d.SPECLT_RDN_EARTH_AT === 'Y',
      분양가상한제: d.PARCPRC_ULS_AT === 'Y',
    },
    자격요건: {
      무주택: 민영 ? '가점제=무주택세대구성원(추첨 일부 1주택 허용 가능)' : '무주택세대구성원',
      청약통장: 민영 ? '주택청약종합저축 — 지역·면적별 예치금 충족' : '주택청약종합저축 — 가입기간·납입인정횟수 순차',
      거주요건: '해당지역 우선(거주기간 컷은 공고문 확인)',
      소득자산: '특별공급·공공분양 일부 적용(소득·자산 컷은 공고문 확인)',
    },
    순위규칙: rankRules(d),
    전매제한: null, 실거주의무: null,
    원문링크: { 상세페이지: d.PBLANC_URL || null },
    _갭: 갭,
  };
}

// ── 실행 ───────────────────────────────────────────────────
let dirs = [];
try { dirs = readdirSync(RAW, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); }
catch { console.error('❌ data/raw/applyhome 없음 — 먼저 node applyhome-collect.mjs'); process.exit(1); }

let ok = 0, skip = 0;
for (const no of dirs) {
  const dDir = new URL(`${no}/`, RAW);
  const dp = new URL('detail.json', dDir), mp = new URL('models.json', dDir);
  if (!existsSync(dp)) { skip++; continue; }
  const d = JSON.parse(readFileSync(dp, 'utf8'));
  const models = existsSync(mp) ? JSON.parse(readFileSync(mp, 'utf8')) : [];
  const req = derive(no, d, models);
  const outDir = new URL(`${no}/`, DERIVED);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(new URL('requirements.json', outDir), JSON.stringify(req, null, 2));
  ok++;
  if (ok <= 8) {
    const amts = req.공급형.map(s => s.분양가만원).filter(Boolean);
    console.log(`  ✅ ${no} ${(req.공고명 || '').slice(0, 24)} · ${req.유형} · ${req.선정방식} · 분양가 ${amts.length ? Math.min(...amts) + '~' + Math.max(...amts) + '만' : '-'} · 주택형 ${req.공급형.length} · 갭 ${req._갭.length}`);
  }
}
console.log(`\n분양 requirements 생성 ${ok}건 (skip ${skip}) → data/derived/applyhome/<no>/requirements.json`);
