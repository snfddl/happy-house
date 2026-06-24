# 청약홈 분양 소스 — 정찰 결과 & API 노트

> 정찰 완료: 2026-06-22. 결론: **청약홈 분양정보는 data.go.kr OpenAPI(한국부동산원)로 "구조화 JSON"이 그대로 나온다.**
> → 분양은 LH 임대처럼 PDF→슬라이스→Sonnet 추출이 **필요 없다**(임대보다 쉬움). 가점 매칭까지 **GO**.
> 이 문서는 이제 정찰 계획이 아니라 **분양 어댑터 구현용 소스 노트**(LH_SCRAPE_NOTES의 청약홈판).

## 0. 결론 (검증 완료)

- 분양 공고문이 청약홈에만 있는 건 맞지만, **공고문 PDF를 긁을 필요가 없다.** 한국부동산원이 분양정보를 **OpenAPI(REST·JSON)** 로 구조화해서 공개함.
- 따라서 분양 1차(리스트 + D-day + 분양가 + 주택형별 세대 + 지역우선 + 가점 기초매칭)는 **API만으로** 가능. 외부 LLM 추출 0 (no-API 규칙과 정합, 오히려 추출 단계가 사라짐).
- 가점/추첨 비율·특공 세부배분·전매제한·실거주의무 등 일부 갭은 API에 없을 수 있음 → 필요 시 **공고문 PDF 2차 보강**(applyhome 접근 가능 확인). 1차엔 불필요.

## 1. 소스: 한국부동산원 청약홈 OpenAPI (data.go.kr)

활용신청 대상 서비스 2개 (둘 다 무료·REST·JSON, 실시간):
- **분양정보 조회 서비스** — data.go.kr `15098547`
- **청약접수 경쟁률 및 특별공급 신청현황 조회 서비스** — data.go.kr `15098905`

호출 형식 (odcloud REST):
```
GET https://api.odcloud.kr/api/<Svc>/v1/<op>?serviceKey=<KEY>&page=1&perPage=1000
응답: { currentCount, data: [ {...}, ... ], matchCount, page, perPage, totalCount }
```
- `serviceKey`는 기존 `.env`의 `DATA_GO_KR_SERVICE_KEY`(디코딩 형태) 그대로 사용. **서비스별 "활용신청" 필요.**
- **활용신청 승인·실데이터 동작 확인 (2026-06-22, HTTP 200).** APT Detail totalCount=2791, APT Mdl totalCount=14233(전체 누적).
- ⚠️ **`cond[FIELD::GTE]` 기간필터 미동작** — totalCount가 필터 전과 동일(무시됨). 단 결과가 **모집공고일(RCRIT_PBLANC_DE) 최신순으로 정렬되어 나옴** → 수집기는 cond 의존 말고 `perPage=1000` 페이징 + **클라이언트 측 기간컷(2026-05-01+)**. 최신만 보면 첫 페이지에서 조기종료 가능.

### 1-1. 분양정보 서비스 엔드포인트 (`ApplyhomeInfoDetailSvc/v1`)
공고 헤더 = `...Detail`, 주택형별(분양가·세대) = `...Mdl`. 유형별로 쌍 존재. (전부 -4로 유효 확인)
| op | 내용 |
|---|---|
| `getAPTLttotPblancDetail` | APT(민간사전청약·신혼희망타운 포함) 공고 |
| `getAPTLttotPblancMdl` | APT **주택형별**(분양가·세대수) |
| `getUrbtyOfctlLttotPblancDetail` / `...Mdl` | 오피스텔/도시형/민간임대/생활숙박 |
| `getRemndrLttotPblancDetail` | APT 무순위/잔여세대 |
| `getPblPvtRentLttotPblancDetail` | 공공지원 민간임대 |
| `getOPTLttotPblancDetail` | 임의공급 |

### 1-2. 경쟁률·특공현황 서비스 (`ApplyhomeInfoCmpetRtSvc/v1`)
- `getAPTLttotPblancCmpet` (-4 유효) 등. 특공 신청현황 op 정확명은 **활용신청 후 Swagger 명세에서 확정**(추정명 `getAPTLttotPblancSpecmpet`은 -3=틀린 경로였음).
- 용도: 사후 경쟁률·특공 신청수(매칭 필수는 아님, 참고지표).

## 2. 응답 필드 (실측 키 — 2026-06-22 실호출)

### Detail (공고 헤더, 공고당 1행) — `getAPTLttotPblancDetail`
조인키: **`HOUSE_MANAGE_NO` == `PBLANC_NO`** (둘 다 동일값, 예 `2026000248`). Mdl과 `PBLANC_NO`로 조인.
- 식별/구분: `HOUSE_NM`(주택명) · `HOUSE_SECD`/`_NM`(APT 등) · `HOUSE_DTL_SECD`/`_NM`(**01=민영**, 국민 등) · `RENT_SECD`/`_NM`(**분양/임대 구분**)
- 위치/규모: `SUBSCRPT_AREA_CODE`/`_NM`(공급지역 예 경기) · `HSSPLY_ADRES`(주소) · `HSSPLY_ZIP` · `TOT_SUPLY_HSHLDCO`(총공급세대)
- 규제: `MDAT_TRGET_AREA_SECD`(조정대상지역) · `PARCPRC_ULS_AT`(분양가상한제) · `SPECLT_RDN_EARTH_AT`(투기과열지구) · `PUBLIC_HOUSE_SPCLW_APPLC_AT` 등 Y/N 플래그
- 일정: `RCRIT_PBLANC_DE`(모집공고일) · `RCEPT_BGNDE`/`ENDDE`(청약접수) · `SPSPLY_RCEPT_BGNDE`/`ENDDE`(특공접수) · `GNRL_RNK1_*`/`GNRL_RNK2_*`(**해당지역 CRSPAREA / 경기 ETC_GG / 기타 ETC_AREA** 별 1·2순위 접수일 → 지역우선 판별) · `PRZWNER_PRESNATN_DE`(당첨발표) · `CNTRCT_CNCLS_BGNDE`/`ENDDE`(계약) · `MVN_PREARNGE_YM`(입주예정월)
- 기타: `BSNS_MBY_NM`(시행사) · `CNSTRCT_ENTRPS_NM`(시공사) · `MDHS_TELNO`(문의) · `HMPG_ADRES` · **`PBLANC_URL`**(applyhome 상세 직링크 `…selectAPTLttotPblancDetail.do?houseManageNo=&pblancNo=`)

### Mdl (주택형별, 공고당 N행) — `getAPTLttotPblancMdl`
- `PBLANC_NO`(=조인키) · `MODEL_NO` · `HOUSE_TY`(주택형 예 `051.0000A`) · `SUPLY_AR`(공급면적㎡)
- **`LTTOT_TOP_AMOUNT`(분양최고금액, 만원)** ← 분양가 · `SUPLY_HSHLDCO`(일반공급세대) · `SPSPLY_HSHLDCO`(특별공급 합계)
- **특공 세부배분 전부 필드로 제공** (갭 아님 — 예상보다 좋음): `MNYCH_HSHLDCO`(다자녀) · `NWWDS_HSHLDCO`(신혼부부) · `NWBB_HSHLDCO`(신생아) · `LFE_FRST_HSHLDCO`(생애최초) · `OLD_PARNTS_SUPORT_HSHLDCO`(노부모부양) · `INSTT_RECOMEND_HSHLDCO`(기관추천) · `YGMN_HSHLDCO`(청년) · `TRANSR_INSTT_ENFSN_HSHLDCO`(이전기관) · `ETC_HSHLDCO`(기타)

## 3. 갭 (API에 없음 → 필요 시 공고문 PDF 2차 보강)
- **가점제/추첨제 비율**, 1·2순위 세부 자격, **전매제한·실거주의무**, 지역 거주기간 요건. (특공 세부배분은 갭 아님 — Mdl에 다 있음.)
- 보강 경로: `applyhome.co.kr` 접근 가능(HTTP 200, NetFunnel 차단 無 — 2026-06-22). `PBLANC_URL` 상세페이지 공고문 PDF → LH와 동일 PDF→슬라이스→Sonnet. **1차엔 불필요(API만으로 리스트+분양가+세대배분+지역우선+가점기초 매칭 가능).**

## 4. 구현 메모 (다음 작업)
1. ~~**활용신청**~~ ✅ 완료(2026-06-22, 200 동작). `15098547` 분양정보 승인 확인. (`15098905` 경쟁률·특공은 매칭 필수 아님 — 필요 시 확인.)
2. ~~**수집기** `applyhome-collect.mjs`~~ ✅ 완료(2026-06-22): Detail+Mdl 페이징, `PBLANC_NO`로 조인, 기간컷(`--since`)·분양만(`--include-rent`로 임대 포함), `data/raw/applyhome/<no>/`에 `detail.json`·`models.json`(불변)+`meta.json`(정규화), index 키 `ah:<no>`로 통합. 멱등(재실행 신규0). 실측: 분양 42건/2026-05+, 특공 세부배분 합계 일치 확인.
3. **스키마**: SCHEMA.md에 분양 변형 추가 — `분양가`(만원), `특별공급`(배분), `선정방식`(가점제|추첨제|혼합 + 비율), `전매제한`·`실거주의무`(갭=PDF 보강 시).
4. **가점 계산기**(match.mjs 결정론): 무주택기간(≤32) + 부양가족수(≤35) + 통장가입기간(≤17) = **84점**. UserProfile에 통장가입일·부양가족·무주택 기점 추가.
5. **LH↔청약홈 매칭**: 단지명+공고일+지역으로 중복제거/보강. 분양 정식키 = 청약홈 `PBLANC_NO`. LH 분양 메타(0000061xxx)는 포인터로만.

## 출처
- 분양정보 서비스: https://www.data.go.kr/data/15098547/openapi.do
- 경쟁률·특공현황: https://www.data.go.kr/data/15098905/openapi.do
- 필드(파일데이터): https://www.data.go.kr/data/15101046/fileData.do (공고) · https://www.data.go.kr/data/15101047/fileData.do (주택형별)
- 구현 참고: https://velog.io/@snorlax1106 (Spring Scheduler 청약 자동갱신)
