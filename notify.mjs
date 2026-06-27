// notify.mjs — 활성 공고를 구독자 프로필로 매칭해 이메일 알림. process-all.mjs 마지막 단계.
//   외부 LLM API 0: 매칭=match-core(결정론) · 저장/조회=Supabase REST · 발송=Resend REST. 전부 전역 fetch(새 의존성 0).
//   env 미설정이면 graceful skip(geocode와 동일 — CI·타인 환경 무결).
//   중복발송 방지의 단일 권위 = Supabase `sent` 테이블. 신규/기존 구분 없이 활성 공고 전체를 매칭하고
//   `sent`에 없는 매칭분만 발송(가입 직후 "지금 열린 공고" 환영 다이제스트가 자연스럽게 처리됨).
import { readFileSync, existsSync } from 'node:fs';
import { createMatcher } from './match-core.mjs';

// .env 로드(Node는 자동 로드 안 함). 없으면(CI) 무시 — 그땐 env 미설정으로 아래에서 graceful skip.
try { process.loadEnvFile(new URL('.env', import.meta.url)); } catch { /* .env 없음 */ }

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY,
        NOTIFY_FROM, NOTIFY_SITE_URL, NOTIFY_STRICT, NOTIFY_DAILY_CAP } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !RESEND_API_KEY) {
  console.log('(notify 건너뜀 — SUPABASE_URL/SUPABASE_SERVICE_KEY/RESEND_API_KEY 미설정)');
  process.exit(0);
}

// 날짜는 KST 기준(국내 마감일·하루 경계). UTC로 자르면 09:00 KST에 날이 바뀌어 상한이 어긋남.
const TODAY = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const ACTIVE = new Set(['접수중', '공고중', '정정공고중']);
const STRICT = NOTIFY_STRICT === '1';   // 1=지원가능만. 기본=지원가능+확인필요(기회 누락 < 약간 노이즈)
const DAILY_CAP = Math.max(1, Number(NOTIFY_DAILY_CAP) || 1);   // 구독자당 하루 최대 발송 통수(기본 1, 2+ 원하면 env로)
const SITE = (NOTIFY_SITE_URL || '').replace(/\/$/, '');

// 1) 빌드된 reqs(신선도·슬림 반영 = 브라우저 매칭과 동일 데이터)
const reqsPath = new URL('./data/reqs-built.json', import.meta.url);
if (!existsSync(reqsPath)) { console.log('(notify 건너뜀 — data/reqs-built.json 없음. build-site 먼저)'); process.exit(0); }
const reqs = JSON.parse(readFileSync(reqsPath, 'utf8')).filter(r => ACTIVE.has(r.상태));

// ── Supabase REST 헬퍼(service_role = RLS 우회) ──
const sb = (path, opts = {}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
  ...opts,
  headers: {
    apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json', ...(opts.headers || {}),
  },
});

// 2) 활성 구독자
const subs = await sb('subscribers?active=eq.true&select=id,email,profile,filters,last_emailed_on,emailed_count').then(r => r.json());
if (!Array.isArray(subs)) { console.log('  ⚠️ 구독자 조회 실패:', JSON.stringify(subs)); process.exit(1); }
if (!subs.length) { console.log('✅ notify — 활성 구독자 0명'); process.exit(0); }

// 3) 발송 이력 → sub_id별 발송완료 panId Set(중복방지)
const sentRows = await sb('sent?select=sub_id,pan_id').then(r => r.json());
const sentMap = new Map();
for (const { sub_id, pan_id } of (Array.isArray(sentRows) ? sentRows : []))
  (sentMap.get(sub_id) || sentMap.set(sub_id, new Set()).get(sub_id)).add(pan_id);

// ── 코스 사전필터(상품군 임대/분양 · 공급자 공공/민간) — 매칭 전 노이즈 컷 ──
const 공급자Of = r => /민영분양|민간/.test(r.유형 || '') ? '민간' : '공공';
function passFilter(r, f = {}) {
  if (Array.isArray(f.상품군) && f.상품군.length && !f.상품군.includes(r.상품군)) return false;
  if (Array.isArray(f.공급자) && f.공급자.length && !f.공급자.includes(공급자Of(r))) return false;
  return true;
}

// ── 이메일 본문(인라인 스타일 다이제스트) ──
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ddayLabel = res => res.dday == null ? '' : res.dday < 0 ? '마감' : res.dday === 0 ? '오늘 마감' : `D-${res.dday}`;
function renderEmail(sub, hits) {
  const rows = hits.map(({ r, res }) => {
    const badge = res.판정 === '지원가능' ? '✅ 지원가능' : '🔎 확인필요';
    const meta = [esc(r.유형), esc(r.지역), ddayLabel(res), r.마감일미상 ? '마감일 미상' : esc(r.마감일)].filter(Boolean).join(' · ');
    const link = res.링크 ? `<a href="${esc(res.링크)}" style="color:#3b5bdb">${esc(res.링크라벨 || '원문 보기')}</a>` : '';
    return `<tr><td style="padding:12px 0;border-bottom:1px solid #eee">
      <div style="font-size:12px;color:#888">${badge} · ${meta}</div>
      <div style="font-weight:700;margin:2px 0">${esc(r.공고명)}</div>
      <div style="font-size:13px">${link}</div></td></tr>`;
  }).join('');
  const unsub = SITE ? `<p style="font-size:12px;color:#aaa;margin-top:24px">
    더 받지 않으려면 <a href="${SITE}/unsubscribe.html?t=${sub.id}" style="color:#aaa">알림 해지</a></p>` : '';
  return `<div style="max-width:560px;margin:0 auto;font-family:-apple-system,sans-serif;color:#222">
    <h2 style="font-size:18px">내 조건에 맞는 공고 ${hits.length}건</h2>
    <table style="width:100%;border-collapse:collapse">${rows}</table>${unsub}</div>`;
}

async function sendEmail(to, n, html) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: NOTIFY_FROM || 'happy-house <onboarding@resend.dev>', to, subject: `내 조건에 맞는 공고 ${n}건`, html }),
  });
  if (!r.ok) { console.log(`  ⚠️ Resend 실패(${to}): ${r.status} ${await r.text().catch(() => '')}`); return false; }
  return true;
}

// 4) 구독자별 매칭 → 미발송 매칭분 발송 → sent 기록
let sentCount = 0;
for (const sub of subs) {
  // 백스톱: 무주택 미입력이면 임대 전건이 '확인필요'로 떠 스팸. 가입폼서 필수 입력 강제하지만 여기서도 방어.
  if (sub.profile?.무주택 == null) { console.log(`  · ${sub.email} 건너뜀(프로필 무주택 미입력)`); continue; }
  // 하루 발송 상한 — 오늘(KST) 이미 DAILY_CAP통 보냈으면 건너뜀(매칭분은 sent에 안 남으니 내일/상한↑ 때 그대로 발송됨, 누락 없음).
  const sentToday = sub.last_emailed_on === TODAY ? (sub.emailed_count || 0) : 0;
  if (sentToday >= DAILY_CAP) { console.log(`  · ${sub.email} 건너뜀(오늘 ${sentToday}/${DAILY_CAP}통 발송)`); continue; }
  const seen = sentMap.get(sub.id) || new Set();
  const m = createMatcher(sub.profile, TODAY);
  const hits = [];
  for (const r of reqs) {
    const pid = String(r.panId);
    if (seen.has(pid) || !passFilter(r, sub.filters)) continue;
    let res; try { res = m.evaluate(r); } catch { continue; }
    if (res.판정 === '지원가능' || (!STRICT && res.판정 === '확인필요')) hits.push({ r, res });
  }
  if (!hits.length) continue;
  if (!(await sendEmail(sub.email, hits.length, renderEmail(sub, hits)))) continue;
  // 발송 성공분만 sent 기록(중복키 무시 = 동시성/재시도 안전)
  await sb('sent', {
    method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates' },
    body: JSON.stringify(hits.map(h => ({ sub_id: sub.id, pan_id: String(h.r.panId) }))),
  });
  // 하루 발송 카운터 갱신(날 바뀌면 1로 리셋, 같은 날이면 누적) — 상한 판정 근거.
  await sb(`subscribers?id=eq.${sub.id}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ last_emailed_on: TODAY, emailed_count: sentToday + 1 }),
  });
  sentCount++;
  console.log(`  ✉️  ${sub.email} ← ${hits.length}건`);
}
console.log(`✅ notify — 활성 ${subs.length}명 중 ${sentCount}명에게 발송(STRICT=${STRICT ? '지원가능만' : '지원가능+확인필요'})`);
