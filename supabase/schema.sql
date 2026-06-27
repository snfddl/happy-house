-- happy-house 알림 구독 스키마 (Supabase / Postgres)
--   Supabase 대시보드 SQL Editor에 붙여 실행. 멱등(여러 번 실행해도 안전).
--   설계: 외부 LLM API 0. 매칭=match-core(결정론), 저장=이 DB, 발송=notify.mjs(Resend).
--   PII(이메일·프로필) 보호 = RLS. anon 키는 site에 공개되지만 INSERT만 가능, 읽기/수정/삭제 차단.
--   해지는 서버 없이 SECURITY DEFINER RPC(unsubscribe)로 처리.

-- ── subscribers ─────────────────────────────────────────────
-- profile = match-core가 그대로 먹는 P 객체(JSONB). filters = 코스 사전필터.
create table if not exists subscribers (
  id         uuid primary key default gen_random_uuid(),   -- 해지 토큰 겸용(추측불가)
  email      text not null,
  profile    jsonb not null,                               -- match-core P 객체 통째(소득·자산·자녀·청약 등)
  filters    jsonb not null default '{}'::jsonb,           -- {"상품군":["임대"],"공급자":["공공"]} · 빈 객체=전체
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  last_emailed_on date,                                    -- 마지막 발송 날짜(KST) — 하루 상한 판정용
  emailed_count   int not null default 0                   -- 그 날짜에 보낸 통수(NOTIFY_DAILY_CAP, 기본 1)
);
-- 기존 테이블에 이미 적용했다면(컬럼 없을 때) 멱등 보강:
alter table subscribers add column if not exists last_emailed_on date;
alter table subscribers add column if not exists emailed_count int not null default 0;
-- 활성 구독 기준 이메일 중복가입 방지(해지 후 재가입은 허용 — active=false는 인덱스서 제외).
create unique index if not exists subscribers_email_active
  on subscribers (lower(email)) where active;

-- ── sent ────────────────────────────────────────────────────
-- (구독자 × 공고) 발송 이력 = 중복발송 방지의 단일 권위. notify는 여기 없는 매칭분만 발송.
create table if not exists sent (
  sub_id  uuid not null references subscribers(id) on delete cascade,
  pan_id  text not null,
  sent_at timestamptz not null default now(),
  primary key (sub_id, pan_id)
);

-- ── RLS ─────────────────────────────────────────────────────
alter table subscribers enable row level security;
alter table sent        enable row level security;

-- anon(브라우저)은 가입(INSERT)만. select/update/delete 정책 없음 → 전부 거부(PII 읽기 차단).
--   service_role(notify.mjs)은 RLS 우회라 정책 불필요.
drop policy if exists subscribers_anon_insert on subscribers;
create policy subscribers_anon_insert on subscribers
  for insert to anon with check (active = true);

grant insert on subscribers to anon;     -- 테이블 레벨 권한(RLS와 함께 작동). select은 부여 안 함.
-- sent: anon 권한·정책 전무 → service_role만 접근.

-- ── 해지 RPC (서버 0) ───────────────────────────────────────
-- 토큰(=subscribers.id)으로 active=false. SECURITY DEFINER로 RLS 우회, anon엔 실행권한만.
--   존재여부를 노출 않도록 항상 true 반환(타이밍/존재 추론 방지).
create or replace function unsubscribe(p_token uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  update subscribers set active = false where id = p_token and active;
  select true;
$$;
revoke all on function unsubscribe(uuid) from public;
grant execute on function unsubscribe(uuid) to anon;
