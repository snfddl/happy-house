// 공고문 본문에서 '마감시각' 결정론 추출 → requirements.json에 주입. 외부 LLM 0.
// 사용: node inject-deadline-time.mjs [--source=lh] [--report]
// 방식: 이미 아는 마감일(YYYY-MM-DD)에 앵커링 — 본문에서 그 날짜(M.D) 바로 뒤의 HH:MM만 채택.
//   (본문엔 당첨발표·서류제출 등 다른 시각이 많아, 마감 날짜에 붙은 시각만 잡아야 오추출이 없음.)
//   여러 후보면 접수/신청/~ 문맥 우선, 그래도 복수면 가장 늦은 시각(접수 종료시각) 채택.
// applyhome(청약홈)은 본문 없음(API 날짜만) → notice_sliced.txt 부재로 자동 스킵 → 템플릿이 소스 휴리스틱 폴백.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { writeJSONIfChanged } from './collect-util.mjs';

const ROOT = new URL('./data/derived/', import.meta.url);
const argv = process.argv.slice(2);
const ONLY = (argv.find(s => s.startsWith('--source=')) || '').split('=')[1] || '';
const REPORT = argv.includes('--report');
const SOURCES = ['lh', 'applyhome', 'myhome', 'sh', 'gh'].filter(s => !ONLY || s === ONLY);

const hhmm = mod => `${String(Math.floor(mod / 60)).padStart(2, '0')}:${String(mod % 60).padStart(2, '0')}`;

// 마감일(M,D)에 앵커링해 인접 HH:MM 후보 추출. 채택 실패 시 null.
function dateAnchored(text, M, D) {
  const md = `0?${M}\\s*\\.\\s*0?${D}(?![0-9])\\s*\\.?\\s*(?:\\([월화수목금토일]\\))?\\s*`;
  const re = new RegExp(md + `([01]?\\d|2[0-3])\\s*:\\s*([0-5]\\d)`, 'g');
  const cands = [];
  let m;
  while ((m = re.exec(text))) {
    const ctx = text.slice(Math.max(0, m.index - 30), m.index);
    cands.push({ mod: Number(m[1]) * 60 + Number(m[2]), prio: /접수|신청|마감|~|∼/.test(ctx) ? 1 : 0 });
  }
  if (!cands.length) return null;
  const pri = cands.filter(c => c.prio); const pool = pri.length ? pri : cands;
  return pool.sort((a, b) => b.mod - a.mod)[0].mod;            // 접수 종료시각 = 가장 늦은 시각
}

// 접수 문맥의 시간범위(HH:MM~HH:MM) 끝값 — 표 레이아웃/일반 접수시간 규칙 대응. 콜센터·점심·발표 제외.
function rangeEnd(text) {
  const re = /([01]?\d|2[0-3])\s*:\s*([0-5]\d)\s*[~∼\-]\s*([01]?\d|2[0-3])\s*:\s*([0-5]\d)/g;
  const freq = {}; let m;
  while ((m = re.exec(text))) {
    const around = text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 20);
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (!/(접수|신청|청약)/.test(around)) continue;
    if (/(콜센터|문의|상담|점심|평일|발표|제출|상환)/.test(before)) continue;   // 제외 키워드는 선행 문맥만(예: "점심시간 12:00~13:00"의 점심은 그 범위 앞)
    const end = Number(m[3]) * 60 + Number(m[4]);
    freq[end] = (freq[end] || 0) + 1;
  }
  const ent = Object.entries(freq);
  if (!ent.length) return null;
  return Number(ent.sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0]);   // 최빈(동률→늦은시각)
}

function extractTime(text, mm, dd) {
  const mod = dateAnchored(text, Number(mm), Number(dd)) ?? rangeEnd(text);
  if (mod == null || mod < 12 * 60) return null;   // 12시 이전=접수마감 아님(오전은 접수시작/발표 오추출) → 기각·휴리스틱 폴백
  return hhmm(mod);
}

const stat = {};
for (const src of SOURCES) {
  const base = new URL(`${src}/`, ROOT);
  if (!existsSync(base)) continue;
  stat[src] = { withDue: 0, hit: 0, miss: [] };
  for (const no of readdirSync(base)) {
    const rp = new URL(`${src}/${no}/requirements.json`, ROOT);
    const np = new URL(`${src}/${no}/notice_sliced.txt`, ROOT);
    if (!existsSync(rp)) continue;
    const r = JSON.parse(readFileSync(rp, 'utf8'));
    const due = r.마감일;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due || '')) continue;   // 마감일 없으면 대상 외
    stat[src].withDue++;
    if (!existsSync(np)) { stat[src].miss.push(`${no}(본문없음)`); continue; }
    const t = extractTime(readFileSync(np, 'utf8'), due.slice(5, 7), due.slice(8, 10));
    if (t) {
      stat[src].hit++;
      if (!REPORT) { r.마감시각 = t; writeJSONIfChanged(rp, r); }
    } else {
      stat[src].miss.push(`${no}(${due})`);
      if (!REPORT && '마감시각' in r) { delete r.마감시각; writeJSONIfChanged(rp, r); } // 멱등: 이전 오추출 제거
    }
  }
}

console.log(`${REPORT ? '[REPORT] ' : ''}마감시각 추출 (마감일 보유 공고 대상):`);
for (const src of SOURCES) {
  const s = stat[src]; if (!s) continue;
  const rate = s.withDue ? Math.round(s.hit / s.withDue * 100) : 0;
  console.log(`  ${src}: ${s.hit}/${s.withDue}건 (${rate}%)${s.miss.length && REPORT ? ' · 미추출: ' + s.miss.slice(0, 8).join(', ') + (s.miss.length > 8 ? ' …' : '') : ''}`);
}
