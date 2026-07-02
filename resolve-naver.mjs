// 네이버 부동산 딥링크 리졸버 — 분양 단지명+주소 → pre.land 분양 딥링크(검증게이트 통과분만 requirements.json `네이버부동산`에 저장).
// 사용: node resolve-naver.mjs            → 활성 분양(접수중·접수예정·공고중)만 (증분·멱등)
//       node resolve-naver.mjs --all      → 전 분양(마감 포함)
//       node resolve-naver.mjs --force     → 이미 있어도 재해결
// 원리: 네이버 통합검색 HTML의 '분양 스마트블록'에 build_dtl_cd/supp_cd+좌표(SYMap)+등록명(data-title)이 박혀 옴(JSON API는 데이터센터 IP 429 차단, HTML은 통과).
//   딥링크 = pre.land.naver.com/complexes/{build_dtl_cd}/{supp_cd}. 분양은 매매 complexNo와 ID체계가 다름 → 매매 검색(m.land/search/result)으론 못 찾는 게 기존 버그.
// 검증게이트(오매칭 차단): 등록명(data-title)이 우리 단지명과 토큰일치 + 좌표 존재. 실패 시 미저장 → 사이트는 통합검색으로 안전 강등.
// 외부 LLM API 0 — 영문명 음역(SKY→스카이) 등 미해결분은 /update 등 에이전트 폴백(별도). 이 스크립트는 결정론 부분만.
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadCache, saveCache, normKey } from './geo.mjs';

const argv = process.argv.slice(2);
const ALL = argv.includes('--all'), FORCE = argv.includes('--force');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const SRC = ['lh', 'applyhome', 'myhome', 'sh', 'gh'];
const ACTIVE = new Set(['접수중', '접수예정', '공고중', '정정공고중']);
// 결정론 노이즈 제거: 괄호접미사·블록코드·모집유형 토큰(요건 의미 없음, 검색 정확도만 떨어뜨림)
const NOISE = /\([^)]*\)|\[[^\]]*\]|[A-Z]{1,3}-?\d{1,2}BL|블록|무순위|잔여세대|잔여|조합원\s*취소분|취소분|일반공급|특별공급|추가모집|사후접수|선착순|계약취소|보류지|임의공급|공공분양주택|공공분양|민영|본청약|\d+차/g;
export const normName = s => (s || '').replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
const 시도시군구 = a => { const m = (a || '').match(/([가-힣]{2,}(?:시|군))/); return m ? m[1] : ''; };
const strip = s => (s || '').replace(/[\s\-_()[\]·,.]/g, '').toLowerCase();
// 주소 괄호 안 실단지명: "(조촌동, 세경아파트)" → "세경아파트". 공고명이 제목형 노이즈(예: '…우선분양전환 후 잔여세대')일 때 실명 확보.
const nameFromAddr = a => { const m = (a || '').match(/\(([^)]*)\)/); if (!m) return ''; const seg = m[1].split(/[,·]/).map(s => s.trim()).filter(Boolean); return seg.reverse().find(s => /아파트|단지|마을|타운|빌|캐슬|푸르지오|자이|힐스|스타|시티|아이파크|e편한|롯데|sk|한라|디에트르/i.test(s)) || ''; };

// 한 쿼리로 통합검색 분양 스마트블록 파싱 → {url, 명, 좌표} | null (검증게이트 포함)
function tryQuery(base, region) {
  const q = encodeURIComponent((region ? region + ' ' : '') + base);
  let html = '';
  try { html = execFileSync('curl', ['-s', '-m', '15', '-A', UA, `https://m.search.naver.com/search.naver?query=${q}`], { maxBuffer: 2e7 }).toString(); } catch { return null; }
  const m = html.match(/build_dtl_cd=(\d+)&(?:amp;)?supp_cd=(\d+)/);
  if (!m) return null;
  const dt = (html.match(/data-title="([^"]+)"/) || [])[1] || '';
  const sy = html.match(/SYMap=([\d.]+):([\d.]+)/);
  // 검증게이트: 등록명이 우리명과 토큰일치(서로 포함) + 좌표 존재(실재 분양 보증). 실패=오매칭 의심 → null.
  //   부분포함 오탐 가드: 짧은 쪽이 4자 미만이거나 긴 쪽의 절반 미만이면 기각("힐스"⊂"힐스테이트" 류 인접단지 오매칭).
  //   기각돼도 사이트는 통합검색 폴백이라 안전(정밀도 우선, 좌표·딥링크 오지정이 더 해로움).
  const ours = strip(base), theirs = strip(dt.split('\n')[0]);
  const shorter = Math.min(ours.length, theirs.length), longer = Math.max(ours.length, theirs.length);
  const nameOk = dt && shorter >= 4 && shorter / longer >= 0.5 && (theirs.includes(ours) || ours.includes(theirs));
  if (!nameOk || !sy) return null;
  return { url: `https://pre.land.naver.com/complexes/${m[1]}/${m[2]}`, 명: dt.split('\n')[0], 좌표: [+sy[1], +sy[2]] };
}
// 이름 후보 = [공고명/단지명 정규화, 주소 괄호 실단지명] 순으로 시도(첫 검증통과 채택). 외부 LLM 음역(SKY→스카이)은 별도 에이전트 폴백.
function resolveBunyang(name, addr) {
  const region = 시도시군구(addr);
  const cands = [...new Set([normName(name), nameFromAddr(addr)].filter(Boolean))];
  for (const c of cands) { const hit = tryQuery(c, region); if (hit) return hit; }
  return null;
}

if (process.argv[1] && process.argv[1].endsWith('resolve-naver.mjs')) {
  const targets = [];
  for (const s of SRC) { const d = new URL(`./data/derived/${s}/`, import.meta.url); if (!existsSync(d)) continue;
    for (const no of readdirSync(d)) { const p = new URL(`${no}/requirements.json`, d); if (!existsSync(p)) continue;
      const r = JSON.parse(readFileSync(p, 'utf8'));
      if (r.상품구조 !== '분양') continue;
      if (!ALL && !ACTIVE.has(r.상태)) continue;
      if (r.네이버부동산 && !FORCE) continue;            // 멱등
      targets.push({ p, r, no });
    } }
  console.log(`분양 리졸브 대상 ${targets.length}건 (${ALL ? '전체' : '활성'}${FORCE ? '·강제' : ''})\n`);
  const TODAY = new Date().toISOString().slice(0, 10);
  const geo = loadCache();   // 좌표 사이드카 — 검증게이트가 이미 확인한 분양 단지 좌표를 무료 회수(추가 API 0)
  let ok = 0, fail = 0, geoNew = 0;
  for (const t of targets) {
    const nm = t.r.단지?.[0]?.단지명 || t.r.공고명;
    const addr = t.r.단지?.[0]?.주소 || t.r.지역 || '';
    const hit = resolveBunyang(nm, addr);
    if (hit) {
      t.r.네이버부동산 = hit.url; writeFileSync(t.p, JSON.stringify(t.r, null, 2)); ok++;
      const key = normKey(addr);                       // build-site가 단지[].주소로 조회하는 키와 동일
      if (key && hit.좌표 && !geo[key]) { geo[key] = { lat: hit.좌표[0], lng: hit.좌표[1], src: 'naver', 확정도: '건물', ts: TODAY }; geoNew++; }
      console.log(`✅ ${t.no} "${nm}" → ${hit.url} (${hit.명})`);
    }
    else { fail++; console.log(`·  ${t.no} "${nm}" → 미해결(통합검색 폴백)`); }
  }
  saveCache(geo);
  console.log(`\n해결 ${ok} · 미해결 ${fail} / ${targets.length} (미해결은 사이트에서 통합검색으로 노출) · 좌표캐시 +${geoNew}`);
}
