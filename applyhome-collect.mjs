// 청약홈(한국부동산원) 분양·임대정보 수집기 — data.go.kr OpenAPI(ApplyhomeInfoDetailSvc)
// 사용: node applyhome-collect.mjs [--since=2026-05-01] [--only=APT,오피스텔/도시형] [--perPage=1000]
//   유형(family)별 Detail(공고헤더)+Mdl(주택형별)을 PBLANC_NO로 조인해 저장.
//   family: APT · 오피스텔/도시형 · 무순위/잔여 · 임의공급 · 공공지원민간임대(임대).
//   APT/오피스텔 행 중 RENT_SECD_NM/HOUSE_SECD_NM이 임대면 kind=rent로 분기(보증금만원).
// 원칙: raw/ 는 불변(원본 API 응답 detail.json/models.json). meta.json·index는 갱신 가능.
//   외부 LLM API 미사용(구조화 JSON이라 추출 불필요). 상세: 청약홈_분양_API_노트.md
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';

const SVC = 'https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1';
// [라벨, 공고헤더 op, 주택형별 op, 기본kind]. 전 op HTTP 200 실측(2026-06-24).
const FAMILIES = [
  ['APT', 'getAPTLttotPblancDetail', 'getAPTLttotPblancMdl', 'sale'],
  ['오피스텔/도시형', 'getUrbtyOfctlLttotPblancDetail', 'getUrbtyOfctlLttotPblancMdl', 'sale'],
  ['무순위/잔여', 'getRemndrLttotPblancDetail', 'getRemndrLttotPblancMdl', 'sale'],
  ['임의공급', 'getOPTLttotPblancDetail', 'getOPTLttotPblancMdl', 'sale'],
  ['공공지원민간임대', 'getPblPvtRentLttotPblancDetail', 'getPblPvtRentLttotPblancMdl', 'rent'],
];
const ROOT = new URL('./data/', import.meta.url);
const RAW = new URL('raw/applyhome/', ROOT);
const IDX = new URL('index.json', ROOT);

// ── 인자 ───────────────────────────────────────────────────
const argv = process.argv.slice(2);
const getArg = (k, d) => (argv.find(a => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split('=')[1];
const SINCE = getArg('since', '2026-05-01');          // 모집공고일 이 날짜 이후만 (클라 측 컷)
const PER_PAGE = Number(getArg('perPage', '1000'));
const ONLY = getArg('only', '').split(',').map(s => s.trim()).filter(Boolean); // family 라벨 제한(빈값=전체)

// ── 키 로드(.env, 인코딩/디코딩 무관) ──────────────────────
let KEY = process.env.DATA_GO_KR_SERVICE_KEY || '';
try {
  for (const line of readFileSync(new URL('.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^DATA_GO_KR_SERVICE_KEY=(.*)$/);
    if (m) KEY = m[1].trim();
  }
} catch {}
if (!KEY) { console.error('❌ .env 의 DATA_GO_KR_SERVICE_KEY 가 비어있음'); process.exit(1); }
const SERVICE_KEY = /%[0-9A-Fa-f]{2}/.test(KEY) ? decodeURIComponent(KEY) : KEY; // URLSearchParams가 재인코딩

// ── 유틸 ───────────────────────────────────────────────────
const dwell = ms => new Promise(r => setTimeout(r, ms));
const today = new Date();
const fmt = d => d.toISOString().slice(0, 10);
const TODAY = fmt(today);
// family마다 날짜 포맷이 다름(ISO "2026-06-24" vs 압축 "20260624") → YYYY-MM-DD로 정규화
const dnorm = s => { const d = (s || '').replace(/\D/g, ''); return d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null; };
// 접수일: APT는 RCEPT_*, 그 외 family는 SUBSCRPT_RCEPT_* (실측)
const rceptOf = d => [dnorm(d.RCEPT_BGNDE ?? d.SUBSCRPT_RCEPT_BGNDE), dnorm(d.RCEPT_ENDDE ?? d.SUBSCRPT_RCEPT_ENDDE)];
const spsplyOf = d => [dnorm(d.SPSPLY_RCEPT_BGNDE), dnorm(d.SPSPLY_RCEPT_ENDDE)];
// 금액: APT/무순위/임의공급=LTTOT_TOP_AMOUNT, 오피스텔/민간임대=SUPLY_AMOUNT (만원)
const amountOf = m => Number(m.LTTOT_TOP_AMOUNT ?? m.SUPLY_AMOUNT ?? 0);
function statusOf([b, e]) {
  if (b && TODAY < b) return '접수예정';
  if (e && TODAY > e) return '접수마감';
  if (b && e) return '접수중';
  return null;
}
// 행 단위 분양/임대 판별: rent family거나, RENT_SECD_NM 또는 세부유형(HOUSE_DTL/DETAIL_SECD_NM)에 임대.
// 주의: Urbty의 HOUSE_SECD_NM은 전 행이 "도시형/오피스텔/생활숙박시설/민간임대" 통짜 카테고리라 판별에 쓰면 안 됨 → 세부유형으로만.
const rowKind = (famKind, d) => (famKind === 'rent' || /임대/.test(d.RENT_SECD_NM || '') || /임대/.test(d.HOUSE_DTL_SECD_NM ?? d.HOUSE_DETAIL_SECD_NM ?? '')) ? 'rent' : 'sale';

function loadIndex() { try { return JSON.parse(readFileSync(IDX, 'utf8')); } catch { return {}; } }
const index = loadIndex();

// odcloud 페이징: totalCount 채울 때까지 페이지 순회
async function fetchAll(op) {
  const out = [];
  for (let page = 1; ; page++) {
    const qs = new URLSearchParams({ serviceKey: SERVICE_KEY, page: String(page), perPage: String(PER_PAGE) });
    const res = await fetch(`${SVC}/${op}?${qs}`, { headers: { Accept: 'application/json' } });
    const text = await res.text();
    let j; try { j = JSON.parse(text); } catch { throw new Error(`${op} 비JSON 응답 HTTP ${res.status}: ${text.slice(0, 200)}`); }
    if (j.code) throw new Error(`${op} API오류 ${j.code} ${j.msg}`); // -1 트래픽초과 / -4 미등록 등
    const rows = j.data || [];
    out.push(...rows);
    const total = j.totalCount ?? out.length;
    if (!rows.length || out.length >= total) break;
    await dwell(150);
  }
  return out;
}

// ── 수집 ───────────────────────────────────────────────────
let isNew = 0, kept = 0, skippedOld = 0, failedFam = 0;
for (const [label, detailOp, mdlOp, famKind] of FAMILIES) {
  if (ONLY.length && !ONLY.includes(label)) continue;
  console.log(`\n=== ${label} 수집 (${detailOp}) ===`);
  let details, models;
  try {
    details = await fetchAll(detailOp);
    models = await fetchAll(mdlOp);
  } catch (e) { console.error(`  ⚠️ ${label} 수집 실패(건너뜀): ${e.message}`); failedFam++; continue; }
  console.log(`공고 ${details.length}건 · 주택형 ${models.length}행 (전체 누적)`);

  // 주택형별을 PBLANC_NO로 묶음
  const mdlBy = new Map();
  for (const m of models) {
    const k = m.PBLANC_NO ?? m.HOUSE_MANAGE_NO;
    if (!mdlBy.has(k)) mdlBy.set(k, []);
    mdlBy.get(k).push(m);
  }

  let famNew = 0;
  for (const d of details) {
    const no = d.PBLANC_NO ?? d.HOUSE_MANAGE_NO;
    if (!no) continue;
    const 공고일 = dnorm(d.RCRIT_PBLANC_DE);
    if (공고일 && 공고일 < SINCE) { skippedOld++; continue; }     // 기간 컷
    kept++;

    const mdls = mdlBy.get(no) || [];
    const amts = mdls.map(amountOf).filter(n => n > 0);
    const kind = rowKind(famKind, d);
    const dates = rceptOf(d);
    const norm = {
      no, source: 'applyhome', type: label, kind,
      주택구분: d.HOUSE_SECD_NM, 공급유형: d.HOUSE_DTL_SECD_NM ?? d.HOUSE_DETAIL_SECD_NM ?? d.HOUSE_SECD_NM,
      분양구분: d.RENT_SECD_NM ?? (kind === 'rent' ? '임대' : '분양'),
      title: d.HOUSE_NM, region: d.SUBSCRPT_AREA_CODE_NM, 주소: d.HSSPLY_ADRES,
      총공급세대: d.TOT_SUPLY_HSHLDCO != null ? Number(d.TOT_SUPLY_HSHLDCO) : null,
      [kind === 'rent' ? '보증금만원' : '분양가만원']: amts.length ? { min: Math.min(...amts), max: Math.max(...amts) } : null,
      모집공고일: 공고일, 청약접수: dates, 특별공급접수: spsplyOf(d),
      당첨발표일: dnorm(d.PRZWNER_PRESNATN_DE), 입주예정월: d.MVN_PREARNGE_YM || null,
      상태: statusOf(dates), url: d.PBLANC_URL, 시행사: d.BSNS_MBY_NM, 시공사: d.CNSTRCT_ENTRPS_NM,
      collectedAt: TODAY,
    };

    const dir = new URL(`${no}/`, RAW);
    const idxKey = `ah:${no}`;
    if (index[idxKey]?.done) {                       // 이미 받음 → 갱신만(상태·meta)
      try {
        const mp = new URL('meta.json', dir);
        const prev = JSON.parse(readFileSync(mp, 'utf8'));
        writeFileSync(mp, JSON.stringify({ ...prev, 상태: norm.상태, 청약접수: norm.청약접수, collectedAt: TODAY }, null, 2));
      } catch {}
      Object.assign(index[idxKey], { 상태: norm.상태, 마감일: dates[1] });
      continue;
    }

    mkdirSync(dir, { recursive: true });
    // 원본 API 응답은 불변(한 번만 기록)
    const dj = new URL('detail.json', dir), mj = new URL('models.json', dir);
    if (!existsSync(dj)) writeFileSync(dj, JSON.stringify(d, null, 2));
    if (!existsSync(mj)) writeFileSync(mj, JSON.stringify(mdls, null, 2));
    writeFileSync(new URL('meta.json', dir), JSON.stringify(norm, null, 2));

    index[idxKey] = {
      source: 'applyhome', title: norm.title, region: norm.region, type: `${label}/${norm.공급유형 || ''}`, kind,
      분양구분: norm.분양구분, 모집공고일: norm.모집공고일, 마감일: dates[1], 상태: norm.상태,
      주택형수: mdls.length, done: true,
    };
    isNew++; famNew++;
    const 금액 = amts.length ? `${Math.min(...amts)}~${Math.max(...amts)}만` : '-';
    if (famNew <= 30) console.log(`  ✅ ${no} ${(norm.title || '').slice(0, 24)} · ${norm.region} · ${kind === 'rent' ? '보증금' : '분양가'} ${금액} · 주택형 ${mdls.length}`);
  }
  console.log(`  → ${label} 신규 ${famNew}건`);
}

mkdirSync(ROOT, { recursive: true });
writeFileSync(IDX, JSON.stringify(index, null, 2));
console.log(`\n신규 ${isNew}건 저장 · 유지(기간내) ${kept}건 · 기간밖 ${skippedOld}${failedFam ? ` · 실패family ${failedFam}` : ''}`);
console.log(`index 총 ${Object.keys(index).length}건 추적중 (applyhome ${Object.keys(index).filter(k => k.startsWith('ah:')).length}).`);
