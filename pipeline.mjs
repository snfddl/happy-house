// pipeline.mjs — 신규 LH 공고 end-to-end 자동 처리 (완전자동 + 검증 게이트)
//
// 사용:
//   node pipeline.mjs                 전국×전유형 수집 → 신규만 추출까지 완전자동
//   node pipeline.mjs 11 41           서울·경기만 수집
//   node pipeline.mjs --types=13/26   매입임대만
//   node pipeline.mjs --skip-collect  수집 생략(이미 raw 있을 때 재처리)
//   node pipeline.mjs --semi          요건추출(헤드리스) 직전까지만 — wf-args.json 만들고 멈춤
//   node pipeline.mjs --force         requirements.json 있어도 재추출(정정공고 등)
//   node pipeline.mjs --conc=3        헤드리스 추출 동시 실행 수(기본 3)
//
// 단계: 0 수집 → 1 타깃선정 → 2 신규판별+슬라이스 → 3 요건추출(claude -p, 신규만)
//       → 4 xlsx파싱 → 5 링크주입 → 6 검증게이트(이상건 needs-review로 격리, 사용자 유도)
// 원칙: 결정론 단계(0~2,4~6)는 스크립트, 비결정론 추출(3)만 Claude Code 헤드리스 — 외부 LLM API 0.
//       증분: requirements.json 이미 있으면 추출 스킵(108건 통째 재처리 안 함).
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { validateFile, buildReport, printReport } from './validate-requirements.mjs';
import { pickPdf, pool } from './collect-util.mjs';

const HERE = new URL('./', import.meta.url);
const ROOT = new URL('./data/', import.meta.url);
const RAW = new URL('raw/lh/', ROOT);
const DERIVED = new URL('derived/lh/', ROOT);
const p = u => decodeURIComponent(u.pathname);

const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const opt = (n, d) => { const a = argv.find(x => x.startsWith(`${n}=`)); return a ? a.split('=')[1] : d; };
const SEMI = flag('--semi');
const SKIP_COLLECT = flag('--skip-collect');
const FORCE = flag('--force');
const CONC = Math.max(1, parseInt(opt('--conc', '3'), 10));
const ONLY = (opt('--only', '') || '').split(',').filter(Boolean);  // 특정 panId(접미사 매칭)만 재처리
const collectArgs = argv.filter(a => !['--semi', '--skip-collect', '--force'].includes(a) && !a.startsWith('--conc=') && !a.startsWith('--only='));

const ACTIVE = new Set(['접수중', '공고중', '정정공고중']);
const log = (...a) => console.log(...a);
const hr = t => log(`\n${'━'.repeat(58)}\n${t}\n${'━'.repeat(58)}`);

// 사전요건 프리플라이트 — 외부 바이너리 부재 시 단계 도중 모호하게 실패하므로 미리 가시화(조건부 단계라 경고만, 중단 안 함).
const missingBins = ['pdftotext', 'claude', 'python3'].filter(b => {
  try { execFileSync('which', [b], { stdio: 'ignore' }); return false; } catch { return true; }
});
if (missingBins.length) log(`⚠️ 사전요건 누락: ${missingBins.join(', ')} — pdftotext(슬라이스)·claude(추출)·python3(xlsx파싱) 필요. 해당 단계가 실패할 수 있음.`);

// ── 0. 수집 ───────────────────────────────────────────────────
let collectFailed = false;
if (!SKIP_COLLECT) {
  hr('[0/6] 수집 — lh-collect.mjs');
  try {
    execFileSync('node', [p(new URL('lh-collect.mjs', HERE)), ...collectArgs],
      { stdio: 'inherit', cwd: p(HERE) });
  } catch (e) { collectFailed = true; log('⚠️ 수집 단계 오류(계속 진행, 신규 0건은 정상 아닐 수 있음):', e.message); }
} else log('[0/6] 수집 생략(--skip-collect)');

// ── 1. 타깃선정: 활성 + 빈유형 백필 ───────────────────────────
hr('[1/6] 타깃선정 — 접수중/공고중/정정 − 접수마감 (+빈유형 백필)');
const index = JSON.parse(readFileSync(new URL('index.json', ROOT), 'utf8'));
const all = Object.entries(index).filter(([, v]) => v.done).map(([panId, v]) => ({ panId, ...v }));

// 공고문 PDF fileid 추출(meta.json)
function noticeFileid(panId) {
  try {
    const meta = JSON.parse(readFileSync(new URL(`${panId}/meta.json`, RAW), 'utf8'));
    const real = (meta.files || []).filter(f => !f.skipped && f.ext === '.pdf');
    const pick = real.find(f => /공고문/.test(f.name)) || real.find(f => /모집/.test(f.name)) || real[0];
    return pick ? pick.fileid : null;
  } catch { return null; }
}

const active = all.filter(t => ACTIVE.has(t.상태));
const activeTypes = new Set(active.map(t => t.type));
// 백필: 활성 0건인 유형마다 가장 최근 접수마감 1건
const backfill = [];
const byType = {};
for (const t of all) (byType[t.type] ||= []).push(t);
for (const [type, list] of Object.entries(byType)) {
  if (activeTypes.has(type)) continue;
  const closed = list.filter(t => t.상태 === '접수마감')
    .sort((a, b) => String(b.마감일 || '').localeCompare(String(a.마감일 || '')));
  if (closed[0]) backfill.push(closed[0]);
}
let selected = [...active, ...backfill].map(t => ({
  panId: t.panId, type: t.type, region: t.region, 상태: t.상태, 마감일: t.마감일,
  fileid: noticeFileid(t.panId), title: t.title,
}));
if (ONLY.length) {
  // --only: index에 없을 수도 있으니(접수마감 등) all에서 직접 보강
  const pool = all.map(t => ({ panId: t.panId, type: t.type, region: t.region, 상태: t.상태, 마감일: t.마감일, fileid: noticeFileid(t.panId), title: t.title }));
  selected = pool.filter(t => ONLY.some(o => t.panId.endsWith(o)));
  log(`--only 지정: ${selected.length}건만 처리 (${selected.map(s => s.panId.slice(-4)).join(',')})`);
}
if (!ONLY.length) {
  writeFileSync(new URL('extract-targets.json', ROOT), JSON.stringify(selected, null, 2));
  log(`타깃 ${selected.length}건 (활성 ${active.length} + 백필 ${backfill.length})`);
}

// ── 2. 신규판별 + 슬라이스 ────────────────────────────────────
hr('[2/6] 신규판별 + 슬라이스');
const slicer = p(new URL('slice-notice.mjs', HERE));

const newTargets = [], skipped = [], noPdf = [];
for (const t of selected) {
  const reqPath = new URL(`${t.panId}/requirements.json`, DERIVED);
  if (!FORCE && existsSync(reqPath)) { skipped.push(t.panId); continue; }
  const pdfName = pickPdf(new URL(`${t.panId}/files/`, RAW), t.fileid);
  if (!pdfName) { noPdf.push({ panId: t.panId, type: t.type, 사유: 'PDF 없음(첨부 0 또는 비PDF) — 수동 확인', dtl: `https://apply.lh.or.kr/lhapply/apply/wt/wrtanc/selectWrtancInfo.do?panId=${t.panId}` }); continue; }
  const pdfPath = p(new URL(`${t.panId}/files/${pdfName}`, RAW));
  const outDir = new URL(`${t.panId}/`, DERIVED);
  mkdirSync(outDir, { recursive: true });
  const slicedPath = p(new URL('notice_sliced.txt', outDir));
  try {
    const sliced = execFileSync('node', [slicer, pdfPath], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
    writeFileSync(slicedPath, sliced);
    newTargets.push({ panId: t.panId, type: t.type, region: t.region, status: t.상태, due: t.마감일, sliced: slicedPath });
  } catch (e) { noPdf.push({ panId: t.panId, type: t.type, 사유: 'slice 실패 — 수동 확인', dtl: `https://apply.lh.or.kr/lhapply/apply/wt/wrtanc/selectWrtancInfo.do?panId=${t.panId}` }); }
}
writeFileSync(new URL('wf-args.json', ROOT), JSON.stringify(newTargets, null, 2));
log(`신규 ${newTargets.length}건 슬라이스 / 기존 스킵 ${skipped.length}건` + (noPdf.length ? ` / ⚠️ PDF없음·실패 ${noPdf.length}: ${noPdf.map(x => x.panId).join(', ')}` : ''));

if (!newTargets.length) { log('\n✅ 신규 추출 대상 없음. (xlsx/링크 갱신만 수행)'); }

// ── 3. 요건추출 (claude -p 헤드리스, 신규만) ──────────────────
const V1_SCHEMA = readFileSync(new URL('schema-v1.jsonc', HERE), 'utf8');
const RULES = readFileSync(new URL('extract-rules.txt', HERE), 'utf8');
function buildPrompt(it) {
  const reqPath = it.sliced.replace('notice_sliced.txt', 'requirements.json');
  return `당신은 한국 LH 임대주택 공고문에서 입주 요건을 구조화 추출하는 전문가입니다. 외부 API 없이 주어진 텍스트만 근거로 작업합니다.

[대상 공고]
- panId: ${it.panId}
- 유형: ${it.type}
- 지역(목록기준): ${it.region}
- 상태: ${it.status}
- 마감일(목록기준): ${it.due}

[작업 순서]
1) Read 도구로 다음 파일(보일러플레이트 제거된 공고문 본문)을 읽으세요:
   ${it.sliced}
2) 본문을 정독하고 아래 정규 스키마 v1로 요건을 추출하세요. panId/유형/상태/마감일은 위 값을 기본으로, 지역(시군구)/공고일/접수시작/일정/단지/공급형/자격요건/순위규칙/배점표는 본문에서 정확히 채웁니다. 표(소득·임대료·배점)는 행/열을 신중히 대응시켜 숫자를 옮기세요.
3) Write 도구로 다음 경로에 저장하세요(유효한 단일 JSON 객체, 기존 덮어쓰기):
   ${reqPath}
4) 저장 후 한 줄 요약(선정방식·공급형수·검증노트수)만 반환하세요.

[정규 스키마 v1]
${V1_SCHEMA}

${RULES}`;
}

function extractOne(it) {
  return new Promise(resolve => {
    const args = ['-p', buildPrompt(it), '--model', 'sonnet', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read', 'Write'];
    const ps = spawn('claude', args, { cwd: p(HERE), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    ps.stdout.on('data', d => out += d);
    ps.stderr.on('data', d => err += d);   // 실패 원인 추적용 — 성공 시 버림, 실패 시 표면화
    ps.on('close', code => {
      const ok = existsSync(it.sliced.replace('notice_sliced.txt', 'requirements.json'));
      log(`  ${ok ? '✅' : '❌'} ${it.type}:${it.panId.slice(-4)} ${out.trim().slice(0, 70)}`);
      if (!ok) log(`     ↳ exit ${code}${err.trim() ? ` · stderr: ${err.trim().slice(-200)}` : ' · stderr 없음(requirements.json 미생성)'}`);
      resolve({ ...it, ok: code === 0 && ok, err: ok ? '' : err.trim().slice(-500) });
    });
  });
}

let extracted = [];
if (SEMI) {
  hr('[3/6] 요건추출 — 생략(--semi)');
  log(`wf-args.json 준비됨(${newTargets.length}건). 추출은 Workflow(lh-extract-requirements) 또는 재실행(--auto)으로.`);
  process.exit(0);
} else if (newTargets.length) {
  hr(`[3/6] 요건추출 — claude -p 헤드리스 (Sonnet, 동시성 ${CONC})`);
  extracted = await pool(newTargets, CONC, extractOne);
  const extFailed = extracted.filter(e => !e.ok);
  if (extFailed.length) log(`⚠️ 추출 실패 ${extFailed.length}/${newTargets.length}건: ${extFailed.map(e => e.panId.slice(-4)).join(', ')} — 원인은 위 ↳ stderr 라인 참조(검증게이트가 격리).`);
}

// ── 3.5 계층별 메타 정규화 ─────────────────────────────────────
if (newTargets.length) {
  hr('[3.5] 계층별 메타 정규화 — normalize-requirements.mjs');
  try { execFileSync('node', [p(new URL('normalize-requirements.mjs', HERE)), ...newTargets.map(t => t.panId)], { stdio: 'inherit', cwd: p(HERE) }); }
  catch (e) { log('⚠️ 정규화 오류(계속 진행):', e.message); }
}

// ── 4. xlsx 파싱 ──────────────────────────────────────────────
hr('[4/6] xlsx 주택목록 파싱');
const xlsxTargets = newTargets.filter(t => {
  try { return readdirSync(new URL(`${t.panId}/files/`, RAW)).some(n => n.endsWith('.xlsx')); } catch { return false; }
}).map(t => t.panId);
if (xlsxTargets.length) {
  try { execFileSync('python3', [p(new URL('parse-housing-xlsx.py', HERE)), ...xlsxTargets], { stdio: 'inherit', cwd: p(HERE) }); }
  catch (e) { log('⚠️ xlsx 파싱 오류:', e.message); }
} else log('신규 中 xlsx 없음 — 생략');

// ── 5. 링크주입 ───────────────────────────────────────────────
hr('[5/6] 원문링크 주입 — inject-links.mjs');
try { execFileSync('node', [p(new URL('inject-links.mjs', HERE))], { stdio: 'inherit', cwd: p(HERE) }); }
catch (e) { log('⚠️ 링크주입 오류:', e.message); }

// ── 6. 검증 게이트 ────────────────────────────────────────────
hr('[6/6] 검증 게이트 — 이상건 격리 (validate-requirements 공통)');
const dtlOf = panId => `https://apply.lh.or.kr/lhapply/apply/wt/wrtanc/selectWrtancInfo.do?panId=${panId}`;
const verdicts = (newTargets.length ? newTargets : []).map(it => validateFile(
  new URL(`${it.panId}/requirements.json`, DERIVED),
  { panId: it.panId, type: it.type, dtl: dtlOf(it.panId), hasXlsx: xlsxTargets.includes(it.panId) },
));
// PDF없음/슬라이스실패도 검토필요로 surface(추출 자체 불가)
const report = buildReport(verdicts, { 신규: newTargets.length, extraReview: noPdf });
writeFileSync(new URL('pipeline-report.json', ROOT), JSON.stringify(report, null, 2));
printReport(report, log);
log(`\n리포트: data/pipeline-report.json`);
if (collectFailed) log('⚠️ 이번 실행은 [0/6] 수집이 실패 — 위 신규 건수는 수집 누락으로 과소집계일 수 있음(네트워크/키 확인 후 재실행 권장).');
if (report.실패.length) process.exitCode = 1;
