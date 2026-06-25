# 코드·아키텍처 진단 (2026-06-25)

5개 소스(LH/청약홈/마이홈/SH/GH) 연동 완료 시점의 구조 점검. 멀티에이전트 병렬 진단(아키텍처·코드품질·자원효율) 결과 종합. **P0–P3 전건 처리 완료(2026-06-25). 보류 항목만 의도적 deprioritize.**

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
- [x] **`statusOf` 3중 구현 통일.** ~~`applyhome-collect.mjs:53`/`myhome-collect.mjs:61`/`myhome-pipeline.mjs:22` 시그니처 제각각(`([b,e])` vs `(b,e)` vs `(b,e,prev)`) — 같은 규칙 3곳, 변경 시 동시 수정 필요.~~
  - **완료(2026-06-25):** `collect-util.mjs`에 캐논 `statusOf(b,e,prev=null)`+`TODAY` export. 4 수집기(applyhome·myhome-collect·myhome-pipeline·sh) 로컬 정의 제거·import. 캐논 본문은 pipeline/sh판(마감→예정→접수중→`prev ?? null`). 의미차 수렴: applyhome/myhome-collect의 `접수중` 판정 `(b&&e)`→`(e)`(마감일만 있고 시작 null이면 접수중). SH 기본 `'공고중'`은 호출부 `?? '공고중'`으로 보존. 검증: `node --check` 5파일·캐논 7케이스 스모크 통과.
- [x] **`pickPdf` 통일.** ~~`pipeline.mjs:95`/`prep-slices.mjs:10`/`myhome-pipeline.mjs:33` 3변형.~~
  - **완료(2026-06-25):** `collect-util.mjs`에 캐논 `pickPdf(filesDir, fileid=null)` — fileid 접두(LH) → 모집공고/입주자모집 → 공고문 → 공고(붙임·별지·서식 제외) → 모집 → 첫 PDF. pipeline·myhome-pipeline 로컬 정의 제거·import. **prep-slices는 호출처 0(pipeline 인라인 [2/6]으로 대체)임을 확인 → `[DEAD/참고]` 배너 + 캐논 공유**(P3 죽은코드 격리 일부 선반영). 검증: 302개 raw 전수에서 기존 3변형 대비 **선택차이 0건**, 4소스 라이브 픽 정상.
- [x] **panId 키 규약 일원화.** ~~접두사(`ah:`/`mh-`/`sh-`/`gh-`/LH무접두) 5곳 분산, applyhome panId(bare)≠index키(`ah:…`).~~
  - **완료(2026-06-25):** `collect-util.mjs`에 `SRC_PREFIX`+`makePanId(src,rawId)` 단일선언. **불변식 확립: index 키 === derived panId === `${접두}${원시ID}` (전 5소스).** 근본원인=applyhome은 collect(idxKey)와 derive(panId)가 별파일이라 각자 구성→불일치 → 양쪽 `makePanId('applyhome',no)`로 강제(콜론 접두는 기존 index.json 키 호환 위해 유지, 마이그레이션 0). myhome/sh/gh collect·count로그도 헬퍼/`SRC_PREFIX` 경유로 통일. `build-site` LIVE_OVERLAY에 불변식 주석. **검증: derived 재생성 후 applyhome 183건 전수 panId가 index 키와 일치(이전 0건)**, derived diff는 panId 라인만(183파일), 사이트 빌드 333건·`__id` 전부 `applyhome:ah:…`·드리프트 가드 통과. **footgun 해소 — 이제 어느 소스든 overlay 안전.**

### P3 — 정리/정확성 — ✅ 완료(2026-06-25)

- [x] **죽은/참고코드 격리.** ~~`extract-requirements.mjs`(외부 LLM API+하드코딩 경로, §1 위반)·`lh-scrape.mjs`(OpenAPI로 대체)·`test-lh-api.mjs`(일회성 탐침).~~
  - **완료:** 3종을 `reference/`로 git mv(import·실행 0건 확인). `reference/README.md`에 각 사유·"실행금지" 명시. `CLAUDE.md §1`은 `reference/extract-requirements.mjs`로 경로 갱신. (prep-slices는 pickPdf 통일 때 `[DEAD]` 배너 선반영.)
- [x] **slicer 절감 수치 정정.** ~~"평균 ~34%"~~
  - **완료:** 슬라이서 전수 재실측(LH 265건) → **건별평균 21.0%·총합 20.3%·중앙값 18.5%**(전 소스 288건은 19.8%). `CLAUDE.md §3`·`DECISIONS.md` 둘 다 "~21%(전수 실측)"으로 정정. "34%"는 소표본 추정이었음.
- [x] **`lh-collect` top-level try/catch + 런타임 prereq 체크.** ~~메인루프 catch 없어 fetch throw 시 크래시, 전제 미선언.~~
  - **완료:** lh-collect 신규처리 루프를 **건별 try/catch**로(한 공고 throw가 전체 런·index 저장을 안 죽임), 실패는 모아 끝에 가시화. **Node 20+ 가드**(`getSetCookie`, 미만 즉시 중단). `pipeline.mjs`에 `pdftotext`/`claude`/`python3` 프리플라이트(부재 경고). `README.md`에 사전요건 섹션 추가. 스모크: 가드·프리플라이트 로직 검증.
- [x] **수집 실패 가시화.** ~~`pipeline.mjs:47` 에러 삼킴, `extractOne` stderr 무시.~~
  - **완료:** `extractOne`이 stderr 누적→실패 시 `exit code·stderr` 표면화(`↳` 라인), 추출 실패 N건 요약. 수집 단계 실패는 `collectFailed` 플래그로 끝에 "신규 0건은 정상 아닐 수 있음" 경고. lh-collect도 실패 panId 목록 출력.

### 보류 (의도적 deprioritize)

- **raw 디스크 883MB.** gitignore·로컬전용이라 서비스/정확도 영향 0. 단 PDF(481MB)는 "재파싱 보험"으로 실효 가치 있음 → 보존 정당.
  - **[부분완료 2026-06-25] 다운로드 형식 필터.** `lh-collect`가 이제 파서 있는 .pdf/.xlsx만 받고 hwp/hwpx(PDF없을 때만 fallback)·zip·이미지는 `skipped:'비요건형식'`로 id만 기록. 드라이런(265공고): junk 575건(hwp 493/hwpx 53/zip 27/jpg 2) 차단, **PDF·xlsx 오드롭 0**. → 앞으론 비대 안 됨. **단 기존 디스크 ~263MB(hwp 175+hwpx 33+zip 55)는 그대로** — 일회성 prune은 raw 불변규칙상 별도 확인 후(미실행).
- **index.json 무한누적(487건, 209 유령) + 전량 read/write.** 개인 규모(수백 건)에선 무해, 수년 누적 시 첫 병목. 만료/아카이브 전략 부재.
- **site/index.html 1.8MB 전건 인라인, 페이지네이션 없음.** 공고 수에 선형. 현재는 견딜 만, 수천 건 시 모바일 부담.

## 강점 (유지할 것)

- 외부 LLM/npm 의존성 0(전수 grep 확인) — 공급망·버전드리프트 리스크 없음.
- match-core fail-safe 일관성(`'check'` 상태로 불확실을 단정탈락 안 함).
- slicer 안전우선(`RISK_LINE` 매칭 시 요건표 무조건 보존, `slice-notice.mjs:71`) — 요건손실 0건.
- 증분처리 견고: 다운로드(`index.done`)·추출(`requirements.json` 존재) 스킵 일관, raw 불변(`!existsSync` 가드).
- CI/로컬 경계 명확(결정론만 CI, LLM 로컬), `--seed` 분기로 개인 프로필 CI 배제.
