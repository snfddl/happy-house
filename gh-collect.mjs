// GH(경기주택도시공사) 임대·매입임대 모집공고 수집기 — apply.gh.or.kr egovframe 스크래핑
//   data.go.kr엔 실시간 모집공고 API 없음(공급정보 fileData 스냅샷뿐) → 사이트 직접 스크래핑.
//   NetFunnel 대기열은 비활성(주석처리)이라 무세션 직접 호출 가능(2026-06-24 실측). 전부 UTF-8 HTML.
//   목록: POST /sb/sr/<board>/selectPbancRentHouseList.do (searchState=1공고중·2접수중, pageIndex=N). 10행/페이지.
//   상세: POST /sb/sr/<board>/selectPbancDetailView.do (pbancNo·pbancKndCd·previewYn) → 첨부 <a>.
//   첨부: GET /sr/<board>/selectFileDown.do?pbancNo=&atchFileSn=&atchFileDtlSn=&mode=1 (무세션, %PDF 실측).
//   장점: 목록에 상태·마감일 제공(접수마감 자동 제외). 소득/자산은 공고문 PDF 추출 후속.
// 사용: node gh-collect.mjs [--since=2026-05-01] [--probe] [--refresh]
//   --refresh : CI용 — 기존 상태/마감일 갱신 + 신규만 data/new-pending.json에 기록(다운로드/추출은 로컬 process-all). GH는 키 불필요.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import https from 'node:https';
import tls from 'node:tls';

const ORIGIN = 'https://apply.gh.or.kr';
// apply.gh.or.kr는 leaf 인증서만 보내고 중간 인증서(Sectigo RSA OV)를 누락 → Node fetch가 체인검증 실패.
//   (curl은 macOS 키체인 캐시로 통과). TLS검증을 끄지 않고, 누락된 중간 인증서를 CA에 추가해 체인을 완성한다.
//   이 중간 인증서는 USERTrust RSA 루트(Node 기본신뢰)로 체인됨 — Linux CI에서도 동일하게 동작(자체완결).
const GH_INTERMEDIATE_CA = `-----BEGIN CERTIFICATE-----
MIIGGTCCBAGgAwIBAgIQE31TnKp8MamkM3AZaIR6jTANBgkqhkiG9w0BAQwFADCB
iDELMAkGA1UEBhMCVVMxEzARBgNVBAgTCk5ldyBKZXJzZXkxFDASBgNVBAcTC0pl
cnNleSBDaXR5MR4wHAYDVQQKExVUaGUgVVNFUlRSVVNUIE5ldHdvcmsxLjAsBgNV
BAMTJVVTRVJUcnVzdCBSU0EgQ2VydGlmaWNhdGlvbiBBdXRob3JpdHkwHhcNMTgx
MTAyMDAwMDAwWhcNMzAxMjMxMjM1OTU5WjCBlTELMAkGA1UEBhMCR0IxGzAZBgNV
BAgTEkdyZWF0ZXIgTWFuY2hlc3RlcjEQMA4GA1UEBxMHU2FsZm9yZDEYMBYGA1UE
ChMPU2VjdGlnbyBMaW1pdGVkMT0wOwYDVQQDEzRTZWN0aWdvIFJTQSBPcmdhbml6
YXRpb24gVmFsaWRhdGlvbiBTZWN1cmUgU2VydmVyIENBMIIBIjANBgkqhkiG9w0B
AQEFAAOCAQ8AMIIBCgKCAQEAnJMCRkVKUkiS/FeN+S3qU76zLNXYqKXsW2kDwB0Q
9lkz3v4HSKjojHpnSvH1jcM3ZtAykffEnQRgxLVK4oOLp64m1F06XvjRFnG7ir1x
on3IzqJgJLBSoDpFUd54k2xiYPHkVpy3O/c8Vdjf1XoxfDV/ElFw4Sy+BKzL+k/h
fGVqwECn2XylY4QZ4ffK76q06Fha2ZnjJt+OErK43DOyNtoUHZZYQkBuCyKFHFEi
rsTIBkVtkuZntxkj5Ng2a4XQf8dS48+wdQHgibSov4o2TqPgbOuEQc6lL0giE5dQ
YkUeCaXMn2xXcEAG2yDoG9bzk4unMp63RBUJ16/9fAEc2wIDAQABo4IBbjCCAWow
HwYDVR0jBBgwFoAUU3m/WqorSs9UgOHYm8Cd8rIDZsswHQYDVR0OBBYEFBfZ1iUn
Z/kxwklD2TA2RIxsqU/rMA4GA1UdDwEB/wQEAwIBhjASBgNVHRMBAf8ECDAGAQH/
AgEAMB0GA1UdJQQWMBQGCCsGAQUFBwMBBggrBgEFBQcDAjAbBgNVHSAEFDASMAYG
BFUdIAAwCAYGZ4EMAQICMFAGA1UdHwRJMEcwRaBDoEGGP2h0dHA6Ly9jcmwudXNl
cnRydXN0LmNvbS9VU0VSVHJ1c3RSU0FDZXJ0aWZpY2F0aW9uQXV0aG9yaXR5LmNy
bDB2BggrBgEFBQcBAQRqMGgwPwYIKwYBBQUHMAKGM2h0dHA6Ly9jcnQudXNlcnRy
dXN0LmNvbS9VU0VSVHJ1c3RSU0FBZGRUcnVzdENBLmNydDAlBggrBgEFBQcwAYYZ
aHR0cDovL29jc3AudXNlcnRydXN0LmNvbTANBgkqhkiG9w0BAQwFAAOCAgEAThNA
lsnD5m5bwOO69Bfhrgkfyb/LDCUW8nNTs3Yat6tIBtbNAHwgRUNFbBZaGxNh10m6
pAKkrOjOzi3JKnSj3N6uq9BoNviRrzwB93fVC8+Xq+uH5xWo+jBaYXEgscBDxLmP
bYox6xU2JPti1Qucj+lmveZhUZeTth2HvbC1bP6mESkGYTQxMD0gJ3NR0N6Fg9N3
OSBGltqnxloWJ4Wyz04PToxcvr44APhL+XJ71PJ616IphdAEutNCLFGIUi7RPSRn
R+xVzBv0yjTqJsHe3cQhifa6ezIejpZehEU4z4CqN2mLYBd0FUiRnG3wTqN3yhsc
SPr5z0noX0+FCuKPkBurcEya67emP7SsXaRfz+bYipaQ908mgWB2XQ8kd5GzKjGf
FlqyXYwcKapInI5v03hAcNt37N3j0VcFcC3mSZiIBYRiBXBWdoY5TtMibx3+bfEO
s2LEPMvAhblhHrrhFYBZlAyuBbuMf1a+HNJav5fyakywxnB2sJCNwQs2uRHY1ihc
6k/+JLcYCpsM0MF8XPtpvcyiTcaQvKZN8rG61ppnW5YCUtCC+cQKXA0o4D/I+pWV
idWkvklsQLI+qGu41SWyxP7x09fn1txDAXYw+zuLXfdKiXyaNb78yvBXAfCNP6CH
MntHWpdLgtJmwsQt6j8k9Kf5qLnjatkYYaA7jBU=
-----END CERTIFICATE-----`;
const ghAgent = new https.Agent({ keepAlive: true, ca: [...tls.rootCertificates, GH_INTERMEDIATE_CA] });

// node:https 요청(전역 fetch는 ca 주입 불가 + undici 미노출) → 검증 유지한 채 중간 인증서 공급.
function httpsReq(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, port: 443, path: u.pathname + u.search, method, headers, agent: ghAgent }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buffer: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
const ROOT = new URL('./data/', import.meta.url);
const RAW = new URL('raw/gh/', ROOT);
const DERIVED = new URL('derived/gh/', ROOT);
const IDX = new URL('index.json', ROOT);

const argv = process.argv.slice(2);
const getArg = (k, d) => (argv.find(a => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split('=')[1];
const PROBE = argv.includes('--probe');
const REFRESH = argv.includes('--refresh');   // CI 갱신: 기존 상태/마감일 갱신 + 신규는 new-pending 기록만(다운로드/추출 없음). 키 불필요.
const SINCE = getArg('since', '2026-05-01');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
// 게시판: [라벨, sb-board(목록/상세), sr-board(파일다운)]. sr7150=공공임대, sr7155=매입임대.
const BOARDS = [
  ['임대', 'sr7150', 'sr7150'],
  ['매입임대', 'sr7155', 'sr7155'],
];
const STATES = [['1', '공고중'], ['2', '접수중']];   // 접수마감(3) 제외 — CLAUDE.md §2
const listUrl = b => `${ORIGIN}/sb/sr/${b[1]}/selectPbancRentHouseList.do`;
const detailUrl = b => `${ORIGIN}/sb/sr/${b[1]}/selectPbancDetailView.do`;
const fileDownUrl = (b, p) => `${ORIGIN}/sr/${b[2]}/selectFileDown.do?pbancNo=${encodeURIComponent(p.pbancNo)}&atchFileSn=${encodeURIComponent(p.atchFileSn)}&atchFileDtlSn=${encodeURIComponent(p.atchFileDtlSn)}&mode=1`;

const SKIP_FILE = /팸플릿|팜플렛|리플렛|리플릿|브로슈어|카탈로그|조감도|평면도|위임장|서식|별지/;
const sani = s => String(s).replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
const dwell = ms => new Promise(r => setTimeout(r, ms));
const TODAY = new Date().toISOString().slice(0, 10);
function loadIndex() { try { return JSON.parse(readFileSync(IDX, 'utf8')); } catch { return {}; } }
// new-pending.json 소스별 병합(CI에서 lh→sh→gh 순차 갱신 시 서로 덮어쓰지 않게). 이 소스 항목만 교체.
function mergeNewPending(source, entries) {
  let cur = []; try { cur = JSON.parse(readFileSync(new URL('new-pending.json', ROOT), 'utf8')); } catch {}
  if (!Array.isArray(cur)) cur = [];
  const others = cur.filter(x => !String(x.panId || '').startsWith(`${source}-`));
  writeFileSync(new URL('new-pending.json', ROOT), JSON.stringify([...others, ...entries], null, 2));
}

async function postForm(url, fields, referer) {
  const body = new URLSearchParams(fields).toString();
  const r = await httpsReq(url, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9', 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), ...(referer ? { Referer: referer } : {}) },
    body,
  });
  const text = r.buffer.toString('utf8');
  if (/netfunnel|대기.*순번|service is busy/i.test(text.slice(0, 500))) throw new Error('NetFunnel 대기열 활성화됨 — 수집 중단(브라우저 큐 필요)');
  return text;
}

// 목록 행 파싱 → [{pbancNo, pbancKndCd, bizTyNm, title, 지역, 공고일, 마감일, 상태}]
function parseList(html) {
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g; let m;
  while ((m = trRe.exec(html))) {
    const row = m[1];
    const a = row.match(/data-pbancNo="(\d+)"[^>]*data-pbancKndCd="([^"]*)"[^>]*data-bizTyNm="([^"]*)"/);
    if (!a) continue;
    const tm = row.match(/data-bizTyNm="[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    const title = tm ? tm[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    const rm = row.match(/<\/a>\s*<\/td>\s*<td>\s*([^<]+?)\s*</);     // 제목셀 다음 = 지역
    const dates = [...row.matchAll(/(20\d\d-\d\d-\d\d)/g)].map(x => x[1]);
    const st = row.match(/(정정공고중|공고중|접수중|접수마감)/);
    rows.push({ pbancNo: a[1], pbancKndCd: a[2], bizTyNm: a[3].trim(), title, 지역: rm ? rm[1].trim() : null, 공고일: dates[0] || null, 마감일: dates[1] || null, 상태: st ? st[1] : null });
  }
  return rows;
}

// 상세 → 첨부 [{pbancNo, atchFileSn, atchFileDtlSn, name, bytes}]
function parseAttachments(html) {
  const out = [];
  const re = /selectFileDown\.do\?([^"']*)["'][^>]*>([\s\S]*?)<\/a>/g; let m;
  while ((m = re.exec(html))) {
    const q = Object.fromEntries(new URLSearchParams(m[1]));
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const bm = text.match(/\(([\d,]+)\s*Byte\)/i);
    const name = text.replace(/\(([\d,]+)\s*Byte\)/i, '').trim();
    out.push({ pbancNo: q.pbancNo, atchFileSn: q.atchFileSn, atchFileDtlSn: q.atchFileDtlSn, name, bytes: bm ? Number(bm[1].replace(/,/g, '')) : null });
  }
  return out;
}

async function fetchNoticeFiles(b, atts, referer, dir) {
  const files = [];
  for (const f of atts) {
    if (SKIP_FILE.test(f.name)) { files.push({ ...f, skipped: '팸플릿/서식류' }); continue; }
    if (!/\.(pdf|hwp|hwpx)$/i.test(f.name)) { files.push({ ...f, skipped: '비문서' }); continue; }
    try {
      const r = await httpsReq(fileDownUrl(b, f), { headers: { 'User-Agent': UA, Referer: referer } });
      const buf = r.buffer;
      if (buf.length < 100 || /<!DOCTYPE html/i.test(buf.subarray(0, 200).toString('latin1'))) { files.push({ ...f, skipped: '다운실패' }); continue; }
      const ext = (f.name.match(/\.[a-z0-9]+$/i) || ['.pdf'])[0].toLowerCase();
      mkdirSync(new URL('files/', dir), { recursive: true });
      writeFileSync(new URL(`files/${f.atchFileDtlSn}__${sani(f.name)}`, dir), buf);
      files.push({ ...f, ext });
      await dwell(200);
    } catch { files.push({ ...f, skipped: '오류' }); }
  }
  return files;
}

// 행 → 통합 envelope(SCHEMA §0). 상태·마감일은 목록제공, 소득/자산은 공고문 PDF 추출 후속.
function toEnvelope(b, row) {
  return {
    panId: `gh-${row.pbancNo}`, source: 'gh', 상품군: '임대',
    공고명: row.title, 유형: row.bizTyNm || b[0], 상품구조: '임대', 공급기관: 'GH 경기주택도시공사',
    지역: ['경기', row.지역].filter(Boolean).join(' '), 주소: null,
    공고일: row.공고일, 접수시작: null, 마감일: row.마감일, 상태: row.상태, 당첨자발표: null, 공고구분: null,
    단지: [], 공급형: [],
    선정방식: '순위', 선정방식상세: `GH ${row.bizTyNm || b[0]} — 자격·순위·소득/자산 컷은 공고문 확인.`,
    자격요건: {
      무주택: '무주택세대구성원(유형별 상이 — 공고문 확인)',
      소득기준: { 종류: '공고문미기재', 기본퍼센트: null, 가구원수별: null, 가산규칙: '', 비고: 'GH 목록 소득기준 미제공 — 공고문 PDF 확인' },
      자산상한: '공고문미기재', 자동차상한: '공고문미기재', 청약요건: '공고문미기재', 대상계층: ['일반'], 계층별: null,
    },
    순위규칙: [], 배점표: [], 우선배정: [],
    원문링크: { 상세페이지: detailUrl(b), 공급기관: ORIGIN, pbancNo: row.pbancNo, pbancKndCd: row.pbancKndCd },
    _검증노트: ['소득/자산기준 목록미제공 → 공고문 PDF 추출 필요(myhome식 파이프라인)'],
  };
}

// ── 실행 ───────────────────────────────────────────────────
if (PROBE) {
  for (const b of BOARDS) {
    for (const [sv, sn] of STATES) {
      const rows = parseList(await postForm(listUrl(b), { searchState: sv, pageIndex: '1' }));
      console.log(`✅ ${b[0]}/${sn}: ${rows.length}행`);
      for (const r of rows.slice(0, 5)) console.log(`  ${r.pbancNo} [${r.pbancKndCd}] ${r.상태} ~${r.마감일} ${r.지역} ${r.title.slice(0, 32)}`);
    }
  }
  const b = BOARDS[0];
  const rows = parseList(await postForm(listUrl(b), { searchState: '1', pageIndex: '1' }));
  if (rows[0]) {
    const dv = await postForm(detailUrl(b), { pbancNo: rows[0].pbancNo, pbancKndCd: rows[0].pbancKndCd, previewYn: 'N' });
    console.log(`\n첨부(pbancNo ${rows[0].pbancNo}): ${JSON.stringify(parseAttachments(dv).map(f => f.name))}`);
    console.log('\nenvelope 샘플:\n' + JSON.stringify(toEnvelope(b, rows[0]), null, 1));
  }
  process.exit(0);
}

const index = loadIndex();
let isNew = 0, kept = 0, skippedOld = 0;
const byBoard = {}, newPending = [];
try {
  for (const b of BOARDS) {
    for (const [sv] of STATES) {
      for (let page = 1; ; page++) {
        const html = await postForm(listUrl(b), { searchState: sv, pageIndex: String(page) });
        const rows = parseList(html);
        if (!rows.length) break;     // "데이터 없음" 행엔 data-pbancNo 없음 → 0행 = 종료
        for (const row of rows) {
          if (row.공고일 && row.공고일 < SINCE) { skippedOld++; continue; }
          const env = toEnvelope(b, row);
          kept++; byBoard[b[0]] = (byBoard[b[0]] || 0) + 1;
          const idxKey = env.panId, slug = row.pbancNo;
          const ddir = new URL(`${slug}/`, DERIVED);
          // 상태·마감일은 매 실행 갱신(목록제공). 이미 받았으면 메타만 갱신하고 재다운 안 함.
          if (index[idxKey]?.done) {
            Object.assign(index[idxKey], { 상태: env.상태, 마감일: env.마감일 });
            try { const r = JSON.parse(readFileSync(new URL('requirements.json', ddir), 'utf8')); r.상태 = env.상태; r.마감일 = env.마감일; writeFileSync(new URL('requirements.json', ddir), JSON.stringify(r, null, 2)); } catch {}
            continue;
          }
          if (REFRESH) {   // CI 갱신: 신규는 다운로드/추출 없이 목록만 기록(로컬 process-all이 처리)
            newPending.push({ panId: env.panId, title: env.공고명, type: env.유형, region: env.지역, 상태: env.상태, 마감일: env.마감일 });
            isNew++; continue;
          }
          mkdirSync(ddir, { recursive: true });
          const dir = new URL(`${slug}/`, RAW);
          mkdirSync(dir, { recursive: true });
          const dv = await postForm(detailUrl(b), { pbancNo: row.pbancNo, pbancKndCd: row.pbancKndCd, previewYn: 'N' }, listUrl(b));
          const atts = parseAttachments(dv);
          if (!existsSync(new URL('attachments.json', dir))) writeFileSync(new URL('attachments.json', dir), JSON.stringify(atts, null, 2));
          let files = [];
          try { files = await fetchNoticeFiles(b, atts, detailUrl(b), dir); } catch { /* 비치명적 */ }
          env.files = files;
          writeFileSync(new URL('meta.json', dir), JSON.stringify(env, null, 2));
          writeFileSync(new URL('requirements.json', ddir), JSON.stringify(env, null, 2));
          index[idxKey] = { source: 'gh', title: env.공고명, region: env.지역, type: env.유형, 공급기관: env.공급기관, 상태: env.상태, 마감일: env.마감일, files: files.length, done: true };
          isNew++;
          if (isNew <= 40) console.log(`  ✅ ${env.panId} ${(env.공고명 || '').slice(0, 30)} · ${env.유형} · ${env.상태} ~${env.마감일} · 첨부 ${files.filter(f => !f.skipped).length}`);
          await dwell(150);
        }
      }
    }
  }
} catch (e) { console.error(`❌ ${e.message}`); process.exit(1); }

mkdirSync(ROOT, { recursive: true });
writeFileSync(IDX, JSON.stringify(index, null, 2));
if (REFRESH) { mergeNewPending('gh', newPending); console.log(`\n[refresh] 상태 갱신 완료. 미추출 신규 ${newPending.length}건 → data/new-pending.json (다운로드/추출은 로컬 process-all).`); process.exit(0); }
console.log(`\n신규 ${isNew} · 유지 ${kept} · 기간밖 ${skippedOld}`);
console.log(`게시판 분포(수집분): ${JSON.stringify(byBoard)}`);
console.log(`gh index ${Object.keys(index).filter(k => k.startsWith('gh-')).length}건. 소득/자산은 공고문 PDF 추출 후속.`);
