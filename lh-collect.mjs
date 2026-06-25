// LH 공고 아카이빙 수집기: 목록 → 신규 공고 detect → 상세 스냅샷 + 첨부 원본 전부 저장
// 사용: node lh-collect.mjs [지역코드...] [--types=06/10,06/07]
//   예) node lh-collect.mjs 41 --types=06/10      (경기 행복주택)
//       node lh-collect.mjs 11 26 41              (서울/부산/경기, 전체 임대유형)
// 원칙: raw/ 는 불변(원본). derived/ 는 재생성 가능. index.json 으로 신규 diff.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { UA, dwell, sani, getArg, loadIndex, loadServiceKey, PAMPHLET_PAT } from './collect-util.mjs';

// 런타임 전제: Node 20+ (Headers.getSetCookie). 미만이면 세션쿠키 누락→인증 실패가 조용히 발생 → 즉시 명시적 중단.
const NODE_MAJOR = +process.versions.node.split('.')[0];
if (NODE_MAJOR < 20) { console.error(`❌ Node ${process.versions.node} 감지 — LH 수집은 Node 20+ 필요(Headers.getSetCookie 쿠키 파싱). 업그레이드 후 재실행.`); process.exit(1); }

const BASE = 'https://apply.lh.or.kr/lhapply';
const ROOT = new URL('./data/', import.meta.url);
const RAW = new URL('raw/lh/', ROOT);
const IDX = new URL('index.json', ROOT);

// 임대 세부유형(uppAisTpCd/aisTpCd). 기본=주요 임대유형 전체
const TYPE_LABEL = {
  '06/07': '국민임대', '06/08': '공공임대', '06/09': '영구임대', '06/10': '행복주택',
  '06/11': '장기전세', '06/48': '통합공공임대', '06/27': '신축다세대매입', '06/52': '6년공공임대',
  '13/26': '매입임대', '13/17': '전세임대', '13/36': '집주인임대',
  '39/42': '행복주택(신혼희망)', '39/51': '통합공공임대(신혼희망)',
}; // 매입임대(13/26)에 든든전세 포함
const REGION_LABEL = { '11': '서울', '26': '부산', '27': '대구', '28': '인천', '29': '광주', '30': '대전', '31': '울산', '36110': '세종', '41': '경기', '51': '강원', '43': '충북', '44': '충남', '52': '전북', '46': '전남', '47': '경북', '48': '경남', '50': '제주' };
// 요건 없는 홍보물(평면도·조감도 책자) — 받지 않고 fileid만 meta에 기록

const argv = process.argv.slice(2);
const REFRESH = argv.includes('--refresh'); // 상태/마감일만 갱신, 신규 다운로드 안 함(CI용·raw 불필요)
const regions = argv.filter(a => !a.startsWith('--'));
const typesArg = (argv.find(a => a.startsWith('--types=')) || '').split('=')[1];
const REGIONS = regions.length ? regions : Object.keys(REGION_LABEL);
const TYPES = (typesArg ? typesArg.split(',') : Object.keys(TYPE_LABEL)).map(t => t.split('/'));

// ── 세션/요청 ──────────────────────────────────────────────
let COOKIE = '';
function absorb(res) {
  for (const line of (res.headers.getSetCookie?.() || [])) {
    const kv = line.split(';')[0];
    const k = kv.split('=')[0];
    COOKIE = COOKIE.split('; ').filter(x => x && x.split('=')[0] !== k).concat(kv).join('; ');
  }
}
async function req(url, opts = {}) {
  const res = await fetch(url, { ...opts, redirect: 'manual',
    headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9', ...(COOKIE ? { Cookie: COOKIE } : {}), ...(opts.headers || {}) } });
  absorb(res);
  return res;
}

// ── 유틸 ───────────────────────────────────────────────────
function cdName(disposition, fallback) {
  const m = (disposition || '').match(/filename="?([^";]+)"?/);
  if (!m) return fallback;
  try { return Buffer.from(m[1], 'latin1').toString('utf8'); } catch { return m[1]; }
}
const index = loadIndex(IDX);

// ── 1) 세션 (상세/PDF 다운로드용 쿠키) ─────────────────────
await req(`${BASE}/apply/wt/wrtanc/selectWrtancList.do?mi=1026`);

// ── 2) 공식 OpenAPI로 목록 수집 (B552555/lhLeaseNoticeInfo1) ─
// 과거 목록 스크래핑(selectWrtancList.do HTML 파싱)을 대체. 실시간(사이트와 동일 DB·지연 없음 실측).
// 메타+DTL_URL은 API가, 상세/PDF 본문은 여전히 사이트(selectWrtancInfo.do·lhFile.do)에서 — 하이브리드.
const today = new Date();
const fmt = d => d.toISOString().slice(0, 10);
// 초기 백필 범위. 이후 실행은 index.json diff로 신규만 추가됨. --since=YYYY-MM-DD 로 조정
const startDt = getArg('since', '2026-05-01');

// data.go.kr 서비스키(.env, 인코딩/디코딩 무관 — applyhome-collect와 동일 규칙)
const SERVICE_KEY = loadServiceKey();
if (!SERVICE_KEY) {
  // CI(키 미주입)에서 --refresh로 호출되면 LH만 건너뛰고 정상종료 — SH/GH 등 키 불필요 소스가 이어서 돌 수 있게(refresh.yml).
  if (REFRESH) { console.warn('⚠️ DATA_GO_KR_SERVICE_KEY 없음 — LH refresh 생략(키 필요). 키 불필요 소스(SH/GH)만 진행.'); process.exit(0); }
  console.error('❌ .env 의 DATA_GO_KR_SERVICE_KEY 가 비어있음 (LH 공식 API 호출 불가)'); process.exit(1);
}
const LH_API = 'https://apis.data.go.kr/B552555/lhLeaseNoticeInfo1/lhLeaseNoticeInfo1';

// CNP_CD 코드는 응답에 없고 CNP_CD_NM(전체 도명, "… 외" 멀티지역 포함)만 옴 → 코드 역매핑
const NM2CNP = [['서울','11'],['부산','26'],['대구','27'],['인천','28'],['광주','29'],['대전','30'],['울산','31'],['세종','36110'],['경기','41'],['강원','51'],['충청북','43'],['충북','43'],['충청남','44'],['충남','44'],['전라북','52'],['전북','52'],['전라남','46'],['전남','46'],['경상북','47'],['경북','47'],['경상남','48'],['경남','48'],['제주','50']];
const cnpOf = nm => (NM2CNP.find(([k]) => (nm || '').includes(k)) || [, null])[1];
const dotDate = s => (s ? s.replace(/\./g, '-') : null);

// UPP_AIS_TP_CD 단위로 페이징(PG_SZ/PAGE). PAN_ST_DT~PAN_ED_DT=게시일 서버측 기간필터(실동작).
async function fetchLhList(upp) {
  const rows = []; const PG = 500;
  for (let page = 1; ; page++) {
    const qs = new URLSearchParams({ serviceKey: SERVICE_KEY, PG_SZ: String(PG), PAGE: String(page),
      PAN_ST_DT: startDt.replace(/-/g, ''), PAN_ED_DT: fmt(today).replace(/-/g, ''), UPP_AIS_TP_CD: upp });
    const res = await fetch(`${LH_API}?${qs}`, { headers: { Accept: 'application/json' } });
    const text = await res.text();
    let j; try { j = JSON.parse(text); } catch { throw new Error(`LH API 비JSON HTTP ${res.status}: ${text.slice(0, 150)}`); }
    const dl = (Array.isArray(j) ? (j.find(x => x.dsList) || {}).dsList : null) || [];
    rows.push(...dl);
    const total = Number(dl[0]?.ALL_CNT || rows.length);
    if (!dl.length || rows.length >= total) break;
    await dwell(150);
  }
  return rows;
}

const UPPS = [...new Set(TYPES.map(([u]) => u))];          // 질의할 상위유형(06 임대 / 13 주거복지 / 39 신혼희망)
const TYPESET = new Set(TYPES.map(([u, a]) => `${u}/${a}`)); // 현행 유형 화이트리스트 유지
const regionFilter = regions.length ? new Set(REGIONS) : null;

let found = [], isNew = 0;
const newPending = [];
for (const upp of UPPS) {
  const rows = await fetchLhList(upp);
  let kept = 0;
  for (const r of rows) {
    const key = `${r.UPP_AIS_TP_CD}/${r.AIS_TP_CD}`;
    if (!TYPESET.has(key)) continue;                      // 화이트리스트 외(가정어린이집 등) 제외
    const cnpCd = cnpOf(r.CNP_CD_NM);
    if (regionFilter && !regionFilter.has(cnpCd)) continue;
    found.push({
      panId: r.PAN_ID, upp: r.UPP_AIS_TP_CD, ais: r.AIS_TP_CD, cnpCd,
      ccr: r.CCR_CNNT_SYS_DS_CD || '03',                  // 상세 POST용 — 행별 실제값(과거 하드코딩 '03' 대체)
      title: (r.PAN_NM || '').replace(/\s+/g, ' ').trim(),
      게시일: dotDate(r.PAN_NT_ST_DT), 마감일: dotDate(r.CLSG_DT), 상태: r.PAN_SS || null,
    });
    kept++;
  }
  console.log(`[UPP ${upp} · ${TYPE_LABEL[`${upp}/${rows[0]?.AIS_TP_CD}`] || ''}] API ${rows.length}건 → 대상 ${kept}건`);
  await dwell(150);
}

// 중복 제거(여러 유형 질의에 같은 공고가 잡힐 일은 없으나 안전망)
const uniq = [...new Map(found.map(x => [x.panId, x])).values()];
console.log(`\n총 공고 ${uniq.length}건 (신규만 상세/다운로드)`);

// ── 3) 신규 공고: 상세 스냅샷 + 첨부 전부 저장 ─────────────
// 건별 try/catch — 한 공고의 네트워크 throw가 전체 런을 죽이지 않게(나머지 처리·index 보존). 실패는 모아서 끝에 가시화.
const failed = [];
for (const n of uniq) {
 try {
  const dir = new URL(`${n.panId}/`, RAW);
  if (index[n.panId]?.done) {
    // 이미 받음 → 재다운로드 없이 상태·날짜만 갱신(상태는 시간따라 변함). index는 무조건 갱신(raw 없어도), meta는 best-effort.
    Object.assign(index[n.panId], { 상태: n.상태, 마감일: n.마감일 });
    try {
      const mp = new URL('meta.json', dir);
      const m = JSON.parse(readFileSync(mp, 'utf8'));
      m.상태 = n.상태; m.게시일 = n.게시일; m.마감일 = n.마감일;
      writeFileSync(mp, JSON.stringify(m, null, 2));
    } catch {}
    continue;
  }
  if (REFRESH) { // 갱신 모드: 신규는 다운로드하지 않고 목록만 기록(로컬 pipeline이 추출 처리)
    newPending.push({ panId: n.panId, title: n.title, type: TYPE_LABEL[`${n.upp}/${n.ais}`] || `${n.upp}/${n.ais}`, region: REGION_LABEL[n.cnpCd], 상태: n.상태, 마감일: n.마감일 });
    continue;
  }
  mkdirSync(new URL('files/', dir), { recursive: true });

  const dRes = await req(`${BASE}/apply/wt/wrtanc/selectWrtancInfo.do`, { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${BASE}/apply/wt/wrtanc/selectWrtancList.do?mi=1026` },
    body: new URLSearchParams({ panId: n.panId, ccrCnntSysDsCd: n.ccr || '03', uppAisTpCd: n.upp, aisTpCd: n.ais, mi: '1026' }) });
  const detail = await dRes.text();
  if (/잘못된 경로|페이지가 삭제/.test(detail)) { console.log(`  ⚠️ ${n.panId} 상세 실패`); continue; }
  writeFileSync(new URL('detail.html', dir), detail);

  // 상세에서 fileid→파일명 페어 (다운로드 전 필터용)
  const pairs = [...new Map([...detail.matchAll(/fileDownLoad\('(\d+)'\);">([^<]+)/g)].map(m => [m[1], m[2].trim()])).entries()];
  // 형식 필터(CLAUDE §2): 요건추출=PDF·주택목록=xlsx만 파서 있음 → 그 외 파서0 형식(hwp/hwpx/zip/이미지/서식)은 다운로드 안 함(불변 raw 비대 방지, fileid만 기록해 재다운 가능).
  //   단 hwp/hwpx는 "PDF 없을 때만" 본문 fallback 보존(§2). 확장자 미상은 fail-safe로 보존(요건 PDF 유실 방지).
  const SKIP_EXT = /\.(hwp|hwpx|zip|png|jpe?g|gif|bmp|doc|docx|ppt|pptx|txt)$/i;
  const FALLBACK_EXT = /\.(hwp|hwpx)$/i;
  const hasPdf = pairs.some(([, nm]) => /\.pdf$/i.test(nm));
  const files = [];
  for (const [fid, dispName] of pairs) {
    if (PAMPHLET_PAT.test(dispName)) { files.push({ fileid: fid, name: dispName, skipped: '팸플릿류' }); continue; } // 받지 않고 id만 기록
    if (SKIP_EXT.test(dispName) && !(!hasPdf && FALLBACK_EXT.test(dispName))) { files.push({ fileid: fid, name: dispName, skipped: '비요건형식' }); continue; } // 파서 없는 형식 — id만 기록
    const fr = await req(`${BASE}/lhFile.do?fileid=${fid}`, { headers: { Referer: `${BASE}/apply/wt/wrtanc/selectWrtancInfo.do` } });
    const buf = Buffer.from(await fr.arrayBuffer());
    if (buf.length < 100 || /<!DOCTYPE html/i.test(buf.subarray(0, 200).toString('latin1'))) continue; // 에러응답 스킵
    const name = cdName(fr.headers.get('content-disposition'), dispName || `${fid}.bin`);
    const ext = (name.match(/\.[a-z0-9]+$/i) || ['.bin'])[0].toLowerCase();
    writeFileSync(new URL(`files/${fid}__${sani(name)}`, dir), buf);
    files.push({ fileid: fid, name, ext, bytes: buf.length });
    await dwell(200);
  }
  const meta = { panId: n.panId, title: n.title, type: TYPE_LABEL[`${n.upp}/${n.ais}`] || `${n.upp}/${n.ais}`,
    cnpCd: n.cnpCd, region: REGION_LABEL[n.cnpCd], upp: n.upp, ais: n.ais,
    상태: n.상태, 게시일: n.게시일, 마감일: n.마감일,
    dtlUrl: `${BASE}/apply/wt/wrtanc/selectWrtancInfo.do?panId=${n.panId}`, files, collectedAt: fmt(today) };
  writeFileSync(new URL('meta.json', dir), JSON.stringify(meta, null, 2));
  index[n.panId] = { title: n.title, region: meta.region, type: meta.type, 상태: n.상태, 마감일: n.마감일, files: files.length, done: true };
  isNew++;
  console.log(`  ✅ ${n.panId} ${n.title.slice(0, 30)} — 첨부 ${files.length}개`);
  await dwell(300);
 } catch (e) {
  console.log(`  ⚠️ ${n.panId} 처리 실패(건너뜀): ${e.message}`);
  failed.push({ panId: n.panId, title: n.title, error: e.message });
 }
}

mkdirSync(ROOT, { recursive: true });
writeFileSync(IDX, JSON.stringify(index, null, 2));
if (failed.length) console.log(`⚠️ 처리 실패 ${failed.length}건(index 미기록 — 다음 실행 시 재시도): ${failed.map(f => f.panId).join(', ')}`);
if (REFRESH) {
  writeFileSync(new URL('new-pending.json', ROOT), JSON.stringify(newPending, null, 2));
  console.log(`\n[refresh] 상태 갱신 완료. 미추출 신규 ${newPending.length}건 → data/new-pending.json (다운로드/추출은 로컬 pipeline).`);
} else {
  console.log(`\n신규 ${isNew}건 저장 완료. index: ${Object.keys(index).length}건 추적중.`);
}
