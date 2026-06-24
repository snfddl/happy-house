// 레버 A — 공고문 보일러플레이트 슬라이서 (결정론적, fail-safe=보존)
// 유형공통 설명문(신청방법·제출서류·산정방법·유의사항·시공·편의시설)만 제거하고
// 이 공고 고유 요건(자격·선정/배점·임대조건·소득자산 '기준')은 남긴다.
// 못 알아보는 섹션은 무조건 남긴다(보존 우선).
//
// 사용:
//   node slice-notice.mjs <file.pdf>            → 슬라이스된 텍스트 stdout
//   node slice-notice.mjs <file.pdf> --report   → 보존/제거 섹션 + 절감률 표시(stderr)
//   pdftotext -layout x.pdf - | node slice-notice.mjs --stdin
import { execFileSync } from 'node:child_process';

// ── 제거 대상 ──────────────────────────────────────────────
// 최상위 섹션(번호.) 제목이 순수 보일러플레이트인 경우 통째 제거
const DROP_TOP = /신청\s*서류|제출\s*서류|유의\s*사항|시행자|시공\s*업체|시공사|편의\s*시설|개인정보|행정정보\s*공동이용|문의처|안내문/;
// 보존 섹션 내부의 ■/▣/○ 하위블록 중 절차·방법 설명문만 제거
const DROP_SUB = /산정\s*방법|청약\s*방법|인터넷\s*[(（]?\s*PC|현장\s*청약|서류\s*제출\s*(대상|방법)|제출\s*방법|접수\s*방법|유의\s*사항/;
// 버린 섹션에 '요건표'가 들어있었는지 탐지 — 진짜 위험신호.
// (단순 키워드 등장이 아니라, 기준값 표 패턴: 항목 + 수치/이하/만원/점/%)
const RISK_LINE = /(소득|자산|배점|가점|임대료|보증금|전용면적|공급호수|중위소득|도시근로자).{0,30}(이하|초과|만\s?원|[0-9],?[0-9]{3}|[0-9]+\s?점|[0-9]+\s?%|순위)/;

function splitTopSections(text) {
  const lines = text.split('\n');
  const heads = []; // {idx, num, title}
  let expect = 1;
  for (let i = 0; i < lines.length; i++) {
    // 목차(TOC) 줄 제외: "1. 공급일정 …… 4" 처럼 점선 리더+페이지번호로 끝나는 줄은 진짜 섹션헤더가 아님.
    //   (SH 등 목차 있는 공고에서 목차를 섹션으로 오인 → 마지막 항목 섹션이 본문 전체를 삼키고 통째 제거되던 버그)
    if (/[.·…ㆍ‥]{3,}\s*\d{1,3}\s*$/.test(lines[i])) continue;
    const m = lines[i].match(/^\s{0,5}(\d{1,2})\.\s*([가-힣].{0,40})/);
    if (!m) continue;
    const num = +m[1];
    // 순차(expect)인 번호만 최상위 섹션으로 인정 → "5.실종선고" 같은 본문 리스트 오인 방지
    if (num === expect) { heads.push({ idx: i, num, title: m[2].trim() }); expect++; }
  }
  const sections = [];
  // 첫 섹션 앞부분(표지+주요사항 요약+재계약기준)은 preamble로 보존
  if (!heads.length) return [{ title: '(전체)', body: text, keep: true }];
  sections.push({ title: '(머리·요약)', lines: lines.slice(0, heads[0].idx), keep: true });
  for (let h = 0; h < heads.length; h++) {
    const start = heads[h].idx;
    const end = h + 1 < heads.length ? heads[h + 1].idx : lines.length;
    sections.push({ title: heads[h].title, num: heads[h].num, lines: lines.slice(start, end), keep: !DROP_TOP.test(heads[h].title) });
  }
  return sections;
}

// 보존 섹션 안에서 ■/▣/○/◦ 하위 보일러플레이트 블록 제거
function stripSubBlocks(secLines) {
  const out = [];
  let dropping = false;
  for (const ln of secLines) {
    const isHead = /^\s*[■▣◆●○◦▶]/.test(ln);
    if (isHead) dropping = DROP_SUB.test(ln);
    if (!dropping) out.push(ln);
  }
  return out;
}

function slice(text) {
  const sections = splitTopSections(text);
  const report = [];
  const kept = [];
  let risk = 0;
  for (const s of sections) {
    const raw = (s.lines || [s.body]).join('\n');
    if (!s.keep) {
      const hits = raw.split('\n').filter(l => RISK_LINE.test(l));
      risk += hits.length;
      // fail-safe: 버리려던 섹션에 요건표(소득/자산/배점 등 기준값)가 있으면 제거하지 않고 보존.
      //   보일러플레이트 제거는 토큰절감 최적화일 뿐 — 요건 손실 위험이 있으면 보존이 절대우선(CLAUDE.md §3).
      if (hits.length) {
        report.push({ title: s.title, action: `보존(제거대상이나 요건표 ${hits.length}행 → fail-safe 보존)`, chars: raw.length, sample: hits[0] });
        kept.push(s.lines ? stripSubBlocks(s.lines).join('\n') : raw);
        continue;
      }
      report.push({ title: s.title, action: '제거', chars: raw.length });
      continue;
    }
    const body = s.lines ? stripSubBlocks(s.lines).join('\n') : raw;
    const droppedSub = raw.length - body.length;
    report.push({ title: s.title, action: droppedSub > 50 ? `보존(하위 ${droppedSub}자 제거)` : '보존', chars: body.length });
    kept.push(body);
  }
  return { text: kept.join('\n'), report, orig: text.length, risk };
}

// ── 실행 ───────────────────────────────────────────────────
const args = process.argv.slice(2);
const wantReport = args.includes('--report');
const useStdin = args.includes('--stdin');
const file = args.find(a => !a.startsWith('--'));

let text;
if (useStdin) {
  text = await new Promise(r => { let b = ''; process.stdin.on('data', d => b += d); process.stdin.on('end', () => r(b)); });
} else if (file) {
  text = execFileSync('pdftotext', ['-layout', file, '-'], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
} else {
  console.error('사용: node slice-notice.mjs <file.pdf> [--report]'); process.exit(1);
}

const { text: out, report, orig, risk } = slice(text);
if (wantReport) {
  console.error('섹션\t동작\t글자수');
  for (const r of report) console.error(`${r.title}\t${r.action}\t${r.chars}${r.sample ? '\n      ↳ ' + r.sample.trim().slice(0, 90) : ''}`);
  const pct = ((1 - out.length / orig) * 100).toFixed(1);
  console.error(`\n원본 ${orig}자 → 슬라이스 ${out.length}자  (▼${pct}% 절감)`);
  console.error(risk ? `⚠️ 버린 섹션에 요건표 의심 ${risk}행 — 위 ↳ 확인 필요` : `✅ 버린 섹션에 요건표 없음(안전)`);
}
process.stdout.write(out);
