// normalize-requirements.mjs — 추출된 requirements.json의 '계층별' 메타를 결정론적으로 정규화(canonical schema v1).
//   추출(Sonnet)은 계층 키/필드명을 자유형으로 뱉어 같은 개념이 제각각(자산상한 vs 총자산상한, 신혼부부·한부모가족 vs …계층).
//   이 패스가 동의어→캐논으로 표준화 + 만원→원 숫자화 + 키 충돌 병합. 무손실·멱등(두 번 돌려도 동일). 외부 LLM 0.
//   사용: node normalize-requirements.mjs [--report] [panId ...]
//     --report  : 쓰지 않고 변경 요약만 출력
//     panId 인자 : 해당 공고만(없으면 data/derived/lh 전체)
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';

const HERE = new URL('./', import.meta.url);
const DERIVED = new URL('data/derived/lh/', HERE);
const args = process.argv.slice(2);
const REPORT = args.includes('--report');
const onlyPans = args.filter(a => !a.startsWith('--'));

// ── 캐논 계층 enum ────────────────────────────────────────────
//   행복주택 등에서 쓰는 공급계층. 동의어/표기변형을 흡수.
export function canonTierKey(key) {
  const k = String(key).replace(/계층|\s|·|ㆍ|_|\(.*?\)/g, '');
  if (/대학생|취업준비생/.test(k)) return '대학생';
  if (/청년|사회초년생|청년창업/.test(k)) return '청년';
  if (/신혼|한부모|예비신혼/.test(k)) return '신혼·한부모';
  if (/고령/.test(k)) return '고령자';
  if (/주거급여/.test(k)) return '주거급여수급자';
  if (/산단|산업단지/.test(k)) return '산업단지근로자';
  if (/주거약자/.test(k)) return '주거약자';
  if (/일반|공통/.test(k)) return '일반';
  return String(key).trim();   // 미상은 보존(fail-safe)
}

// ── 캐논 계층 내부 필드명 ─────────────────────────────────────
const FIELD_SYN = {
  자산상한: ['자산상한', '총자산상한', '총자산', '자산', '가산자산표'],
  자동차상한: ['자동차상한', '자동차'],
  소득기준: ['소득기준', '소득', '소득상한', '소득상한%', '소득상한_기본', '소득상한기준', '소득기준비고'],
  소득가구원수별: ['소득가구원수별', '소득표', '가구원수별소득'],
  청약요건: ['청약요건', '청약'],
  연령: ['연령', '나이'],
  무주택: ['무주택'],
  대상: ['대상', '정의', '요건', '세부', '조건'],
};
const FIELD_MAP = {};
for (const [canon, syns] of Object.entries(FIELD_SYN)) for (const s of syns) FIELD_MAP[s] = canon;
const canonField = name => FIELD_MAP[name] || '비고';   // 미상 필드는 비고로 흡수
const AMOUNT_FIELDS = new Set(['자산상한', '자동차상한']);

// ── 만원/원 문자열 → 원(정수). 순수 금액형만 변환, 설명형 문자열은 보존 ──
export function parseAmt(v) {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (!/^[\d,]+\s*(만\s*원|만|원)?\s*(이하|미만)?$/.test(s)) return v;   // "34,500만원 이하" / "345,000,000원" / "108000000"
  const num = Number((s.match(/[\d,]+/) || ['0'])[0].replace(/,/g, ''));
  return /만/.test(s) ? num * 10000 : num;
}
// 금액 우선순위: 숫자(가장 엄격=낮은값) > "없음" > 설명문자열 > "공고문미기재"/null
function pickAmount(vals) {
  const nums = vals.filter(v => typeof v === 'number');
  if (nums.length) return Math.min(...nums);
  if (vals.includes('없음')) return '없음';
  const other = vals.find(v => typeof v === 'string' && v && v !== '공고문미기재');
  if (other) return other;
  return vals.find(v => v != null) ?? '공고문미기재';
}
function mergeVals(canon, vals) {
  if (AMOUNT_FIELDS.has(canon)) return pickAmount(vals.map(parseAmt));
  const obj = vals.find(v => v && typeof v === 'object');   // 구조형 필드(예: 소득가구원수별 표)는 그대로 보존(문자열화 금지)
  if (obj) return obj;
  const strs = [...new Set(vals.filter(v => v != null && v !== '').map(String))];
  return strs.length ? strs.join(' / ') : (vals[0] ?? null);
}
// 한 계층 entry(자유형) → 캐논 필드 entry
function normTierEntry(entry) {
  if (typeof entry !== 'object' || entry == null) return { 대상: String(entry) };
  const buckets = {};
  for (const [k, val] of Object.entries(entry)) (buckets[canonField(k)] ||= []).push(val);
  const out = {};
  for (const [cf, vals] of Object.entries(buckets)) out[cf] = mergeVals(cf, vals);
  return out;
}
// 같은 캐논 키로 합쳐지는 두 계층 entry 병합
function mergeTierEntries(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (out[k] == null || out[k] === '' || out[k] === '공고문미기재') { out[k] = v; continue; }
    if (AMOUNT_FIELDS.has(k)) out[k] = pickAmount([out[k], v].map(parseAmt));
    else if (typeof out[k] === 'string' && typeof v === 'string' && out[k] !== v)
      out[k] = [...new Set([out[k], v])].join(' / ');
  }
  return out;
}
function normalizeCb(cb) {
  if (!cb || typeof cb !== 'object') return cb;
  const out = {};
  for (const [key, entry] of Object.entries(cb)) {
    const ck = canonTierKey(key);
    const e = normTierEntry(entry);
    out[ck] = out[ck] ? mergeTierEntries(out[ck], e) : e;
  }
  return out;
}
// 대상계층 배열도 캐논 enum으로 정리(중복 제거, 순서 보존)
function normTargetList(arr) {
  if (!Array.isArray(arr)) return arr;
  const seen = new Set(), out = [];
  for (const t of arr) { const c = canonTierKey(t); if (!seen.has(c)) { seen.add(c); out.push(c); } }
  return out;
}

// ── 한 공고 정규화 ────────────────────────────────────────────
function normalizeReq(r) {
  const zq = r.자격요건;
  if (!zq || typeof zq !== 'object') return { changed: false };
  const before = JSON.stringify(zq);
  if (zq.계층별 && typeof zq.계층별 === 'object' && !Array.isArray(zq.계층별)) zq.계층별 = normalizeCb(zq.계층별);
  if (Array.isArray(zq.대상계층)) zq.대상계층 = normTargetList(zq.대상계층);
  // top-level 자산/자동차상한: 숫자·"없음"만 유효, "계층별 상이: …" 등 설명형은 "공고문미기재"로(매처가 계층별로 위임)
  for (const f of ['자산상한', '자동차상한']) if (f in zq) {
    const p = parseAmt(zq[f]);
    zq[f] = typeof p === 'number' ? p : p === '없음' ? '없음' : '공고문미기재';
  }
  return { changed: JSON.stringify(zq) !== before };
}

// ── 실행 ──────────────────────────────────────────────────────
const pans = onlyPans.length ? onlyPans : readdirSync(DERIVED);
let changed = 0, scanned = 0;
const keySet = new Set(), fieldSet = new Set();
for (const pan of pans) {
  const f = new URL(`${pan}/requirements.json`, DERIVED);
  if (!existsSync(f)) continue;
  scanned++;
  const r = JSON.parse(readFileSync(f, 'utf8'));
  const { changed: ch } = normalizeReq(r);
  const cb = r.자격요건?.계층별;
  if (cb && !Array.isArray(cb)) for (const [k, e] of Object.entries(cb)) { keySet.add(k); Object.keys(e || {}).forEach(x => fieldSet.add(x)); }
  if (ch) {
    changed++;
    if (!REPORT) writeFileSync(f, JSON.stringify(r, null, 2));
    if (REPORT) console.log(`  ~ ${pan}  ${(r.공고명 || '').slice(0, 30)}`);
  }
}
console.log(`\n${REPORT ? '[report] ' : ''}스캔 ${scanned}건 · 변경 ${changed}건${REPORT ? ' (미저장)' : ' 저장'}`);
console.log(`정규화 후 계층 키(${keySet.size}종): ${[...keySet].sort().join(', ')}`);
console.log(`정규화 후 계층 필드(${fieldSet.size}종): ${[...fieldSet].sort().join(', ')}`);
