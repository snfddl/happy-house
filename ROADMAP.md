# ROADMAP

우선순위 순. 완료 현황은 `README.md`, 결정 근거는 `DECISIONS.md` 참고.

## 다음 (Next)

1. **알림 레이어** (개인용 본류 마무리)
   - ✅ **이메일 채널 구축**: `notify.mjs`(process-all 마지막 단계) — 활성 공고를 구독자 프로필로 `match-core` 매칭해 미발송분만 Resend 다이제스트 발송. 저장=Supabase(`supabase/schema.sql`: subscribers·sent·RLS·unsubscribe RPC), 가입/해지 UI=사이트(anon 가입·토큰 해지, PII는 RLS 차단). 외부 LLM 0·env 없으면 skip. 중복방지=`sent` 권위 + 하루상한. **임대+분양 통합**(한 reqs). 라이브 발송 E2E 검증(가입·RLS차단·중복409·발송·해지·중복발송차단).
   - 잔여: D-day 변화 감지(현재는 활성 매칭만) · 카톡/웹푸시 채널 · 주간요약·예상빈도 안내(공고 드물어도 안 죽게). 빈도 실측: 전국 8.6건/주, 수도권 1.1건/주, 특정 시군구 ≈0.

## 완료 (지도 연동 조회 · 2026-06-27)
- ✅ **Leaflet 지도 + 카드 목록 양방향 연동**(키 0·벤더 인라인·자체완결 유지): 핀↔카드 클릭 하이라이트, 지역 select→해당 지역 줌(`fitToPins`), **'이 지도 영역만' 토글→가시영역(bounds)으로 목록 필터**(`state.mapBoundsOn`+`pass()` 술어+moveend), 판정 색 핀, 데스크탑 좌지도/우목록·모바일 토글. 좌표없음 공고는 핀 생략(목록 유지).
- ✅ **좌표 파이프라인**: `geo.mjs`(사이드카 캐시·제공자 추상화) + `geocode.mjs`(Kakao Local·로컬 키·증분·멱등) + `resolve-naver` 분양 좌표 무료 시드. 좌표는 requirements 아닌 **주소키 사이드카**(`geo-cache.json`)에 → 재derive 면역. CI 키-0(캐시+시군구 centroid 폴백). build-site가 `좌표목록` 조인·임베드.
- ✅ **대시보드 UI 다듬기**(2026-06-27): 데스크탑 고정 셸(헤더·필터 고정, 지도 뷰포트 채움·스크롤X, 목록만 독립 스크롤·`overflow-y`), 상단 컴팩트화, 목록 2컬럼(`minmax 360`), 카드 스펙 라인(금액 아래 전용면적·세대수), 건수·토글 칩라인 병합, 지도 한국 영역 고정(`maxBounds`+`minZoom 6`+noWrap), 선택 핀 30px 펄스 강조, Leaflet z-index를 모달 아래로(`.mapwrap` stacking context). 카드 클릭=핀 강조(지도이동 미사용·`focusOnMap` 보존).
- ✅ **조회 UX 2차**(2026-06-27): 카드 hover→해당 핀 강조(`onmouseenter/leave`+`selId` 추적, 터치엔 클릭 유지), `prefers-reduced-motion` 1블록(핀 펄스·hover 이동·transition 정지), 빈 상태 '필터 초기화' 버튼(`#emptyReset`→state 리셋+apply), **관심공고 찜**(별표 토글·`localStorage hh_fav_v1`·'⭐ 찜' 필터칩, 마감 알림 수익화 연결), **카드 본문 클릭=상세 모달**(hover=핀강조와 역할 분리, 이전 본문클릭=핀강조 cd9bf3f 되돌림), **마감임박 긴급강조**(오늘 마감·D-1→`.dday.urgent` 채운 빨강·깜빡임, D-2~3→연한 `.soon`), **카드·상세모달 a11y**(제목을 `h3>button.cardttl aria-haspopup=dialog`로 키보드/SR 진입, focus-visible 링; 모달 `role=dialog`·`aria-modal`·`aria-labelledby`·포커스 트랩·열기/닫기 포커스 이동·닫기 버튼 aria-label), **드로어·위저드 a11y**(공유 `trapTabIn` 트랩 헬퍼·`role=dialog`·`aria-modal`·`aria-labelledby`·포커스 진입/복귀; 드로어 닫힘상태 `visibility:hidden`로 탭/SR 누수 차단; 위저드 단계전환마다 질문 heading 포커스로 SR 안내). **조회 UX 백로그 소진**(메모리 `map-ux-todo`).
- 교훈: 키리스 Nominatim은 한국 상세주소 지오코딩 불가(전국중심 폴백·무작위 POI) → Kakao Local 키 채택(무과금·서비스 ON 필요). 상세: `ARCHITECTURE.md` 모듈지도 · `SCHEMA.md` §7 · `DEPLOY.md`.

## 완료 (웹 조회 UI)
- ✅ `build-site.mjs` → `site/index.html` 자체완결 정적(requirements+프로필+`match-core` 인라인, 서버 불필요). 임대+분양 통합, 판정 배지·필터·검색·정렬·상세 모달. **브라우저 내 조건 수정 패널→실시간 재계산**(매칭 로직=`match-core.mjs` 단일소스 공유, localStorage 저장). 신뢰감: 출처·기준일·**검증된 원문링크**·"확인필요/참고/추정" 정직표기·판정기준 안내. 템플릿=`site/_template.html`.
- 교훈: LH 상세페이지 GET은 깨짐(POST 전용)→공고문 PDF로 교체. **링크는 항상 접근성 검증 후 노출**(curl).

## 완료 (분양 확장 — 청약홈 OpenAPI)
- ✅ 정찰·활용신청·수집기·SCHEMA §6·매퍼·**가점계산기(`match.mjs` 분양 분기)** 완료. 분양 42건이 임대와 한 엔진에서 매칭(민영=가점84점, 공공=순차, 청약순위·지역우선 tier·특공해당). 갭 중 가점/추첨비율은 "참고", 공공 소득·자산컷은 "확인필요"(전매제한·실거주의무·재당첨제한은 이후 공고문 표서 결정론 추출 — 아래 완료 섹션). 소스노트=`청약홈_분양_API_노트.md`.
- 잔여(선택): LH↔청약홈 단지 매칭(중복제거/보강).

## 완료 (공고문 PDF 결정론 추출 · 건물유형 · 임대 분석 · 2026-06-26)
- ✅ **청약홈 갭 보강(PDF 2차)**: `inject-applyhome-notice`가 공고문 '단지 주요정보' 표서 **전매제한·실거주의무·재당첨제한**을 결정론 추출(헤더 토큰 컬럼 밴드 파싱·LLM 0·로컬). 157/193 채움. 매칭의 "참고/원문확인" 헤지를 공고문 직독 사실로 대체. 검증: 고덕 자연앤 4차=전매3년·실거주3년 재현.
- ✅ **건물유형 태그**(아파트/오피스텔/도시형생활주택): API `HOUSE_DTL_SECD_NM` + 무순위/임의 공고문 표/키워드 + 단지형 공공임대=normalize서 '아파트'. 공급방식(유형)과 별개 축. 매입/전세는 호별 산재라 미설정(fail-safe).
- ✅ **유형 필터 대분류/소분류**: 평평한 18개 → 4대분류(분양/공공임대/매입·전세임대/민간·특화임대) + 드릴다운(`TYPE_GROUPS`·`groupOf`·pass()의 'g:대분류').
- ✅ **임대 분석 뷰**: ① 결정론 보조뷰(`rentView` — 임대료·소득대비 부담률·거주안정성, 런타임·전건) ② 단지형 공공임대 LLM 참고분석(분양과 대칭·`build-lease-analysis-queue`→Sonnet→Opus검증, 6건 백필).
- ✅ **배점 floor 명시**: 0점구간 없는 배점표서 미입력→최저구간 자동득점을 '최소 N점·입력 시 상향'으로 정직 표기.
- ✅ **데이터 안전**: applyhome-derive 주입필드 보존 하드닝(단독 재실행 참고분석 소실 차단), SH generic '임대'→공고명 기반 구체유형 보정, inject-analysis panId 충돌가드.
- 상세: `ARCHITECTURE.md` 모듈지도 · `SCHEMA.md` §6-2 · `/update` 스킬 2.5~2.6.

## 백로그 (Backlog)

- **민간/공공 대분류 필터** (다음 세션 착수 합의): 사이트 필터에 공급주체 토글 추가 — 공공(공공기관 임대 lh/sh/gh/myhome + 공공분양) vs 민간(민영분양·무순위·임의공급·오피스텔·공공지원민간임대). **데이터(유형 6종)·매칭(민영=가점/공공=순차)은 이미 구별됨 — 필터 UI만 `site/_template.html`에 추가**(state.공급주체 + pass() 한 줄 + select 옵션). 분류 함수: `['lh','sh','gh','myhome'].includes(source) || 유형==='공공분양' ? 공공 : 민간`.
- **매칭 고도화**: 순위규칙 부분문자열매칭 휴리스틱 개선(연접지역 오탐), 예상배점 미반영 항목 축소, 우선배정(2세미만 등) 구현, 통합공공임대 소득구간 매칭 정교화.
- **UserProfile 입력 UI** (현재 `profile.json` 직접편집).
- **분양전환 추가 분석**: 현재 3건만. 10년 공공임대 분양전환 등.
- **매입/집주인 검증노트 많은 건 스팟체크**.

## 보류 (Deferred)

- **git 초기화 + Conventional Commits** — 변경/진행 이력을 커밋으로 관리. (현재 미설정. 설정 시 이 ROADMAP의 완료항목은 커밋 히스토리로 대체 가능.)

## 알려진 제약

- **0000061xxx 공고**(공공분양·공공임대 리츠): 첨부 0·공고문 본문 LH에 없음 → LH로는 요건추출 불가, pipeline에서 "검토필요"로 자동 격리. (분양은 청약홈 OpenAPI로 해결 — 위 1번.)
- 추출은 Claude Code 헤드리스 의존 → 공개 다중사용자 서비스화 시 no-API 규칙과 충돌(개인용은 무관). `DECISIONS.md` 참고.
