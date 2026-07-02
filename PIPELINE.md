# happy-house — 신규 공고 처리 파이프라인 (런북)

신규 LH 공고가 올라오면 **`node pipeline.mjs` 한 줄**로 수집→요건추출→구조화까지 끝낸다.
결정론 단계는 스크립트가, 비결정론(요건추출)만 Claude Code 헤드리스가 처리한다 — **외부 LLM API 0**.

## 한 줄 실행

```bash
node pipeline.mjs                 # 전국×전유형 수집 → 신규만 완전자동 처리
node pipeline.mjs 11 41           # 서울·경기만
node pipeline.mjs --types=13/26   # 매입임대만
node pipeline.mjs --skip-collect  # 수집 생략(이미 raw 있을 때 재처리)
node pipeline.mjs --semi          # 추출 직전까지만(토큰 0). wf-args.json만 생성
node pipeline.mjs --force         # requirements.json 있어도 재추출(정정공고 갱신 등)
node pipeline.mjs --conc=4        # 헤드리스 추출 동시 실행 수(기본 3)
node pipeline.mjs --skip-collect --force --only=020038,020094   # 특정 공고(panId 접미사)만 재처리
                                  # 재추출→xlsx재파싱→링크주입→검증까지 자동(주택목록·원문링크 보존)
```

## 단계 (pipeline.mjs)

| # | 단계 | 도구 | 성격 | 비고 |
|---|---|---|---|---|
| 0 | 수집 | `lh-collect.mjs` | 결정론 | index.json diff로 **신규만** 다운로드. 팸플릿 제외. raw 불변 |
| 1 | 타깃선정 | (내장) | 결정론 | **LH만**(index는 5소스 공유 — `source` 없거나 'lh'인 항목만) 접수중·공고중·정정 − **접수마감**(+유형별 활성0이면 최근 마감 1건 백필) → `extract-targets.json` |
| 2 | 신규판별+슬라이스 | `slice-notice.mjs` | 결정론 | **requirements.json 없는 건만**. pdftotext→보일러플레이트 제거→`notice_sliced.txt`. PDF없음/실패는 격리 |
| 3 | 요건추출 | **워크플로우**(권장) 또는 `claude -p` (Sonnet) | **에이전트** | 신규만. `schema-v1.jsonc`+`extract-rules.txt`로 프롬프트. 각자 requirements.json 기록. ↓경로 비교 |
| 4 | xlsx파싱 | `parse-housing-xlsx.py` | 결정론 | 신규 中 xlsx 보유분. `housing_list.json` + `주택목록` 주입 |
| 5 | 링크주입 | `inject-links.mjs` | 결정론 | meta.json 기반 `원문링크`(상세·PDF·첨부) 주입 |
| 6 | 검증게이트 | (내장) | 결정론 | 스키마/필수필드 체크. **이상건은 통과시키지 않고 격리** → `data/pipeline-report.json` |

## 요건추출 [3단계] 실행 경로 — 워크플로우 vs 헤드리스 (로컬 전용)

추출 골격은 `extract-core.mjs` 단일 소스(buildExtractPrompt mode=new/merge · runHeadless · 큐 `extract-queue.json`). 두 경로가 있고 **결과·품질은 동일**(같은 프롬프트·`schema-v1.jsonc`·`extract-rules.txt`). **속도만 다르다.** `--semi`가 만든 `extract-queue.json`(전소스 통합 큐)이 공통 입력.

| 경로 | 무엇 | 속도 | 언제 |
|---|---|---|---|
| **`/update` 스킬(워크플로우)** (권장) | `extract-queue.json`을 병렬 에이전트(동시 ~16)로 추출(`update-extract.workflow.mjs`) | **빠름** — 19건 ~3분 | **사람이 세션에서 직접 돌릴 때.** 기본으로 이걸 쓴다 |
| **헤드리스 `claude -p`** (`process-all`/`pipeline` 내장) | 건당 별도 claude 프로세스, conc 3 기본 | 느림 — 건당 풀세션 부팅(수십 초)·동시 3 | **무인 cron 등 대화형 세션이 없을 때만**의 fallback |

- `node process-all.mjs`(또는 `pipeline.mjs`)를 그냥 실행하면 무인용 헤드리스 경로로 간다(느림). 로컬에서 빠르게 처리하려면 **`/update` 스킬**을 쓴다(= `process-all --semi`로 큐 생성 → 워크플로우 추출 → 정규화·xlsx·링크·빌드).
- 워크플로우 추출 후 후속은 신규로 자동 인식되지 않으므로(이미 requirements.json 존재) **정규화·xlsx·링크·빌드를 명시적으로** 돌린다(`/update` 스킬 3단계가 이를 수행).

## 증분(incremental) 원칙

- 추출(3단계)은 **`requirements.json`이 없는 신규 공고만** 돈다. 108건을 통째로 재추출하지 않는다.
- 0~2,4~6 결정론 단계는 idempotent — 여러 번 돌려도 안전.
- 정정공고로 내용이 바뀌어 다시 뽑아야 하면 `--force`(전체) 또는 해당 `requirements.json` 삭제 후 재실행.

## 검증 게이트 — "이상한 건 사람이"

완전자동으로 끝까지 돌리되, 아래는 **자동 통과시키지 않고** `data/pipeline-report.json` + 콘솔에 dtlUrl과 함께 띄운다.

- **실패(❌)**: 추출 파일 없음 / JSON 깨짐 / 필수필드 누락 / 선정방식 enum 위반 → exit code 1
- **검토필요(⚠️)**: _검증노트 8개↑ / 목록유형↔추출유형 불일치 / xlsx 있는데 주택목록 미주입 / 공급형 비었는데 주택목록도 없음 / PDF없음·슬라이스실패

리포트의 dtlUrl을 열어 원문 대조 후 수정하거나, 해당 requirements.json 지우고 `--force` 재실행.

## 자동 스케줄(cron) 예시

```bash
# 매일 09:00 전국 신규 공고 처리 (로그 보관)
0 9 * * * cd /Users/snfddl/project/active/happy-house && /opt/homebrew/bin/node pipeline.mjs >> data/pipeline.log 2>&1
```
무인 실행 시에도 검증 게이트가 이상건을 `pipeline-report.json`에 격리하므로, 로그/리포트만 주기적으로 확인하면 된다.

## 산출물

- `data/raw/lh/<panId>/` — 원본(PDF·xlsx·meta.json·detail.html). **불변**
- `data/derived/lh/<panId>/notice_sliced.txt` — 슬라이스 본문
- `data/derived/lh/<panId>/requirements.json` — **정규 스키마 v1**(요건+원문링크+주택목록)
- `data/derived/lh/<panId>/housing_list.json` — 매입/전세 호별 전체 목록
- `data/index.json` — 추적 상태 / `data/extract-targets.json`·`wf-args.json` — 단계 산출 / `data/pipeline-report.json` — 검증 결과

스키마 상세는 `SCHEMA.md`, 수집 RE 노트는 `LH_SCRAPE_NOTES.md`, 절대규칙은 `CLAUDE.md` 참고.
