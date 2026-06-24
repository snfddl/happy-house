// 청약홈(한국부동산원) 분양정보 수집기 — data.go.kr OpenAPI(ApplyhomeInfoDetailSvc)
// 사용: node applyhome-collect.mjs [--since=2026-05-01] [--include-rent] [--perPage=1000]
//   Detail(공고헤더) + Mdl(주택형별: 분양가·세대배분)을 PBLANC_NO로 조인해 저장.
// 원칙: raw/ 는 불변(원본 API 응답 detail.json/models.json). meta.json·index는 갱신 가능.
//   외부 LLM API 미사용(구조화 JSON이라 추출 불필요). 상세: 청약홈_분양_API_노트.md
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';

const SVC = 'https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1';
// 수집 대상 유형: [공고헤더 op, 주택형별 op, 라벨]. v1=APT만 검증완료. 타유형은 필드확인 후 추가.
const ENDPOINTS = [
  ['getAPTLttotPblancDetail', 'getAPTLttotPblancMdl', 'APT'],
  // ['getUrbtyOfctlLttotPblancDetail', 'getUrbtyOfctlLttotPblancMdl', '오피스텔/도시형/생숙'],
  // ['getRemndrLttotPblancDetail', 'getRemndrLttotPblancMdl', '무순위/잔여세대'],
];
const ROOT = new URL('./data/', import.meta.url);
const RAW = new URL('raw/applyhome/', ROOT);
const IDX = new URL('index.json', ROOT);

// ── 인자 ───────────────────────────────────────────────────
const argv = process.argv.slice(2);
const getArg = (k, d) => (argv.find(a => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split('=')[1];
const SINCE = getArg('since', '2026-05-01');          // 모집공고일 이 날짜 이후만 (클라 측 컷)
const PER_PAGE = Number(getArg('perPage', '1000'));
const INCLUDE_RENT = argv.includes('--include-rent'); // 기본은 분양만, 임대 APT 제외

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

// 접수일 기준 상태 도출(청약홈은 상태필드가 없음)
function statusOf(d) {
  const b = d.RCEPT_BGNDE, e = d.RCEPT_ENDDE;
  if (b && TODAY < b) return '접수예정';
  if (e && TODAY > e) return '접수마감';
  if (b && e) return '접수중';
  return null;
}

// ── 수집 ───────────────────────────────────────────────────
let isNew = 0, kept = 0, skippedRent = 0, skippedOld = 0;
for (const [detailOp, mdlOp, label] of ENDPOINTS) {
  console.log(`\n=== ${label} 수집 (${detailOp}) ===`);
  const details = await fetchAll(detailOp);
  const models = await fetchAll(mdlOp);
  console.log(`공고 ${details.length}건 · 주택형 ${models.length}행 (전체 누적)`);

  // 주택형별을 PBLANC_NO로 묶음
  const mdlBy = new Map();
  for (const m of models) {
    const k = m.PBLANC_NO ?? m.HOUSE_MANAGE_NO;
    if (!mdlBy.has(k)) mdlBy.set(k, []);
    mdlBy.get(k).push(m);
  }

  for (const d of details) {
    const no = d.PBLANC_NO ?? d.HOUSE_MANAGE_NO;
    if (!no) continue;
    if ((d.RCRIT_PBLANC_DE || '') < SINCE) { skippedOld++; continue; }     // 기간 컷
    if (!INCLUDE_RENT && /임대/.test(d.RENT_SECD_NM || '')) { skippedRent++; continue; } // 분양만
    kept++;

    const mdls = mdlBy.get(no) || [];
    const amts = mdls.map(m => Number(m.LTTOT_TOP_AMOUNT)).filter(n => n > 0);
    const norm = {
      no, source: 'applyhome', type: label,
      주택구분: d.HOUSE_SECD_NM, 공급유형: d.HOUSE_DTL_SECD_NM, 분양구분: d.RENT_SECD_NM,
      title: d.HOUSE_NM, region: d.SUBSCRPT_AREA_CODE_NM, 주소: d.HSSPLY_ADRES,
      총공급세대: d.TOT_SUPLY_HSHLDCO != null ? Number(d.TOT_SUPLY_HSHLDCO) : null,
      분양가만원: amts.length ? { min: Math.min(...amts), max: Math.max(...amts) } : null,
      모집공고일: d.RCRIT_PBLANC_DE, 청약접수: [d.RCEPT_BGNDE, d.RCEPT_ENDDE],
      특별공급접수: [d.SPSPLY_RCEPT_BGNDE, d.SPSPLY_RCEPT_ENDDE],
      당첨발표일: d.PRZWNER_PRESNATN_DE, 입주예정월: d.MVN_PREARNGE_YM,
      상태: statusOf(d), url: d.PBLANC_URL, 시행사: d.BSNS_MBY_NM, 시공사: d.CNSTRCT_ENTRPS_NM,
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
      Object.assign(index[idxKey], { 상태: norm.상태, 마감일: d.RCEPT_ENDDE });
      continue;
    }

    mkdirSync(dir, { recursive: true });
    // 원본 API 응답은 불변(한 번만 기록)
    const dj = new URL('detail.json', dir), mj = new URL('models.json', dir);
    if (!existsSync(dj)) writeFileSync(dj, JSON.stringify(d, null, 2));
    if (!existsSync(mj)) writeFileSync(mj, JSON.stringify(mdls, null, 2));
    writeFileSync(new URL('meta.json', dir), JSON.stringify(norm, null, 2));

    index[idxKey] = {
      source: 'applyhome', title: norm.title, region: norm.region, type: `${label}/${d.HOUSE_DTL_SECD_NM || ''}`,
      분양구분: norm.분양구분, 모집공고일: norm.모집공고일, 마감일: d.RCEPT_ENDDE, 상태: norm.상태,
      주택형수: mdls.length, done: true,
    };
    isNew++;
    if (isNew <= 40) console.log(`  ✅ ${no} ${(norm.title || '').slice(0, 26)} · ${norm.region} · 분양가 ${norm.분양가만원 ? norm.분양가만원.min + '~' + norm.분양가만원.max + '만' : '-'} · 주택형 ${mdls.length}`);
  }
}

mkdirSync(ROOT, { recursive: true });
writeFileSync(IDX, JSON.stringify(index, null, 2));
console.log(`\n신규 ${isNew}건 저장 · 유지(분양/기간내) ${kept}건 · 임대제외 ${skippedRent} · 기간밖 ${skippedOld}`);
console.log(`index 총 ${Object.keys(index).length}건 추적중 (applyhome ${Object.keys(index).filter(k => k.startsWith('ah:')).length}).`);
