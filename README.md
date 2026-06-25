# happy-house

LH 등 공공임대주택 공고를 **수집 → 요건 자동 구조화 → 개인 조건 매칭 → (예정) 알림**하는 개인용 서비스.
공고문(PDF)을 자격/순위/소득·자산/임대료 스키마로 뽑아, 사용자 프로필을 대입해 "지원가능/순위/예상배점"을 계산한다.
**5소스(LH·청약홈·마이홈·SH·GH)를 단일 envelope로 통합** — 진입점 `node process-all.mjs`, 전체 구조는 `ARCHITECTURE.md` 참고.

## 현재 상태 (2026-06-24)

데이터·매칭·웹 UI·**무료 자동배포**까지 동작. → **라이브: https://snfddl.github.io/happy-house/**

- ✅ **수집**: LH 청약플러스 전국×전유형 스크래핑, 신규 diff (`lh-collect.mjs`). `--refresh`=상태/마감일만 갱신(다운로드 없음, CI용)
- ✅ **요건추출**: 공고문 PDF → 슬라이스 → Sonnet → 정규 스키마 v1, **126건** (`data/derived/lh/<panId>/requirements.json`)
- ✅ **계층별 메타 정규화**(결정론·멱등): 추출 자유형 → 캐논 키/필드(`normalize-requirements.mjs`, 파이프라인 [3.5])
- ✅ **결정론 보강**(LLM 미사용): 원문링크(`inject-links.mjs`) · 매입/전세 주택목록 xlsx 파싱(`parse-housing-xlsx.py`)
- ✅ **완전자동 파이프라인**: 수집→추출(헤드리스 `claude -p`)→정규화→보강→검증게이트 (`pipeline.mjs`)
- ✅ **매칭 엔진 v1**: 프로필 × 임대+분양 → 자격게이트·계층(캐논 fallback)·순위·예상배점·면적/지역, 공급형태·분양전환·분양(전환) 필터 (`match.mjs`/`match-core.mjs`)
- ✅ **분양(청약홈)**: OpenAPI 수집→결정론 매핑→가점 84점·청약순위·지역우선·특공해당 매칭 (민영=가점/공공=순차)
- ✅ **멀티소스 임대**: 마이홈포털(지방공사 API) + **SH(서울 i-sh.co.kr)·GH(경기 apply.gh.or.kr) 스크래핑** — data.go.kr에 SH/GH 실시간 공고API 없어(정적 fileData뿐) 사이트 직접 수집. 통합 envelope(SCHEMA §0)로 매처·사이트가 단일 형태로 소비. 소득/자산은 공고문 PDF 추출(`myhome-pipeline.mjs --source=sh|gh`)
- ✅ **웹 UI**: 자체완결 정적 `site/index.html` — 첫 방문 **단계별 마법사**, 시·도→시·군·구 콤보박스, 희망지역 다중선택, **자격/희망 분리**, 청약통장·무주택기간 친화입력, 필터·검색·상세, **브라우저 내 조건수정→실시간 재계산**(총 168건 인라인)
- ✅ **무료 자동배포**: GitHub Actions cron(하루 3회 상태갱신) + push 트리거(즉시 배포) → GitHub Pages (`.github/workflows/refresh.yml`). 자세히는 `DEPLOY.md`
- ⏳ **다음**: 알림 레이어. → `ROADMAP.md`

## 사전요건

- **Node 20+** — `Headers.getSetCookie`(LH 세션쿠키 파싱)에 필요. 미만이면 `lh-collect`가 명시적 중단.
- **`pdftotext`**(poppler) — 공고문 PDF→텍스트(슬라이스 입력). · **`python3`** — 매입/전세 주택목록 xlsx 파싱. · **`claude`**(Claude Code CLI) — 헤드리스 요건추출(외부 LLM API 0).
- `node pipeline.mjs`는 시작 시 위 바이너리 부재를 경고로 가시화한다(조건부 단계라 중단은 안 함).

## 빠른 실행

```bash
node process-all.mjs           # [전 소스] 진입점 — LH·청약홈·마이홈·SH·GH 수집~파생/추출~검증~사이트빌드 통합 (--source=sh,gh / --skip-collect / --semi / --no-build)
node pipeline.mjs              # [임대·LH] 신규 공고 수집~추출~정규화~검증 완전자동 (process-all의 LH 하위 단계, PIPELINE.md 참고)
node normalize-requirements.mjs # 계층별 메타 캐논 정규화(파이프라인에 포함, 단독 재실행 가능. --report=미저장 점검)
node match.mjs                 # profile.json 으로 임대+분양 매칭 (로직=match-core.mjs 공유)(--possible/--supply=/--type=)
node applyhome-collect.mjs     # [분양] 청약홈 OpenAPI 수집 (--since=2026-05-01 / --include-rent)
node sh-collect.mjs            # [임대] SH 서울주택도시공사 스크래핑(임대 게시판, --include-sale=분양, --probe)
node gh-collect.mjs            # [임대] GH 경기주택도시공사 스크래핑(임대+매입임대, 상태/마감일 제공, --probe)
node myhome-pipeline.mjs --source=sh   # [임대] SH/GH/마이홈 공고문 PDF → 소득·자산·계층 추출(헤드리스 Sonnet)
node applyhome-derive.mjs      # [분양] raw → requirements.json 결정론 매핑(LLM 미사용)
node build-site.mjs            # [공유용] 조회 페이지 → site/index.html (빈 프로필, 방문자가 입력)
node build-site.mjs --seed     # [개인용] 내 profile.json을 기본값으로 미리채움
node lh-collect.mjs --refresh  # [CI] 상태/마감일만 갱신(다운로드 없음) + 신규 → new-pending.json
node prune-index.mjs           # [관리] 오래된 마감 공고를 index→index-archive 이관(기본 dry-run·180일, --apply로 실행)
```

**배포:** `site/index.html`은 의존성 없는 단일 파일이라 정적 호스팅 어디든 됨. 이 repo는 **GitHub Actions + Pages로 무료 자동배포** 구성 — push하면 즉시 빌드·배포, cron(하루 3회)이 상태/마감일 갱신. 요건추출(LLM)만 로컬 `node pipeline.mjs`로(외부 API 0). 신규 공고는 CI가 이슈로 알림. **구조·운영법은 `DEPLOY.md` 참고.** 방문자 조건은 각자 브라우저 localStorage에만 저장(서버 전송 없음).

## 문서 맵

| 문서 | 내용 |
|---|---|
| **개요·런북** | |
| `README.md` | 진입점·현재 상태·실행 (이 문서) |
| `ARCHITECTURE.md` | **전체 구조 한 장** — 5소스→통합 envelope→매칭→사이트 데이터 흐름·모듈 지도 |
| `PIPELINE.md` | LH 신규 공고 처리 파이프라인 런북(`pipeline.mjs` 6단계) |
| `DEPLOY.md` | 무료 자동배포(GitHub Actions + Pages) 구조·운영 런북 |
| `CLAUDE.md` | 작업 규칙(절대규칙 포함) — 에이전트/기여자용 |
| **기획·진단** | |
| `ROADMAP.md` | 다음 할 일·백로그 |
| `DECISIONS.md` | 주요 결정과 그 이유 (경량 ADR) |
| `MONETIZATION.md` | 수익화 모델(무료조회+유료알림)·호스팅 전략 |
| `PRECISION_TEST.md` | 매칭 정밀도 테스트 결과·방법 |
| `AUDIT.md` | 코드·아키텍처 진단 기록(Round 1·2, 이슈별 처리내역) |
| **핵심 코드 모듈** | |
| `process-all.mjs` | **진입점** — 전 5소스 통합 오케스트레이터(얇은 시퀀서) |
| `match-core.mjs` | 매칭 로직 단일 소스(순수 함수) — `match.mjs`·조회페이지 공유 |
| `normalize-requirements.mjs` | 계층별 메타 캐논 정규화(키/필드 enum·만원→원·멱등) |
| `validate-requirements.mjs` | 전 소스 공통 요건 검증 게이트(pass/review/fail) |
| `check-canon-drift.mjs` | 계층 캐논 함수 드리프트 가드(매처↔정규화 동일성 assert, 빌드 전 차단) |
| `collect-util.mjs` | 5종 수집기 공통 순수유틸(목록·envelope 헬퍼) |
| **스키마·CI** | |
| `SCHEMA.md` | 데이터 스키마(3층: UserProfile·NoticeRequirements·Matching). §0=통합 envelope, §6=분양 변형 |
| `schema-v1.jsonc` / `schema-sale-v1.jsonc` | 임대 / 분양 requirements 컴팩트 스키마 |
| `.github/workflows/refresh.yml` | CI: cron 상태갱신 + push 자동배포 → Pages |
| **소스 RE 노트** | |
| `LH_SCRAPE_NOTES.md` | LH 스크래핑 리버스엔지니어링 노트 |
| `청약홈_분양_API_노트.md` | 분양 확장 — 청약홈 OpenAPI 소스 노트(엔드포인트·필드·구현계획) |

## 핵심 산출물

- `data/raw/lh/<panId>/` — 원본(PDF·xlsx·meta.json). **불변**
- `data/raw/applyhome/<no>/` — [분양] 청약홈 원본 `detail.json`·`models.json`(불변) + `meta.json`(정규화)
- `data/derived/applyhome/<no>/requirements.json` — [분양] §6 분양 requirements(결정론 매핑)
- `data/derived/lh/<panId>/requirements.json` — 정규 스키마 v1 요건
- `data/derived/lh/<panId>/housing_list.json` — 매입/전세 호별 목록
- `profile.json` — 사용자 프로필(매칭 입력) / `data/match-result.json` — 매칭 결과
- `site/index.html` — 조회 페이지(빌드 산출물) / `site/_template.html` — UI 템플릿
