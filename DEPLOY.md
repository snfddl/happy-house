# DEPLOY.md — 무료 자동배포 / 운영 런북

`site/index.html`(의존성 0·자체완결 정적)을 **GitHub Actions + GitHub Pages**로 무료 자동배포한다.
핵심 원칙: **결정론 작업만 CI에서**(키·과금 0), **LLM 요건추출은 로컬에서**(외부 API 금지 규칙 유지).

- 라이브: https://snfddl.github.io/happy-house/
- 워크플로: `.github/workflows/refresh.yml`

## 구조

```
GitHub Actions (refresh & deploy)
├─ trigger: schedule(cron 하루 3회) · push(main) · 수동(workflow_dispatch)
├─ build job
│   ├─ [push 아닐 때만] lh-collect.mjs --refresh   # 상태/마감일 라이브 갱신(다운로드 X), 신규→new-pending.json
│   ├─ build-site.mjs                              # index.json 최신상태 오버레이 → site/index.html(빈 프로필)
│   ├─ [push 아닐 때만] index.json 커밋·push
│   ├─ [push 아닐 때만] 신규 있으면 GitHub 이슈 생성
│   └─ upload-pages-artifact (site/)
└─ deploy job → deploy-pages → Pages
```

| 트리거 | 동작 | 용도 |
|---|---|---|
| **push** (main, 사이트 영향 경로) | 빌드 + 배포만(스크래핑 X·빠름) | 코드/데이터 커밋 즉시 라이브 |
| **schedule** (UTC 0·8·16 = KST 09·17·01) | 상태갱신 + 빌드 + 배포 + 신규 이슈 | 매일 신선도(접수중·D-day) |
| **수동** (`gh workflow run "refresh & deploy"`) | schedule과 동일(전체) | 즉시 상태갱신+배포 |

push 트리거 경로: `site/**`, `*.mjs`, `data/derived/**`, `.github/workflows/**` (문서만 바꾸면 배포 안 함).

## 왜 추출은 CI에서 안 하나

요건추출은 `claude -p`(Sonnet 헤드리스)로 한다. CI에서 무인 실행하려면 API 키(=과금, "외부 LLM API 금지" 위반)나 세션 인증이 필요해 **무료로 불가**. 그래서 추출은 **로컬에서** 돌리고 결과(requirements.json)만 커밋한다. 파이프라인이 증분이라 신규 없는 날은 추출 0건 — 대부분 날은 CI의 결정론 갱신만으로 충분.

## 일상 운영

**신규 공고가 떴을 때** (CI가 이슈로 알림 / 또는 `node lh-collect.mjs --refresh`로 직접 확인):
```bash
node pipeline.mjs                 # 수집→추출(claude -p)→정규화→xlsx→링크→검증
node build-site.mjs               # 사이트 재빌드(168→…)
git add data/derived data/index.json site/index.html
git commit -m "feat: 신규 공고 N건"
git push                          # push 트리거 → 자동 배포
```

**UI/로직만 고쳤을 때**: `_template.html`/`match-core.mjs` 수정 → `node build-site.mjs` → 커밋·push → 자동 배포.
(`match-core.mjs`는 빌드 때 `site/index.html`에 인라인되므로 반드시 재빌드.)

## 최초 셋업 (이미 완료, 기록용)

```bash
git init && git add -A && git commit -m "..."
gh repo create <user>/happy-house --public --source=. --push   # 또는 기존 repo에 remote 연결
gh repo edit <user>/happy-house --visibility public            # Pages 무료는 public repo만
gh api -X POST repos/<user>/happy-house/pages -f build_type=workflow
gh workflow run "refresh & deploy"
```
> 무료 플랜 Pages는 **public repo만** 지원. profile.json은 gitignore라 공개돼도 개인정보 유출 없음.

## gitignore 원칙

- `data/raw/`(724MB·불변·재수집 가능) — 빌드엔 derived만 필요
- `profile.json` — 개인정보(공개 repo 유출 방지). CI는 빈 프로필로 빌드
- 파이프라인 재생성 산출물: `new-pending.json`·`pipeline-report.json`·`extract-targets.json`·`wf-args.json`·`slice-manifest.json`
- **커밋 대상**: `data/derived/`(사이트 데이터)·`data/index.json`(추적·상태)·`site/`·스크립트·문서

## 트러블슈팅

- **Actions 빨간불 / `lh-collect --refresh` 실패**: LH가 Actions IP를 막거나 목록 셀렉터 변경 가능 → `gh run view --log-failed`로 확인. 라이브 스크래핑은 환경 의존적이라 첫 실행 로그를 꼭 본다.
- **push했는데 라이브 안 바뀜**: 변경 경로가 push 트리거 paths에 없으면 배포 안 됨. `gh workflow run`으로 수동 트리거.
- **봇 커밋과 충돌**: schedule이 `index.json`을 커밋·push하므로 로컬 작업 전 `git pull --rebase`.
- **신규 공고가 사이트에 안 보임**: requirements.json이 없으면(추출 전) 사이트에 안 뜬다 — 로컬 `node pipeline.mjs` 필요.
