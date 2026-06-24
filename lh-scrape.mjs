// LH 청약플러스 스크래퍼 (자체 세션 발급 → 목록 → 상세 → 공고문 PDF 다운로드)
// 실행: node lh-scrape.mjs
import { writeFileSync } from 'node:fs';

const BASE = 'https://apply.lh.or.kr/lhapply';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
let COOKIE = '';

// 응답 Set-Cookie 누적
function absorbCookies(res) {
  const sc = res.headers.getSetCookie?.() ?? [];
  const jar = Object.fromEntries(COOKIE.split('; ').filter(Boolean).map(c => c.split('=').slice(0, 1).concat(c.split('=').slice(1).join('=')).slice(0, 2)).map(([k, ...v]) => [k, v.join('=')]));
  for (const line of sc) {
    const [kv] = line.split(';');
    const i = kv.indexOf('=');
    jar[kv.slice(0, i)] = kv.slice(i + 1);
  }
  COOKIE = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function req(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    redirect: 'manual',
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'ko-KR,ko;q=0.9',
      ...(COOKIE ? { Cookie: COOKIE } : {}),
      ...(opts.headers || {}),
    },
  });
  absorbCookies(res);
  return res;
}

// 1) 세션 발급: 목록 페이지 GET
await req(`${BASE}/apply/wt/wrtanc/selectWrtancList.do?mi=1026`);
console.log('세션 쿠키:', COOKIE.split('; ').map(c => c.split('=')[0]).join(', '));

// 2) 목록 POST (경기=41, 행복주택=06/10, 공고중, 최근 60일)
const today = new Date('2026-06-21');
const fmt = d => d.toISOString().slice(0, 10);
const body = new URLSearchParams({
  panId: '', ccrCnntSysDsCd: '', srchUppAisTpCd: '06', uppAisTpCd: '06',
  aisTpCd: '10', srchAisTpCd: '10', prevListCo: '', mi: '1026', currPage: '1',
  srchY: 'Y', indVal: 'N', viewType: '', netbgn: '', srchFilter: 'Y', mvinQf: '0',
  cnpCd: '41', panSs: '공고중', schTy: '0',
  startDt: fmt(new Date(today - 60 * 864e5)), endDt: fmt(today), panNm: '', listCo: '20',
});
const listRes = await req(`${BASE}/apply/wt/wrtanc/selectWrtancList.do`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://apply.lh.or.kr',
    Referer: `${BASE}/apply/wt/wrtanc/selectWrtancList.do?mi=1026` },
  body,
});
const listHtml = await listRes.text();
console.log('목록 HTTP', listRes.status, 'len', listHtml.length,
  /잘못된 경로|페이지가 삭제/.test(listHtml) ? '❌에러' : '✅');

// 공고 행 파싱: <a data-id1=panId data-id3=upp data-id4=ais ... class="wrtancInfoBtn">제목</a>
const notices = [...listHtml.matchAll(
  /<a[^>]*\bdata-id1="(\d+)"[^>]*\bdata-id3="(\d+)"[^>]*\bdata-id4="(\d+)"[^>]*class="wrtancInfoBtn"[^>]*>([\s\S]*?)<\/a>/g
)].map(m => ({
  panId: m[1], upp: m[2], ais: m[3],
  title: m[4].replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
}));
console.log(`\n공고 ${notices.length}건:`);
notices.slice(0, 5).forEach((n, i) => console.log(` ${i + 1}. [${n.panId}] ${n.title.slice(0, 40)}`));

if (!notices.length) { console.log('공고 없음 — 종료'); process.exit(0); }

// 3) 첫 공고 상세 POST → fileid 추출
const n0 = notices[0];
const dRes = await req(`${BASE}/apply/wt/wrtanc/selectWrtancInfo.do`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded',
    Referer: `${BASE}/apply/wt/wrtanc/selectWrtancList.do?mi=1026` },
  body: new URLSearchParams({ panId: n0.panId, ccrCnntSysDsCd: '03', uppAisTpCd: n0.upp, aisTpCd: n0.ais, mi: '1026' }),
});
const detailHtml = await dRes.text();
console.log('\n상세 HTTP', dRes.status, 'len', detailHtml.length,
  /잘못된 경로|페이지가 삭제/.test(detailHtml) ? '❌에러' : '✅');
const fileIds = [...new Set([...detailHtml.matchAll(/fileDownLoad\('(\d+)'\)/g)].map(m => m[1]))];
console.log('첨부 fileid:', fileIds.slice(0, 10).join(', '), `(총 ${fileIds.length})`);

if (!fileIds.length) { console.log('첨부 없음 — 종료'); process.exit(0); }

// 4) 첫 fileid 다운로드 → 파일 저장 (Content-Disposition 파일명)
const fRes = await req(`${BASE}/lhFile.do?fileid=${fileIds[0]}`, {
  headers: { Referer: `${BASE}/apply/wt/wrtanc/selectWrtancInfo.do` },
});
const cd = fRes.headers.get('content-disposition') || '';
const fname = decodeURIComponent((cd.match(/filename="?([^"]+)"?/) || [, `${fileIds[0]}.bin`])[1]);
const buf = Buffer.from(await fRes.arrayBuffer());
writeFileSync(new URL(`./dl_${fileIds[0]}`, import.meta.url), buf);
const magic = buf.subarray(0, 4).toString('latin1');
console.log('\n다운로드 HTTP', fRes.status, fRes.headers.get('content-type'));
console.log('파일명:', fname, '| 크기:', buf.length, '| magic:', JSON.stringify(magic),
  magic === '%PDF' ? '✅PDF' : (buf.subarray(0, 4).toString('hex') === 'd0cf11e0' ? '✅HWP(구)' : ''));
