// collect-util.mjs — 수집기 공통 순수유틸. 5종 collect(lh/applyhome/myhome/sh/gh)가 복붙하던 것을 1벌로.
//   수집기는 Node 실행(브라우저 인라인 아님)이라 정당하게 import 공유 가능(CLAUDE.md §4 — 인라인 제약은 match-core 한정).
//   순수함수·결정론이라 위험 낮음. 소스별로 다른 로직(목록파싱·URL빌더)은 각 파일에 둠.
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';

// 스크래핑 공통 User-Agent(데스크톱 크롬). 차단 회피용 고정값.
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

// 예의상 요청 간격(ms).
export const dwell = ms => new Promise(r => setTimeout(r, ms));

// 첨부 필터 패턴(캐논 1벌 — 과거 4 수집기가 제각각 복붙해 lh만 '평면도'·'카달로그' 누락하던 드리프트 제거).
//   PAMPHLET = 요건 없는 홍보물(평면도·조감도·카탈로그 책자) → 다운로드 안 함. lh/myhome가 사용.
export const PAMPHLET_PAT = /팸플릿|팜플렛|리플렛|리플릿|브로슈어|카탈로그|카달로그|조감도|평면도/;
//   NON_NOTICE = 홍보물 + 공고 본문 아닌 첨부(서식·별지·위임장·점검표·안내문·당첨자명단). sh/gh가 사용.
export const NON_NOTICE_PAT = /팸플릿|팜플렛|리플렛|리플릿|브로슈어|카탈로그|카달로그|조감도|평면도|위임장|점검표|안내문|당첨자|명단|서식|별지/;

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

// 공고문 PDF 1개 고르기(파이프라인 공통). filesDir = `<slug>/files/` URL. fileid 있으면(LH meta) "<fileid>__" 접두 우선.
//   이후 이름패턴: 모집공고/입주자모집 → 공고문 → 공고(붙임·별지·서식 제외) → 모집 → 첫 PDF. PDF 없거나 디렉터리 부재 시 null.
//   pipeline(LH)·myhome-pipeline(myhome/sh/gh) 2변형 + prep-slices 1변형을 1벌로. 302개 raw 전수 무손실 검증(선택차이 0).
export function pickPdf(filesDir, fileid = null) {
  let names; try { names = readdirSync(filesDir); } catch { return null; }
  const pdfs = names.filter(n => n.toLowerCase().endsWith('.pdf'));
  if (!pdfs.length) return null;
  return (fileid && pdfs.find(n => n.startsWith(`${fileid}__`)))
    || pdfs.find(n => /모집공고|입주자모집/.test(n))
    || pdfs.find(n => /공고문/.test(n))
    || pdfs.find(n => /공고/.test(n) && !/붙임|별지|서식/.test(n))
    || pdfs.find(n => /모집/.test(n))
    || pdfs[0];
}

// 소스별 panId 접두 규약(단일 선언). 불변식: index 키 === derived panId === `${접두}${원시ID}` (전 소스 공통).
//   LH는 레거시 무접두(API panId 그대로), 나머지는 소스 약칭 접두. applyhome ':'(콜론)은 기존 index 키 호환 위해 유지(타 소스는 '-').
//   ★ applyhome은 collect(idxKey)와 derive(panId)가 별파일이라 과거 panId=bare vs key='ah:…' 불일치 → overlay 조용한실패. 양쪽 makePanId로 강제.
export const SRC_PREFIX = { lh: '', applyhome: 'ah:', myhome: 'mh-', sh: 'sh-', gh: 'gh-' };
export const makePanId = (src, rawId) => `${SRC_PREFIX[src] ?? ''}${rawId}`;

// index.json 로드(없거나 깨졌으면 {}). idxUrl = 각 수집기의 IDX(URL/경로).
export function loadIndex(idxUrl) { try { return JSON.parse(readFileSync(idxUrl, 'utf8')); } catch { return {}; } }

// new-pending.json 소스별 병합(CI에서 lh→sh→gh 순차 갱신 시 서로 안 덮어쓰게). 이 소스(`${source}-` 접두) 항목만 교체.
//   rootUrl = data/ URL. sh/gh가 바이트동일 복붙하던 것을 1벌로.
export function mergeNewPending(rootUrl, source, entries) {
  const f = new URL('new-pending.json', rootUrl);
  let cur = []; try { cur = JSON.parse(readFileSync(f, 'utf8')); } catch {}
  if (!Array.isArray(cur)) cur = [];
  const others = cur.filter(x => !String(x.panId || '').startsWith(`${source}-`));
  writeFileSync(f, JSON.stringify([...others, ...entries], null, 2));
}

// 첨부 1개 저장(스킵판정·검증·기록 공통 코어). fetch 메커니즘만 호출부가 fetchBuf로 주입(fetch vs cert주입 https 차이 흡수).
//   skipPat 매칭/비문서(pdf·hwp·hwpx 외)/HTML에러·빈응답이면 {skipped}, 성공이면 {ext,bytes}. sh/gh/myhome 3변형의 드리프트 코어를 1벌로.
export async function saveDoc({ name, dir, saveKey, skipPat, fetchBuf }) {
  if (skipPat && skipPat.test(name)) return { skipped: '팸플릿/서식류' };
  if (!/\.(pdf|hwp|hwpx)$/i.test(name)) return { skipped: '비문서' };
  try {
    const buf = await fetchBuf();
    if (buf.length < 100 || /<!DOCTYPE html/i.test(buf.subarray(0, 200).toString('latin1'))) return { skipped: '다운실패' };
    const ext = (name.match(/\.[a-z0-9]+$/i) || ['.pdf'])[0].toLowerCase();
    mkdirSync(new URL('files/', dir), { recursive: true });
    writeFileSync(new URL(`files/${saveKey}__${sani(name)}`, dir), buf);
    await dwell(200);
    return { ext, bytes: buf.length };
  } catch { return { skipped: '오류' }; }
}

// 메타만 주는 소스(sh/gh/myhome)의 미추출 자격요건 플레이스홀더(소득/자산 모두 공고문미기재). 소득기준 비고만 소스별 상이.
//   매처는 '공고문미기재'를 '확인필요'로 처리(정직). 공고문 PDF 추출(myhome-pipeline)이 후속 채움.
export const emptyQualification = (소득비고) => ({
  무주택: '무주택세대구성원(유형별 상이 — 공고문 확인)',
  소득기준: { 종류: '공고문미기재', 기본퍼센트: null, 가구원수별: null, 가산규칙: '', 비고: 소득비고 },
  자산상한: '공고문미기재', 자동차상한: '공고문미기재', 청약요건: '공고문미기재', 대상계층: ['일반'], 계층별: null,
});

// data.go.kr 서비스키 로드(.env 또는 process.env). URLSearchParams 재인코딩 대비 %인코딩이면 디코드해 반환.
//   키 없으면 '' 반환 — 빈값 처리(exit / graceful skip)는 호출 파일 정책에 위임(lh는 --refresh 시 skip).
export function loadServiceKey() {
  let key = process.env.DATA_GO_KR_SERVICE_KEY || '';
  try { for (const line of readFileSync(new URL('.env', import.meta.url), 'utf8').split('\n')) { const m = line.match(/^DATA_GO_KR_SERVICE_KEY=(.*)$/); if (m) key = m[1].trim(); } } catch {}
  return /%[0-9A-Fa-f]{2}/.test(key) ? decodeURIComponent(key) : key;
}
