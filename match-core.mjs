// match-core — 매칭 로직 단일 소스(순수 함수, node·브라우저 공용)
//   createMatcher(P, todayStr).evaluate(req) → 판정/순위/배점 결과.
//   파일 IO·CLI·출력은 match.mjs, 웹 인라인은 build-site.mjs(=export 제거 후 주입).
//   외부 LLM API 미사용. 확정 가능한 것만 판정, 불확실은 "확인필요"/"참고"(추측 금지).
export function createMatcher(P, todayStr) {
  const TODAY = new Date(todayStr);
  const age = P.생년월일 ? Math.floor((TODAY - new Date(P.생년월일)) / (365.25 * 864e5)) : null;
  const 미성년자녀 = (P.자녀 || []).filter(c => c.생년월일 && (TODAY - new Date(c.생년월일)) / (365.25 * 864e5) < 19 || c.태아).length;
  const won = n => (n == null ? '?' : (n / 1e4).toLocaleString() + '만');
  const LH_LIST = 'https://apply.lh.or.kr/lhapply/apply/wt/wrtanc/selectWrtancList.do?mi=1026';
  // 동작하는 원문 링크 선택: LH 상세페이지(selectWrtancInfo.do)는 GET 시 "비정상 경로" 에러라 못 씀
  //   → LH는 공고문 PDF(lhFile.do, GET 검증됨), 분양(청약홈)은 상세페이지가 GET 정상.
  function pickLink(req) {
    const ln = req.원문링크 || {};
    if (req.상품구조 === '분양') return ln.상세페이지 ? { url: ln.상세페이지, label: '원문 공고 보기' } : { url: null, label: null };
    if (ln.공고문PDF) return { url: ln.공고문PDF, label: '공고문 PDF(원문)' };
    const pdf = (ln.첨부 || []).find(a => a.ext === '.pdf');
    if (pdf) return { url: pdf.다운로드, label: '공고문 PDF(원문)' };
    return { url: LH_LIST, label: 'LH 공고목록에서 검색' };
  }

  // ── 게이트(임대) ──────────────────────────────────────────
  function gateHousing() {
    if (P.무주택 === true) return { s: 'pass', m: '무주택' };
    if (P.무주택 === false) return { s: 'fail', m: '유주택(무주택 요건 미충족)' };
    return { s: 'check', m: '무주택 여부 미입력' };
  }
  function gateIncome(req) {
    const sg = req.자격요건?.소득기준;
    if (!sg || typeof sg !== 'object') return { s: 'check', m: '소득기준 형태 불명 → 원문확인' };
    if (sg.종류 === '없음' || sg.종류 === '자격증명갈음') return { s: 'pass', m: `소득심사 ${sg.종류}` };
    // 자격완화 등으로 소득요건 배제: 쓸 표가 없고 비고에 배제/심사없음이 명시된 경우(추출이 종류='없음'을 못 잡은 케이스 보정)
    const noTable = !sg.가구원수별 || !Object.keys(sg.가구원수별).length;
    // '소득요건 배제/제한 없음/심사 없음/미적용' 등 한 문장 내 표현을 포괄(자격완화로 소득 배제했는데 종류가 '없음'으로 정규화 안 된 경우 보정)
    if (noTable && /소득[^.]{0,10}(제한\s*없|배제|없음|미적용)/.test(sg.비고 || ''))
      return { s: 'pass', m: '소득심사 없음(자격완화로 배제)' };
    if (P.월평균소득 == null || P.세대원수 == null) return { s: 'check', m: '소득/세대원수 미입력' };
    const row = sg.가구원수별?.[`${P.세대원수}인`];
    if (!row || typeof row !== 'object') return { s: 'check', m: `${P.세대원수}인 소득표 없음(기본 ${sg.기본퍼센트 ?? '?'}%) → 원문확인` };
    const [pct, limit] = Object.entries(row)[0];
    if (typeof limit !== 'number') return { s: 'check', m: '소득 상한 수치 없음' };
    return P.월평균소득 <= limit
      ? { s: 'pass', m: `소득 ${won(P.월평균소득)} ≤ ${pct} ${won(limit)}` }
      : { s: 'fail', m: `소득초과 ${won(P.월평균소득)} > ${pct} ${won(limit)}` };
  }
  function gateLimit(val, mine, label, via) {
    const suf = via ? ` (${via} 기준)` : '';
    if (val === '없음') return { s: 'pass', m: `${label} 심사 없음${suf}` };
    if (typeof val === 'number') {
      if (mine == null) return { s: 'check', m: `${label} 미입력 — 입력하면 판정` };   // 내 정보 누락(행동가능)
      return mine <= val ? { s: 'pass', m: `${label} ${won(mine)} ≤ ${won(val)}${suf}` }
        : { s: 'fail', m: `${label}초과 ${won(mine)} > ${won(val)}${suf}` };
    }
    return { s: 'check', m: `공고에 ${label} 기준 미기재 → 원문확인` };               // 공고 자체에 기준 없음
  }
  // 계층 키 정규화(사용자 입력 → 캐논 enum). normalize-requirements.mjs와 동일 규칙(데이터는 빌드 전 정규화됨).
  const isMissing = v => v == null || v === '공고문미기재' || v === '미기재' || v === '' || (typeof v === 'string' && /계층별|상이/.test(v));
  function canonTier(key) {
    const k = String(key).replace(/계층|\s|·|ㆍ|_|\(.*?\)/g, '');
    if (/대학생|취업준비생/.test(k)) return '대학생';
    if (/청년|사회초년생|청년창업/.test(k)) return '청년';
    if (/신혼|한부모|예비신혼/.test(k)) return '신혼·한부모';
    if (/고령/.test(k)) return '고령자';
    if (/주거급여/.test(k)) return '주거급여수급자';
    if (/산단|산업단지/.test(k)) return '산업단지근로자';
    if (/주거약자/.test(k)) return '주거약자';
    if (/일반|공통/.test(k)) return '일반';
    return String(key).trim();
  }
  // 자산/자동차 상한이 top-level엔 미기재여도, 본인 계층(캐논)의 계층별 값으로 평가
  function tierKeyFor(계층별) {
    const keys = Object.keys(계층별 || {}); if (!keys.length) return null;
    const want = [];
    (P.공급계층선택 || []).forEach(s => want.push(canonTier(s)));
    if (P.수급자 && P.수급자 !== '해당없음') want.push('주거급여수급자');
    if (['혼인중', '예비', '한부모'].includes(P.혼인상태)) want.push('신혼·한부모');
    if (age != null && age >= 65) want.push('고령자');
    if (age != null && age >= 19 && age <= 39) want.push('청년');
    for (const w of want) if (keys.includes(w)) return w;
    return null;
  }
  function tierLimit(req, topVal, tierField, label, mine) {
    if (!isMissing(topVal)) return gateLimit(topVal, mine, label);
    const 계층별 = req.자격요건?.계층별, key = tierKeyFor(계층별);
    if (key && 계층별[key] && !isMissing(계층별[key][tierField]))
      return gateLimit(계층별[key][tierField], mine, label, key);
    return gateLimit(topVal, mine, label);   // 계층 못 정하면 '확인필요'
  }
  function gateSubscription(req) {
    const c = req.자격요건?.청약요건;
    if (!c || c === '없음' || /없음|불필요|미적용/.test(c)) return { s: 'pass', m: '청약통장 불필요' };
    if (P.청약저축?.가입 === true) return { s: 'check', m: '청약통장 필요(가입O, 회차/금액은 원문확인)' };
    if (P.청약저축?.가입 === false) return { s: 'fail', m: '청약통장 필요(미가입)' };
    return { s: 'check', m: '청약통장 보유 여부 미입력 → 입력하면 판정' };
  }
  function gateTier(req) {
    const t = req.유형 || '', name = req.공고명 || '', 계층 = (req.자격요건?.대상계층 || []).join(' ');
    if (/고령자/.test(name) || (/고령자/.test(계층) && !/행복주택/.test(t))) {
      if (age != null && age >= 65) return { s: 'pass', m: '고령자(65+) 해당' };
      return { s: 'check', m: '고령자복지주택=만65세+ 대상(본인 미해당 가능)' };
    }
    if (t === '영구임대') {
      if (P.수급자 && P.수급자 !== '해당없음') return { s: 'pass', m: `영구임대 자격(${P.수급자})` };
      if ((P.특수자격 || []).length) return { s: 'check', m: '영구임대 특수자격 확인' };
      return { s: 'check', m: '영구임대=수급자/차상위/국가유공 등 대상(본인 해당없음 가능)' };
    }
    if (/행복주택/.test(t)) {
      const sel = P.공급계층선택 || [];
      const has = sel.some(s => 계층.includes(s) || 계층.includes(s.replace('부부', '')));
      const youth = age != null && age >= 19 && age <= 39;
      const 신혼 = ['혼인중', '예비', '한부모'].includes(P.혼인상태);
      if (has || youth || 신혼) return { s: 'pass', m: '행복 계층(청년/신혼/선택계층) 해당가능' };
      return { s: 'check', m: '행복 공급계층(청년/신혼/대학생/고령자 등) 확인' };
    }
    return { s: 'pass', m: '' };
  }

  function supplyForm(r) {
    const hasReal공급형 = (r.공급형 || []).some(f => (f.전용면적 || 0) > 0);
    if (r.전세지원 && !r.주택목록) return { code: '지원형', label: '지원형(전세보증금지원·집 직접탐색)' };
    if (r.주택목록) return { code: '실물', label: '실물공급(매입주택목록서 선택)' };
    if (r.매입주택) return { code: '실물', label: '실물공급(매입주택·목록미연동)' };
    if (hasReal공급형) return { code: '실물', label: '실물공급(건설단지 호실)' };
    return { code: '불명', label: '공급형태 불명' };
  }
  function residenceRank(req) {
    const rules = (req.순위규칙 || []).filter(r => /거주/.test(r.기준 || ''));
    if (!rules.length) return null;
    const sgg = P.거주지?.시군구, sd = P.거주지?.시도;
    const hit = [];
    for (const r of rules) {
      const txt = (r.조건 || []).join(' ');
      if ((sgg && txt.includes(sgg)) || (sd && txt.includes(sd))) hit.push(r.순위);
    }
    if (hit.length) return { rank: Math.min(...hit), maxRank: Math.max(...rules.map(r => r.순위)) };
    return { rank: null, maxRank: Math.max(...rules.map(r => r.순위)) };
  }
  function areaMatch(req) {
    const wMin = P.희망?.전용면적?.min, wMax = P.희망?.전용면적?.max;
    if (wMin == null && wMax == null) return null;   // 면적 희망 미입력 → 매칭/표시 안 함
    const areas = (req.공급형 || []).map(f => f.전용면적).filter(a => typeof a === 'number' && a > 0);
    let min = areas.length ? Math.min(...areas) : null, max = areas.length ? Math.max(...areas) : null;
    const hl = req.주택목록?.전용면적;
    if (hl?.최소 != null) { min = min == null ? hl.최소 : Math.min(min, hl.최소); max = max == null ? hl.최대 : Math.max(max, hl.최대); }
    if (min == null) return { ok: null, range: null };
    const ok = !((wMin != null && max < wMin) || (wMax != null && min > wMax));   // 한쪽만 입력해도 그 조건만 적용
    return { ok, range: [min, max] };
  }
  function regionMatch(req) {
    const want = P.희망?.지역; if (!want?.length) return null;
    const hay = [req.지역, ...(req.단지 || []).map(d => d.주소), ...Object.keys(req.주택목록?.지역분포 || {})].join(' ');
    const hit = want.filter(w => hay.includes(w));
    return { ok: hit.length > 0, hit };
  }
  function pickBand(bands, value) {
    for (const [label, score] of bands) {
      const nums = (label.match(/\d+/g) || []).map(Number);
      if (!nums.length) continue;
      const n = nums[0];
      if (/이상|초과|\+/.test(label)) { if (value >= n) return score; }
      else if (/미만|이하/.test(label)) { if (value <= n) return score; }
      else if (value >= n) return score;
    }
    return 0;
  }
  function estimateScore(req) {
    const tbl = req.배점표 || []; if (!tbl.length) return null;
    let got = 0, max = 0; const used = [], skipped = [];
    // 괄호 부연(예: "대학생 거주지(부모 거주지)")은 제거 후 핵심 라벨만 — 기계적 자르기로 괄호 깨지는 것 방지
    const lbl = s => String(s).replace(/[（(].*$/, '').replace(/\s+/g, ' ').trim().slice(0, 22);
    for (const item of tbl) {
      const name = item.항목 || ''; const bands = item.구간 || [];
      const top = Math.max(0, ...bands.map(b => b[1] || 0)); max += top;
      let v = null;
      if (/거주\s*기간|연속\s*거주/.test(name)) v = (P.거주개월 ?? 0) / 12;
      else if (/자녀/.test(name)) v = 미성년자녀;
      else if (/납입\s*횟수|청약/.test(name)) v = P.청약저축?.납입횟수 ?? 0;
      else if (/무주택\s*기간/.test(name)) v = (P.무주택기간개월 ?? 0) / 12;
      if (v == null) { skipped.push(lbl(name)); continue; }
      const sc = pickBand(bands, v); got += sc; used.push(`${lbl(name)}:${sc}`);
    }
    return { got, max, used, skipped };
  }

  // ── 분양: 가점 84점·청약순위·지역우선·특공 ──────────────────
  const 신혼대상 = () => {
    const yrs = P.혼인신고일 ? (TODAY - new Date(P.혼인신고일)) / (365.25 * 864e5) : null;
    return P.혼인상태 === '예비' || (['혼인중', '한부모'].includes(P.혼인상태) && yrs != null && yrs <= 7);
  };
  function 가점Calc() {
    const notes = [];
    let 무주택점;
    if (P.무주택 !== true) { 무주택점 = 0; notes.push('유주택→무주택기간 0'); }
    else if (P.무주택기간개월 == null) 무주택점 = null;
    else if (age != null && age < 30 && !['혼인중', '예비', '한부모'].includes(P.혼인상태)) { 무주택점 = 0; notes.push('만30세미만 미혼→무주택기간 미산정'); }
    else { const m = P.무주택기간개월; 무주택점 = m < 12 ? 2 : Math.min(32, 2 + Math.floor(m / 12) * 2); }

    const 직계존속 = P.부양가족?.직계존속 ?? 0;
    const 배우자 = P.혼인상태 === '혼인중' ? 1 : 0;
    const 미혼자녀 = (P.자녀 || []).length;
    const 부양수 = 배우자 + 미혼자녀 + 직계존속;
    const 부양점 = Math.min(35, 5 + 부양수 * 5);

    let 통장점;
    if (!P.청약저축?.가입) 통장점 = 0;
    else if (P.청약저축?.가입개월 == null) 통장점 = null;
    else { const g = P.청약저축.가입개월; 통장점 = g < 6 ? 1 : g < 12 ? 2 : Math.min(17, 3 + Math.floor((g - 12) / 12)); }

    const known = [무주택점, 부양점, 통장점].every(p => p != null);
    const total = (무주택점 || 0) + (부양점 || 0) + (통장점 || 0);
    return { 무주택점, 부양점, 통장점, 부양수, total, known, notes };
  }
  function 청약순위(req) {
    if (P.청약저축?.가입 !== true) return { m: P.청약저축?.가입 === false ? '통장미가입' : '통장 미입력' };
    const reg = req.규제?.투기과열지구 || req.규제?.조정대상지역;
    const capital = ['서울', '경기', '인천'].includes(P.거주지?.시도);
    const th = reg ? 24 : capital ? 12 : 6;
    const g = P.청약저축?.가입개월;
    if (g == null) return { m: '가입기간 미입력' };
    return g >= th ? { rank: 1, m: `1순위(가입 ${g}≥${th}개월)` } : { rank: 2, m: `2순위(가입 ${g}<${th}개월)` };
  }
  function 지역우선(req) {
    const tiers = (req.순위규칙 || []).map(r => (r.조건 || [])[0]).filter(Boolean);
    const sgg = P.거주지?.시군구, sd = P.거주지?.시도;
    const 공고시도 = (req.지역 || '').split(' ')[0];
    const 공고주소 = [req.지역, ...(req.단지 || []).map(d => d.주소)].join(' ');
    let mine = '기타지역';
    if (sgg && 공고주소.includes(sgg)) mine = '해당지역';
    else if (sd && 공고시도 && sd === 공고시도) mine = '기타경기/광역';
    return { tier: mine, exists: tiers.includes(mine) };
  }
  function 특공Match(req) {
    const avail = t => (req.공급형 || []).reduce((s, f) => s + (f.특별공급?.[t] || 0), 0);
    const out = [];
    if (신혼대상() && avail('신혼부부')) out.push(`신혼부부(${avail('신혼부부')})`);
    if (미성년자녀 >= 2 && avail('다자녀')) out.push(`다자녀(${avail('다자녀')})`);
    const 신생아 = (P.자녀 || []).some(c => c.태아 || (c.생년월일 && (TODAY - new Date(c.생년월일)) / (365.25 * 864e5) <= 2));
    if (신생아 && avail('신생아')) out.push(`신생아(${avail('신생아')})`);
    return out;
  }

  // 신혼희망타운(공공분양) 표준 자격 — 정책값 인코딩(연도 명시). 소득=2024적용 도시근로자 100%, 자산=2026적용.
  const NHT_INC = { 1: 3482964, 2: 5415712, 3: 7198649, 4: 8248467, 5: 8775071 }; // 100%(2024적용=2023통계)
  const NHT_ASSET = 362000000; // 총자산 3.62억(2026 적용)
  function evalNHT(req) {
    const fails = [], checks = [], 참고 = [];
    // 대상계층: 혼인 7년 이내 / 만7세미만 자녀 / 예비신혼 / 한부모(7세미만 자녀)
    const yrs = P.혼인신고일 ? (TODAY - new Date(P.혼인신고일)) / (365.25 * 864e5) : null;
    const 자녀7 = (P.자녀 || []).some(c => c.태아 || (c.생년월일 && (TODAY - new Date(c.생년월일)) / (365.25 * 864e5) < 7));
    if (P.혼인상태 == null && !(P.자녀 || []).length) checks.push('대상:혼인/자녀 정보 미입력');
    else if (!(P.혼인상태 === '예비' || (['혼인중', '한부모'].includes(P.혼인상태) && yrs != null && yrs <= 7) || 자녀7))
      fails.push('대상:신혼희망타운=혼인7년이내·만7세미만자녀·예비신혼만');
    // 무주택
    const gH = gateHousing();
    if (gH.s === 'fail') fails.push(`무주택:${gH.m}`); else if (gH.s === 'check') checks.push(`무주택:${gH.m}`);
    // 청약통장 가입 6개월·6회
    if (P.청약저축?.가입 !== true) (P.청약저축?.가입 === false ? fails : checks).push('청약통장:가입 필요(6개월·6회↑)');
    else { const g = P.청약저축?.가입개월, c = P.청약저축?.납입횟수;
      if (g == null || c == null) checks.push('청약통장:가입기간/납입횟수 미입력');
      else if (g < 6 || c < 6) fails.push(`청약통장:6개월·6회 미달(현재 ${g}개월·${c}회)`); }
    // 총자산 3.62억(2026)
    if (P.총자산 == null) checks.push('자산:미입력');
    else if (P.총자산 > NHT_ASSET) fails.push(`자산초과:${won(P.총자산)}>3.62억(2026 정책값)`);
    // 소득 130%(맞벌이 140%)
    const n = Math.min(P.세대원수 || 1, 5), base = NHT_INC[n], rate = P.맞벌이 ? 1.4 : 1.3;
    const lim = base ? Math.round(base * rate) : null;
    if (P.월평균소득 == null || P.세대원수 == null) checks.push('소득:소득/세대원수 미입력');
    else if (lim && P.월평균소득 > lim) fails.push(`소득초과:${won(P.월평균소득)}>${P.맞벌이 ? '140' : '130'}% ${won(lim)}(2024 도시근로자 기준)`);
    참고.push('기준=신혼희망타운 표준 정책값(소득 2024적용·자산 2026). 공고문과 다를 수 있음');
    참고.push('본청약: 사전청약 당첨자 우선공급 후 일반공급(60%)·추첨(10%) — 신규 신청분/물량은 공고문 확인');
    const 배점 = '우선공급 가점제(30%)+일반(60%)+추첨(10%) — 신혼희망타운 점수표 별도';
    return { fails, checks, 참고, 배점, gp: null };
  }

  function evaluateSale(req) {
    const 민영 = req.유형 === '민영분양';
    const 신혼 = /신혼희망타운/.test(req.공고명 || '');
    let fails, checks, 참고, 배점, gp;
    if (신혼) {
      ({ fails, checks, 참고, 배점, gp } = evalNHT(req));
    } else {
      fails = []; checks = []; 참고 = [];
      const gH = gateHousing();
      const gS = P.청약저축?.가입 === true ? { s: 'pass', m: '청약통장 가입' }
        : P.청약저축?.가입 === false ? { s: 'fail', m: '청약통장 미가입' } : { s: 'check', m: '청약통장 미입력' };
      if (gH.s === 'fail') fails.push(`무주택:${gH.m}`); else if (gH.s === 'check') checks.push(`무주택:${gH.m}`);
      if (gS.s === 'fail') fails.push(`청약:${gS.m}`); else if (gS.s === 'check') checks.push(`청약:${gS.m}`);
      if (!민영) checks.push('소득·자산:공공분양 일반공급 컷 원문확인');
      gp = 민영 ? 가점Calc() : null;
      배점 = 민영
        ? `가점 ${gp.total}/84${gp.known ? '' : '(일부미입력)'} [무주택기간 ${gp.무주택점 ?? '?'}·부양 ${gp.부양점}(${gp.부양수}명)·통장 ${gp.통장점 ?? '?'}]`
        : `순차제(저축 ${won(P.청약저축?.저축총액)}·납입 ${P.청약저축?.납입횟수 ?? '?'}회)`;
    }

    for (const g of (req._갭 || [])) {
      if (g === '가점추첨비율') 참고.push('가점/추첨 비율 원문확인(면적·규제별)');
      else if (g === '전매제한') 참고.push('전매제한 원문확인');
      else if (g === '실거주의무') 참고.push('실거주의무 원문확인');
    }
    if (req.규제?.투기과열지구 || req.규제?.조정대상지역 || req.규제?.분양가상한제)
      참고.push(`규제: ${[req.규제.투기과열지구 && '투기과열', req.규제.조정대상지역 && '조정대상', req.규제.분양가상한제 && '분양가상한제'].filter(Boolean).join('·')}`);

    let 판정 = fails.length ? '지원불가' : checks.length ? '확인필요' : '지원가능';
    const 순위 = 청약순위(req), 지역t = 지역우선(req), 특공 = 신혼 ? [] : 특공Match(req);
    const amts = (req.공급형 || []).map(f => f.분양가만원).filter(Boolean);
    const 분양가 = amts.length ? `${Math.min(...amts).toLocaleString()}~${Math.max(...amts).toLocaleString()}만` : null;
    const area = areaMatch(req), region = regionMatch(req);
    const dday = req.마감일 ? Math.round((new Date(req.마감일) - TODAY) / 864e5) : null;
    if (특공.length) 참고.push(`특공 해당(${특공.map(s => s.split('(')[0]).join('·')}) — 자격컷(소득·자산·거주) 원문확인`);

    return {
      panId: req.no, 유형: req.유형, 공고명: req.공고명, 지역: req.지역,
      상태: req.상태, 마감일: req.마감일, dday, 판정,
      공급형태: '분양', 공급형태설명: `분양 · 분양가 ${분양가 || '?'} · 특공해당 ${특공.length ? 특공.join(',') : '없음/확인'}`,
      분양전환: false,
      실격사유: fails, 확인필요: checks, 참고,
      통과: [],
      거주지순위: `${순위.m} · 지역우선:${지역t.tier}${지역t.exists ? '' : '(tier없음)'}`,
      선정방식: req.선정방식,
      예상배점: 배점, 가점: gp ? gp.total : null,
      면적: area ? (area.ok == null ? '면적정보없음' : area.ok ? `맞음(${area.range[0]}~${area.range[1]}㎡)` : `안맞음(공고 ${area.range[0]}~${area.range[1]}㎡)`) : null,
      지역희망: region ? (region.ok ? `맞음(${region.hit.join(',')})` : '희망지역 아님') : null,
      희망지역매칭: region ? region.ok : null,
      링크: pickLink(req).url, 링크라벨: pickLink(req).label,
    };
  }

  function evaluate(req) {
    if (req.상품구조 === '분양') return evaluateSale(req);
    const gates = {
      무주택: gateHousing(), 소득: gateIncome(req),
      자산: tierLimit(req, req.자격요건?.자산상한, '자산상한', '총자산', P.총자산),
      자동차: tierLimit(req, req.자격요건?.자동차상한, '자동차상한', '차량가액', P.자동차가액),
      청약: gateSubscription(req), 계층: gateTier(req),
    };
    const fails = Object.entries(gates).filter(([, g]) => g.s === 'fail');
    const checks = Object.entries(gates).filter(([, g]) => g.s === 'check');
    let 판정 = fails.length ? '지원불가' : checks.length ? '확인필요' : '지원가능';
    const rank = residenceRank(req);
    const area = areaMatch(req), region = regionMatch(req);
    const score = estimateScore(req);
    const dday = req.마감일 ? Math.round((new Date(req.마감일) - TODAY) / 864e5) : null;
    const supply = supplyForm(req);
    return {
      panId: req.panId, 유형: req.유형, 공고명: req.공고명, 지역: req.지역,
      상태: req.상태, 마감일: req.마감일, dday, 판정,
      공급형태: supply.code, 공급형태설명: supply.label,
      분양전환: req.분양전환 === '분양전환형',
      실격사유: fails.map(([k, g]) => `${k}:${g.m}`),
      확인필요: checks.map(([k, g]) => `${k}:${g.m}`),
      참고: [],
      통과: Object.entries(gates).filter(([, g]) => g.s === 'pass').map(([k]) => k),
      거주지순위: rank ? (rank.rank ? `${rank.rank}순위` : `해당지역 미명시(최후 ${rank.maxRank}순위 추정)`) : '순위없음/추첨',
      선정방식: req.선정방식,
      예상배점: score ? `${score.got}/${score.max}점(추정)${score.skipped.length ? ` ·미반영:${score.skipped.join(',')}` : ''}` : null,
      가점: null,
      면적: area ? (area.ok == null ? '면적정보없음' : area.ok ? `맞음(${area.range[0]}~${area.range[1]}㎡)` : `안맞음(공고 ${area.range[0]}~${area.range[1]}㎡)`) : null,
      지역희망: region ? (region.ok ? `맞음(${region.hit.join(',')})` : '희망지역 아님') : null,
      희망지역매칭: region ? region.ok : null,
      링크: pickLink(req).url, 링크라벨: pickLink(req).label,
    };
  }

  return { evaluate, age, 미성년자녀 };
}
