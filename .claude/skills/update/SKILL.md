---
name: update
description: 전 기관(LH·청약홈·마이홈·SH·GH) 임대/분양 공고를 한 명령으로 수집→추출→정제→통합→빌드. "공고 갱신", "데이터 업데이트", "전체 갱신", "오늘 공고 받아줘" 등 데이터 갱신 요청 시 사용. 추출은 워크플로우 병렬(빠름), 무인이 필요하면 대신 `node process-all.mjs`를 안내.
---

# /update [소스]

전 소스 데이터 갱신을 한 흐름으로. **결정론(수집·정제·통합)은 node, 비결정론(요건추출)만 워크플로우 병렬**. 외부 LLM API 0 (CLAUDE.md §1).

소스 미지정 시 전 5소스, 지정 시 해당 소스만(예: `/update sh`, `/update sh,gh`). 아래 `<SRC>`는 `--source=<소스>` 또는 생략(전소스)으로 치환.

## 절차 (순서대로 실행)

### 1. 수집 + 슬라이스 + 큐 (결정론, node)
```bash
node process-all.mjs --semi <SRC>
```
- 전소스 collect(비-refresh = **신규 raw 다운로드 포함**)·슬라이스 후 `data/extract-queue.json` 생성(각 항목에 완성 prompt 포함, mode=new[LH]/merge[myhome·sh·gh]).
- 청약홈(applyhome)은 결정론 매핑(`applyhome-derive`)이라 LLM 추출 없음 — 큐에 안 들어감(정상).
- 큐가 비면(신규 0) 2단계 생략하고 3단계로.

### 2. 요건추출 (비결정론, 워크플로우 병렬)
`schema-v1.jsonc`·`extract-rules.txt`·`data/extract-queue.json`(각 항목에서 큰 `prompt` 필드는 제외한 메타)을 읽어 args로 워크플로우 실행:
```
Workflow({ scriptPath: "<repo>/update-extract.workflow.mjs",
  args: { schema: <schema-v1.jsonc 내용>, rules: <extract-rules.txt 내용>,
          items: <extract-queue.json 항목들(prompt 제외: source/slug/mode/slicedPath/reqPath/header/label)> } })
```
- 워크플로우가 mode(new/merge)대로 prompt를 조립해 agent 병렬 추출 → requirements.json 생성(new)/MERGE(merge). 동시 ~16.
- 헤드리스(`claude -p` conc 3)보다 빠름(19건 ≈ 3분). 완료 통지까지 대기. 큐 비면 생략.
- 실패 항목(반환 null)은 보고하고, 필요 시 재실행.

### 2.5 비정규 분양 AI 참고분석 (비결정론, Sonnet 생성 + Opus 검증 — 선택)
'무순위/잔여'·'임의공급' 분양만 대상(왜 다시/임의로 공급되나=미달·잔여·소규모가 가치·사실성 높음. 민영 일반분양 시세코멘트는 책임·신뢰도상 제외).
```bash
node build-analysis-queue.mjs    # 활성 무순위/잔여·임의공급 중 참고분석 없는 건 → data/analysis-queue.json (유형별 prompt 포함)
```
- 큐가 비면 생략. 안 비면:
  1. **생성**: 각 항목 `prompt`를 **Sonnet 에이전트로 병렬 실행**(웹검색·외부 API 0) → `{"요약","확신도","출처":[]}` JSON.
  2. **적대적 검증**: 1의 산출을 **Opus 에이전트로 병렬 팩트체크** — 핵심 수치 웹 재확인, 주관 평가문구·환각 제거, 단일출처/미확인 시 확신도 하향. → `{"요약","확신도","출처","검증":"통과|수정","검증노트"}`.
  3. 검증 결과를 `{ "<no>": {...} }` 형태로 `data/analysis-results.json`에 모은 뒤:
```bash
node inject-analysis.mjs         # requirements.json '참고분석'에 주입(생성일·검증 포함). 멱등
```
- 모델: 생성=Sonnet(검색+사실요약, 추출과 동류·CLAUDE.md §3), 검증=Opus(감수용). 사이트엔 '참고용·원문확인' 디스클레이머 + 확신도·출처·'✓ 교차검증' 노출(모델명은 사용자에 비노출).

### 3. 정제 + 통합 + 빌드 (결정론, node — 멱등)
추출된 소스에 대해 순서대로:
```bash
node normalize-requirements.mjs --source=lh      # 갱신된 소스마다(--source=sh 등). 계층 캐논 정규화, 멱등
python3 parse-housing-xlsx.py --all              # 매입/전세임대 주택목록 xlsx 주입(LH 등)
node inject-links.mjs                            # 원문링크 주입
node inject-applyhome-pdf.mjs                    # 청약홈 공고문 PDF 직링크 주입 + 로컬 raw 다운로드(상세페이지 getAtchmnfl 파싱). 무인이면 --links-only
node inject-deadline-time.mjs                    # 공고문 본문→마감시각 추출(당일 컷오프용). 결정론·LLM0·멱등
node prune-expired.mjs                           # 마감 후 60일(기본) 지난 derived 정리. 멱등
node build-site.mjs                              # 드리프트 가드 + 5소스 통합 → site/index.html
```
- 모두 결정론·멱등이라 전체 재실행 안전(신규만 골라낼 필요 없음).
- `build-site`가 정정공고 원본 중복도 제거(정정본만 표시).

### 4. 검증 + 커밋 안내
- `data/pipeline-report.json`(LH)·`data/<source>-report.json` 의 pass/review/fail 확인. review/fail은 dtlUrl로 원문 대조 안내(자동 통과 금지).
- 결과 요약 후 커밋·푸시는 사용자 확인 받고: `git add data/derived data/index.json site/index.html && git commit && git push`.

## 무인(CI/cron)이 필요하면
대화형 세션 없이 자동 실행해야 하면 워크플로우 대신 헤드리스 한 명령을 안내:
```bash
node process-all.mjs <SRC>     # collect→추출(claude -p, 느림)→정제→검증→build 일괄
```
품질은 동일하나 추출이 동시 3이라 느림. 결정론 갱신만 필요하면 `node *-collect.mjs --refresh`(상태/마감일만).
