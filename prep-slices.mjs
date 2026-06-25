// [DEAD/참고] 독립 슬라이서 — 현재 진입점 pipeline.mjs [2/6] 인라인 슬라이스로 대체됨(호출처 0).
//   extract-targets.json→slice-manifest.json 산출. 재활성화 시 pickPdf는 collect-util 캐논 공유.
// 추출(LLM) 전에 결정론적으로 미리 잘라둔다. 토큰 0.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pickPdf } from './collect-util.mjs';

const ROOT = new URL('./data/', import.meta.url);
const targets = JSON.parse(readFileSync(new URL('extract-targets.json', ROOT), 'utf8'));

const slicer = new URL('slice-notice.mjs', import.meta.url).pathname;
let ok = 0, miss = [], small = [];
const manifest = [];
for (const t of targets) {
  const fdir = new URL(`raw/lh/${t.panId}/files/`, ROOT);
  const pdfName = pickPdf(fdir, t.fileid);
  if (!pdfName) { miss.push(t.panId); continue; }
  const pdfPath = decodeURIComponent(new URL(pdfName, fdir).pathname); // 한글 경로 → 실제 fs 경로
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
