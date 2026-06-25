# reference/ — 참고·죽은코드 격리

파이프라인(`pipeline.mjs`/`process-all.mjs`)에서 **호출되지 않는** 과거/참고용 스크립트. 혼동 방지로 분리(import·실행 0건 확인됨).

- **`extract-requirements.mjs`** — 요건 추출의 *스키마/프롬프트 참고용*. ⚠️ 외부 LLM API를 직접 호출하고 하드코딩 경로(`…/CertiQ/.env`)를 가져 **CLAUDE.md §1(외부 LLM API 금지)과 정면 모순** → 실제 추출은 Claude Code 에이전트(`myhome-pipeline`/Workflow)로 수행. 이 파일은 **실행하지 말 것**, 정규 스키마 필드 참고로만.
- **`lh-scrape.mjs`** — LH 공고 HTML 스크래핑 초기판. data.go.kr **OpenAPI(`lh-collect.mjs`)로 대체**됨. 보존은 RE 노트(`LH_SCRAPE_NOTES.md`) 맥락 참고용.
- **`test-lh-api.mjs`** — LH API 탐침 일회성 스크립트. 재현/디버그 참고용.

이 디렉터리 파일은 빌드·CI·수집·추출 어디에도 연결돼 있지 않다. 삭제해도 파이프라인 동작에 영향 없음(참고가치 때문에 보존).
