// extract-core.mjs — LLM 요건추출 골격 단일 소스.
//   pipeline.mjs(LH=신규생성)·myhome-pipeline.mjs(myhome/sh/gh=MERGE)가 복제하던 buildPrompt+extractOne을 흡수.
//   결과·품질 동일, mode(new|merge)로만 분기. 헤드리스(claude -p) 백엔드 + 워크플로우 공용 postProcess.
//   외부 LLM API 0 (claude -p 헤드리스 또는 워크플로우로만 추출 — CLAUDE.md §3).
//   - 무인(node): runHeadless(queue, conc) — pipeline/myhome-pipeline/process-all이 호출.
//   - 대화형(세션): 워크플로우가 queue의 prompt를 agent()에 넣어 병렬 추출 후 각 항목에 postProcess() 호출.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { pool, statusOf } from './collect-util.mjs';

const HERE = new URL('./', import.meta.url);
const p = u => decodeURIComponent(u.pathname);
const V1_SCHEMA = readFileSync(new URL('schema-v1.jsonc', HERE), 'utf8');
const RULES = readFileSync(new URL('extract-rules.txt', HERE), 'utf8');

// 완성 프롬프트 문자열. mode='new'(LH, sliced만→신규 생성) | 'merge'(myhome/sh/gh, 기존 envelope에 MERGE).
//   header: new={panId,type,region,status,due} · merge={공급기관,유형,panId}
export function buildExtractPrompt({ mode, slicedPath, reqPath, header }) {
  if (mode === 'merge') {
    return `당신은 한국 공공임대주택 공고문에서 입주 요건을 구조화 추출하는 전문가입니다. 외부 API 없이 주어진 텍스트만 근거로 합니다.

[대상] ${header.공급기관} ${header.유형} 공고 (panId ${header.panId})

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
  // mode === 'new' (LH)
  return `당신은 한국 LH 임대주택 공고문에서 입주 요건을 구조화 추출하는 전문가입니다. 외부 API 없이 주어진 텍스트만 근거로 작업합니다.

[대상 공고]
- panId: ${header.panId}
- 유형: ${header.type}
- 지역(목록기준): ${header.region}
- 상태: ${header.status}
- 마감일(목록기준): ${header.due}

[작업 순서]
1) Read 도구로 다음 파일(보일러플레이트 제거된 공고문 본문)을 읽으세요:
   ${slicedPath}
2) 본문을 정독하고 아래 정규 스키마 v1로 요건을 추출하세요. panId/유형/상태/마감일은 위 값을 기본으로, 지역(시군구)/공고일/접수시작/일정/단지/공급형/자격요건/순위규칙/배점표는 본문에서 정확히 채웁니다. 표(소득·임대료·배점)는 행/열을 신중히 대응시켜 숫자를 옮기세요.
3) Write 도구로 다음 경로에 저장하세요(유효한 단일 JSON 객체, 기존 덮어쓰기):
   ${reqPath}
4) 저장 후 한 줄 요약(선정방식·공급형수·검증노트수)만 반환하세요.

[정규 스키마 v1]
${V1_SCHEMA}

${RULES}`;
}

// 추출 결과물 기반 성공판정 + mode별 후처리. 헤드리스/워크플로우 양쪽이 호출.
//   new: requirements.json 생성 여부만(후처리 없음).
//   merge: 자격요건 키 존재로 성공판정 + __pdf추출=true 마킹 + statusOf 상태 재계산 후 재저장.
export function postProcess({ mode, reqPath }) {
  if (mode === 'merge') {
    try {
      const r = JSON.parse(readFileSync(reqPath, 'utf8'));
      const ok = !!r.자격요건;
      if (ok) { r.__pdf추출 = true; r.상태 = statusOf(r.접수시작, r.마감일, r.상태); writeFileSync(reqPath, JSON.stringify(r, null, 2)); }
      return { ok };
    } catch { return { ok: false }; }
  }
  return { ok: existsSync(reqPath) };
}

// 헤드리스 1건 (claude -p Sonnet). item.prompt 있으면 사용, 없으면 buildExtractPrompt로 생성.
function extractOneHeadless(item, log) {
  return new Promise(resolve => {
    const prompt = item.prompt || buildExtractPrompt(item);
    const ps = spawn('claude', ['-p', prompt, '--model', 'sonnet', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read', 'Write'], { cwd: p(HERE), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    ps.stdout.on('data', d => out += d);
    ps.stderr.on('data', d => err += d);   // 실패 원인 추적용 — 성공 시 버림, 실패 시 표면화
    ps.on('close', code => {
      const pp = postProcess(item);
      // new는 code===0도 요구(원본 pipeline 동작 보존), merge는 추출물(자격요건 키) 기준 — 기존 파일이 늘 있어 code 무관.
      const ok = pp.ok && (item.mode !== 'new' || code === 0);
      log(`  ${ok ? '✅' : '❌'} ${item.label} ${out.trim().slice(0, 70)}`);
      if (!ok) log(`     ↳ exit ${code}${err.trim() ? ` · stderr: ${err.trim().slice(-200)}` : ' · stderr 없음(추출물 미생성)'}`);
      resolve({ ...item, ok, err: ok ? '' : err.trim().slice(-500) });
    });
  });
}

// 헤드리스 백엔드: 큐 병렬 추출(동시성 conc). ok 포함 결과 배열 반환.
export async function runHeadless(queue, conc = 3, log = console.log) {
  return pool(queue, conc, it => extractOneHeadless(it, log));
}

// 큐 항목 생성 — 완성 prompt를 포함해 헤드리스/워크플로우 양쪽이 "prompt 받아 실행"만 하면 되게.
export function toQueueItem({ mode, source, slug, slicedPath, reqPath, header, label }) {
  return { source, slug, mode, slicedPath, reqPath, header, label: label || `${source}:${slug}`,
    prompt: buildExtractPrompt({ mode, slicedPath, reqPath, header }) };
}

// 전소스 통합 큐(extract-queue.json)에 해당 source 몫을 교체 기록(다른 소스 항목 보존). mergeNewPending과 동일 패턴.
//   대화형 /update 워크플로우가 이 파일을 읽어 병렬 추출. 재생성물(gitignore).
export function mergeQueue(rootUrl, source, items) {
  const f = new URL('extract-queue.json', rootUrl);
  let q = []; try { q = JSON.parse(readFileSync(f, 'utf8')); } catch {}
  q = q.filter(x => x.source !== source).concat(items);
  writeFileSync(f, JSON.stringify(q, null, 2));
  return q;
}
