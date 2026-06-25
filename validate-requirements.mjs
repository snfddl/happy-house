// validate-requirements.mjs — 전 소스 공통 요건 검증 게이트(결정론).
//   pipeline.mjs(LH)·myhome-pipeline.mjs(myhome/sh/gh)가 공유. requirements.json이 매처가 쓸 최소 스키마를 만족하는지 검사.
//   판정: fail(필수필드 누락·JSON 깨짐·선정방식 enum 위반) / review(미추출 대기·검증노트多·유형 불일치·공급형 비음) / pass.
//   브라우저 인라인 제약 없음(수집/파이프라인 전용) → 정상 import. 외부 LLM 0.
import { existsSync, readFileSync } from 'node:fs';

export const METHODS = new Set(['추첨', '가점', '순차', '혼합']);   // schema-v1.jsonc 선정방식 enum
export const REQUIRED_KEYS = ['panId', '공고명', '유형', '선정방식', '자격요건', '공급형', '원문링크'];

const dtlOf = r => r?.원문링크?.상세페이지 || r?.원문링크?.공급기관 || '';

// 파싱된 requirements 객체 → 판정. ctx: {type?(목록기준 유형), hasXlsx?, dtl?}
export function validateReq(r, ctx = {}) {
  const type = ctx.type ?? r.유형;
  const dtl = ctx.dtl ?? dtlOf(r);
  const base = { panId: r.panId, type, dtl };
  const miss = REQUIRED_KEYS.filter(k => !(k in r));
  if (miss.length) return { ...base, status: 'fail', 사유: `필수필드 누락: ${miss.join(',')}` };
  // 미추출(소득·자산 모두 '공고문미기재' + 선정방식 placeholder): PDF 추출 대기 → review(SH 신규 등 오탐 방지). 추출 후엔 정상 판정.
  const z = r.자격요건 || {};
  const 미추출 = z?.소득기준?.종류 === '공고문미기재' && z?.자산상한 === '공고문미기재' && !METHODS.has(r.선정방식);
  if (미추출) return { ...base, status: 'review', 사유: 'PDF 추출 대기(소득·자산·선정방식 미확정)' };
  if (!METHODS.has(r.선정방식)) return { ...base, status: 'fail', 사유: `선정방식 enum 위반: ${String(r.선정방식).slice(0, 30)}` };
  const warn = [];
  const notes = (r._검증노트 || []).length;
  if (notes >= 8) warn.push(`검증노트 ${notes}개`);
  if (ctx.type && r.유형 !== ctx.type) warn.push(`유형 불일치(목록:${ctx.type}→추출:${r.유형})`);
  if (ctx.hasXlsx && !r.주택목록) warn.push('xlsx 있으나 주택목록 미주입');
  if ((r.공급형 || []).length === 0 && r.유형 !== '전세임대' && !r.주택목록) warn.push('공급형 비어있음');
  return warn.length ? { ...base, status: 'review', 사유: warn.join('; ') } : { ...base, status: 'pass' };
}

// 파일 경로(URL|string) → 판정. 파일 없음·JSON 깨짐을 fail로 처리.
export function validateFile(reqPath, ctx = {}) {
  const dtl = ctx.dtl || '';
  if (!existsSync(reqPath)) return { panId: ctx.panId, type: ctx.type, dtl, status: 'fail', 사유: '추출 실패(파일 없음)' };
  let r;
  try { r = JSON.parse(readFileSync(reqPath, 'utf8')); }
  catch { return { panId: ctx.panId, type: ctx.type, dtl, status: 'fail', 사유: 'JSON 파싱 실패' }; }
  return validateReq(r, { ...ctx, dtl: ctx.dtl || dtlOf(r) });
}

// 판정 배열 → 리포트(pipeline-report.json 형태). extraReview: 추출 자체 불가건(PDF없음 등) 추가 격리.
export function buildReport(verdicts, { 신규 = verdicts.length, extraReview = [], 실행시각 = new Date().toISOString() } = {}) {
  const fmt = v => ({ panId: v.panId, type: v.type, 사유: v.사유, dtl: v.dtl });
  const failed = verdicts.filter(v => v.status === 'fail').map(fmt);
  const review = [...verdicts.filter(v => v.status === 'review').map(fmt), ...extraReview];
  const passed = verdicts.filter(v => v.status === 'pass').map(v => v.panId);
  return { 실행시각, 신규, 통과: passed.length, 실패: failed, 검토필요: review };
}

// 콘솔 요약 출력(공통). report=buildReport 결과.
export function printReport(report, log = console.log) {
  log(`\n신규 ${report.신규}건 → ✅ 통과 ${report.통과} / ⚠️ 검토필요 ${report.검토필요.length} / ❌ 실패 ${report.실패.length}`);
  if (report.실패.length) { log('\n❌ 실패(사람이 처리 필요):'); for (const f of report.실패) log(`  ${f.panId} [${f.type}] ${f.사유}\n     ${f.dtl}`); }
  if (report.검토필요.length) { log('\n⚠️ 검토 권장(자동 통과시키지 않음):'); for (const f of report.검토필요) log(`  ${f.panId} [${f.type}] ${f.사유}\n     ${f.dtl}`); }
}
