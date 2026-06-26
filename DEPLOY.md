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
│   ├─ [push 아닐 때만] 5소스 상태/신규 갱신 (env: DATA_GO_KR_SERVICE_KEY)
│   │     lh/sh/gh-collect --refresh   # 상태/마감일(다운로드 X), 신규→new-pending. lh=공개API·sh/gh=스크래핑(키 불필요)
│   │     myhome-collect --refresh     # 상태/마감일(키 필요·없으면 graceful skip), 신규→new-pending
│   │     applyhome-collect + derive   # 청약홈: 추출이 결정론(LLM 0) → 신규 분양까지 CI 완전 처리(키 필요)
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

## 왜 (LLM) 추출은 CI에서 안 하나

**LLM 요건추출**(LH·마이홈의 공고문 PDF → 자격/소득)은 `claude -p`(Sonnet 헤드리스)로 한다. CI 무인 실행은 API 키(=과금, "외부 LLM API 금지" 위반)나 세션 인증이 필요해 **무료로 불가** → **로컬에서** 돌리고(`/update` 또는 `process-all`) 결과만 커밋. 증분이라 신규 없는 날은 추출 0건.

**예외 — 청약홈(분양)은 CI에서 완전 처리한다.** 청약홈은 추출이 결정론(`applyhome-derive`, LLM 0)이라 키만 있으면 collect+derive로 신규 분양까지 CI가 끝낸다. 그래서 CI는 5소스 상태갱신 + 청약홈 신규를 자동 반영하고, **LH·마이홈 신규 임대 추출만** 로컬 몫(이슈로 알림).

**키(Secret)**: data.go.kr 키를 `gh secret set DATA_GO_KR_SERVICE_KEY`로 등록해야 LH(refresh)·마이홈(refresh)·청약홈(collect+derive)이 CI에서 동작. 미설정 시 키 필요 소스만 graceful 생략, SH/GH는 키 불필요라 항상 동작.

**지도 좌표(geocode)도 동일한 "로컬 키 / CI 키-0" 모델.** 단지 주소→좌표는 Kakao Local 키(`.env`의 `KAKAO_REST_KEY`, gitignore)로 **로컬에서만** 채우고(`node geocode.mjs`, 증분·멱등) `geo-cache.json` 결과만 커밋. CI(`process-all`/`build-site`)는 키 없이 **캐시+시군구 centroid 폴백**으로 핀을 그린다(키-0). 분양 좌표는 `resolve-naver`가 무료 시드. 키 발급: developers.kakao.com REST 키 + 그 앱의 "카카오맵(Local)" 서비스 ON(무과금·도메인 등록 불필요).

## 일상 운영

**신규 공고가 떴을 때** (CI가 이슈로 알림 / 또는 `node lh-collect.mjs --refresh`로 직접 확인):
```bash
/update                           # [권장] 대화형 한 명령 — 수집→추출(워크플로우 병렬·빠름)→정제→통합→build
# 또는 무인:
node process-all.mjs              # 전 소스 통합: collect→derive/extract(claude -p 헤드리스·느림)→정규화→검증→build
git add data/derived data/index.json site/index.html
git commit -m "feat: 신규 공고 N건"
git push                          # push 트리거 → 자동 배포
```
`process-all.mjs`가 소스별 진입점(LH=`pipeline.mjs`, applyhome=`applyhome-collect`+`derive`, myhome/sh/gh=`*-collect`+`myhome-pipeline`)을 순서대로 호출하고 마지막에 `build-site`까지 수행한다. 특정 소스만: `--source=sh,gh`. 한 소스만 따로: 기존 진입점 직접 호출도 그대로 유효.
검증 리포트: `data/pipeline-report.json`(LH) · `data/<source>-report.json`(myhome/sh/gh).

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
- **커밋 대상**: `data/derived/`(사이트 데이터·`geo-cache.json` 포함)·`data/index.json`(추적·상태)·`data/vendor/`(Leaflet 인라인용)·`site/`·스크립트·문서
- `.env`의 `KAKAO_REST_KEY`는 gitignore(`.env`) — 좌표 캐시 결과만 커밋(키 비공개·CI 키-0)

## 트러블슈팅

- **Actions 빨간불 / `lh-collect --refresh` 실패**: LH가 Actions IP를 막거나 목록 셀렉터 변경 가능 → `gh run view --log-failed`로 확인. 라이브 스크래핑은 환경 의존적이라 첫 실행 로그를 꼭 본다.
- **push했는데 라이브 안 바뀜**: 변경 경로가 push 트리거 paths에 없으면 배포 안 됨. `gh workflow run`으로 수동 트리거.
- **봇 커밋과 충돌**: schedule이 `index.json`을 커밋·push하므로 로컬 작업 전 `git pull --rebase`.
- **신규 공고가 사이트에 안 보임**: requirements.json이 없으면(추출 전) 사이트에 안 뜬다 — 로컬 `node pipeline.mjs` 필요.
