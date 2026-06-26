// process-all.mjs — 전 소스 통합 오케스트레이터(얇은 시퀀서).
//   신규 처리 절차가 소스마다 3갈래(LH=pipeline 6단계, applyhome=collect+derive, myhome/sh/gh=collect+myhome-pipeline)로
//   갈라져 있어 런북·CI가 LH만 따라가던 문제(AUDIT.md P1)를 해소. 각 소스의 기존 진입점을 순서대로 호출 + 마지막에 build-site.
//   결정론 단계만 오케스트레이션; LLM 추출(claude -p)은 각 하위 파이프라인이 로컬 수행(외부 LLM API 0 규칙 유지).
// 사용:
//   node process-all.mjs                   전 소스(collect→derive/extract→검증→build)
//   node process-all.mjs --source=sh,gh     특정 소스만(쉼표구분)
//   node process-all.mjs --skip-collect     수집 생략(이미 raw 있을 때 재처리)
//   node process-all.mjs --semi             추출 직전까지(하위 파이프라인에 --semi 전달, build 생략)
//   node process-all.mjs --no-build         build-site 생략
import { execFileSync } from 'node:child_process';

const HERE = new URL('./', import.meta.url);
const p = u => decodeURIComponent(new URL(u, HERE).pathname);
const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const opt = (n, d) => { const a = argv.find(x => x.startsWith(`${n}=`)); return a ? a.split('=')[1] : d; };
const SKIP_COLLECT = flag('--skip-collect');
const SEMI = flag('--semi');
const NO_BUILD = flag('--no-build') || SEMI;   // --semi는 추출 미완료 → 빌드 생략
const ALL = ['lh', 'applyhome', 'myhome', 'sh', 'gh'];
const sel = (opt('--source', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const SOURCES = sel.length ? ALL.filter(s => sel.includes(s)) : ALL;

const log = (...a) => console.log(...a);
const hr = t => log(`\n${'━'.repeat(60)}\n${t}\n${'━'.repeat(60)}`);
const collectArg = SKIP_COLLECT ? null : true;   // 수집 단계 포함 여부
const semiArg = SEMI ? ['--semi'] : [];

// 소스별 처리 단계(스크립트, 인자) — collect 단계는 SKIP_COLLECT면 생략.
function plan(src) {
  switch (src) {
    case 'lh':        return [['pipeline.mjs', ...(SKIP_COLLECT ? ['--skip-collect'] : []), ...semiArg]];  // pipeline=collect+추출+검증 일체
    case 'applyhome': return [...(collectArg ? [['applyhome-collect.mjs']] : []), ['applyhome-derive.mjs']]; // 결정론(LLM 없음) — --semi 무관
    case 'myhome':    return [...(collectArg ? [['myhome-collect.mjs']] : []), ['myhome-pipeline.mjs', '--source=myhome', ...semiArg]];
    case 'sh':        return [...(collectArg ? [['sh-collect.mjs']] : []), ['myhome-pipeline.mjs', '--source=sh', ...semiArg]];
    case 'gh':        return [...(collectArg ? [['gh-collect.mjs']] : []), ['myhome-pipeline.mjs', '--source=gh', ...semiArg]];
    default:          return [];
  }
}

const summary = [];
for (const src of SOURCES) {
  hr(`◆ ${src}`);
  let ok = true, note = '';
  for (const [script, ...args] of plan(src)) {
    log(`\n▶ node ${script} ${args.join(' ')}`);
    try { execFileSync('node', [p(script), ...args], { stdio: 'inherit', cwd: p('.') }); }
    catch (e) {
      // 한 소스/단계 실패가 나머지를 막지 않게 격리(수집 키 부재·네트워크 등). 종료코드 1(검증 fail)도 여기로.
      ok = false; note = `${script} 종료코드 ${e.status ?? '?'}`;
      log(`  ⚠️ ${src}:${script} 실패(계속): ${e.message.split('\n')[0]}`);
      break;
    }
  }
  summary.push({ src, ok, note });
}

// 빌드(전 소스 derived → site/index.html). 일부 소스 실패해도 성공분으로 빌드.
if (!NO_BUILD) {
  hr('◆ inject-applyhome-pdf (청약홈 공고문 PDF 링크)');
  try { execFileSync('node', [p('inject-applyhome-pdf.mjs'), '--links-only'], { stdio: 'inherit', cwd: p('.') }); }
  catch (e) { log(`  ⚠️ inject-applyhome-pdf 실패: ${e.message.split('\n')[0]}`); }
  hr('◆ inject-applyhome-notice (공고문 표 → 전매·실거주·재당첨)');  // raw PDF 없으면(CI) fail-safe skip
  try { execFileSync('node', [p('inject-applyhome-notice.mjs')], { stdio: 'inherit', cwd: p('.') }); }
  catch (e) { log(`  ⚠️ inject-applyhome-notice 실패: ${e.message.split('\n')[0]}`); }
  hr('◆ inject-deadline-time (공고문 마감시각 주입)');
  try { execFileSync('node', [p('inject-deadline-time.mjs')], { stdio: 'inherit', cwd: p('.') }); }
  catch (e) { log(`  ⚠️ inject-deadline-time 실패: ${e.message.split('\n')[0]}`); }
  hr('◆ build-site');
  try { execFileSync('node', [p('build-site.mjs'), ...argv.filter(a => a === '--seed')], { stdio: 'inherit', cwd: p('.') }); }
  catch (e) { log(`  ⚠️ build-site 실패: ${e.message.split('\n')[0]}`); summary.push({ src: 'build', ok: false, note: e.message.split('\n')[0] }); }
} else log(`\n(빌드 생략 — ${SEMI ? '--semi' : '--no-build'})`);

hr('요약');
for (const s of summary) log(`  ${s.ok ? '✅' : '❌'} ${s.src}${s.note ? ' — ' + s.note : ''}`);
log(`\n소스별 검증 리포트: data/pipeline-report.json(lh) · data/<source>-report.json(myhome/sh/gh)`);
if (summary.some(s => !s.ok)) process.exitCode = 1;
