// 청약홈 공고문 PDF 직링크 수집 — 상세페이지(서버렌더 HTML)의 getAtchmnfl.do 링크를 파싱해 requirements 원문링크.공고문PDF에 주입.
// 사용: node inject-applyhome-pdf.mjs [--all] [--limit=N]
//   기본: 공고문PDF 없는 건만(증분). --all: 전건 재파싱.
// 근거: API(data.go.kr)엔 PDF 필드가 없으나 청약홈 상세페이지엔 <a href="https://static.applyhome.co.kr/ai/aia/getAtchmnfl.do?...">모집공고문 보기</a> 직링크 존재.
//   atchmnflSeqNo가 API엔 없어 페이지 fetch·파싱 필요(결정론·외부 LLM 0). raw detail.json의 PBLANC_URL을 상세페이지로 사용.
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

const ROOT = new URL('./data/', import.meta.url);
const DER = new URL('derived/applyhome/', ROOT);
const RAW = new URL('raw/applyhome/', ROOT);
const argv = process.argv.slice(2);
const ALL = argv.includes('--all');
const LIMIT = Number((argv.find(s => s.startsWith('--limit=')) || '').split('=')[1] || 0);
const UA = { 'User-Agent': 'Mozilla/5.0' };

// 상세페이지 HTML에서 모집공고문 PDF 링크 추출. 여러 첨부 중 '모집공고문' 라벨 우선, 없으면 첫 getAtchmnfl.
function parsePdf(html) {
  const links = [...html.matchAll(/<a\s+href="(https:\/\/static\.applyhome\.co\.kr\/[^"]*getAtchmnfl\.do[^"]*)"[^>]*>([^<]*)<\/a>/gi)]
    .map(m => ({ url: m[1].replace(/&amp;/g, '&'), label: m[2].trim() }));
  if (!links.length) return null;
  return (links.find(l => /모집공고문|공고문/.test(l.label)) || links[0]).url;
}

let dirs = readdirSync(DER, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
let ok = 0, skip = 0, miss = 0, already = 0, done = 0;
for (const no of dirs) {
  if (LIMIT && done >= LIMIT) break;
  const rp = new URL(`${no}/requirements.json`, DER);
  if (!existsSync(rp)) continue;
  const r = JSON.parse(readFileSync(rp, 'utf8'));
  if (!ALL && r.원문링크?.공고문PDF) { already++; continue; }
  const dp = new URL(`${no}/detail.json`, RAW);
  if (!existsSync(dp)) { skip++; continue; }                         // 로컬 raw 없으면 PBLANC_URL 불명 → 다음 collect 후
  const url = JSON.parse(readFileSync(dp, 'utf8')).PBLANC_URL;
  if (!url) { skip++; continue; }
  done++;
  try {
    const res = await fetch(url, { headers: UA });
    const pdf = parsePdf(await res.text());
    if (pdf) { r.원문링크 = { ...(r.원문링크 || {}), 공고문PDF: pdf }; writeFileSync(rp, JSON.stringify(r, null, 2)); ok++; }
    else { miss++; }
  } catch (e) { miss++; }
  await new Promise(r => setTimeout(r, 120));                        // 예의상 간격
}
console.log(`청약홈 공고문PDF 링크: 주입 ${ok} · 미발견 ${miss} · raw없음 ${skip} · 기존보유 ${already}`);
