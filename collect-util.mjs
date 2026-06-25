// collect-util.mjs — 수집기 공통 순수유틸. 5종 collect(lh/applyhome/myhome/sh/gh)가 복붙하던 것을 1벌로.
//   수집기는 Node 실행(브라우저 인라인 아님)이라 정당하게 import 공유 가능(CLAUDE.md §4 — 인라인 제약은 match-core 한정).
//   순수함수·결정론이라 위험 낮음. 소스별로 다른 로직(fetchNoticeFiles·URL빌더)은 각 파일에 둠.
import { readFileSync } from 'node:fs';

// 스크래핑 공통 User-Agent(데스크톱 크롬). 차단 회피용 고정값.
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

// 예의상 요청 간격(ms).
export const dwell = ms => new Promise(r => setTimeout(r, ms));

// 파일명 새니타이즈: 경로/예약문자 → '_', 공백 단일화, 120자 컷. String()로 비문자열(숫자 fileSn 등)도 안전(과거 lh가 누락했던 버그를 캐논으로 흡수).
export const sani = s => String(s).replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);

// 8자리 숫자날짜(YYYYMMDD, 구분자 무관) → 'YYYY-MM-DD'. 그 외(빈값·형식이상)는 null.
export const dnorm = s => { const d = (s || '').replace(/\D/g, ''); return d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null; };

// 오늘(YYYY-MM-DD, 로컬 자정 기준 ISO). statusOf 비교용 캐논 — 각 수집기가 복제하던 const TODAY를 1벌로.
export const TODAY = new Date().toISOString().slice(0, 10);

// 접수시작(b)·마감일(e) 기준 상태(결정론). b/e는 'YYYY-MM-DD'|null. 4개 수집기로 갈라졌던 statusOf 단일 캐논.
//   마감 지남→접수마감, 시작 전→접수예정, 마감일 있음→접수중, 날짜 없음→prev 유지(없으면 null).
//   날짜 없을 때 기본 '공고중'이 필요한 소스(SH)는 prev에 '공고중'을 넘긴다.
export function statusOf(b, e, prev = null) {
  if (e && TODAY > e) return '접수마감';
  if (b && TODAY < b) return '접수예정';
  if (e) return '접수중';
  return prev ?? null;
}

// CLI 인자 --k=v 읽기(없으면 기본값 d). process.argv 직접 조회(호출 파일과 동일 인자).
export const getArg = (k, d) => (process.argv.slice(2).find(a => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split('=')[1];

// index.json 로드(없거나 깨졌으면 {}). idxUrl = 각 수집기의 IDX(URL/경로).
export function loadIndex(idxUrl) { try { return JSON.parse(readFileSync(idxUrl, 'utf8')); } catch { return {}; } }

// data.go.kr 서비스키 로드(.env 또는 process.env). URLSearchParams 재인코딩 대비 %인코딩이면 디코드해 반환.
//   키 없으면 '' 반환 — 빈값 처리(exit / graceful skip)는 호출 파일 정책에 위임(lh는 --refresh 시 skip).
export function loadServiceKey() {
  let key = process.env.DATA_GO_KR_SERVICE_KEY || '';
  try { for (const line of readFileSync(new URL('.env', import.meta.url), 'utf8').split('\n')) { const m = line.match(/^DATA_GO_KR_SERVICE_KEY=(.*)$/); if (m) key = m[1].trim(); } } catch {}
  return /%[0-9A-Fa-f]{2}/.test(key) ? decodeURIComponent(key) : key;
}
