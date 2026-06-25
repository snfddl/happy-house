# 코드·아키텍처 진단 (2026-06-25)

5개 소스(LH/청약홈/마이홈/SH/GH) 연동 완료 시점의 구조 점검. 멀티에이전트 병렬 진단(아키텍처·코드품질·자원효율) 결과 종합. **수정은 미착수 — 내일 전건 처리 예정.**

## 한 줄 결론

읽기 경로(envelope 스키마·매처·사이트)는 단일 스키마로 잘 통합돼 지속가능. 그러나 **쓰기 경로(오케스트레이션·정규화·신선도·CI)가 전부 LH를 1급 시민으로 두고 나머지 4소스를 곁가지로 처리** → envelope가 약속한 "새 소스 = 매핑 함수 1개" 이점을 운영 레이어가 못 따라감. P0 두 건은 사용자에게 잘못된 결과를 보여주는 정확도/정직성 버그(비LH 건수가 적어 아직 미표면화).

## 우선순위 작업 목록

### P0 — 정확도/정직성 (사용자에게 잘못된 결과)

- [x] **정규화 소스 확장.** ~~`normalize-requirements.mjs:10`이 `data/derived/lh/`만 정규화 → myhome/sh/gh 계층 키가 자유형(`신혼부부·한부모가족`)으로 남아, 매처 `tierLimit`/`tierKeyFor`(`match-core.mjs:97-112`)가 캐논 키(`신혼·한부모`)로 못 찾음 → **자산/소득 게이트 조용히 누락**. `myhome-pipeline.mjs:114`가 이 누락을 스스로 인정(placeholder).~~
  - **수정완료(2026-06-25):** `normalize-requirements.mjs`에 `--source=`(기본 lh, 하위호환) 추가·`DERIVED` 파라미터화, `r.source='lh'` 강제스탬프 → `r.source || SOURCE`(myhome/sh/gh 자체 source 보존)로. `myhome-pipeline.mjs:113` placeholder → `execFileSync`로 `--source=${SOURCE}` 실호출. 검증: sh `대상계층` 자유형(`보호대상 한부모가족`·`자립준비청년`)이 캐논(`신혼·한부모`·`청년`)으로 변환·중복제거됨, source 오염 0건.
- [x] **신선도 상태 재계산.** ~~SH는 모든 공고를 `상태:'공고중'`으로 박고 갱신원 없음(`sh-collect.mjs:103,154`) → 마감돼도 영원히 "공고중". applyhome은 collect 시점 meta값 고정(`applyhome-derive.mjs:52`), `build-site.mjs:8` LIVE_OVERLAY=`{lh,gh}`에 둘 다 없어 오버레이 보정도 못 받음.~~
  - **수정완료(2026-06-25):** `build-site.mjs`에 `freshStatus(b,e,prev)` 추가 — 마감일 경과건만 `TODAY` 기준 `접수마감`으로 결정론 강등(그 외 상태는 보존해 `정정공고중` 등 활성뉘앙스 평탄화 안 함), 오버레이 후 전 레코드 적용. 검증: 199건 정직 강등, 활성 잔존 누수 0. 날짜 자체 없는 활성건은 `마감일미상` 플래그→`match-core`(두 결과객체)·`_template.html ddayHtml` "마감일 미상" 뱃지로 정직 표시.
  - **SH 날짜 정밀화(2026-06-25, 사용자 지적 반영):** SH 마감일은 사실 대부분 첨부 PDF 추출로 이미 확보(18/20)됨 — 앞 진단의 "SH는 HWP뿐" 전제가 오류였음. 잔여 누락 4건 진단→처리: ②발표글 2건(`입주대상자/서류심사대상자 발표`)은 모집공고 아님 → `sh-collect.mjs SKIP_TITLE`에 `대상자\s*발표` 추가로 제외(index+derived+raw 삭제), ①PDF없이 HWP만 첨부된 303858은 상세 본문 작성자 기재 신청기간을 `parseBodyDates`로 백필(접수 5.4~마감 5.22 → 접수마감), ①상시모집 304968만 마감일 null 유지(`마감일미상` 뱃지 정당). 신규 수집에도 본문 백필 적용, 기존분은 `--reparse`(재다운로드 없이 제목필터 재적용+본문 백필). 22건 전수 파서 검증: 접수기간·발표일 오탐 0.

### P1 — 지속가능성 (쓰기 경로 LH 편중) — ✅ 완료(2026-06-25)

- [x] **오케스트레이션 통합.** ~~`pipeline.mjs`에 비LH 참조 0건 → 신규 처리 절차가 소스 수만큼 분기.~~
  - **완료:** `process-all.mjs`(얇은 시퀀서) 신설 — 소스 순회로 기존 진입점(LH=pipeline, applyhome=collect+derive, myhome/sh/gh=collect+myhome-pipeline) 호출 + build-site. `--source=`/`--skip-collect`/`--semi`/`--no-build`, 단계실패 격리. `DEPLOY.md` 런북을 process-all 기준으로 갱신.
- [x] **검증 게이트 비LH 적용.** ~~필수필드/enum/격리/리포트가 LH(`pipeline.mjs:208-248`)에만.~~
  - **완료:** `validate-requirements.mjs` 공통 모듈 추출(validateReq/validateFile/buildReport/printReport). pipeline.mjs(동작동일)·myhome-pipeline.mjs([4/4] 게이트, `data/<source>-report.json`)가 공유. 미추출(소득·자산 모두 공고문미기재)은 fail 아닌 review로(오탐 방지). 검증: lh 선정방식 enum위반 1건 fail 포착.
- [x] **CI 멀티소스 갱신.** ~~`refresh.yml`이 `lh-collect --refresh`만 → 비LH 신규 미감지·미알림.~~
  - **완료(범위=SH/GH, 사용자 결정):** sh/gh-collect에 `--refresh`(신규 감지→new-pending, 다운로드 없음, 키 불필요) 추가, `mergeNewPending` 소스별 병합. lh-collect는 키 부재 시 graceful skip(CI 안 깨짐). refresh.yml에 lh/sh/gh --refresh 순차. **lh/applyhome/myhome(키 필요)은 로컬 process-all 유지.** 검증: sh 실신규 2건 알림, raw 무변화.

### P2 — 코드 부채

- [x] **`canonTier` 드리프트 가드.** ~~`match-core.mjs:84-95` ↔ `normalize-requirements.mjs:17-28`이 주석 한 줄 빼고 바이트 동일. 계층 enum은 도메인 규칙이라 한쪽만 고치면 조용한 매칭 오류. `match-core`는 브라우저 인라인용이라 import 금지(`CLAUDE.md §4`) → 빌드/CI에 "두 함수 본문 동일성 assert" 추가로 드리프트 차단.~~
  - **완료(2026-06-25):** `check-canon-drift.mjs` 신설 — 두 함수 본문을 중괄호 매칭으로 추출, 줄주석·들여쓰기·함수명 차이만 정규화로 흡수하고 규칙 본문(replace+8 if+return)을 바이트 비교. `build-site.mjs`가 빌드 전 `execFileSync`로 호출 → 로컬(process-all)·CI(refresh.yml의 빌드 스텝) 양쪽에서 드리프트 시 빌드 실패. 양 함수에 상호참조 주석 추가. 검증: 동의어 1개 주입 시 exit 1·diff 출력, 복원 시 통과.
- [x] **수집기 공통유틸 추출.** ~~5종이 `sani`(4곳, lh만 `String()` 누락 — 이미 불일치), `dwell`(5), `loadIndex`(5), `getArg`(4), `.env`로드(4), `dnorm`(2), `UA`(5), `fetchNoticeFiles`(3) 복붙. → `collect-util.mjs` 1벌로(수집기는 인라인 제약 없음, 정당하게 공유 가능). 순수함수라 위험 낮고 효과 큼.~~
  - **완료(2026-06-25):** `collect-util.mjs` 신설 — 순수유틸 7개 export(`UA`·`dwell`·`sani`·`dnorm`·`getArg`·`loadIndex(idxUrl)`·`loadServiceKey()`). 5 수집기가 자기 필요분만 import. **`sani`는 캐논=`String()`판으로 통일 → lh의 비문자열 크래시 버그 흡수.** `loadServiceKey`는 디코드된 키만 반환(빈값시 exit/skip 정책은 호출부에 위임 → lh `--refresh` graceful skip 보존). **`fetchNoticeFiles`는 의도적 제외** — 3변형이 URL빌더·필드명·시그니처가 소스별로 진짜 다름(순수 복붙 아님). 콜백 떡칠 대비 가치 낮아 각 파일 유지. `statusOf` 통일은 별도 P2 항목. 검증: 6파일 `node --check` 통과, 유틸 단위테스트(sani 숫자입력·dnorm·loadIndex결측·키 유무) 통과, sh/gh `--refresh` 라이브 정상(신규 2/0건, 데이터 churn 0).
- [ ] **`statusOf` 3중 구현 통일.** `applyhome-collect.mjs:53`/`myhome-collect.mjs:61`/`myhome-pipeline.mjs:22` 시그니처 제각각(`([b,e])` vs `(b,e)` vs `(b,e,prev)`) — 같은 규칙 3곳, 변경 시 동시 수정 필요.
- [ ] **`pickPdf` 통일 + panId 키 규약 일원화.** `pickPdf`가 `pipeline.mjs:95`/`prep-slices.mjs:10`/`myhome-pipeline.mjs:33` 3변형. panId 접두사(`ah:`/`mh-`/`sh-`/`gh-`/LH무접두)가 5곳 문자열 리터럴로 분산. applyhome은 derived `panId`(`2026…`)와 index 키(`ah:2026…`) 불일치 — LIVE_OVERLAY에 넣으면 조용히 실패.

### P3 — 정리/정확성

- [ ] **죽은/참고코드 격리.** `extract-requirements.mjs`는 외부 LLM API 직접 호출(`:46`)+하드코딩 경로(`/Users/snfddl/…/CertiQ/.env`, `:10`)로 절대규칙(CLAUDE.md §1)과 정면 모순(실행은 안 되나 혼동). `lh-scrape.mjs`는 OpenAPI로 대체됨(`lh-collect.mjs:62` 주석), `test-lh-api.mjs`는 일회성 탐침. → `reference/`로 격리하거나 "DEAD/참고전용" 배너.
- [ ] **slicer 절감 수치 정정.** `CLAUDE.md §3` "평균 ~34%"는 실측 평균 21%(265건 전수). 효과·요건손실0건은 검증됨, 수치만 정정(검증 안 된 수치 보고 금지 원칙).
- [ ] **`lh-collect` top-level try/catch + 런타임 prereq 체크.** lh만 메인루프 catch 없어 fetch throw 시 부분저장 없이 크래시. `pdftotext`/`python3`/`claude`/Node20(`getSetCookie` 19.7+) 전제가 코드·문서 어디에도 미선언.
- [ ] **수집 실패 가시화.** `pipeline.mjs:47`이 수집 에러를 catch로 삼키고 진행 → "신규 0건"을 정상으로 오인 가능. `extractOne` stderr도 완전 무시(`:159`)라 추출 실패 원인 미기록.

### 보류 (의도적 deprioritize)

- **raw 디스크 883MB.** gitignore·로컬전용이라 서비스/정확도 영향 0. 단 PDF(481MB)는 "재파싱 보험"으로 실효 가치 있음(공고 내려가도 재추출 가능) → 보존 정당. 진짜 잡쓰레기는 **파싱코드 0개인 HWP 175MB+hwpx 33MB+zip 55MB+html 64MB**. 핵심은 디스크가 아니라 `lh-collect.mjs:160-168`이 "PDF 우선" 정책과 달리 형식 불문 전량 다운로드한다는 점 → 다운로드 단계서 비PDF/비xlsx 거르는 한 줄. 급하지 않음.
- **index.json 무한누적(487건, 209 유령) + 전량 read/write.** 개인 규모(수백 건)에선 무해, 수년 누적 시 첫 병목. 만료/아카이브 전략 부재.
- **site/index.html 1.8MB 전건 인라인, 페이지네이션 없음.** 공고 수에 선형. 현재는 견딜 만, 수천 건 시 모바일 부담.

## 강점 (유지할 것)

- 외부 LLM/npm 의존성 0(전수 grep 확인) — 공급망·버전드리프트 리스크 없음.
- match-core fail-safe 일관성(`'check'` 상태로 불확실을 단정탈락 안 함).
- slicer 안전우선(`RISK_LINE` 매칭 시 요건표 무조건 보존, `slice-notice.mjs:71`) — 요건손실 0건.
- 증분처리 견고: 다운로드(`index.done`)·추출(`requirements.json` 존재) 스킵 일관, raw 불변(`!existsSync` 가드).
- CI/로컬 경계 명확(결정론만 CI, LLM 로컬), `--seed` 분기로 개인 프로필 CI 배제.
