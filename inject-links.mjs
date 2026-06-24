// requirements.json 에 '원문링크' 블록을 결정론적으로 주입 (meta.json 기반, LLM 미사용)
//  - 상세페이지: 청약플러스 원문 보기 (dtlUrl)
//  - 공고문PDF : lhFile.do?fileid (공고문 PDF 직접 다운로드)
//  - 로컬PDF  : data/raw 보관 원본 경로
//  - 첨부     : 팸플릿 제외 전체 첨부 다운로드 링크
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';

const ROOT = new URL('./data/', import.meta.url);
const BASE = 'https://apply.lh.or.kr/lhapply';
const dl = fileid => `${BASE}/lhFile.do?fileid=${fileid}`;

const derivedDir = new URL('derived/lh/', ROOT);
const panIds = readdirSync(derivedDir).filter(n => existsSync(new URL(`${n}/requirements.json`, derivedDir)));

let ok = 0, skip = [];
for (const panId of panIds) {
  const reqPath = new URL(`${panId}/requirements.json`, derivedDir);
  const metaPath = new URL(`raw/lh/${panId}/meta.json`, ROOT);
  if (!existsSync(metaPath)) { skip.push(panId + '(meta없음)'); continue; }
  let req, meta;
  try { req = JSON.parse(readFileSync(reqPath, 'utf8')); meta = JSON.parse(readFileSync(metaPath, 'utf8')); }
  catch (e) { skip.push(panId + '(파싱실패)'); continue; }

  const files = meta.files || [];
  const realFiles = files.filter(f => !f.skipped); // 팸플릿 제외
  // 공고문 PDF: 이름에 '공고문' 포함 .pdf 우선, 없으면 첫 .pdf
  const noticePdf = realFiles.find(f => f.ext === '.pdf' && /공고문/.test(f.name))
    || realFiles.find(f => f.ext === '.pdf' && /모집/.test(f.name))
    || realFiles.find(f => f.ext === '.pdf');
  // 로컬 원본 경로
  const fdir = new URL(`raw/lh/${panId}/files/`, ROOT);
  let localPdf = null;
  if (noticePdf) {
    try { localPdf = readdirSync(fdir).find(n => n.startsWith(`${noticePdf.fileid}__`)); } catch {}
    if (localPdf) localPdf = decodeURIComponent(new URL(`raw/lh/${panId}/files/${localPdf}`, ROOT).pathname);
  }

  req.원문링크 = {
    상세페이지: meta.dtlUrl || `${BASE}/apply/wt/wrtanc/selectWrtancInfo.do?panId=${panId}`,
    공고문PDF: noticePdf ? dl(noticePdf.fileid) : null,
    로컬PDF: localPdf,
    첨부: realFiles.map(f => ({ name: f.name, ext: f.ext, 다운로드: dl(f.fileid) })),
  };
  writeFileSync(reqPath, JSON.stringify(req, null, 2));
  ok++;
}
console.log(`원문링크 주입: ${ok}/${panIds.length}`);
if (skip.length) console.log(`건너뜀(${skip.length}): ${skip.join(', ')}`);
