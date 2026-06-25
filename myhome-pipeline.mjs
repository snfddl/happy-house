// myhome-pipeline.mjs — 메타만 주는 소스(마이홈/SH/GH)의 공고문 PDF에서 소득·자산·계층 요건을 추출해 requirements.json 보강.
//   각 수집기가 만든 requirements.json(envelope+메타)에 PDF 추출분을 MERGE. --source 로 소스(raw/derived 디렉터리) 선택.
//   단계: 슬라이스(slice-notice) → 요건추출(claude -p Sonnet, 신규만) → 계층 정규화(normalize-requirements)
//   결정론(슬라이스·정규화)은 스크립트, 비결정론(추출)만 Claude Code 헤드리스 — 외부 LLM API 0. (pipeline.mjs의 비-LH판)
// 사용: node myhome-pipeline.mjs [--source=myhome|sh|gh] [--force] [--semi] [--conc=3]
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { validateFile, buildReport, printReport } from './validate-requirements.mjs';
import { pickPdf } from './collect-util.mjs';
import { runHeadless } from './extract-core.mjs';

const HERE = new URL('./', import.meta.url);
const ROOT = new URL('./data/', import.meta.url);
const argv = process.argv.slice(2);
const SOURCE = (argv.find(a => a.startsWith('--source=')) || '--source=myhome').split('=')[1];
const RAW = new URL(`raw/${SOURCE}/`, ROOT);
const DERIVED = new URL(`derived/${SOURCE}/`, ROOT);
const p = u => decodeURIComponent(u.pathname);
const FORCE = argv.includes('--force');
const SEMI = argv.includes('--semi');
const CONC = Math.max(1, parseInt((argv.find(a => a.startsWith('--conc=')) || '--conc=3').split('=')[1], 10));
const log = (...a) => console.log(...a);
// 추출된 접수시작/마감일로 상태 결정론 재계산은 collect-util의 캐논 statusOf 사용(날짜 없으면 prev 유지).

// ── 1. 슬라이스 ───────────────────────────────────────────────
const slicer = p(new URL('slice-notice.mjs', HERE));
let slugs = []; try { slugs = readdirSync(RAW); } catch { log(`raw/${SOURCE} 없음 — ${SOURCE}-collect 먼저`); process.exit(0); }
const targets = [];
for (const slug of slugs) {
  const reqPath = new URL(`${slug}/requirements.json`, DERIVED);
  const metaPath = new URL(`${slug}/meta.json`, RAW);
  if (!existsSync(metaPath)) continue;
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  // 이미 PDF추출됨(자산상한이 공고문미기재가 아니거나 계층별 있음) + !FORCE → 스킵
  let done = false;
  if (existsSync(reqPath) && !FORCE) {
    const r = JSON.parse(readFileSync(reqPath, 'utf8'));
    done = r.__pdf추출 === true;
  }
  if (done) continue;
  const pdf = pickPdf(new URL(`${slug}/files/`, RAW));
  if (!pdf) { log(`  ⚠️ ${slug} 공고문 PDF 없음 — API메타만 유지`); continue; }
  const slicedPath = p(new URL(`${slug}/notice_sliced.txt`, DERIVED));
  try {
    const sliced = execFileSync('node', [slicer, p(new URL(`${slug}/files/${pdf}`, RAW))], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
    writeFileSync(slicedPath, sliced);
    targets.push({ slug, meta, slicedPath, reqPath: p(reqPath) });
  } catch (e) { log(`  ⚠️ ${slug} 슬라이스 실패: ${e.message}`); }
}
log(`[1/4] 슬라이스 ${targets.length}건`);
if (!targets.length) { log('추출 대상 없음.'); process.exit(0); }
if (SEMI) { log('[--semi] 추출 직전까지. 슬라이스 완료.'); process.exit(0); }

// ── 2. 요건추출 (extract-core 헤드리스, mode=merge, 신규만) ────
log(`[2/4] 요건추출 — claude -p 헤드리스 (Sonnet, 동시성 ${CONC})`);
const queue = targets.map(it => ({
  mode: 'merge', slug: it.slug, meta: it.meta,
  slicedPath: it.slicedPath, reqPath: it.reqPath,
  header: { 공급기관: it.meta.공급기관, 유형: it.meta.유형, panId: it.meta.panId },
  label: `${it.meta.공급기관}:${it.slug}`,
}));
await runHeadless(queue, CONC, log);

// ── 3. 계층 정규화 ────────────────────────────────────────────
//   추출(Sonnet)이 계층 키/필드를 자유형으로 뱉으면 매처(tierLimit/tierKeyFor)가 캐논 키로 못 찾아 자산/소득 게이트가 조용히 누락됨.
//   normalize-requirements.mjs를 --source로 같은 디렉터리에 적용(결정론·멱등). LH(pipeline.mjs)와 동일 패턴.
log('[3/4] 계층별 메타 정규화 — normalize-requirements.mjs');
const normalizer = p(new URL('normalize-requirements.mjs', HERE));
try {
  const out = execFileSync('node', [normalizer, `--source=${SOURCE}`, ...targets.map(t => t.slug)], { cwd: p(HERE) }).toString('utf8');
  process.stdout.write(out);
} catch (e) { log(`  ⚠️ 정규화 실패: ${e.message}`); }

// ── 4. 검증 게이트 (LH pipeline과 공통 모듈) ──────────────────
log('[4/4] 검증 게이트 — validate-requirements 공통');
const verdicts = targets.map(it => validateFile(
  new URL(`${it.slug}/requirements.json`, DERIVED), { panId: it.meta.panId, type: it.meta.유형 }));
const report = buildReport(verdicts, { 신규: targets.length });
writeFileSync(new URL(`${SOURCE}-report.json`, ROOT), JSON.stringify(report, null, 2));
printReport(report, log);
log(`\n리포트: data/${SOURCE}-report.json · build-site.mjs 재실행으로 사이트 반영.`);
if (report.실패.length) process.exitCode = 1;
