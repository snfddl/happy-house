// 101개 추출 타깃의 공고문 PDF → pdftotext → slice → data/derived/lh/<panId>/notice_sliced.txt
// 추출(LLM) 전에 결정론적으로 미리 잘라둔다. 토큰 0.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('./data/', import.meta.url);
const targets = JSON.parse(readFileSync(new URL('extract-targets.json', ROOT), 'utf8'));

// 공고문 PDF 고르기: fileid 일치 > 이름에 '공고문' 포함 .pdf > 가장 큰 .pdf
function pickPdf(panId, fileid) {
  const fdir = new URL(`raw/lh/${panId}/files/`, ROOT);
  let names;
  try { names = readdirSync(fdir); } catch { return null; }
  const pdfs = names.filter(n => n.toLowerCase().endsWith('.pdf'));
  if (!pdfs.length) return null;
  const byId = pdfs.find(n => n.startsWith(`${fileid}__`));
  if (byId) return new URL(byId, fdir);
  const byName = pdfs.find(n => /공고문/.test(n)) || pdfs.find(n => /모집/.test(n));
  if (byName) return new URL(byName, fdir);
  // 가장 큰 파일
  let best = pdfs[0], bestSz = 0;
  for (const n of pdfs) { const sz = readFileSync(new URL(n, fdir)).length; if (sz > bestSz) { bestSz = sz; best = n; } }
  return new URL(best, fdir);
}

const slicer = new URL('slice-notice.mjs', import.meta.url).pathname;
let ok = 0, miss = [], small = [];
const manifest = [];
for (const t of targets) {
  const pdf = pickPdf(t.panId, t.fileid);
  if (!pdf) { miss.push(t.panId); continue; }
  const pdfPath = decodeURIComponent(pdf.pathname); // 한글 경로 → 실제 fs 경로
  let sliced;
  try {
    sliced = execFileSync('node', [slicer, pdfPath], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  } catch (e) { miss.push(t.panId + '(slice실패)'); continue; }
  const outDir = new URL(`derived/lh/${t.panId}/`, ROOT);
  mkdirSync(outDir, { recursive: true });
  const outPath = new URL('notice_sliced.txt', outDir);
  writeFileSync(outPath, sliced);
  if (sliced.length < 1500) small.push(`${t.panId}(${sliced.length}자)`);
  manifest.push({ panId: t.panId, type: t.type, region: t.region, 상태: t.상태, 마감일: t.마감일,
    title: t.title, pdf: pdfPath, slicedPath: decodeURIComponent(outPath.pathname), chars: sliced.length });
  ok++;
}
writeFileSync(new URL('slice-manifest.json', ROOT), JSON.stringify(manifest, null, 2));
console.log(`슬라이스 생성: ${ok}/${targets.length}`);
if (miss.length) console.log(`⚠️ 누락(${miss.length}): ${miss.join(', ')}`);
if (small.length) console.log(`⚠️ 비정상적으로 짧음(${small.length}): ${small.join(', ')}`);
const tot = manifest.reduce((s, m) => s + m.chars, 0);
console.log(`총 슬라이스 ${tot}자 (≈${Math.round(tot / 2)} 토큰), 평균 ${Math.round(tot / ok)}자/건`);
