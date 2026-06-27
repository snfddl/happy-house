# ARCHITECTURE — 전체 구조 한 장

happy-house는 **5개 공공주택 소스를 단일 스키마(envelope)로 통합**해, 사용자 프로필을 대입하면 "지원가능/순위/예상배점"을 브라우저에서 즉시 계산하는 정적 사이트다.
핵심 설계: **수집·파생은 소스마다 다르되, 산출물(`requirements.json`)은 전 소스 동일 envelope** → 매처·사이트는 단 하나의 형태만 읽는다.

데이터 흐름 상세 규칙은 `CLAUDE.md`(절대규칙)·`SCHEMA.md`(스키마)·`PIPELINE.md`(LH 런북)·`DEPLOY.md`(배포)로 분기. 이 문서는 그 위를 가로지르는 **지도**다.

## 절대 제약 (왜 이런 구조인가)

- **외부 LLM API 0** (`CLAUDE.md §1`). 요건추출은 Claude Code 헤드리스(`claude -p`, Sonnet)로 — API 키·과금 없음. 그래서 LLM 단계는 **CI 불가 → 로컬 전용**, CI는 결정론만.
- **`raw/` 불변, `derived/` 재생성 가능.** 재파싱 대비 원본 보존, 파생은 언제든 다시 찍는다.
- **`match-core.mjs`는 브라우저 인라인용 → 외부 import 금지** (`CLAUDE.md §4`, 필요한 헬퍼는 인라인 복제). CLI(`match.mjs`)는 Node라 match-core를 import해 공유하지만, match-core 자신은 `normalize-requirements`의 계층 캐논 함수를 import할 수 없어 양쪽에 복제된다 → `check-canon-drift.mjs`가 본문 동일성 assert로 드리프트를 차단(빌드 전).

## 데이터 흐름

```
                         ┌──────────────── 진입점: node process-all.mjs (얇은 시퀀서) ────────────────┐
                         │                                                                            │
  [수집 collect]         │   [파생/요건추출 derive/extract]            [검증]          [빌드]          │
  소스 사이트/API ──▶ raw/<source>/ ──▶ derived/<source>/requirements.json ──▶ (gate) ──▶ site/index.html
   (불변)                    (불변)            = 통합 envelope (SCHEMA §0)                  (정적·의존성 0)
                                                                                              │
  ┌─ lh        : lh-collect ──────▶ pipeline.mjs: slice-notice→claude -p(Sonnet)             │
  │                                  →normalize-requirements→parse-housing-xlsx.py→inject-links
  ├─ applyhome : applyhome-collect(OpenAPI) ──▶ applyhome-derive  (결정론 매핑, LLM 0)        │
  ├─ myhome    : myhome-collect ─┐                                                            │
  ├─ sh        : sh-collect ─────┼──▶ myhome-pipeline --source=<src>: PDF 소득/자산/계층      │
  └─ gh        : gh-collect ─────┘                            추출(claude -p, Sonnet)         │
                                                                                              ▼
   공통: collect-util.mjs              공통 게이트: validate-requirements.mjs          빌드 전 가드:
   (목록·envelope 헬퍼)                 (pass / review / fail)                          check-canon-drift.mjs
                                                                                       (드리프트 시 빌드 차단)
                                            브라우저에서 실시간 매칭 ▶ match-core (site/index.html에 인라인 복제)
                                            CLI 매칭 ▶ match.mjs (Node — match-core를 정당하게 import)
```

## 소스별 파생 경로 (왜 3갈래인가)

| 소스 | 수집 | 파생/추출 | LLM | 비고 |
|---|---|---|---|---|
| **lh** (주 소스) | `lh-collect.mjs` | `pipeline.mjs` 6단계 | ✅ Sonnet | 공고문 PDF→슬라이스→추출→정규화. 런북=`PIPELINE.md` |
| **applyhome** (분양) | `applyhome-collect.mjs` (청약홈 OpenAPI) | `applyhome-derive.mjs` | ❌ | API가 구조화 데이터 제공 → 결정론 매핑만 |
| **myhome/sh/gh** (지방·서울·경기 임대) | `*-collect.mjs` (API/스크래핑) | `myhome-pipeline.mjs --source=` | ✅ Sonnet | 목록만 구조적, 소득/자산은 공고문 PDF에서 추출 |

`process-all.mjs`는 이 3갈래를 소스 순회로 호출 + 마지막에 `build-site`·`notify`(구독자 알림) 한다. 단계 실패는 격리(한 소스 실패가 나머지·빌드를 막지 않음). 한 소스만 처리하려면 위 진입점을 직접 호출해도 동일.

## 통합 envelope (SCHEMA §0)

모든 `requirements.json`은 공유 envelope를 가진다 — `panId`·`source`·`상품군`(`임대`|`분양`, **매처 라우팅 키**)·공통 메타·`단지[]`·`공급형[]`·`선정방식`·`원문링크`·`_검증노트`/`_갭`. 그 위에 상품별 타입블록(임대=자격요건/계층별 §5, 분양=가점/특공 §6)을 얹는다.

- 결정론·멱등 정규화가 envelope를 보장: 청약홈=`applyhome-derive`, LH/마이홈계열=`normalize-requirements`(`CLAUDE.md §3.5`). 기존 레코드는 **LLM 재추출 없이** 이 단계 재실행으로 마이그레이션.
- 매처는 `상품군`으로 라우팅: `분양→evaluateSale`, `임대→evaluate`.
- `source` 값 5종: `lh`·`applyhome`·`myhome`·`sh`·`gh`. (SCHEMA §0 표의 enum은 초기 3소스 기준 — sh/gh는 myhome 파이프라인 공유로 추가됨.)

## 모듈 지도

- **오케스트레이션**: `process-all.mjs`(무인 진입점·헤드리스 추출) · `/update` 스킬(대화형 진입점·워크플로우 병렬 추출) · `pipeline.mjs`(LH 하위)
- **수집**: `lh-collect` · `applyhome-collect` · `myhome-collect` · `sh-collect` · `gh-collect` · `collect-util`(공통; `writeJSONIfChanged`로 inject/normalize 쓰기를 content-guard — 내용 동일 시 미저장이라 포맷·키순서 변경 churn 없음)
- **추출 골격**: `extract-core`(buildExtractPrompt mode=new/merge · runHeadless · postProcess · toQueueItem/mergeQueue → `extract-queue.json`) — pipeline·myhome-pipeline·`/update` 워크플로우(`update-extract.workflow.mjs`)가 공유하는 단일 소스
- **파생**: `slice-notice`(보일러플레이트 제거) · `applyhome-derive`(분양 결정론·LLM 0, ⚠️기존 주입필드[참고분석·전매/실거주·PDF링크·건물유형·네이버부동산] 이월 보존 — 단독 재실행 데이터유실 방지) · `myhome-pipeline`(myhome/sh/gh 슬라이스+추출) · `parse-housing-xlsx.py`(주택목록) · `inject-links`(원문링크) · `resolve-naver`(분양 네이버 딥링크 — 통합검색 HTML서 build_dtl_cd/supp_cd+좌표 추출·등록명 검증게이트, 외부API0·증분, 미해결은 사이트 통합검색 폴백. 검증된 분양 좌표를 `geo-cache.json`에도 무료 시드 → 지도 핀)
- **지도 좌표(로컬 전용 키 단계·키-0 폴백)**: `geo.mjs`(사이드카 캐시 `data/derived/geo-cache.json` — 정규화 주소/지역 키, 제공자 추상화) + `geocode`(전 소스 단지 주소→좌표, Kakao Local·증분·멱등; 키 없으면 skip). 좌표는 derive 재생성에 면역하도록 **requirements.json이 아닌 주소키 사이드카**에 보관. build-site가 주소키로 조인해 `좌표목록` 임베드(미스는 시군구 centroid 폴백). CI는 캐시만 읽음(키-0).
- **청약홈 공고문 PDF(로컬 전용·raw gitignore)**: `inject-applyhome-pdf`(상세페이지서 getAtchmnfl 직링크+로컬 다운로드) → `inject-applyhome-notice`(공고문 '단지 주요정보' 표 → 전매/실거주/재당첨/건물유형 결정론 추출, 헤더 토큰 컬럼 밴드 파싱·LLM 0)
- **정규화·검증**: `normalize-requirements`(캐논화 + 단지형 임대 `건물유형`='아파트' + SH generic '임대'→공고명 기반 구체유형 보정) · `validate-requirements`(게이트) · `check-canon-drift`(드리프트 가드)
- **AI 참고분석(비결정론·로컬·외부 API 0)**: `build-analysis-queue`(무순위/임의 분양) · `build-lease-analysis-queue`(단지형 임대; 기본 접수중·접수예정, `--공고중-수도권` 플래그로 공고중 상시모집 중 수도권·광역시 백필) → Sonnet 생성 → Opus 적대검증 → `inject-analysis`(소스무관·panId 충돌가드). staging json은 gitignore, 영구기록은 requirements.참고분석
- **매칭**: `match-core`(로직 단일 소스 — 판정·가점·배점[미입력 floor='최소'표기]·임대 보조뷰 `rentView`[부담률·거주안정성·면적앵커(전용범위·평형수)]) · `match.mjs`(CLI) — 사이트는 인라인본(유형 대분류/소분류 `TYPE_GROUPS`·`groupOf`)
- **빌드·운영**: `build-site`(→`site/index.html`, match-core·전 소스 derived·**Leaflet 벤더(`data/vendor/`) 인라인** + `geo-cache` 조인해 `좌표목록` 임베드. 인라인 직전 **비렌더 내부/감수 필드 blocklist strip**(`_검증노트`·`선정방식상세`·`첨부.name` 등 매처·템플릿 미사용분, ~27%↓; source는 보존, `원문링크.로컬PDF` 절대경로 누출도 차단)) · `prune-index`(오래된 마감 아카이브) · `.github/workflows/refresh.yml`(CI). 사이트 UI에 **지도 연동**(핀↔카드·지역선택 줌·'이 지도 영역만' 가시영역 필터, 키 0·타일만 네트워크)
- **알림(구독·발송, 로컬 전용·외부 LLM 0)**: `notify.mjs`(process-all 마지막 단계) — 활성 공고를 구독자 프로필로 `match-core` 매칭해 `sent`에 없는 매칭분만 Resend로 이메일 다이제스트 발송(매칭=결정론·저장/조회=Supabase REST·발송=Resend REST, 전역 fetch·신규 의존성 0). env(SUPABASE_URL/SERVICE_KEY·RESEND_API_KEY) 없으면 graceful skip(CI·타인 환경 무결). 중복발송 방지의 단일 권위=`sent` 테이블, 구독자당 하루 상한=`NOTIFY_DAILY_CAP`. 저장소=Supabase Postgres `supabase/schema.sql`(`subscribers`·`sent`·RLS·`unsubscribe` RPC): anon(브라우저)은 **가입 INSERT·해지 RPC만**, PII 읽기/수정은 RLS로 차단, service_role(notify)만 전체 접근. 가입 UI=`site/_template.html` '🔔 알림 받기'(build-site가 `SUPABASE_URL`+`SUPABASE_ANON_KEY` env 주입 시에만 노출, anon키는 공개 의도), 해지=`site/_unsubscribe.html`→`unsubscribe.html`(토큰=`subscribers.id`로 `unsubscribe` RPC, 서버 0)
- **테스트**: `test-match-core.mjs`(매처 회귀 17케이스)

## 배포 경계 (DEPLOY.md)

- **CI(GitHub Actions)** = 결정론만: `lh-collect --refresh`(상태/마감일 갱신, 다운로드 0) → `build-site` → Pages 배포. cron 하루 3회 + main push 즉시.
- **로컬** = LLM 추출 포함 전체: `node process-all.mjs` → 커밋·push. 신규 공고는 CI가 GitHub 이슈로 알림.
- `data/raw/`·`profile.json`은 gitignore(공개 repo 유출 방지). CI는 빈 프로필로 빌드, 방문자 조건은 브라우저 localStorage에만 저장.
