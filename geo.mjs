// geo.mjs — 좌표 사이드카 캐시 + 키-0 지오코딩(OSM Nominatim) 공유 헬퍼.
//   resolve-naver(분양 좌표 무료 회수)·geocode(주소/지역 일괄)·build-site(좌표 조인)가 공유하는 단일 소스.
//   ⚠️ 좌표는 requirements.json에 넣지 않는다 — derive가 raw서 통째 재생성하며 주입필드를 수동 이월하므로(applyhome-derive.mjs)
//      유실 위험. 대신 '정규화 주소/지역 문자열'을 키로 한 사이드카 캐시 → 재derive에 면역(멱등·증분 자동 성립).
//   키 0: 본 프로젝트의 키리스 스크레이프(resolve-naver) 철학과 동일. 유료 키 불필요. Kakao 키 추가 시 geocodeOne만 드롭인 교체.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export const CACHE_PATH = new URL('./data/derived/geo-cache.json', import.meta.url);

export function loadCache() {
  return existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, 'utf8')) : {};
}
export function saveCache(c) {
  // 키 정렬로 git diff 안정화
  const sorted = Object.fromEntries(Object.keys(c).sort().map(k => [k, c[k]]));
  writeFileSync(CACHE_PATH, JSON.stringify(sorted, null, 2) + '\n');
}

// 캐시키 정규화 — 괄호 보조설명·'일원'·중복공백 제거. 주소/지역 공통(seed·geocode·build가 동일 함수로 키 생성해야 히트).
export function normKey(s) {
  return (s || '')
    .replace(/\([^)]*\)/g, ' ')      // "(복현동) 일원" 등 괄호 보조
    .replace(/\s*일원\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 주소/지역 → centroid 폴백용 '시도 [시군구]' 질의. 둘째 토큰이 시/군/구로 끝나면 포함(예: "대구광역시 북구").
//   "경기도 부천시 오정구 원종동 276-2" → "경기도 부천시"; "서울" → "서울"; "대구·경북" → "대구".
export function regionOf(s) {
  const t = normKey(s).split(/[ ·,/]/).filter(Boolean);
  if (!t.length) return '';
  const out = [t[0]];
  if (t[1] && /(시|군|구)$/.test(t[1])) out.push(t[1]);
  return out.join(' ');
}

// Kakao REST 키 로딩 — process.env 우선, 없으면 .env(gitignore) 파싱. 키는 커밋 안 됨(캐시 결과만 커밋 → CI 키-0).
//   키리스 Nominatim은 한국 상세주소를 못 찾아(전국중심 폴백·무작위 POI) 폐기. Kakao Local이 건물 수준 정확.
function kakaoKey() {
  if (process.env.KAKAO_REST_KEY) return process.env.KAKAO_REST_KEY.trim();
  try {
    const env = readFileSync(new URL('./.env', import.meta.url), 'utf8');
    const m = env.match(/^KAKAO_REST_KEY=(.+)$/m);
    if (m) return m[1].trim();
  } catch { /* no .env */ }
  return null;
}
export const hasKey = () => !!kakaoKey();

// 지오코더(Kakao Local). 주소검색 우선, 빈 결과면 키워드검색 폴백. {lat,lng}|null. 키 없으면 throw(geocode.mjs가 안내).
//   다른 제공자(VWorld 등)로 바꾸려면 이 함수만 교체(캐시/조인 로직 불변).
export function geocodeOne(query) {
  const key = kakaoKey();
  if (!key) throw new Error('KAKAO_REST_KEY 없음 — .env에 추가하세요(README/안내 참고).');
  const hdr = ['-H', `Authorization: KakaoAK ${key}`];
  const call = (path, q) => {
    const url = `https://dapi.kakao.com/v2/local/search/${path}?query=${encodeURIComponent(q)}&size=1`;
    try {
      const out = execFileSync('curl', ['-s', '-m', '15', ...hdr, url], { maxBuffer: 1e7 }).toString();
      const j = JSON.parse(out);
      const d = j.documents && j.documents[0];
      if (d && d.x && d.y) return { lat: +d.y, lng: +d.x };   // Kakao: x=경도, y=위도
    } catch { /* ignore */ }
    return null;
  };
  return call('address.json', query) || call('keyword.json', query);
}
