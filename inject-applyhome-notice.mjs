// 청약홈 공고문 PDF '단지 주요정보' 표 → 전매제한·실거주의무·재당첨제한 결정론 추출·주입
// 사용: node inject-applyhome-notice.mjs [--dry]
//
// 배경: applyhome-derive(API 결정론)는 전매/실거주를 채울 수 없어(API 미제공) null+_갭으로 둠.
//       공고문 PDF 상단 '단지 주요정보' 표에 [전매제한·거주의무기간·(재당첨제한)] 칸이 있어
//       헤더 토큰 컬럼 밴드로 데이터 블록을 수집·정규화한다(LLM 0·결정론·멱등).
// 역할분담(설계): PDF=공고 사실(전매/실거주/재당첨), AI 참고분석=외부맥락(시세/경쟁률)만.
// raw notice.pdf는 gitignore라 로컬에만 존재 → 없는 건 fail-safe로 건너뜀(null 유지).
//   CI는 PDF 없어 채우지 않음(기존 inject-applyhome-pdf --links-only 한계와 동일). 로컬 /update에서 채워 커밋.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RAW = new URL('./data/raw/applyhome/', import.meta.url);
const DERIVED = new URL('./data/derived/applyhome/', import.meta.url);
const DRY = process.argv.includes('--dry');

// 셀 텍스트 → { 기간, 개월, 적용, 원문 } 정규화. "N년"/"N개월"/"없음"/"소유권이전등기시까지"
function parseCell(s) {
  if (s == null) return null;
  const t = s.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (/없\s*음|해당\s*없음|^-+$/.test(t)) return { 기간: '없음', 개월: 0, 적용: false, 원문: t };
  const y = t.match(/(\d+)\s*년/);
  const mo = t.match(/(\d+)\s*개월/);
  if (y) { const n = +y[1]; const mm = mo ? +mo[1] : 0; return { 기간: `${n}년${mm ? ` ${mm}개월` : ''}`, 개월: n * 12 + mm, 적용: true, 원문: t }; }
  if (mo) { const n = +mo[1]; return { 기간: `${n}개월`, 개월: n, 적용: true, 원문: t }; }
  if (/소유권\s*이전\s*등기|등기\s*시까지/.test(t)) return { 기간: '소유권이전등기시까지', 개월: null, 적용: true, 원문: t };
  return { 기간: t, 개월: null, 적용: null, 원문: t };  // 미상 — 보존(fail-safe)
}

// 한 줄 → [{text, col}] (2+ 공백 경계로 셀 분리, 시작 컬럼 보존)
function cells(line) {
  const out = []; let i = 0;
  for (const p of line.split(/(\s{2,})/)) {
    if (/^\s{2,}$/.test(p) || p === '') { i += p.length; continue; }
    out.push({ text: p.trim(), col: i + (p.length - p.trimStart().length) }); i += p.length;
  }
  return out;
}
const center = c => c.col + c.text.length / 2;

// '단지 주요정보' 표 추출 — 헤더에 전매제한·거주의무 둘 다 있는 라인 앵커
function extractTable(txt) {
  const lines = txt.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/전매제한/.test(lines[i]) || !/거주의무/.test(lines[i])) continue;
    const hdr = cells(lines[i]).sort((a, b) => a.col - b.col);
    if (hdr.length < 3) continue;
    const hc = hdr.map(center);
    const bounds = hc.map((c, k) => k === 0 ? -Infinity : (hc[k - 1] + c) / 2).concat(Infinity);
    const colOf = cx => { for (let k = 0; k < hc.length; k++) if (cx >= bounds[k] && cx < bounds[k + 1]) return k; return hc.length - 1; };

    // 데이터 블록: 헤더 다음 비공백 라인들(긴 셀이 위/아래로 줄바꿈 분산되므로 블록 전체 수집).
    // 데이터 시작 후 첫 공백라인 또는 섹션마커서 종료.
    const win = []; let started = false;
    for (let k = i + 1; k < lines.length && k < i + 9; k++) {
      if (!lines[k].trim()) { if (started) break; continue; }
      if (started && /^\s*[■※□☞]|입주자\s*모집|주택형|모집\s*세대|^\s*\d+\s*[.)]\s/.test(lines[k])) break;
      win.push(lines[k]); started = true;
    }
    if (!win.length) return null;
    const buckets = hdr.map(() => []);
    for (const ln of win) for (const seg of cells(ln)) buckets[colOf(center(seg))].push(seg.text);
    const colText = buckets.map(b => b.join(' '));
    const pick = name => { const k = hdr.findIndex(h => h.text.replace(/\s/g, '').includes(name)); return k < 0 ? null : colText[k]; };
    return { 전매: parseCell(pick('전매제한')), 거주: parseCell(pick('거주의무')), 재당첨: parseCell(pick('재당첨제한')), 주택유형: pick('주택유형') };
  }
  return null;
}

// 건물유형 1차: API detail.json 직제공분(+공고명 보조). PDF 없이 결정(CI·복원 경로). 무순위/임의는 대개 null→PDF로.
function bldgFromApi(d) {
  const x = d.HOUSE_DTL_SECD_NM;
  if (x === '오피스텔') return '오피스텔';
  if (x === '도시형생활주택') return '도시형생활주택';
  if (x === '민영' || x === '국민' || d.HOUSE_SECD_NM === 'APT') return '아파트';
  const nm = d.HOUSE_NM || '';
  if (/오피스텔/.test(nm)) return '오피스텔';
  if (/생활숙박|생숙/.test(nm)) return '생활숙박시설';
  if (/공공지원민간임대/.test(d.HOUSE_SECD_NM || '')) return '아파트'; // 청약홈 임대=공공지원민간임대 APT(현 8건 전부 아파트)
  if (/아파트|AP\s*\d|[A-Z]\d+\s*BL|블록/i.test(nm)) return '아파트';
  return null; // 무순위/임의(공급방식) — 공고문 표/키워드로
}

// 건물유형 2차(무순위/임의 등) — 공고문 표 주택유형 우선, 없으면 PDF 우세 키워드(아파트가 압도적이라 안전)
function bldgFromNotice(houseType, txt) {
  const ht = houseType || '';
  if (/오피스텔/.test(ht)) return '오피스텔';
  if (/도시형/.test(ht)) return '도시형생활주택';
  if (/생활숙박|생숙/.test(ht)) return '생활숙박시설';
  if (/민영|국민|아파트|주택/.test(ht)) return '아파트';
  const c = {};
  for (const w of (txt.match(/오피스텔|생활숙박|도시형생활주택|아파트/g) || [])) c[w] = (c[w] || 0) + 1;
  const top = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
  return top ? (top[0] === '생활숙박' ? '생활숙박시설' : top[0]) : null;  // 키워드0 → 미상(보존)
}

// ── 실행 ───────────────────────────────────────────────────
let dirs = [];
try { dirs = readdirSync(DERIVED, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); }
catch { console.error('❌ data/derived/applyhome 없음 — 먼저 node applyhome-derive.mjs'); process.exit(1); }

let filled = 0, bldg = 0, noPdf = 0, noTable = 0;
for (const no of dirs) {
  const reqp = new URL(`${no}/requirements.json`, DERIVED);
  const detailp = new URL(`${no}/detail.json`, RAW);
  if (!existsSync(reqp)) continue;
  const req = JSON.parse(readFileSync(reqp, 'utf8'));
  const detail = existsSync(detailp) ? JSON.parse(readFileSync(detailp, 'utf8')) : null;
  let changed = false;

  // 건물유형 1차: API(detail.json). PDF 없이 결정 — 임대(공공지원민간임대=아파트) 포함 거의 전건. 이미 있으면 멱등 보존.
  if (!req.건물유형 && detail) { const b = bldgFromApi(detail); if (b) { req.건물유형 = b; bldg++; changed = true; } }

  // 전매/실거주/재당첨 + 건물유형 2차(무순위/임의)는 공고문 PDF가 있을 때만(분양 한정).
  const pdf = new URL(`${no}/notice.pdf`, RAW);
  if (req.상품군 === '분양' && existsSync(pdf)) {
    let txt = null;
    try { txt = execFileSync('pdftotext', ['-layout', fileURLToPath(pdf), '-'], { encoding: 'utf8', maxBuffer: 1e8, stdio: ['pipe', 'pipe', 'ignore'] }); } catch { txt = null; }
    if (txt) {
      const t = extractTable(txt);
      if (t && (t.전매 || t.거주)) {
        req.전매제한 = t.전매 ? { ...t.전매, 출처: '공고문표' } : req.전매제한;
        req.실거주의무 = t.거주 ? { ...t.거주, 출처: '공고문표' } : req.실거주의무;
        if (t.재당첨) req.재당첨제한 = { ...t.재당첨, 출처: '공고문표' };
        // _갭에서 채워진 항목 제거(헤지 해제). 멱등.
        const drop = new Set(['전매제한', '실거주의무', ...(t.재당첨 ? ['재당첨제한'] : [])]);
        if (Array.isArray(req._갭)) { req._갭 = req._갭.filter(g => !drop.has(g)); if (!req._갭.length) delete req._갭; }
        filled++; changed = true;
      } else noTable++; // 표 없음(오피스텔/보류지 등) — 전매/거주 null 유지
      // 건물유형 2차: API서 못 정한 무순위/임의 — 표 주택유형/키워드
      if (!req.건물유형) { const b = bldgFromNotice(t?.주택유형, txt); if (b) { req.건물유형 = b; bldg++; changed = true; } }
    } else noPdf++;
  } else if (req.상품군 === '분양') noPdf++; // raw PDF 없음(CI/미다운로드) — 전매/거주 null 유지(건물유형은 API서 처리됨)

  if (changed && !DRY) writeFileSync(reqp, JSON.stringify(req, null, 2));
}
console.log(`청약홈 공고문 주입${DRY ? '(dry)' : ''} — 전매/거주 채움 ${filled} · 건물유형 보강 ${bldg} · PDF없음 ${noPdf} · 표없음 ${noTable}(오피스텔/보류지)`);
console.log('→ requirements.json : 전매제한·실거주의무(+재당첨제한){기간·개월·적용·원문·출처} · 건물유형(아파트/오피스텔/도시형생활주택/생활숙박시설)');
