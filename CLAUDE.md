# happy-house — 프로젝트 규칙
0. Short-term bypasses that risk long-term complications are never an option.
1. Think Before Coding

Don't assume. Don't hide confusion. Surface tradeoffs.

Before implementing:

    State your assumptions explicitly. If uncertain, ask.
    If multiple interpretations exist, present them - don't pick silently.
    If a simpler approach exists, say so. Push back when warranted.
    If something is unclear, stop. Name what's confusing. Ask.

2. Simplicity First

Minimum code that solves the problem. Nothing speculative.

    No features beyond what was asked.
    No abstractions for single-use code.
    No "flexibility" or "configurability" that wasn't requested.
    No error handling for impossible scenarios.
    If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify. 3. Surgical Changes

Touch only what you must. Clean up only your own mess.

When editing existing code:

    Don't "improve" adjacent code, comments, or formatting.
    Don't refactor things that aren't broken.
    Match existing style, even if you'd do it differently.
    If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

    Remove imports/variables/functions that YOUR changes made unused.
    Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request. 4. Goal-Driven Execution

Define success criteria. Loop until verified.

Transform tasks into verifiable goals:

    "Add validation" → "Write tests for invalid inputs, then make them pass"
    "Fix the bug" → "Write a test that reproduces it, then make it pass"
    "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]


LH 등 임대주택 공고 수집·요건 추출·알림 개인용 서비스.
**전체 아키텍처는 `ARCHITECTURE.md`**, 설계 상세는 `SCHEMA.md`, 스크래핑 RE 노트는 `LH_SCRAPE_NOTES.md`, 신규 공고 처리 파이프라인은 `PIPELINE.md` 참고.

**진입점: `node process-all.mjs`** — 전 5소스(LH·청약홈·마이홈·SH·GH)를 수집→파생/요건추출→정규화→검증게이트→사이트빌드까지 통합 처리하는 얇은 시퀀서. 외부 LLM API 0.
  - **LH 단일 파이프라인은 그 하위 단계인 `node pipeline.mjs`** (수집→타깃선정→슬라이스→요건추출(헤드리스)→xlsx파싱→링크주입→검증게이트, 신규만 증분). 한 소스만 돌릴 땐 기존 진입점 직접 호출도 그대로 유효.

## 1. 절대 규칙

- **외부 LLM API 사용 금지.** Anthropic/OpenAI/Gemini 등 유료 LLM API를 코드에서 호출하지 않는다.
  - 공고문 요건 추출 같은 LLM 작업은 **Claude Code 에이전트(이 세션/슬래시 명령/워크플로우)로** 수행한다 — API 키·과금 없음 (CertiQ의 vision 추출 패턴과 동일).
  - `reference/extract-requirements.mjs`의 API 호출 방식은 참고용일 뿐, 실제 파이프라인에서는 쓰지 않는다(죽은코드 격리 — `reference/README.md`).

## 2. LH 수집 (lh-collect.mjs)

(청약홈·마이홈·SH·GH 수집 규칙은 각 `*-collect.mjs` 헤더와 `ARCHITECTURE.md` 참고. 아래는 주 소스인 LH 기준.)

- 대상: **전국 × 전 임대유형**. 기간은 **2026-05-01 이후** 공고만 (과거/마감 공고 제외).
- 상태: **접수중·공고중·정정공고중**만 추출 대상. **접수마감 제외.**
  - 단, 어떤 유형에 활성 공고가 0건이면 **가장 최근 접수마감 1건**을 백필(유형 커버리지 유지).
- 첨부는 **.pdf 우선** (HWP→PDF 변환은 불안정하므로 회피, PDF 없을 때만 fallback).
- **형식 필터(다운로드 단계)**: 파서 있는 **.pdf(요건추출)·.xlsx(주택목록)만 다운로드**. hwp/hwpx는 **그 공고에 PDF 없을 때만** fallback 보존. zip·이미지·서식 등 파서0 형식은 **fileid만 meta에 `skipped:'비요건형식'`로 기록, 다운로드 안 함**(불변 raw 비대 방지·재다운 가능). 확장자 미상은 fail-safe 보존.
- **팸플릿류(평면도·조감도 책자 등 요건 없는 홍보물) 제외** — fileid만 meta에 기록(`skipped:'팸플릿류'`), 다운로드 안 함.
- 원본 보관: `data/raw/` 는 **불변(immutable)**. 재파싱 대비 원본 PDF 보존. `data/derived/` 는 재생성 가능.
- 신규 감지: `data/index.json` diff. 이미 받은 공고는 재다운로드 없이 상태·날짜만 갱신.

## 3. 요건 추출

- 텍스트형 PDF는 **pdftotext -layout** 로 추출(OCR 불필요), 이미지형만 OCR.
- **추출 전 슬라이서(`slice-notice.mjs`, 레버 A) 적용** — 유형공통 보일러플레이트(신청방법·제출서류·산정방법·유의사항·시공·편의시설) 제거. 결정론적·무손실.
  - 제거는 **섹션 제목 블랙리스트로만** 판단. 요건 섹션(신청자격·선정기준·임대조건·소득자산기준)은 절대 제거 안 됨.
  - 못 알아보는 섹션은 **무조건 보존(fail-safe)**. 전 유형 검증 결과 요건표 손실 0건, 평균 ~21% 입력 절감(LH 265건 전수 실측: 건별평균 21.0%·총합 20.3%·중앙값 18.5%).
- **추출 모델 = Sonnet.** Haiku는 품질 부적합(쓰지 않음). Opus는 검증/감수용.
- **추출 골격 = `extract-core.mjs` 단일 소스** (buildExtractPrompt mode=new[LH 신규생성]/merge[myhome·sh·gh envelope MERGE] · runHeadless · postProcess · 큐 `extract-queue.json`). pipeline·myhome-pipeline·`/update` 워크플로우가 공유.
- **추출 실행 경로**: 로컬 대화형은 **`/update` 스킬(워크플로우 병렬·빠름)** 권장, 무인 cron은 `node process-all.mjs`(헤드리스 `claude -p`·conc 3·느림). **품질 동일**(같은 프롬프트·스키마), 속도만 다름. 상세는 `PIPELINE.md`·`ARCHITECTURE.md`.
- 출력은 `SCHEMA.md` §5 **정규 스키마 v1** 형태로 `data/derived/lh/<panId>/requirements.json` 에 저장.
  - 선정방식은 enum 1개, 소득기준은 항상 object, 임대료는 항상 배열. 못 채운 필드는 `_검증노트`에 기록.
  - 자격완화로 소득 배제 시 `소득기준.종류:"없음"` + 비고에 근거. 자산/자동차상한은 숫자(원)·"없음"·"공고문미기재".

## 3.5 계층별 메타 정규화 (normalize-requirements.mjs)

- 추출(Sonnet)이 `계층별` 키/필드를 자유형으로 뱉으면(`총자산상한` vs `자산상한`, `신혼부부·한부모가족` vs `…계층` 등) 매칭이 깨진다. **결정론·멱등 정규화를 반드시 통과**시킨다(파이프라인 [3.5] 단계, 단독 재실행 가능).
- **계층 키 enum**(8종): 대학생·청년·신혼·한부모·고령자·주거급여수급자·산업단지근로자·주거약자·일반. **내부 필드 enum**: 자산상한·자동차상한·소득기준·청약요건·연령·무주택·대상·비고. 금액은 원(정수). top-level "계층별 상이: …" 설명형은 "공고문미기재"로 정규화(매처가 계층별로 위임).
- 미상 키/필드는 **보존(fail-safe)**. `match-core`의 `tierLimit`/`tierKeyFor`가 캐논 키로 본인 계층값을 평가하므로 **키/필드 일관성이 매칭 정확도에 직결**.

## 4. 작업 원칙

- 토큰/비용 의식: 단순하게, 꼭 필요한 것만. 품질 깎는 최적화는 하지 않는다(건수·모델·보일러플레이트 제거로 절감).
- 검증되지 않은 것을 "됐다"고 보고하지 않는다. 테스트한 것만 테스트했다고 한다.
- **사용자 의견에 무조건 동의하지 않는다.** 객관적으로 분석·판단해 근거를 제시하고, 더 나은 방안이 있으면 적극 개진한다(맞으면 동의, 아니면 대안·트레이드오프를 명확히).
- 매처는 `match-core.mjs` 단일 소스(`match.mjs`·조회페이지 공유). 브라우저 인라인용이라 **import 금지**(필요한 헬퍼는 인라인 복제).

## 5. 배포 / 운영 (DEPLOY.md)

- **무료 자동배포**: GitHub Actions + Pages. **결정론 단계만 CI에서**(키 0) — 수집(`--refresh`)·정규화·빌드·배포. cron 하루 3회 상태/마감일 갱신 + main push 시 즉시 빌드·배포.
- **요건추출(LLM)은 CI에서 하지 않는다.** 신규 공고는 CI가 GitHub 이슈로 알리고, **로컬 `node process-all.mjs`**(LH만이면 `pipeline.mjs`)로 추출·정규화 후 커밋·push(외부 API 0 규칙 유지).
- `data/raw/`(불변·대용량)와 개인 `profile.json`은 **gitignore**(공개 repo 유출 방지). CI 빌드는 `--seed` 없이 빈 프로필.
- `build-site.mjs`는 빌드 때 `index.json`의 최신 상태/마감일을 오버레이(신선도). `lh-collect --refresh`는 다운로드 없이 상태만 갱신·신규는 `new-pending.json`에 기록.

## 6. 문서 동기화 (정의-of-done)

**구조·파이프라인·스키마를 바꾸면 같은 작업 안에서 해당 문서를 갱신한다.** 문서 미반영은 작업 미완료로 본다(코드만 커밋 금지). 변경→문서 매핑:

| 변경한 것 | 갱신할 문서 |
|---|---|
| 스크립트/단계 추가·삭제·역할변경 | `ARCHITECTURE.md` 모듈지도 (LH `pipeline.mjs` 단계면 `PIPELINE.md`도) |
| `requirements.json` 필드 추가·타입변경 | `SCHEMA.md` (임대 §5 / 분양 §6) |
| `/update` 단계 변경 | `.claude/skills/update/SKILL.md` |
| `process-all.mjs` 단계 변경 | `process-all.mjs` 주석 + `ARCHITECTURE.md` |
| 기능 완료/착수 | `ROADMAP.md` |
| 항구적 설계결정·함정·재탐색방지 사실 | 메모리(`architecture-audit`) + 필요시 `DECISIONS.md` |

- 원칙: **단일 출처**. 같은 사실을 여러 문서에 복붙하지 말고, 상세는 한 곳(보통 ARCHITECTURE/SCHEMA)에 두고 나머지는 링크/포인터. 메모리는 "재탐색 방지 핵심 사실"만.
- 커밋 전 셀프체크: 이번 diff에 `*.mjs`/스키마 변경이 있는데 대응 `*.md`가 안 바뀌었으면 누락 의심. (백스톱으로 git 훅 경고를 둘 수 있음 — `.claude/settings.json`.)
