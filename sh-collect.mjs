// SH(서울주택도시공사) 임대·매입임대 모집공고 수집기 — i-sh.co.kr egovframe 게시판 스크래핑
//   data.go.kr엔 실시간 모집공고 API가 없음(정적 fileData뿐) → 사이트 직접 스크래핑(무세션·UTF-8 실측 2026-06-24).
//   목록: brd/m_247/list.do?multi_itm_seq=2(임대)|512(매입), page=N. 10행/페이지, 최신순. GET.
//   상세: view.do?seq=ID&multi_itm_seq=K → `initParam.downList=[...]` JSON에서 첨부 메타 파싱.
//   첨부: /com/file/innoFD.do?brdId=&seq=&fileTp=&fileSeq= (무세션 공개 다운로드, %PDF 실측).
//   한계: 목록에 상태(접수중/마감)·마감일·소득/자산 요건 없음 → 등록일 기간컷 + 제목필터로 모집공고만 수집,
//         마감일·상태·소득/자산은 공고문 PDF 추출 후속(myhome식 파이프라인 재사용). 그래서 상태=null로 남김.
// 사용: node sh-collect.mjs [--since=2026-05-01] [--include-sale] [--probe]
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';

const ORIGIN = 'https://www.i-sh.co.kr';
const ROOT = new URL('./data/', import.meta.url);
const RAW = new URL('raw/sh/', ROOT);
const DERIVED = new URL('derived/sh/', ROOT);
const IDX = new URL('index.json', ROOT);

const argv = process.argv.slice(2);
const getArg = (k, d) => (argv.find(a => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split('=')[1];
const PROBE = argv.includes('--probe');
const INCLUDE_SALE = argv.includes('--include-sale');   // 기본은 임대만(분양은 청약홈이 담당)
const SINCE = getArg('since', '2026-05-01');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
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
const SKIP_TITLE = /당첨자|경쟁률|계약\s*체결|계약\s*안내|선정\s*결과|결과\s*발표|발표\s*및|최종\s*청약|명단|점검|환급|반환|중단\s*안내|시스템|연기|취소된/;
const SKIP_FILE = /팸플릿|팜플렛|리플렛|리플릿|브로슈어|카탈로그|조감도|평면도|위임장|점검표|안내문|당첨자|명단|서식|별지/;
const sani = s => String(s).replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
const dwell = ms => new Promise(r => setTimeout(r, ms));
const TODAY = new Date().toISOString().slice(0, 10);
function loadIndex() { try { return JSON.parse(readFileSync(IDX, 'utf8')); } catch { return {}; } }
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

// 첨부 다운로드(공고문 PDF 우선, 팸플릿/서식류 제외). 신규만.
async function fetchNoticeFiles(downList, viewLink, dir) {
  const files = [];
  for (const f of downList) {
    const name = f.oriFileNm || `${f.brdId}_${f.fileSeq}`;
    if (SKIP_FILE.test(name)) { files.push({ ...pick(f), name, skipped: '팸플릿/서식류' }); continue; }
    if (!/\.(pdf|hwp|hwpx)$/i.test(name)) { files.push({ ...pick(f), name, skipped: '비문서' }); continue; }
    try {
      const r = await fetch(downUrl(f), { headers: { 'User-Agent': UA, Referer: viewLink } });
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 100 || /<!DOCTYPE html/i.test(buf.subarray(0, 200).toString('latin1'))) { files.push({ ...pick(f), name, skipped: '다운실패' }); continue; }
      const ext = (name.match(/\.[a-z0-9]+$/i) || ['.pdf'])[0].toLowerCase();
      mkdirSync(new URL('files/', dir), { recursive: true });
      writeFileSync(new URL(`files/${f.fileSeq}__${sani(name)}`, dir), buf);
      files.push({ ...pick(f), name, ext, bytes: buf.length });
      await dwell(200);
    } catch { files.push({ ...pick(f), name, skipped: '오류' }); }
  }
  return files;
}
const pick = f => ({ brdId: f.brdId, seq: f.seq, fileSeq: f.fileSeq, fileTp: f.fileTp });

// 행 → 통합 envelope(SCHEMA §0). 소득/자산·마감일·상태는 공고문 PDF 추출 후속.
function toEnvelope(b, row, viewLink) {
  return {
    panId: `sh-${row.seq}`, source: 'sh', 상품군: b[4],
    공고명: row.title, 유형: b[0], 상품구조: b[4], 공급기관: 'SH 서울주택도시공사',
    지역: '서울', 주소: null,
    // SH 목록엔 상태·마감일 없음. 발표/경쟁률/계약류는 제목필터로 이미 제외 → 모집공고만 남으므로 '공고중'으로 노출
    //   (접수기간·마감일은 공고문 PDF에 있음 → 마감일 null로 두면 D-day 미정 통과, 접수기간은 _검증노트로 확인 위임).
    공고일: row.공고일, 접수시작: null, 마감일: null, 상태: '공고중', 당첨자발표: null, 공고구분: null,
    단지: [], 공급형: [],
    선정방식: '순위', 선정방식상세: `SH ${b[0]} — 자격·순위·소득/자산 컷은 공고문 확인.`,
    자격요건: {
      무주택: '무주택세대구성원(유형별 상이 — 공고문 확인)',
      소득기준: { 종류: '공고문미기재', 기본퍼센트: null, 가구원수별: null, 가산규칙: '', 비고: 'SH 목록 소득기준 미제공 — 공고문 PDF 확인' },
      자산상한: '공고문미기재', 자동차상한: '공고문미기재', 청약요건: '공고문미기재', 대상계층: ['일반'], 계층별: null,
    },
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

const index = loadIndex();
let isNew = 0, kept = 0, skippedOld = 0, skippedTitle = 0;
const byBoard = {};
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
        const ddir = new URL(`${slug}/`, DERIVED);
        mkdirSync(ddir, { recursive: true });
        if (index[idxKey]?.done) { Object.assign(index[idxKey], {}); continue; }  // 이미 받음(상태 갱신원 없음)
        const dir = new URL(`${slug}/`, RAW);
        mkdirSync(dir, { recursive: true });
        const dv = await getText(viewLink);
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
writeFileSync(IDX, JSON.stringify(index, null, 2));
console.log(`\n신규 ${isNew} · 유지 ${kept} · 기간밖 ${skippedOld} · 비모집(제목) ${skippedTitle}`);
console.log(`게시판 분포(수집분): ${JSON.stringify(byBoard)}`);
console.log(`sh index ${Object.keys(index).filter(k => k.startsWith('sh-')).length}건. 마감일·상태·소득/자산은 공고문 PDF 추출 후속.`);
