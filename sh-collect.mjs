// SH(서울주택도시공사) 임대·매입임대 모집공고 수집기 — i-sh.co.kr egovframe 게시판 스크래핑
//   data.go.kr엔 실시간 모집공고 API가 없음(정적 fileData뿐) → 사이트 직접 스크래핑(무세션·UTF-8 실측 2026-06-24).
//   목록: brd/m_247/list.do?multi_itm_seq=2(임대)|512(매입), page=N. 10행/페이지, 최신순. GET.
//   상세: view.do?seq=ID&multi_itm_seq=K → `initParam.downList=[...]` JSON에서 첨부 메타 파싱.
//   첨부: /com/file/innoFD.do?brdId=&seq=&fileTp=&fileSeq= (무세션 공개 다운로드, %PDF 실측).
//   한계: 목록에 상태(접수중/마감)·마감일·소득/자산 요건 없음 → 등록일 기간컷 + 제목필터로 모집공고만 수집.
//         접수기간/마감일/발표일은 (1) 상세 본문 작성자 기재분을 parseBodyDates로 백필, (2) 더 정확한 건 공고문 PDF 추출 후속(myhome식).
//         상태는 백필 날짜로 statusOf 계산. 본문·PDF 모두 날짜 없는 상시모집만 '공고중'+마감일 null로 남음(사이트에서 '마감일 미상' 뱃지).
// 사용: node sh-collect.mjs [--since=2026-05-01] [--include-sale] [--probe] [--reparse] [--refresh]
//   --reparse : 기존 수집분 재처리(재다운로드 없음) — 제목필터 재적용(발표글 등 제거) + 상세 본문에서 접수기간/마감일/발표일 백필.
//   --refresh : CI용 — 신규만 감지해 data/new-pending.json에 기록(다운로드/추출 안 함, 로컬 process-all이 처리). SH는 키 불필요.
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { UA, dwell, sani, getArg, loadIndex, statusOf, makePanId, SRC_PREFIX, NON_NOTICE_PAT, saveDoc, emptyQualification, mergeNewPending } from './collect-util.mjs';

const ORIGIN = 'https://www.i-sh.co.kr';
const ROOT = new URL('./data/', import.meta.url);
const RAW = new URL('raw/sh/', ROOT);
const DERIVED = new URL('derived/sh/', ROOT);
const IDX = new URL('index.json', ROOT);

const argv = process.argv.slice(2);
const PROBE = argv.includes('--probe');
const REPARSE = argv.includes('--reparse');
const REFRESH = argv.includes('--refresh');   // CI 갱신: 신규 감지·new-pending 기록만(다운로드/추출은 로컬). 키 불필요.
const INCLUDE_SALE = argv.includes('--include-sale');   // 기본은 임대만(분양은 청약홈이 담당)
const SINCE = getArg('since', '2026-05-01');

// 게시판: [라벨, program path, m_id, multi_itm_seq, 상품군]. 임대=2·분양=1(m_244).
//   매입 게시판(multi_itm_seq=512)은 SH가 주택을 사들이는 "매입공고"(매도자 대상)라 입주자 매칭에 무관 — 제외.
//   (입주자용 매입임대 모집은 임대 게시판(2)에 "…매입임대주택 입주자 모집" 형태로 들어옴.)
const BOARDS = [
  ['임대', 'S1T294C297', 'm_247', '2', '임대'],
  ['분양', 'S1T294C296', 'm_244', '1', '분양'],
];
const listUrl = (b, page) => `${ORIGIN}/main/lay2/program/${b[1]}/www/brd/${b[2]}/list.do?multi_itm_seq=${b[3]}&page=${page}`;
const viewUrl = (b, seq) => `${ORIGIN}/main/lay2/program/${b[1]}/www/brd/${b[2]}/view.do?seq=${seq}&multi_itm_seq=${b[3]}`;
// 이용자용 원문링크는 SH인터넷청약시스템(/app/, 실제 청약 포털) — /main/ 뉴스게시판과 같은 seq·첨부지만 청약 동선상 적절.
const SH_APPLY_BASE = `${ORIGIN}/app/lay2/program/S48T561C563/www/brd/m_247`;
const pubUrl = (b, seq) => `${SH_APPLY_BASE}/view.do?seq=${seq}&multi_itm_seq=${b[3]}`;
const downUrl = f => `${ORIGIN}/main/com/file/innoFD.do?brdId=${encodeURIComponent(f.brdId)}&seq=${encodeURIComponent(f.seq)}&fileTp=${encodeURIComponent(f.fileTp || 'A')}&fileSeq=${encodeURIComponent(f.fileSeq)}`;

// 모집공고만(당첨자발표·경쟁률·계약·점검·안내문류 배제). 정정공고 포함.
const KEEP_PAT = /모집\s*공고|입주자\s*모집|예비입주자|공급\s*공고|우선\s*공급/;
// 발표·결과류 배제. '…대상자 발표'(입주대상자/서류심사대상자 발표 등)는 모집공고 본문을 인용해도 글 자체는 결과발표 → 제외.
const SKIP_TITLE = /당첨자|경쟁률|계약\s*체결|계약\s*안내|선정\s*결과|결과\s*발표|발표\s*및|대상자\s*발표|최종\s*청약|명단|점검|환급|반환|중단\s*안내|시스템|연기|취소된/;
async function getText(url) { const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9' } }); return await r.text(); }

// 목록 한 페이지 파싱 → [{seq, title, 공고일}]
function parseList(html) {
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g; let m;
  while ((m = trRe.exec(html))) {
    const row = m[1];
    const sm = row.match(/getDetailView\('(\d+)'\)/);
    if (!sm) continue;
    const am = row.match(/getDetailView\('\d+'\)[\s\S]*?>([\s\S]*?)<\/a>/);
    let title = am ? am[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().replace(/^NEW\s*/, '') : '';
    const dm = row.match(/(20\d\d-\d\d-\d\d)/);
    rows.push({ seq: sm[1], title, 공고일: dm ? dm[1] : null });
  }
  return rows;
}
// 총 페이지 수 파싱: "총 1,648 건 [1/165페이지]"
function parseTotalPages(html) { const m = html.match(/\[\s*\d+\s*\/\s*(\d+)\s*페이지/); return m ? Number(m[1]) : 1; }

// 상세 → 첨부 메타(initParam.downList JSON)
function parseDownList(html) {
  const m = html.match(/initParam\.downList\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) return [];
  try { return JSON.parse(m[1]); } catch { return []; }
}

// 상세 본문(작성자 기재)에서 접수기간·당첨자발표 백필. 첨부 PDF 추출이 우선이나, PDF 없는 SH(HWP만 첨부 등)엔 유일한 날짜원.
//   결정론·관용 파서: 끝날짜 연도생략("~ 5.22") / 공백구분("5 22.") / (요일)·시간 꼬리 허용. 22건 전수 검증: 오탐 0.
function parseBodyDates(html) {
  const t = String(html).replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const ymd = (y, m, d) => { y = +y; m = +m; d = +d; return (m >= 1 && m <= 12 && d >= 1 && d <= 31) ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null; };
  const out = { 접수시작: null, 마감일: null, 당첨자발표: null };
  // (신청|접수|모집|청약)기간 … 시작Y.M.D … ~ … 끝(Y.)M(.|공백)D
  const pm = t.match(/(?:신청|접수|모집|청약)\s*기간[^:：\d]{0,30}[:：]?\s*(\d{4})\s*[.\-]\s*(\d{1,2})\s*[.\-]\s*(\d{1,2})[^~]{0,22}~\s*(?:(\d{4})\s*[.\-]\s*)?(\d{1,2})\s*[.\s\-]\s*(\d{1,2})/);
  if (pm) { const s = ymd(pm[1], pm[2], pm[3]), e = ymd(pm[4] || pm[1], pm[5], pm[6]); if (s && e && e >= s) { out.접수시작 = s; out.마감일 = e; } }
  // (당첨자|서류심사대상자|…) 발표 : Y.M.D  — 콜론 필수(네비/제목의 "발표 날짜" 오탐 배제)
  const am = t.match(/(?:당첨자|서류심사\s*대상자|서류제출\s*대상자|예비입주자|입주대상자)\s*발표\s*[:：]\s*(\d{4})\s*[.\-]\s*(\d{1,2})\s*[.\-]\s*(\d{1,2})/);
  if (am) out.당첨자발표 = ymd(am[1], am[2], am[3]);
  return out;
}
// 첨부 다운로드(공고문 PDF 우선, 팸플릿/서식류 제외). 신규만.
async function fetchNoticeFiles(downList, viewLink, dir) {
  const files = [];
  for (const f of downList) {
    const name = f.oriFileNm || `${f.brdId}_${f.fileSeq}`;
    const res = await saveDoc({
      name, dir, saveKey: f.fileSeq, skipPat: NON_NOTICE_PAT,
      fetchBuf: async () => Buffer.from(await (await fetch(downUrl(f), { headers: { 'User-Agent': UA, Referer: viewLink } })).arrayBuffer()),
    });
    files.push({ ...pick(f), name, ...res });
  }
  return files;
}
const pick = f => ({ brdId: f.brdId, seq: f.seq, fileSeq: f.fileSeq, fileTp: f.fileTp });

// 행 → 통합 envelope(SCHEMA §0). 소득/자산·마감일·상태는 공고문 PDF 추출 후속.
function toEnvelope(b, row, viewLink) {
  return {
    panId: makePanId('sh', row.seq), source: 'sh', 상품군: b[4],
    공고명: row.title, 유형: b[0], 상품구조: b[4], 공급기관: 'SH 서울주택도시공사',
    지역: '서울', 주소: null,
    // SH 목록엔 상태·마감일 없음 → 기본 '공고중'. 수집 루프에서 parseBodyDates(상세 본문)로 접수시작/마감일/발표일 백필 후 statusOf 재계산.
    공고일: row.공고일, 접수시작: null, 마감일: null, 상태: '공고중', 당첨자발표: null, 공고구분: null,
    단지: [], 공급형: [],
    선정방식: '순위', 선정방식상세: `SH ${b[0]} — 자격·순위·소득/자산 컷은 공고문 확인.`,
    자격요건: emptyQualification('SH 목록 소득기준 미제공 — 공고문 PDF 확인'),
    순위규칙: [], 배점표: [], 우선배정: [],
    원문링크: { 상세페이지: pubUrl(b, row.seq), 공급기관: ORIGIN },
    _검증노트: ['접수기간·마감일·소득/자산기준 목록미제공 → 공고문 PDF 확인 필요(상태는 공고중으로 가정; myhome식 추출 파이프라인)'],
  };
}

// ── 실행 ───────────────────────────────────────────────────
if (PROBE) {
  const b = BOARDS[0];
  const html = await getText(listUrl(b, 1));
  const rows = parseList(html);
  console.log(`✅ ${b[0]} 총페이지=${parseTotalPages(html)} · 행 ${rows.length}`);
  for (const r of rows.slice(0, 8)) console.log(`  ${r.seq} ${r.공고일} ${KEEP_PAT.test(r.title) && !SKIP_TITLE.test(r.title) ? '✓' : '✗'} ${r.title.slice(0, 40)}`);
  if (rows[0]) {
    const dv = await getText(viewUrl(b, rows[0].seq));
    console.log(`\n첨부(seq ${rows[0].seq}): ${JSON.stringify(parseDownList(dv).map(f => f.oriFileNm))}`);
    console.log('\nenvelope 샘플:\n' + JSON.stringify(toEnvelope(b, rows[0], viewUrl(b, rows[0].seq)), null, 1));
  }
  process.exit(0);
}

const index = loadIndex(IDX);

// ── 재처리(--reparse): 재다운로드 없이 기존 수집분 보정 ──────
//   ① 제목필터 재적용 — 발표글 등 지금 기준 비모집글 제거(index+derived+raw 삭제).
//   ② 마감일 없는 잔여건 → 상세 본문에서 접수기간/마감일/발표일 백필(PDF 추출분은 보존).
if (REPARSE) {
  let dropped = 0, filled = 0, kept0 = 0;
  for (const [key, v] of Object.entries(index)) {
    if (v.source !== 'sh') continue;
    const seq = key.slice(3);
    const t = (v.title || '').replace(/\s+/g, ' ');
    if (!KEEP_PAT.test(t) || SKIP_TITLE.test(t)) {   // 지금 기준 비모집 → 제거
      delete index[key];
      for (const base of [DERIVED, RAW]) try { rmSync(new URL(`${seq}/`, base), { recursive: true, force: true }); } catch {}
      console.log(`  🗑️  ${key} 제거(비모집): ${t.slice(0, 40)}`);
      dropped++; continue;
    }
    const reqPath = new URL(`${seq}/requirements.json`, DERIVED);
    if (!existsSync(reqPath)) { kept0++; continue; }
    const r = JSON.parse(readFileSync(reqPath, 'utf8'));
    if (r.마감일) { kept0++; continue; }             // 이미 마감일 있음(PDF 추출 등) → 유지
    const b = v.type === '분양' ? BOARDS[1] : BOARDS[0];
    const bd = parseBodyDates(await getText(viewUrl(b, seq)));
    if (bd.마감일 || bd.접수시작 || bd.당첨자발표) {
      if (bd.접수시작) r.접수시작 = bd.접수시작;
      if (bd.마감일) r.마감일 = bd.마감일;
      if (bd.당첨자발표) r.당첨자발표 = bd.당첨자발표;
      r.상태 = statusOf(r.접수시작, r.마감일, r.상태 ?? '공고중');
      r._검증노트 = [...new Set([...(r._검증노트 || []), '접수기간/마감일·발표일: 상세 본문에서 백필(--reparse). 소득/자산은 공고문 PDF 확인.'])];
      writeFileSync(reqPath, JSON.stringify(r, null, 2));
      if (index[key]) { index[key].상태 = r.상태; index[key].마감일 = r.마감일; }
      console.log(`  ✅ ${key} 본문백필: 접수 ${r.접수시작 || '-'} ~ 마감 ${r.마감일 || '-'} (${r.상태})`);
      filled++;
    } else { console.log(`  · ${key} 본문 날짜 미검출(상시/PDF전용): ${t.slice(0, 36)}`); kept0++; }
    await dwell(150);
  }
  writeFileSync(IDX, JSON.stringify(index, null, 2));
  console.log(`\n[reparse] 제거 ${dropped} · 백필 ${filled} · 유지 ${kept0}`);
  process.exit(0);
}

let isNew = 0, kept = 0, skippedOld = 0, skippedTitle = 0;
const byBoard = {}, newPending = [];
try {
  for (const b of BOARDS) {
    if (b[4] === '분양' && !INCLUDE_SALE) continue;
    let reachedOld = false;
    const total = parseTotalPages(await getText(listUrl(b, 1)));
    for (let page = 1; page <= total && !reachedOld; page++) {
      const rows = parseList(await getText(listUrl(b, page)));
      if (!rows.length) break;
      for (const row of rows) {
        // 최신순 → 기간밖이 연속 나오면 그 게시판은 조기종료(단, 공고일 없으면 통과)
        if (row.공고일 && row.공고일 < SINCE) { skippedOld++; reachedOld = true; continue; }
        const t = (row.title || '').replace(/\s+/g, ' ');
        if (!KEEP_PAT.test(t) || SKIP_TITLE.test(t)) { skippedTitle++; continue; }
        const viewLink = viewUrl(b, row.seq);
        const env = toEnvelope(b, row, viewLink);
        kept++; byBoard[b[0]] = (byBoard[b[0]] || 0) + 1;
        const idxKey = env.panId, slug = row.seq;
        if (index[idxKey]?.done) continue;   // 이미 받음 — 재다운 안 함(신선도는 build-site freshStatus)
        if (REFRESH) {   // CI 갱신: 신규는 다운로드/추출 없이 목록만 기록(로컬 process-all이 처리)
          newPending.push({ panId: env.panId, title: env.공고명, type: env.유형, region: env.지역, 상태: env.상태, 마감일: env.마감일 });
          isNew++; continue;
        }
        const ddir = new URL(`${slug}/`, DERIVED);
        mkdirSync(ddir, { recursive: true });
        const dir = new URL(`${slug}/`, RAW);
        mkdirSync(dir, { recursive: true });
        const dv = await getText(viewLink);
        // 본문 날짜 백필(첨부 PDF 추출 전 1차) — 접수기간/마감일/발표일. 이후 myhome식 PDF 추출이 더 정확하면 보존·덮어씀.
        const bd = parseBodyDates(dv);
        if (bd.접수시작) env.접수시작 = bd.접수시작;
        if (bd.마감일) env.마감일 = bd.마감일;
        if (bd.당첨자발표) env.당첨자발표 = bd.당첨자발표;
        env.상태 = statusOf(env.접수시작, env.마감일, env.상태 ?? '공고중');
        const downList = parseDownList(dv);
        if (!existsSync(new URL('downlist.json', dir))) writeFileSync(new URL('downlist.json', dir), JSON.stringify(downList, null, 2));
        let files = [];
        try { files = await fetchNoticeFiles(downList, viewLink, dir); } catch { /* 비치명적 */ }
        env.files = files;
        writeFileSync(new URL('meta.json', dir), JSON.stringify(env, null, 2));
        writeFileSync(new URL('requirements.json', ddir), JSON.stringify(env, null, 2));
        index[idxKey] = { source: 'sh', title: env.공고명, region: env.지역, type: env.유형, 공급기관: env.공급기관, 상태: env.상태, 마감일: env.마감일, files: files.length, done: true };
        isNew++;
        if (isNew <= 40) console.log(`  ✅ ${env.panId} ${(env.공고명 || '').slice(0, 30)} · ${b[0]} · ${env.공고일} · 첨부 ${files.filter(f => !f.skipped).length}`);
        await dwell(150);
      }
    }
  }
} catch (e) { console.error(`❌ ${e.message}`); process.exit(1); }

mkdirSync(ROOT, { recursive: true });
if (REFRESH) { writeFileSync(IDX, JSON.stringify(index, null, 2)); mergeNewPending(ROOT, 'sh', newPending); console.log(`\n[refresh] 미추출 신규 ${newPending.length}건 → data/new-pending.json (다운로드/추출은 로컬 process-all).`); process.exit(0); }
writeFileSync(IDX, JSON.stringify(index, null, 2));
console.log(`\n신규 ${isNew} · 유지 ${kept} · 기간밖 ${skippedOld} · 비모집(제목) ${skippedTitle}`);
console.log(`게시판 분포(수집분): ${JSON.stringify(byBoard)}`);
console.log(`sh index ${Object.keys(index).filter(k => k.startsWith(SRC_PREFIX.sh)).length}건. 마감일·상태·소득/자산은 공고문 PDF 추출 후속.`);
