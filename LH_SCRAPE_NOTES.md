# LH 청약플러스 스크래핑 리버스 엔지니어링 노트

목표: 지역/유형별 임대공고 목록 → 상세 → 공고문 PDF 다운로드 (요건 추출 입력)

## 인증/세션
- NetFunnel 안티봇은 사실상 비활성(`NetFunnel_ID=` 빈 값으로도 통과).
- 필요한 쿠키: `WMONID`, `JSESSIONID` (최초 GET으로 발급받아 재사용).
- 단순 form POST로 동작 (특수 헤더 불필요, X-Requested-With는 XHR류에만).

## 1) 공고 목록  ✅ 작동확인
POST `https://apply.lh.or.kr/lhapply/apply/wt/wrtanc/selectWrtancList.do`
form-urlencoded 주요 파라미터:
- `cnpCd` 지역코드: 11서울 26부산 27대구 28인천 29광주 30대전 31울산 36110세종 41경기 51강원 43충북 44충남 52전북 46전남 47경북 48경남 50제주 (빈값=전국)
- 유형: 셀렉트 "06/10" 형태가 **분리**됨 → `uppAisTpCd=06` + `aisTpCd=10`, 그리고 **미러 필드** `srchUppAisTpCd`/`srchAisTpCd` 동일값 같이 전송 필수
  - uppAisTpCd: 01토지 05분양주택 06임대주택 13주거복지 22상가 39신혼희망타운
  - 임대 세부(aisTpCd): 07국민임대 08공공임대 09영구임대 10행복주택 11장기전세 …
- `mvinQf` 입주자격: 0전체 01청년 02신혼부부 03일반
- `panSs` 상태: `공고중`/`접수중`/`접수마감`/`정정공고중` (URL인코딩, 빈값=전체)
- `schTy` 0게시일 1마감일,  `startDt`/`endDt` = YYYY-MM-DD
- `listCo` 페이지당건수(예 50), `currPage`, `srchY=Y`, `indVal=N`, `srchFilter=Y`, `mi=1026`

응답: HTML. 각 행 앵커:
- 상세버튼 `<a class="wrtancInfoBtn" data-id1=PAN_ID data-id3=uppAisTpCd data-id4=aisTpCd>`
- 목록직접다운 `<a class="listFileDown" data-id5=PAN_ID>`
- 행 텍스트에 유형/공고명/지역/첨부여부/게시일/마감일/상태/조회수.

## 2) 공고 상세  ✅ 작동확인
POST `https://apply.lh.or.kr/lhapply/apply/wt/wrtanc/selectWrtancInfo.do`
- `panId`(=목록 data-id1), `ccrCnntSysDsCd`, `uppAisTpCd`, `aisTpCd`, `mi=1026`
- 응답 363KB HTML. 내부 임베디드 JSON에 첨부 객체 배열:
  `{cmnAhflSz, cmnAhflNm(원본명), cmnAhflSn(일련번호), cmnAhflPth(/Files/upload/...)}`
  - 주의: 첨부 묶음이 여러 개(공고문 / 평면도 / 팸플릿 / 제출서류). 위 JSON 리스트는 평면도 이미지였음. 공고문 PDF/HWP는 별도 구조 → 파싱 보강 필요.

## 3) 첨부 메타  ✅ 작동확인
POST `https://apply.lh.or.kr/lhapply/getFilePath.do`  (X-Requested-With: XMLHttpRequest)
- body `cmnAhflSn=<일련번호>`
- 응답 JSON: `{cmnAhflSn, cmnAhflNm, cmnPhyAhflNm(물리명=YYYYMMDD+sn+ext), cmnAhflSz, cmnAhflPth(/Files/upload_dec/...=복호화경로), filekey, chkYn}`
- ⚠️ 이 경로로 직접 GET하면 파일 안 옴(2608B HTML). 별도 다운로드 엔드포인트 존재 추정.

## 4) 실제 PDF 다운로드  ✅ 작동확인 (전체 체인 완성)
- 상세페이지 다운로드 버튼: `<a href="javascript:fileDownLoad('67253288');">` → 함수가 `lhFile.do?fileid=` 호출
- GET `https://apply.lh.or.kr/lhapply/lhFile.do?fileid=<fileId>`  (쿠키 필요, Referer=selectWrtancInfo.do)
  - 응답: `Content-Type: application/octet-stream`, `Content-Disposition: attachment; filename="...pdf"`, 실제 바이너리(%PDF / HWP)
  - 검증: fileid=67253299 → 378KB, %PDF-1.6, "(별지)공통제출서류(필수제출_행복주택).pdf"
- **fileid 출처 = 상세 HTML의 `fileDownLoad('<fileid>')` onclick 들.** getFilePath.do/cmnAhflSn 불필요(그건 바로보기/docViewer용).
- 참고: 바로보기는 `docViewer(enc1, enc2, enc3)` (암호화 파라미터) — 다운로드와 별개.

## 최종 파이프라인 (LH, 검증완료)
1. selectWrtancList.do (지역/유형/상태/기간) → 공고행 + panId(data-id1) + uppAisTpCd/aisTpCd(data-id3/4)
2. selectWrtancInfo.do?panId → 공고문 첨부들의 fileDownLoad('fileid') 목록 (+ 인접 파일명)
3. lhFile.do?fileid → PDF/HWP 바이너리 (Content-Disposition에 원본 파일명)
4. → CertiQ 파이프라인(classify→glyph-map/Upstage)→ LLM 요건추출
- 공고문 PDF만 골라야 함(평면도/팸플릿/제출서류 섞여있음): 파일명 키워드("공고", "모집공고")로 1차 필터.

## 참고: 공식 API (병행 가능)
- `B552555/lhLeaseNoticeInfo1/lhLeaseNoticeInfo1` (분양임대공고문): CNP_CD 지역 + UPP_AIS_TP_CD 유형 + PAN_SS 상태 + PAN_NT_ST_DT~CLSG_DT 기간 + DTL_URL 제공. 키 활용신청 전파 대기중(401).
- 메타데이터는 공식 API, PDF 본문만 사이트에서 받는 하이브리드가 이상적.
