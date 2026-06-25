// prune-index.mjs — index.json 누적 관리(안전·복구가능). 충분히 오래된 마감 공고만 index-archive.json으로 이관.
//   사용: node prune-index.mjs [--days=180] [--apply]   (기본 dry-run, --apply 시 실제 이관)
//
// ⚠️ 왜 보수적인가: index는 증분 dedup의 권위(index[panId].done → 재다운로드 스킵). 최근 마감 공고는 아직 소스
//   목록에 남아 있어, index에서 지우면 다음 수집이 NEW로 오인해 재다운로드한다. 그래서 '마감일이 N일 이상 지난'
//   (= 소스 목록에서 빠진) 건만 대상. 삭제가 아니라 index-archive.json으로 이관 → 필요 시 복구. derived/site는 건드리지 않음.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const ROOT = new URL('./data/', import.meta.url);
const IDX = new URL('index.json', ROOT);
const ARC = new URL('index-archive.json', ROOT);
const argv = process.argv.slice(2);
const DAYS = parseInt((argv.find(a => a.startsWith('--days=')) || '--days=180').split('=')[1], 10);
const APPLY = argv.includes('--apply');
const TODAY = new Date();
const cutoff = new Date(TODAY - DAYS * 864e5).toISOString().slice(0, 10);

const idx = JSON.parse(readFileSync(IDX, 'utf8'));
const arc = existsSync(ARC) ? JSON.parse(readFileSync(ARC, 'utf8')) : {};

const toArchive = [];
for (const [k, e] of Object.entries(idx)) {
  const closed = e.상태 === '접수마감' || (e.마감일 && e.마감일 < TODAY.toISOString().slice(0, 10));
  if (closed && e.마감일 && e.마감일 < cutoff) toArchive.push(k);   // 마감일이 cutoff보다 오래됨(= 소스에서 빠짐)
}

console.log(`index ${Object.keys(idx).length}건 · 마감일 ${DAYS}일+ 경과(${cutoff} 이전) 이관대상 ${toArchive.length}건`);
if (!toArchive.length) { console.log('이관할 항목 없음 — 현재 누적은 전부 최근 마감(소스 목록 잔존 가능). prune 불필요.'); process.exit(0); }
console.log('  ' + toArchive.slice(0, 10).join(', ') + (toArchive.length > 10 ? ' …' : ''));

if (!APPLY) { console.log('\n(dry-run) 실제 이관은 --apply'); process.exit(0); }
for (const k of toArchive) { arc[k] = { ...idx[k], 아카이브일: TODAY.toISOString().slice(0, 10) }; delete idx[k]; }
writeFileSync(IDX, JSON.stringify(idx, null, 2));
writeFileSync(ARC, JSON.stringify(arc, null, 2));
console.log(`\n✅ ${toArchive.length}건 → index-archive.json 이관. index ${Object.keys(idx).length}건 잔존(복구: archive에서 되돌리면 됨).`);
