// 마감 경과 derived prune — 사이트 인라인 비대(장기 누적) 방지. 결정론·멱등.
// 사용: node prune-expired.mjs [--grace=60] [--source=applyhome] [--dry]
//   GRACE: 마감일이 (오늘-GRACE일)보다 과거면 정리 대상. 기본 60일(최근 마감건은 '닫힘'으로 잠시 열람 가능하게 보존).
// 원칙:
//   - derived는 재생성 가능 → 삭제(사이트에서 빠짐). index에 tombstone(pruned:true)으로 부활 차단.
//   - applyhome raw는 API JSON(재취득 가능) → 함께 삭제(derive 전건 재생성형이라 raw 남으면 부활).
//   - lh/sh/gh/myhome raw는 불변 원본(PDF 등, CLAUDE.md §2) → 보존. 이들 derive는 큐 기반이라 자동 부활 안 함.
import { readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';

const ROOT = new URL('./data/', import.meta.url);
const IDX = new URL('index.json', ROOT);
const argv = process.argv.slice(2);
const getArg = (k, d) => { const a = argv.find(s => s.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const GRACE = Number(getArg('grace', '60'));
const ONLY = getArg('source', '');
const DRY = argv.includes('--dry');

const TODAY = new Date().toISOString().slice(0, 10);
const cut = new Date(Date.now() - GRACE * 864e5).toISOString().slice(0, 10);
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

const index = existsSync(IDX) ? JSON.parse(readFileSync(IDX, 'utf8')) : {};
const SOURCES = ['lh', 'applyhome', 'myhome', 'sh', 'gh'].filter(s => !ONLY || s === ONLY);

let grand = 0;
const report = {};
for (const src of SOURCES) {
  const dir = new URL(`derived/${src}/`, ROOT);
  let dirs = [];
  try { dirs = readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { continue; }
  let pruned = 0;
  for (const no of dirs) {
    const rp = new URL(`derived/${src}/${no}/requirements.json`, ROOT);
    if (!existsSync(rp)) continue;
    let r; try { r = JSON.parse(readFileSync(rp, 'utf8')); } catch { continue; }
    const due = index[r.panId]?.마감일 ?? r.마감일;       // index(신선도 갱신본) 우선, 없으면 derived
    if (!isDate(due) || due >= cut) continue;              // 미상·미래·유예내 → 보존
    pruned++; grand++;
    if (DRY) { if (pruned <= 5) report[src] = report[src] || []; (report[src] ||= []).push(`${no} (마감 ${due}) ${(r.공고명 || '').slice(0, 24)}`); continue; }
    rmSync(new URL(`derived/${src}/${no}/`, ROOT), { recursive: true, force: true });
    if (src === 'applyhome') rmSync(new URL(`raw/${src}/${no}/`, ROOT), { recursive: true, force: true });  // 불변 raw(lh PDF 등)는 보존, applyhome JSON만 삭제
    if (index[r.panId]) index[r.panId].pruned = true;     // tombstone — collect/derive 부활 차단
    else index[r.panId] = { source: src, 마감일: due, pruned: true };
  }
  if (pruned) report[src] = DRY ? report[src] : pruned;
}

if (!DRY && grand) writeFileSync(IDX, JSON.stringify(index, null, 2));
console.log(`${DRY ? '[DRY] ' : ''}prune GRACE ${GRACE}일 (마감 < ${cut}) — 정리 ${grand}건`);
for (const src of SOURCES) if (report[src]) console.log(`  ${src}: ${DRY ? '\n    ' + report[src].join('\n    ') + (report[src].length === 5 ? ' …' : '') : report[src] + '건'}`);
if (!grand) console.log('  (정리 대상 없음 — 모두 유예기간 내/마감일 미상)');
