// run-gate.mjs — 요건 검증 게이트 단독 실행(결정론·멱등). validate-requirements 공통 모듈 사용.
//   pipeline/myhome-pipeline 내장 게이트는 "그 실행에서 추출한 신규분"만 본다.
//   워크플로우 병렬 추출(/update 2단계)처럼 파이프라인 밖에서 requirements.json이 생기면 게이트가 안 돌므로 이걸로 돌린다.
// 사용: node run-gate.mjs [--source=lh,sh] [--slugs=306283,20675-1]
//   기본: lh·myhome·sh·gh 전건(청약홈은 결정론 파생이라 이 게이트 스키마 대상 아님). --slugs: 해당 슬러그만.
//   리포트: lh→data/pipeline-report.json, 그외→data/<source>-report.json (파이프라인 내장 게이트와 동일 형식·경로)
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { validateFile, buildReport, printReport } from './validate-requirements.mjs';
import { makePanId } from './collect-util.mjs';

const ROOT = new URL('./data/', import.meta.url);
const argv = process.argv.slice(2);
const getArg = (k) => { const a = argv.find(s => s.startsWith(`--${k}=`)); return a ? a.split('=')[1] : ''; };
const SOURCES = (getArg('source') || 'lh,myhome,sh,gh').split(',').map(s => s.trim()).filter(Boolean);
const SLUGS = getArg('slugs').split(',').map(s => s.trim()).filter(Boolean);

const index = existsSync(new URL('index.json', ROOT)) ? JSON.parse(readFileSync(new URL('index.json', ROOT), 'utf8')) : {};

let anyFail = false;
for (const src of SOURCES) {
  const dir = new URL(`derived/${src}/`, ROOT);
  let slugs = [];
  try { slugs = readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { console.log(`◆ ${src} — derived 없음, 건너뜀`); continue; }
  if (SLUGS.length) slugs = slugs.filter(s => SLUGS.includes(s));
  const verdicts = slugs.map(slug => {
    const panId = makePanId(src, slug);
    return validateFile(new URL(`${slug}/requirements.json`, dir), { panId, type: index[panId]?.type });
  });
  const report = buildReport(verdicts, { 신규: verdicts.length });
  writeFileSync(new URL(src === 'lh' ? 'pipeline-report.json' : `${src}-report.json`, ROOT), JSON.stringify(report, null, 2));
  console.log(`◆ ${src} (${verdicts.length}건)`);
  printReport(report);
  console.log();
  if (report.실패.length) anyFail = true;
}
if (anyFail) process.exitCode = 1;
