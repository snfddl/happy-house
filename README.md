# happy-house

LH 등 공공임대주택 공고를 **수집 → 요건 자동 구조화 → 개인 조건 매칭 → (예정) 알림**하는 개인용 서비스.
공고문(PDF)을 자격/순위/소득·자산/임대료 스키마로 뽑아, 사용자 프로필을 대입해 "지원가능/순위/예상배점"을 계산한다.

## 현재 상태 (2026-06-22)

데이터·매칭 토대 완성, **개인용으로 동작.** 알림·웹 UI는 미구현.

- ✅ **수집**: LH 청약플러스 전국×전유형 스크래핑, 신규 diff (`lh-collect.mjs`)
- ✅ **요건추출**: 공고문 PDF → 슬라이스 → Sonnet → 정규 스키마 v1, **110건** (`data/derived/lh/<panId>/requirements.json`)
- ✅ **결정론 보강**(LLM 미사용): 원문링크(`inject-links.mjs`) · 매입/전세 주택목록 xlsx 파싱(`parse-housing-xlsx.py`)
- ✅ **완전자동 파이프라인**: 수집→추출(헤드리스 `claude -p`)→보강→검증게이트 (`pipeline.mjs`)
- ✅ **매칭 엔진 v1**: 프로필 × 임대110+분양42 → 자격게이트·계층·순위·예상배점·면적/지역, 공급형태(지원형/실물/분양)·분양전환 필터 (`match.mjs`)
- ✅ **분양(청약홈)**: OpenAPI 수집→결정론 매핑→가점 84점·청약순위·지역우선·특공해당 매칭 (민영=가점/공공=순차)
- ✅ **조회 페이지**: `build-site.mjs` → `site/index.html` 자체완결 정적(임대+분양, 필터·검색·상세, **브라우저 내 조건수정→실시간 재계산**, 검증된 원문링크)
- ⏳ **다음**: 알림 레이어. → `ROADMAP.md`

## 빠른 실행

```bash
node pipeline.mjs          # [임대] 신규 공고 수집~추출~검증 완전자동 (PIPELINE.md 참고)
node match.mjs             # profile.json 으로 임대110+분양42 매칭 (로직=match-core.mjs 공유)(--possible/--supply=/--type=)
node applyhome-collect.mjs # [분양] 청약홈 OpenAPI 수집 (--since=2026-05-01 / --include-rent)
node applyhome-derive.mjs  # [분양] raw → requirements.json 결정론 매핑(LLM 미사용)
node build-site.mjs        # [공유용] 조회 페이지 → site/index.html (기본프로필 빈값, 방문자가 입력)
node build-site.mjs --seed # [개인용] 내 profile.json을 기본값으로 미리채움
```

**배포(공유):** `site/index.html`은 의존성 없는 단일 파일. 정적 호스팅 아무 곳에나 업로드하면 됨(GitHub Pages·Netlify drag&drop·Vercel·Cloudflare Pages). 방문자 조건은 각자 브라우저 localStorage에만 저장(서버 전송 없음). 첫 방문 시 온보딩으로 조건 입력 유도. 데이터 갱신 시 재빌드 후 재업로드.

## 문서 맵

| 문서 | 내용 |
|---|---|
| `README.md` | 진입점·현재 상태·실행 (이 문서) |
| `ROADMAP.md` | 다음 할 일·백로그 |
| `DECISIONS.md` | 주요 결정과 그 이유 (경량 ADR) |
| `CLAUDE.md` | 작업 규칙(절대규칙 포함) — 에이전트/기여자용 |
| `match-core.mjs` | 매칭 로직 단일 소스(순수 함수) — `match.mjs`·조회페이지 공유 |
| `PIPELINE.md` | 신규 공고 처리 파이프라인 런북 |
| `SCHEMA.md` | 데이터 스키마(3층: UserProfile·NoticeRequirements·Matching). §6=분양 변형 |
| `schema-v1.jsonc` / `schema-sale-v1.jsonc` | 임대 / 분양 requirements 컴팩트 스키마 |
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
