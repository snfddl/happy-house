# 코드·아키텍처 진단

---

# Round 2 — blank-slate 재감사 (2026-06-25)

메모리·`AUDIT.md`를 잠시 치우고 컨텍스트 0의 fresh 서브에이전트 3대(아키텍처·**정확도/매칭**·코드품질)로 재감사. Round 1이 놓친 이슈, 특히 **매칭 계산의 정답성** 문제가 다수 발견됨.

## 왜 Round 1이 비슷한 문제를 놓쳤나 (회고)

1. **Round 1은 매칭 *로직*을 안 봤다.** 3레인이 전부 쓰기경로·구조에 쏠려, `match-core`는 "단일 소스라 잘 통합됨"이라고 *배선*만 칭찬하고 *정답성*(자격/순위/가점)은 미검증. Round 2 P0 3건이 전부 match-core 안 — **재발이 아니라 처음부터 범위 밖.**
2. **절반만 끝낸 fix의 나머지가 새 버그 자리.** Round 1 "공통유틸 추출"이 `fetchNoticeFiles`·`mergeNewPending`·`SKIP_PAT`을 "의도적 제외"로 남김 → 드리프트 방지가 목적이던 dedup이 정작 드리프트 위험 큰 중복을 남겨, lh SKIP_PAT만 `평면도` 누락 드리프트 발생(#7·#8). 드리프트 가드도 *키*만 막고 *필드명*은 안 막음(#6).
3. **알고도 유예한 것이 재등장.** LIVE_OVERLAY 일반화는 "안전하다" 주석만 달고 미실행(#5).
4. **Audit ≠ 행동검증.** Round 1은 정독만 했고 매처를 *실행*한 적이 없음. Round 2 정확도 레인은 실제 프로필로 `/tmp` 테스트 ~14개를 돌려 버그를 잡음 — 입력을 만들어야만 드러나는 행동 버그는 정독으로 체계적으로 놓침.
5. **앵커링.** Round 1의 "읽기경로는 잘 통합" 결론이 이후 주의를 "쓰기경로가 문제"로 고정. blank-slate가 그 프레임을 깸.

**재발 방지:** ① match-core 회귀 테스트 고정 ② 공유유틸 추출 끝까지 ③ 드리프트 가드 필드명까지 확장.

## Round 2 작업 목록

### P0 — 사용자에게 잘못된 결과
- [x] **#1 자산/자동차 게이트가 본인 계층의 더 엄격한 상한 무시.** ~~`tierLimit`이 top-level 값 있으면 계층별 무시 → 청년 3억 "지원가능" 오판(14공고 라이브).~~
  - **완료(2026-06-25):** `match-core.mjs:108` `tierLimit`을 **계층값 우선**으로 재작성(계층 해결 먼저, 미해결 시 top-level fallback). SCHEMA §5 위임 의도와 일치. 회귀테스트 `test-match-core.mjs` 신설(6케이스: 계층캡 초과→fail·이내→pass·계층미해결→top fallback·역방향 false-negative 방지·계층별없는공고 top-only). 검증: 6/6 통과, 드리프트 가드 OK, 사이트 재빌드 정상.
- [x] **#2 myhome-collect가 추출완료 요건을 조용히 되돌림.** ~~requirements.json을 done 체크 *이전*에 무조건 bare envelope로 덮어 PDF추출 소득/자산을 `공고문미기재`로 퇴행(+매번 재추출).~~
  - **완료(2026-06-25):** done 체크를 requirements.json 쓰기 *위로* 이동. 이미 done이면 기존 파일을 읽어 **상태/마감일만 패치**(gh-collect 식), `__pdf추출`·소득/자산/계층 보존. 신규 경로는 1회만 기록(중복 write 제거). `readFileSync` import 추가. 검증: 실제 보강파일 2건(도시근로자/2.51억/__pdf추출)에 done-branch 시뮬 → 보강분 100% 보존. (전체 live 재수집은 API키 필요로 미실행, 로직 검증.)
- [x] **#3 부양가족수가 자녀를 나이·혼인 무관 전부 카운트.** ~~`(P.자녀||[]).length` → 가점 84점 과대계상.~~
  - **완료(2026-06-25):** `match-core.mjs` 미혼자녀를 **태아 또는 (생년월일 있고 만30세미만 & !기혼)**으로 필터(SCHEMA §6-3). 제외 시 notes에 사유. 웹 UI(미성년 자녀수만 입력)는 무영향, profile.json/CLI 임의 생년월일 케이스 정정. 회귀테스트 3케이스 추가(미성년+5·성인 불변·기혼 불변). 9/9 통과.

### P1 — 정확도/지속가능성
- [x] **#4 시도명 단축/정식 불일치로 분양 지역우선·청약순위 깨짐.** ~~`'경상남도 창원'` vs `'경남'` exact 비교 실패.~~
  - **완료(2026-06-25):** `match-core`에 `시도canon`(단축·정식·신자치 → 2글자) 추가, 청약순위 수도권 판정·지역우선 tier 비교에 적용. 회귀테스트 2케이스(정식명 '서울특별시' 수도권 인식·'경남'↔'경상남도' 동일시도). 12/12 통과. (gateResidence 등 substring 케이스는 시군구가 통상 매칭 살리는 fail-safe라 별도 — #15 인근.)
- [x] **#5 `LIVE_OVERLAY` 하드코딩 `{lh,gh}`.** ~~CI refresh하는 sh 누락.~~
  - **완료(2026-06-25):** 오버레이를 전 소스 일반화 — `liveIdx[r.panId]`가 존재하면 적용(하드코딩 set 제거). panId 불변식이 어느 소스든 키 해소 보장, freshStatus가 백스톱. 검증: 재빌드 333건, sh가 이제 index 상태 반영(공고중17·예정2·마감1), 이상분포 0.
- [x] **#6 매처 tier 필드명 canon이 드리프트 가드 밖.** ~~normalize 스킵/동의어 누락 시 자산게이트 조용히 통과(#1 우선규칙 무력화).~~
  - **완료(2026-06-25):** `match-core`에 `tierFieldVal`(자산/자동차 동의어 내성, normalize FIELD_SYN과 동기화) 추가 — normalize 미적용 데이터(`총자산상한` 등)에서도 본인 계층값을 읽어 #1 우선규칙 유효. 미상 필드는 normalize가 비고로 흡수하므로 금액 2종만. 회귀테스트 1케이스(비캐논 총자산상한→fail). 13/13 통과.

### P2 — 부채
- [x] **#7 lh-collect SKIP_PAT에 `평면도`·`카달로그` 누락.** ~~홍보 PDF ~27MB 다운로드(§2 위반).~~
  - **완료(2026-06-25):** 캐논 `PAMPHLET_PAT`로 교체(평면도·카달로그 포함). dry-run: LH 24개 홍보파일 이제 스킵, 공고문 오스킵 0. **기존 디스크 홍보PDF 7개/27.1MB도 prune**(meta 정합 갱신, raw 610→583M, 공고문 무손실).
- [x] **#8 공유유틸 추출 미완.** ~~mergeNewPending·fetchNoticeFiles·toEnvelope 플레이스홀더·SKIP_PAT 4벌 → #7 근본원인.~~
  - **완료(2026-06-25):** collect-util에 `PAMPHLET_PAT`/`NON_NOTICE_PAT`(캐논 패턴 2종, 드리프트 종식)·`mergeNewPending(root,src,entries)`·`saveDoc`(fetch-검증-저장 코어, 메커니즘은 fetchBuf 콜백 주입으로 fetch/cert-https 차이 흡수)·`emptyQualification(소득비고)` 추출. lh/myhome/sh/gh 4 수집기 재배선. 검증: saveDoc 단위 7/7(스킵·비문서·HTML에러·성공·저장·오류), emptyQualification 키 동등, 5파일 node --check.
- [ ] **#9 슬라이서 sub-block 제거에 RISK_LINE fail-safe 없음.** `slice-notice.mjs:48-57` — top-level만 가드. 현재 손실 0이나 미보장. sub-block에도 RISK_LINE 적용.
- [x] **#10 freshStatus↔statusOf 불일치(미래 접수시작).** ~~빌드 신선도가 미래 접수시작을 '접수중'으로 오표시.~~
  - **완료(2026-06-25):** `freshStatus`에 `if (b && TODAY<b) return '접수예정'` 추가(prev 보존 보수성은 유지). 검증: 미래 접수시작 LH 71건(2026-06-26~07월)이 과거 '공고중' 오표시 → 정확히 '접수예정'으로 정정.
- [ ] **#11 index.json 무한누적**(485건 66% 마감) · [x] **#12 gh-collect TODAY 재선언**(미사용 dead 선언이라 삭제) · **#13 pipeline/myhome-pipeline 스캐폴딩 중복**.

### P3 — 정리/정직성
- [x] **#14** tier 소득표 세대원수 행 없으면 유효 pass→확인필요 강등 → **공통표 행 폴백 추가**(회귀테스트). · [x] **#15** 희망지역 substring 오매칭 → **시도 단축명은 공고 시도와 캐논 비교**(시군구는 substring 유지, 회귀테스트 3케이스). 17/17 통과.
- [ ] **#16** 루트 `dl_67253288`(342KB HWP)·prep-slices 죽은코드 정리 · **#17** LH derived 5건 `상태:null` 백필.

### 검증된 강점 (유지)
panId 불변식·statusOf 단일캐논·raw 불변·검증게이트·GH TLS·증분처리·매처 fail-safe('확인필요' 보수성)·슬라이서 top-level fail-safe(138 PDF 손실 0)·맞벌이/특공/미성년자녀 게이트 정확.

---

# Round 1 — 초기 진단 (2026-06-25)

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
