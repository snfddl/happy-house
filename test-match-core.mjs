// match-core 회귀 테스트 — 자격게이트/순위/가점의 정답성을 고정(정독 대신 실행).
//   AUDIT Round 2 발견 버그(#1 자산게이트 계층우선 등)의 재발 방지. 실행: node test-match-core.mjs
import { createMatcher } from './match-core.mjs';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { if (cond) { pass++; } else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); } };
const TODAY = '2026-06-25';
// 임대 envelope 최소 골격(자격게이트만 검사)
const baseReq = (자격요건) => ({ 상품군: '임대', 상품구조: '국민임대', 공고명: 't', 지역: '경기 수원',
  접수시작: '2026-06-01', 마감일: '2026-12-31', 상태: '접수중', 자격요건, 공급형: [], 단지: [] });
// 게이트 상태를 결과 배열(통과/실격사유/확인필요)에서 역추출. 실격사유·확인필요는 `${게이트키}:…` 접두.
const gateOf = (P, req, k) => {
  const r = createMatcher(P, TODAY).evaluate(req);
  if (r.통과.includes(k)) return { s: 'pass' };
  if (r.실격사유.some(s => s.startsWith(k + ':'))) return { s: 'fail' };
  if (r.확인필요.some(s => s.startsWith(k + ':'))) return { s: 'check' };
  return { s: '?' };
};

// ── #1 자산/자동차 게이트: 본인 계층의 더 엄격한 상한 우선 ──
{
  const req = baseReq({ 무주택: '무주택세대구성원', 소득기준: { 종류: '없음' },
    자산상한: 345000000, 자동차상한: '없음',
    계층별: { 청년: { 자산상한: 251000000 }, 대학생: { 자산상한: 108000000 } } });
  const 청년 = { 생년월일: '2000-01-01', 무주택: true, 세대원수: 1, 월평균소득: 0, 자동차가액: 0, 공급계층선택: ['청년'] };
  // 총자산 3억: 청년 캡(2.51억) 초과 → fail (과거버그: top 3.45억으로 pass 오판)
  ok(gateOf({ ...청년, 총자산: 300000000 }, req, '자산').s === 'fail', '#1 청년 3억 > 청년캡 2.51억 → fail');
  // 총자산 2억: 청년 캡 이내 → pass
  ok(gateOf({ ...청년, 총자산: 200000000 }, req, '자산').s === 'pass', '#1 청년 2억 ≤ 청년캡 → pass');
  // 계층 미해결(60세, 청년/대학생 아님, 선택없음) → top-level 3.45억 적용: 3억 ≤ 3.45억 pass
  const 일반 = { 생년월일: '1966-01-01', 무주택: true, 세대원수: 2, 월평균소득: 0, 자동차가액: 0, 공급계층선택: [], 총자산: 300000000 };
  ok(gateOf(일반, req, '자산').s === 'pass', '#1 계층미해결 3억 ≤ top 3.45억 → pass(top-level fallback)');
  // 역방향(false negative 방지): top이 더 엄격(2억)·청년캡 더 느슨(3.45억) → 청년 3억은 청년캡으로 pass
  const req2 = baseReq({ 무주택: '무주택세대구성원', 소득기준: { 종류: '없음' }, 자산상한: 200000000,
    계층별: { 청년: { 자산상한: 345000000 } } });
  ok(gateOf({ ...청년, 총자산: 300000000 }, req2, '자산').s === 'pass', '#1 청년캡(3.45억)이 top(2억)보다 느슨 → 청년 3억 pass(계층우선)');
}

// ── 계층별 없는 공고: top-level만으로 평가(회귀 안전망) ──
{
  const req = baseReq({ 무주택: '무주택세대구성원', 소득기준: { 종류: '없음' }, 자산상한: 250000000, 자동차상한: 36830000 });
  const P = { 생년월일: '1990-01-01', 무주택: true, 세대원수: 3, 월평균소득: 0, 자동차가액: 40000000, 총자산: 100000000, 공급계층선택: [] };
  ok(gateOf(P, req, '자산').s === 'pass', 'top-only 자산 1억 ≤ 2.5억 → pass');
  ok(gateOf(P, req, '자동차').s === 'fail', 'top-only 차량 4천만 > 3683만 → fail');
}

console.log(`\n${fail ? '❌' : '✅'} match-core 테스트: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
