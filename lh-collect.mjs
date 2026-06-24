// LH 공고 아카이빙 수집기: 목록 → 신규 공고 detect → 상세 스냅샷 + 첨부 원본 전부 저장
// 사용: node lh-collect.mjs [지역코드...] [--types=06/10,06/07]
//   예) node lh-collect.mjs 41 --types=06/10      (경기 행복주택)
//       node lh-collect.mjs 11 26 41              (서울/부산/경기, 전체 임대유형)
// 원칙: raw/ 는 불변(원본). derived/ 는 재생성 가능. index.json 으로 신규 diff.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';

const BASE = 'https://apply.lh.or.kr/lhapply';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
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
const SKIP_PAT = /팸플릿|팜플렛|리플렛|리플릿|브로슈어|카탈로그|조감도/;

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
const dwell = ms => new Promise(r => setTimeout(r, ms)); // 예의상 간격

// ── 유틸 ───────────────────────────────────────────────────
const sani = s => s.replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
function cdName(disposition, fallback) {
  const m = (disposition || '').match(/filename="?([^";]+)"?/);
  if (!m) return fallback;
  try { return Buffer.from(m[1], 'latin1').toString('utf8'); } catch { return m[1]; }
}
function loadIndex() { try { return JSON.parse(readFileSync(IDX, 'utf8')); } catch { return {}; } }
const index = loadIndex();

// ── 1) 세션 ────────────────────────────────────────────────
await req(`${BASE}/apply/wt/wrtanc/selectWrtancList.do?mi=1026`);

// ── 2) 지역×유형 루프로 목록 수집 ──────────────────────────
const today = new Date();
const fmt = d => d.toISOString().slice(0, 10);
// 초기 백필 범위. 이후 실행은 index.json diff로 신규만 추가됨. --since=YYYY-MM-DD 로 조정
const startDt = (argv.find(a => a.startsWith('--since=')) || '--since=2026-05-01').split('=')[1];

let found = [], isNew = 0;
const newPending = [];
for (const cnpCd of REGIONS) {
  for (const [upp, ais] of TYPES) {
    const body = new URLSearchParams({
      panId: '', ccrCnntSysDsCd: '', srchUppAisTpCd: upp, uppAisTpCd: upp, aisTpCd: ais, srchAisTpCd: ais,
      prevListCo: '', mi: '1026', currPage: '1', srchY: 'Y', indVal: 'N', viewType: '', netbgn: '',
      srchFilter: 'Y', mvinQf: '0', cnpCd, panSs: '', schTy: '0', startDt, endDt: fmt(today), panNm: '', listCo: '100',
    });
    const r = await req(`${BASE}/apply/wt/wrtanc/selectWrtancList.do`, { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://apply.lh.or.kr', Referer: `${BASE}/apply/wt/wrtanc/selectWrtancList.do?mi=1026` }, body });
    const html = await r.text();
    // 행(<tr>) 단위 파싱: 셀 순서 = 번호·유형·공고명·지역·첨부·게시일·마감일·상태·조회수
    const rows = [];
    for (const tr of html.split(/<tr[\s>]/).slice(1)) {
      const a = tr.match(/<a[^>]*\bdata-id1="(\d+)"[^>]*\bdata-id3="(\d+)"[^>]*\bdata-id4="(\d+)"[^>]*class="wrtancInfoBtn"[^>]*>([\s\S]*?)<\/a>/);
      if (!a) continue;
      const dates = [...tr.matchAll(/(\d{4})\.(\d{2})\.(\d{2})/g)].map(m => `${m[1]}-${m[2]}-${m[3]}`);
      const status = (tr.match(/접수중|공고중|접수마감|정정공고중/) || [])[0] || null;
      rows.push({
        panId: a[1], upp: a[2], ais: a[3], cnpCd,
        title: a[4].replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
          .replace(/\s*(NEW|new|신규|\d+일전|오늘)\s*$/, '').trim(),
        게시일: dates[0] || null, 마감일: dates[1] || null, 상태: status,
      });
    }
    found.push(...rows);
    console.log(`[${REGION_LABEL[cnpCd] || cnpCd} · ${TYPE_LABEL[`${upp}/${ais}`] || `${upp}/${ais}`}] ${rows.length}건`);
    await dwell(300);
  }
}

// 중복 제거(같은 공고가 여러 지역코드에 잡힐 수 있음)
const uniq = [...new Map(found.map(x => [x.panId, x])).values()];
console.log(`\n총 공고 ${uniq.length}건 (신규만 상세/다운로드)`);

// ── 3) 신규 공고: 상세 스냅샷 + 첨부 전부 저장 ─────────────
for (const n of uniq) {
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
    body: new URLSearchParams({ panId: n.panId, ccrCnntSysDsCd: '03', uppAisTpCd: n.upp, aisTpCd: n.ais, mi: '1026' }) });
  const detail = await dRes.text();
  if (/잘못된 경로|페이지가 삭제/.test(detail)) { console.log(`  ⚠️ ${n.panId} 상세 실패`); continue; }
  writeFileSync(new URL('detail.html', dir), detail);

  // 상세에서 fileid→파일명 페어 (다운로드 전 필터용)
  const pairs = [...new Map([...detail.matchAll(/fileDownLoad\('(\d+)'\);">([^<]+)/g)].map(m => [m[1], m[2].trim()])).entries()];
  const files = [];
  for (const [fid, dispName] of pairs) {
    if (SKIP_PAT.test(dispName)) { files.push({ fileid: fid, name: dispName, skipped: '팸플릿류' }); continue; } // 받지 않고 id만 기록
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
}

mkdirSync(ROOT, { recursive: true });
writeFileSync(IDX, JSON.stringify(index, null, 2));
if (REFRESH) {
  writeFileSync(new URL('new-pending.json', ROOT), JSON.stringify(newPending, null, 2));
  console.log(`\n[refresh] 상태 갱신 완료. 미추출 신규 ${newPending.length}건 → data/new-pending.json (다운로드/추출은 로컬 pipeline).`);
} else {
  console.log(`\n신규 ${isNew}건 저장 완료. index: ${Object.keys(index).length}건 추적중.`);
}
