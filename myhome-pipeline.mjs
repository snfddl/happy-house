// myhome-pipeline.mjs — 메타만 주는 소스(마이홈/SH/GH)의 공고문 PDF에서 소득·자산·계층 요건을 추출해 requirements.json 보강.
//   각 수집기가 만든 requirements.json(envelope+메타)에 PDF 추출분을 MERGE. --source 로 소스(raw/derived 디렉터리) 선택.
//   단계: 슬라이스(slice-notice) → 요건추출(claude -p Sonnet, 신규만) → 계층 정규화(normalize-requirements)
//   결정론(슬라이스·정규화)은 스크립트, 비결정론(추출)만 Claude Code 헤드리스 — 외부 LLM API 0. (pipeline.mjs의 비-LH판)
// 사용: node myhome-pipeline.mjs [--source=myhome|sh|gh] [--force] [--semi] [--conc=3]
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { validateFile, buildReport, printReport } from './validate-requirements.mjs';
import { statusOf, pickPdf } from './collect-util.mjs';

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

const V1_SCHEMA = readFileSync(new URL('schema-v1.jsonc', HERE), 'utf8');
const RULES = readFileSync(new URL('extract-rules.txt', HERE), 'utf8');

// 추출 프롬프트 — 기존 requirements(API envelope) 보존하고 PDF에서 자격요건만 채워 MERGE
function buildPrompt(slug, slicedPath, reqPath, meta) {
  return `당신은 한국 공공임대주택 공고문에서 입주 요건을 구조화 추출하는 전문가입니다. 외부 API 없이 주어진 텍스트만 근거로 합니다.

[대상] ${meta.공급기관} ${meta.유형} 공고 (panId ${meta.panId})

[작업]
1) Read 로 기존 requirements.json 을 읽으세요(마이홈 API 메타가 채워져 있음 — 이 envelope는 보존):
   ${reqPath}
2) Read 로 공고문 본문(보일러플레이트 제거됨)을 읽으세요:
   ${slicedPath}
3) 본문에서 자격요건을 추출해 기존 객체에 MERGE 하세요. 아래는 **PDF에서 채울 필드**(나머지 envelope·임대료·원문링크·panId/source/상품군은 그대로 보존):
   - 자격요건.무주택, 자격요건.소득기준{종류,기본퍼센트,가구원수별,가산규칙,비고},
     자격요건.자산상한(원,정수|"없음"|"공고문미기재"), 자격요건.자동차상한, 자격요건.청약요건,
     자격요건.대상계층[], 자격요건.계층별{계층:{소득,자산,연령,무주택,...}}
   - 순위규칙[](있으면), 배점표[](있으면), 선정방식(추첨|배점|순차|혼합), 선정방식상세
   - **일정(기존 값이 null/비어있을 때만 채움. 이미 값 있으면 보존)**: 접수시작·마감일(YYYY-MM-DD), 당첨자발표(YYYY-MM-DD), 공고일.
     접수기간이 "2026. 7. 6. ~ 7. 8." 처럼 여러 회차/형식이면 가장 늦은 마감일을 마감일로. 상태(접수중/접수예정 등)는 쓰지 말 것 — 날짜만 채우면 코드가 계산함.
   - _검증노트[]: 본문에서 확정 못한 항목 기록(있던 노트는 갱신)
4) Write 로 같은 경로에 저장(유효한 단일 JSON, 기존 덮어쓰기). envelope 필드 누락 금지.
5) 저장 후 한 줄 요약(소득기준 종류·계층 수·자산상한)만 반환.

[정규 스키마 v1 — 자격요건/순위/배점 형태 참고]
${V1_SCHEMA}

${RULES}`;
}

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

// ── 2. 요건추출 (claude -p Sonnet, 신규만) ────────────────────
function extractOne(it) {
  return new Promise(resolve => {
    const ps = spawn('claude', ['-p', buildPrompt(it.slug, it.slicedPath, it.reqPath, it.meta), '--model', 'sonnet', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read', 'Write'], { cwd: p(HERE), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; ps.stdout.on('data', d => out += d); ps.stderr.on('data', () => {});
    ps.on('close', () => {
      let ok = false; try { const r = JSON.parse(readFileSync(it.reqPath, 'utf8')); ok = !!r.자격요건; if (ok) { r.__pdf추출 = true; r.상태 = statusOf(r.접수시작, r.마감일, r.상태); writeFileSync(it.reqPath, JSON.stringify(r, null, 2)); } } catch {}
      log(`  ${ok ? '✅' : '❌'} ${it.meta.공급기관}:${it.slug} ${out.trim().slice(0, 70)}`);
      resolve({ ...it, ok });
    });
  });
}
async function poolRun(items, n, fn) { const res = []; let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; res[k] = await fn(items[k]); } })); return res; }
log(`[2/4] 요건추출 — claude -p (Sonnet, 동시성 ${CONC})`);
await poolRun(targets, CONC, extractOne);

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
