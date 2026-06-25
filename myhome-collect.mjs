// 마이홈포털(국토교통부) 공공임대 모집공고 수집기 — data.go.kr 15108420
//   base: http://apis.data.go.kr/1613000/HWSPR02 · op: rsdtRcritNtcList (표준 getList, JSON)
//   응답: response.body.item[] (items 래핑 없음). totalCount/pageNo/numOfRows.
//   공급기관(suplyInsttNm): LH·부산도시공사·경북/경남개발공사 등. LH는 lh-collect가 더 풍부히 수집중이라 기본 제외(--include-lh로 포함).
//   → 마이홈은 LH 사각지대(지방 도시·개발공사 임대)만 보강. SH/GH는 자체시스템 운영으로 미포함될 수 있음(커버리지 한계).
//   소득·자산 요건은 구조화 미제공 → 공고문 PDF(pcUrl) 추출 후속(LH식 파이프라인 재사용).
// 사용: node myhome-collect.mjs [--since=2026-05-01] [--include-lh] [--probe]
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { UA, dwell, sani, dnorm, getArg, loadIndex, loadServiceKey } from './collect-util.mjs';

const BASE = 'http://apis.data.go.kr/1613000/HWSPR02';
const LIST_OP = 'rsdtRcritNtcList';
const ROOT = new URL('./data/', import.meta.url);
const RAW = new URL('raw/myhome/', ROOT);
const DERIVED = new URL('derived/myhome/', ROOT);
const IDX = new URL('index.json', ROOT);

const argv = process.argv.slice(2);
const PROBE = argv.includes('--probe');
const INCLUDE_LH = argv.includes('--include-lh');   // 기본은 LH 제외(lh-collect가 담당)
const SINCE = getArg('since', '2026-05-01');

const SERVICE_KEY = loadServiceKey();
if (!SERVICE_KEY) { console.error('❌ .env 의 DATA_GO_KR_SERVICE_KEY 가 비어있음'); process.exit(1); }

const FILE_DOWN = 'https://www.myhome.go.kr/hws/com/fms/cvplFileDownload.do';
const SKIP_PAT = /팸플릿|팜플렛|리플렛|리플릿|브로슈어|카탈로그|조감도|평면도/;
const TODAY = new Date().toISOString().slice(0, 10);

// 상세페이지(pcUrl) → 공고문 PDF/HWP 첨부 다운로드 (전자정부 cvplFileDownload.do, atchFileId+fileSn GET)
async function fetchNoticeFiles(pblancId, houseSn, dir) {
  const url = `https://www.myhome.go.kr/hws/portal/sch/selectRsdtRcritNtcDetailView.do?pblancId=${pblancId}&houseSn=${houseSn}`;
  const html = await (await fetch(url, { headers: { 'User-Agent': UA } })).text();
  // <a href="javascript:fnDownFile('atchFileId','fileSn')" >파일명.pdf</a>
  const pairs = [...html.matchAll(/fnDownFile\('([^']+)',\s*'([^']+)'\)"[^>]*>\s*([^<]+?)\s*<\/a>/g)]
    .map(m => ({ atchFileId: m[1], fileSn: m[2], name: m[3].trim() }));
  const files = [];
  for (const f of pairs) {
    if (SKIP_PAT.test(f.name)) { files.push({ ...f, skipped: '팸플릿류' }); continue; }
    if (!/\.(pdf|hwp|hwpx)$/i.test(f.name)) { files.push({ ...f, skipped: '비문서' }); continue; }
    try {
      const r = await fetch(`${FILE_DOWN}?atchFileId=${encodeURIComponent(f.atchFileId)}&fileSn=${encodeURIComponent(f.fileSn)}`, { headers: { 'User-Agent': UA, Referer: url } });
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 100 || /<!DOCTYPE html/i.test(buf.subarray(0, 200).toString('latin1'))) { files.push({ ...f, skipped: '다운실패' }); continue; }
      const ext = (f.name.match(/\.[a-z0-9]+$/i) || ['.pdf'])[0].toLowerCase();
      mkdirSync(new URL('files/', dir), { recursive: true });
      writeFileSync(new URL(`files/${f.atchFileId}__${sani(f.name)}`, dir), buf);
      files.push({ atchFileId: f.atchFileId, fileSn: f.fileSn, name: f.name, ext, bytes: buf.length });
      await dwell(200);
    } catch { files.push({ ...f, skipped: '오류' }); }
  }
  return files;
}
const numOrNull = v => { const n = Number(String(v ?? '').replace(/[^\d]/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };
function statusOf(b, e) { if (b && TODAY < b) return '접수예정'; if (e && TODAY > e) return '접수마감'; if (b && e) return '접수중'; return null; }

async function fetchPage(pageNo, numOfRows) {
  const qs = new URLSearchParams({ serviceKey: SERVICE_KEY, pageNo: String(pageNo), numOfRows: String(numOfRows), type: 'json' });
  const res = await fetch(`${BASE}/${LIST_OP}?${qs}`, { headers: { Accept: 'application/json' } });
  const text = await res.text();
  if (/Forbidden|NOT_REGISTERED|등록되지/.test(text)) throw new Error(`활용신청 미승인/전파대기 (HTTP ${res.status}): ${text.slice(0, 120)}`);
  let j; try { j = JSON.parse(text); } catch { throw new Error(`비JSON HTTP ${res.status}: ${text.slice(0, 160)}`); }
  const b = j?.response?.body || {};
  let items = b.item ?? b.items?.item ?? []; if (items && !Array.isArray(items)) items = [items];
  return { items: items || [], total: Number(b.totalCount || 0) };
}

// 실측 스키마(2026-06-24) → 통합 envelope(SCHEMA §0)
function toEnvelope(it) {
  const b = dnorm(it.beginDe), e = dnorm(it.endDe);
  const 보증금 = numOrNull(it.rentGtn), 월세 = numOrNull(it.mtRntchrg);
  return {
    panId: `mh-${it.pblancId}-${it.houseSn ?? 1}`, source: 'myhome', 상품군: '임대',
    공고명: it.pblancNm, 유형: it.suplyTyNm, 상품구조: it.suplyTyNm, 공급기관: it.suplyInsttNm,
    지역: [it.brtcNm, it.signguNm].filter(Boolean).join(' '), 주소: it.fullAdres,
    공고일: dnorm(it.rcritPblancDe), 접수시작: b, 마감일: e, 상태: statusOf(b, e),
    당첨자발표: dnorm(it.przwnerPresnatnDe), 공고구분: it.sttusNm,
    단지: [{ 단지명: it.hsmpNm, 주소: it.fullAdres, 총공급세대: numOrNull(it.totHshldCo) }],
    공급형: (보증금 || 월세) ? [{ 형명: it.houseTyNm || null, 임대료: [{ 구분: '기본', 임대보증금: 보증금 || 0, 월임대료: 월세 || 0 }] }] : [],
    선정방식: '순위', 선정방식상세: `${it.suplyInsttNm} ${it.suplyTyNm} — 자격·순위·소득/자산 컷은 공고문 확인.`,
    자격요건: {
      무주택: '무주택세대구성원(유형별 상이 — 공고문 확인)',
      소득기준: { 종류: '공고문미기재', 기본퍼센트: null, 가구원수별: null, 가산규칙: '', 비고: '마이홈 API 소득기준 미제공 — 공고문 PDF 확인' },
      자산상한: '공고문미기재', 자동차상한: '공고문미기재', 청약요건: '공고문미기재', 대상계층: ['일반'], 계층별: null,
    },
    순위규칙: [], 배점표: [], 우선배정: [],
    원문링크: { 상세페이지: it.pcUrl || null, 공급기관: it.url || null },
    _검증노트: ['소득·자산기준 API미제공 → 공고문 PDF(pcUrl) 추출 필요(LH식 파이프라인)'],
  };
}

// ── 실행 ───────────────────────────────────────────────────
if (PROBE) {
  const { items, total } = await fetchPage(1, 5);
  console.log(`✅ totalCount=${total} · 받은 ${items.length}`);
  if (items[0]) { console.log(`키(${Object.keys(items[0]).length}): ${Object.keys(items[0]).join(', ')}`); console.log('\nenvelope 샘플:\n' + JSON.stringify(toEnvelope(items[0]), null, 1)); }
  process.exit(0);
}

const index = loadIndex(IDX);
let isNew = 0, kept = 0, skippedOld = 0, skippedLh = 0;
const byInstt = {};
try {
  for (let page = 1; ; page++) {
    const { items, total } = await fetchPage(page, 300);
    if (!items.length) break;
    for (const it of items) {
      if (!INCLUDE_LH && it.suplyInsttNm === 'LH') { skippedLh++; continue; }   // LH는 lh-collect가 담당
      const env = toEnvelope(it);
      if (env.공고일 && env.공고일 < SINCE) { skippedOld++; continue; }
      kept++; byInstt[env.공급기관] = (byInstt[env.공급기관] || 0) + 1;
      const idxKey = env.panId, slug = `${it.pblancId}-${it.houseSn ?? 1}`;
      // 마이홈은 LLM 추출 없음(메타 구조화) → envelope가 곧 requirements.json. derive 폴딩·결정론·멱등.
      const ddir = new URL(`${slug}/`, DERIVED);
      mkdirSync(ddir, { recursive: true });
      writeFileSync(new URL('requirements.json', ddir), JSON.stringify(env, null, 2));
      if (index[idxKey]?.done) { Object.assign(index[idxKey], { 상태: env.상태, 마감일: env.마감일 }); continue; }
      const dir = new URL(`${slug}/`, RAW);
      mkdirSync(dir, { recursive: true });
      if (!existsSync(new URL('item.json', dir))) writeFileSync(new URL('item.json', dir), JSON.stringify(it, null, 2));
      // 공고문 PDF 다운로드(소득·자산 추출 입력) — 신규만. 실패는 비치명적.
      let files = [];
      try { files = await fetchNoticeFiles(it.pblancId, it.houseSn ?? 1, dir); } catch (e) { /* 상세접근 실패 무시 */ }
      env.files = files;
      writeFileSync(new URL('meta.json', dir), JSON.stringify(env, null, 2));
      writeFileSync(new URL('requirements.json', ddir), JSON.stringify(env, null, 2));   // files 포함 갱신
      const pdfCnt = files.filter(f => !f.skipped && f.ext === '.pdf').length;
      index[idxKey] = { source: 'myhome', title: env.공고명, region: env.지역, type: env.유형, 공급기관: env.공급기관, 상태: env.상태, 마감일: env.마감일, files: files.length, done: true };
      isNew++;
      if (isNew <= 30) console.log(`  ✅ ${env.panId} ${(env.공고명 || '').slice(0, 26)} · ${env.공급기관} · ${env.지역} · ${env.상태 || '?'}`);
    }
    if (page * 300 >= total) break;
    await dwell(150);
  }
} catch (e) { console.error(`❌ ${e.message}`); process.exit(1); }

mkdirSync(ROOT, { recursive: true });
writeFileSync(IDX, JSON.stringify(index, null, 2));
console.log(`\n신규 ${isNew} · 유지 ${kept} · LH제외 ${skippedLh} · 기간밖 ${skippedOld}`);
console.log(`공급기관 분포(수집분): ${JSON.stringify(byInstt)}`);
console.log(`myhome index ${Object.keys(index).filter(k => k.startsWith('mh-')).length}건. 소득·자산은 공고문 PDF 추출 후속.`);
