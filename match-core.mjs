// match-core — 매칭 로직 단일 소스(순수 함수, node·브라우저 공용)
//   createMatcher(P, todayStr).evaluate(req) → 판정/순위/배점 결과.
//   파일 IO·CLI·출력은 match.mjs, 웹 인라인은 build-site.mjs(=export 제거 후 주입).
//   외부 LLM API 미사용. 확정 가능한 것만 판정, 불확실은 "확인필요"/"참고"(추측 금지).
export function createMatcher(P, todayStr) {
  const TODAY = new Date(todayStr);
  const age = P.생년월일 ? Math.floor((TODAY - new Date(P.생년월일)) / (365.25 * 864e5)) : null;
  const 미성년자녀 = (P.자녀 || []).filter(c => c.생년월일 && (TODAY - new Date(c.생년월일)) / (365.25 * 864e5) < 19 || c.태아).length;
  const won = n => (n == null ? '?' : (n / 1e4).toLocaleString() + '만');
  // 시도명 캐논(2글자). 단축('경남')·정식('경상남도')·신자치('강원특별자치도'·'전북특별자치도') 혼재 → 비교 전 통일.
  //   (프로필은 단축, 공고 지역은 소스마다 정식/단축 섞임 → exact 비교가 조용히 깨지던 #4.)
  const 시도canon = s => {
    if (!s) return null;
    const t = String(s).replace(/\s/g, '');
    for (const [a, b] of [['충청북', '충북'], ['충청남', '충남'], ['전라북', '전북'], ['전라남', '전남'], ['경상북', '경북'], ['경상남', '경남']])
      if (t.startsWith(a)) return b;
    return t.slice(0, 2);   // 서울특별시·경기도·강원특별자치도·전북특별자치도 등 → 앞 2글자
  };
  const SIDO = new Set(['서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종', '경기', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주']);
  const LH_LIST = 'https://apply.lh.or.kr/lhapply/apply/wt/wrtanc/selectWrtancList.do?mi=1026';
  // 동작하는 원문 링크 선택: LH 상세페이지(selectWrtancInfo.do)는 GET 시 "비정상 경로" 에러라 못 씀
  //   → LH는 공고문 PDF(lhFile.do, GET 검증됨), 분양(청약홈)은 상세페이지가 GET 정상.
  function pickLink(req) {
    const ln = req.원문링크 || {};
    if (req.상품구조 === '분양' || req.상품군 === '분양') return ln.상세페이지 ? { url: ln.상세페이지, label: '원문 공고 보기' } : { url: null, label: null };
    if (ln.공고문PDF) return { url: ln.공고문PDF, label: '공고문 PDF(원문)' };
    const pdf = (ln.첨부 || []).find(a => a.ext === '.pdf');
    if (pdf) return { url: pdf.다운로드, label: '공고문 PDF(원문)' };
    return { url: LH_LIST, label: 'LH 공고목록에서 검색' };
  }

  // 수급·한부모·차상위·장애 등 '자격증명 갈음/순위전용' 대상 여부(소득심사 갈음 공고 판정용)
  const has취약자격 = () =>
    (P.수급자 && P.수급자 !== '해당없음') ||
    P.혼인상태 === '한부모' ||
    (P.특수자격 || []).some(s => /차상위|장애|국가유공|보훈|위안부|북한이탈|아동복지|한부모|수급/.test(s)) ||
    (P.공급계층선택 || []).some(s => /수급|차상위|한부모|장애/.test(s));

  // ── 게이트(임대) ──────────────────────────────────────────
  function gateHousing() {
    if (P.무주택 === true) return { s: 'pass', m: '무주택' };
    if (P.무주택 === false) return { s: 'fail', m: '유주택(무주택 요건 미충족)' };
    return { s: 'check', m: '무주택 여부 미입력' };
  }
  function gateIncome(req) {
    const sg = req.자격요건?.소득기준;
    if (!sg || typeof sg !== 'object') return { s: 'check', m: '소득기준 형태 불명 → 원문확인' };
    if (sg.종류 === '없음') return { s: 'pass', m: '소득심사 없음' };
    if (sg.종류 === '자격증명갈음') {   // 수급·한부모·차상위 등 자격으로 소득심사 갈음 = 그 자격 보유자 대상 공고
      if (has취약자격()) return { s: 'pass', m: '소득심사 자격증명 갈음(해당 자격 보유)' };
      if (!P.수급자 || P.수급자 === '해당없음')
        return { s: 'fail', m: '자격증명 갈음 공고 — 수급/한부모/차상위 등 해당 자격 없음' };
      return { s: 'check', m: '자격증명 갈음 — 본인 해당 자격 확인필요' };
    }
    // 자격완화 등으로 소득요건 배제: 쓸 표가 없고 비고에 배제/심사없음이 명시된 경우(추출이 종류='없음'을 못 잡은 케이스 보정)
    const noTable = !sg.가구원수별 || !Object.keys(sg.가구원수별).length;
    // '소득요건 배제/제한 없음/심사 없음/미적용' 등 한 문장 내 표현을 포괄(자격완화로 소득 배제했는데 종류가 '없음'으로 정규화 안 된 경우 보정)
    if (noTable && /소득[^.]{0,10}(제한\s*없|배제|없음|미적용)/.test(sg.비고 || ''))
      return { s: 'pass', m: '소득심사 없음(자격완화로 배제)' };
    if (P.월평균소득 == null || P.세대원수 == null) return { s: 'check', m: '소득/세대원수 미입력' };
    // 계층별 소득표 상이(행복주택 등): 본인 계층의 소득가구원수별 표 우선(맞벌이 가산 구간 포함). 없으면 공통표.
    const _tk = tierKeyFor(req.자격요건?.계층별);
    const _tierIncome = _tk && req.자격요건?.계층별?.[_tk]?.소득가구원수별;
    const _hasTier = _tierIncome && typeof _tierIncome === 'object' && Object.keys(_tierIncome).length;
    const _key = `${P.세대원수}인`;
    // 계층 소득표 우선, 단 본인 세대원수 행이 없으면 공통표로 폴백(#14: 계층표에 행 없다고 유효 pass를 확인필요로 강등 방지).
    let row = _hasTier ? _tierIncome[_key] : undefined;
    if (!row || typeof row !== 'object') row = sg.가구원수별?.[_key];
    if (!row || typeof row !== 'object') return { s: 'check', m: `${P.세대원수}인 소득표 없음(기본 ${sg.기본퍼센트 ?? '?'}%) → 원문확인` };
    const nums = Object.entries(row).filter(([, v]) => typeof v === 'number');
    if (!nums.length) return { s: 'check', m: '소득 상한 수치 없음' };
    const sorted = nums.slice().sort((a, b) => a[1] - b[1]);
    const [basePct, baseLimit] = sorted[0];                  // 최저(기본) 상한
    const [topPct, topLimit] = sorted[sorted.length - 1];    // 최고(맞벌이/상위구간) 상한
    if (P.맞벌이 && sorted.length > 1)   // 표에 맞벌이 상위구간(예: 90%) 수록 → 그 상한 적용
      return P.월평균소득 <= topLimit
        ? { s: 'pass', m: `소득 ${won(P.월평균소득)} ≤ 맞벌이 ${topPct} ${won(topLimit)}` }
        : { s: 'fail', m: `소득초과 ${won(P.월평균소득)} > 맞벌이 ${topPct} ${won(topLimit)}` };
    if (P.맞벌이 && P.월평균소득 > baseLimit)   // 단일구간만 수록 → 맞벌이 가산 한도 미수록 → 단정 탈락 금지
      return { s: 'check', m: `소득 ${won(P.월평균소득)} > 기본 ${basePct}(${won(baseLimit)}) — 맞벌이 가산 한도 미수록 → 원문확인` };
    return P.월평균소득 <= baseLimit
      ? { s: 'pass', m: `소득 ${won(P.월평균소득)} ≤ ${basePct} ${won(baseLimit)}` }
      : { s: 'fail', m: `소득초과 ${won(P.월평균소득)} > ${basePct} ${won(baseLimit)}` };
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
  // 계층 키 정규화(사용자 입력 → 캐논 enum). normalize-requirements.mjs canonTierKey와 본문 동일해야 함(check-canon-drift.mjs가 빌드때 assert).
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
  // tier 금액 필드 동의어 내성(#6): normalize 미적용/스킵 시 '총자산상한' 등 비캐논 키로 남아도 본인 계층값을 읽어 #1 우선규칙이 유효.
  //   normalize-requirements FIELD_SYN(자산/자동차)과 동기화 — 미상 필드는 normalize가 '비고'로 흡수하므로 여기선 금액 2종만.
  const TIER_ALIAS = { 자산상한: ['자산상한', '총자산상한', '총자산', '자산'], 자동차상한: ['자동차상한', '자동차'] };
  const tierFieldVal = (obj, canon) => {
    for (const a of (TIER_ALIAS[canon] || [canon])) if (obj && !isMissing(obj[a])) return obj[a];
    return undefined;
  };
  function tierLimit(req, topVal, tierField, label, mine) {
    // 본인 계층(캐논)의 계층별 상한이 본인의 구속 상한 — top-level(공통/기본)보다 우선(SCHEMA §5: 매처가 계층별로 위임).
    //   과거버그(#1): top-level 값이 있으면 계층값을 보지도 않고 평가 → 계층 상한이 더 엄격한 경우(예: 행복 top 3.45억 vs 청년 2.51억)
    //   자격없는 사람을 '지원가능'으로 오판(false positive). 그래서 계층 해결을 먼저.
    const 계층별 = req.자격요건?.계층별, key = tierKeyFor(계층별);
    const tv = key && 계층별[key] ? tierFieldVal(계층별[key], tierField) : undefined;
    if (tv !== undefined) return gateLimit(tv, mine, label, key);
    return gateLimit(topVal, mine, label);   // 계층 미해결/계층값 미기재 → top-level(공통). 그것도 미기재면 '확인필요'
  }
  function gateSubscription(req) {
    const c = req.자격요건?.청약요건;
    if (c == null || typeof c !== 'string' || !c.trim()) return { s: 'pass', m: '청약통장 불필요' };
    // 혼합문장("A계층 필요, B계층 없음" / "필수요건 아님…가점") 오매칭 방지: 필요/면제를 분리 판정
    const 필요 = /가입.{0,8}(증명|필요|확인)|가입사실|청약(저축|종합저축|통장)\S{0,14}(필요|증명)/.test(c);
    const 면제 = /필수\s*(요건)?\s*아니|필수\s*아님|가점|불필요|미적용/.test(c);
    const none = /없음/.test(c) && !필요;
    if (면제 && !필요) return { s: 'pass', m: '청약통장 불필요(가점요소·면제)' };
    if (none) return { s: 'pass', m: '청약통장 불필요' };
    const 회차요구 = /\d+\s*회|\d+\s*개월|납입.{0,4}(횟수|인정)|예치|금액|총액/.test(c);
    const g = P.청약저축?.가입;
    if (g === false) return { s: 'fail', m: '청약통장 필요(미가입)' };
    if (g === true) return 회차요구
      ? { s: 'check', m: '청약통장 필요 — 가입O(회차·금액 충족여부 원문확인)' }
      : { s: 'pass', m: '청약통장 가입(가입사실 요건 충족)' };
    return { s: 'check', m: '청약통장 보유 여부 미입력 → 입력하면 판정' };
  }
  // 거주지(사업대상지역) 절대 제한 게이트 — "○○에 주민등록 등재/해당 구·군에만 신청/사업대상지역"
  function gateResidence(req) {
    const t = `${req.자격요건?.무주택 || ''} ${req.공고명 || ''}`;
    const restrictive = /(주민등록[이\s]*등재|해당\s*[구군시][^.]{0,6}에만\s*신청|사업대상지역)/.test(t);
    if (!restrictive) return { s: 'pass', m: '' };
    const sgg = P.거주지?.시군구, sd = P.거주지?.시도;
    if (!sgg && !sd) return { s: 'check', m: '거주지 제한 공고 — 거주지 미입력' };
    if ((sgg && t.includes(sgg)) || (sd && t.includes(sd))) return { s: 'pass', m: '거주지 제한 충족' };
    const strong = /[구군시][^.]{0,4}에만\s*신청|만\s*신청\s*가능/.test(t);
    return strong
      ? { s: 'fail', m: '거주지 미해당 — 공고는 특정 지역 주민등록자만 신청' }
      : { s: 'check', m: `거주지 제한 공고 — 본인 거주지(${sgg || sd}) 해당여부 원문확인` };
  }
  function gateTier(req) {
    const t = req.유형 || '', name = req.공고명 || '', 계층 = (req.자격요건?.대상계층 || []).join(' ');
    if (/고령자복지주택|공공실버주택/.test(name)) {
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

  // 매입임대 '자격유형 순위 전용' — 순위조건 중 하나라도 충족해야 적격(일반 신청자는 저소득 경로로만).
  //   조건 1개씩 yes/no/unknown 판정 → yes 있으면 pass, 전부 no(전부 인식)면 fail, unknown 있으면 check(fail-safe).
  function 순위조건Match(req, c) {
    const s = String(c);
    const incOk = pct => {                              // 소득 N% 이하 충족? (가구원수별 표 조회)
      if (P.월평균소득 == null || P.세대원수 == null) return 'unknown';
      const lim = req.자격요건?.소득기준?.가구원수별?.[`${P.세대원수}인`]?.[`${pct}%`];
      if (typeof lim !== 'number') return 'unknown';
      return P.월평균소득 <= lim ? 'yes' : 'no';
    };
    const 수급 = P.수급자 && P.수급자 !== '해당없음';
    const 장애 = (P.특수자격 || []).some(x => /장애/.test(x));
    const 차상위 = (P.특수자격 || []).some(x => /차상위/.test(x));
    const 한부모 = P.혼인상태 === '한부모' || (P.특수자격 || []).some(x => /한부모/.test(x));
    const 신혼 = ['혼인중', '예비'].includes(P.혼인상태);
    const 자녀수 = (P.자녀 || []).length;
    const 미혼 = !P.혼인상태 || P.혼인상태 === '미혼';
    // 순수 무주택 조건(든든전세 등)만 — '무주택 미혼 청년'처럼 복합조건은 아래 계층 인식자로 위임
    if (/무주택/.test(s) && !/청년|신혼|장애|수급|고령|차상위|한부모/.test(s))
      return P.무주택 === true ? 'yes' : P.무주택 === false ? 'no' : 'unknown';
    // 저소득 고령자(수급+65세)
    if (/고령자/.test(s) && /(수급|기초생활|제2조)/.test(s)) {
      if (age != null && age < 65) return 'no';
      if (age != null && age >= 65 && 수급) return 'yes';
      return 수급 ? 'unknown' : 'no';
    }
    // 수급자 계열(차상위 제외)
    if (/수급/.test(s) && !/차상위/.test(s)) {
      const types = [];
      if (/생계/.test(s)) types.push('생계급여');
      if (/의료/.test(s)) types.push('의료급여');
      if (/주거/.test(s)) types.push('주거급여');
      if (/교육/.test(s)) types.push('교육급여');
      if (!types.length) return 수급 ? 'yes' : 'no';
      if (수급 && types.includes(P.수급자)) return 'yes';
      return 'no';                                       // 미수급 or 다른 급여 → 이 조건엔 비해당
    }
    if (/차상위/.test(s)) return 차상위 ? 'yes' : (P.특수자격 ? 'no' : 'unknown');
    if (/한부모/.test(s)) {
      if (!한부모) return 'no';
      if (/6세 이하|미성년/.test(s)) return 자녀수 ? 'yes' : 'unknown';
      return 'yes';
    }
    if (/장애/.test(s)) {
      if (!장애) return P.특수자격 ? 'no' : 'unknown';
      const m = s.match(/(\d+)\s*%/);
      return m ? incOk(Number(m[1])) : 'yes';
    }
    if (/신생아/.test(s)) {
      const 신생아 = (P.자녀 || []).some(x => x.태아 || (x.생년월일 && (TODAY - new Date(x.생년월일)) / (365.25 * 864e5) <= 2));
      return 신생아 ? 'yes' : 'no';
    }
    if (/신혼|예비신혼|혼인가구/.test(s)) {
      if (!신혼 && P.혼인상태 !== '혼인중') return 'no';
      if (/자녀가 없는/.test(s)) return 자녀수 === 0 ? 'yes' : 'no';
      if (/자녀가 있는|6세 이하/.test(s)) return 자녀수 > 0 ? 'yes' : 'no';
      return 'yes';
    }
    if (/미혼 청년|무주택.{0,4}청년/.test(s) || /\d+\s*세 이상\s*\d+\s*세 이하/.test(s)) {
      if (/미혼/.test(s) && !미혼) return 'no';
      if (age == null) return 'unknown';
      return age >= 19 && age <= 39 ? 'yes' : 'no';
    }
    const mPct = s.match(/월평균\s*소득\D*?(\d+)\s*%/) || (/소득/.test(s) && s.match(/(\d+)\s*%\s*이하/));
    if (mPct && /소득/.test(s)) return incOk(Number(mPct[1]));
    if (/거주자|주민등록|시민|모집권역/.test(s)) {       // 거주 요건 — 본인 거주지가 조건에 보이면 충족, 미일치는 gateResidence가 별도 판정(여기선 fail-safe)
      const sd = P.거주지?.시도, sgg = P.거주지?.시군구;
      if (!sd && !sgg) return 'unknown';
      const short = x => String(x).replace(/특별자치도|특별자치시|특별시|광역시/, '');
      if ((sgg && s.includes(sgg)) || (sd && (s.includes(sd) || s.includes(short(sd))))) return 'yes';
      return 'unknown';
    }
    return 'unknown';                                    // 주거취약·대학생·예술인·소득자산충족 등 → 판정불가
  }
  function gate매입순위(req) {
    if (req.유형 !== '매입임대') return { s: 'pass', m: '' };
    const ranks = (req.순위규칙 || []).filter(r => /자격유형/.test(r.기준 || '') && (r.조건 || []).length);
    if (!ranks.length) return { s: 'pass', m: '' };
    // 추출이 한 순위의 AND조건(단일 자격 프로파일)과 OR대안(독립 카테고리)을 단일 배열로 평탄화 → 순위별로 분류:
    //   독립 자격 카테고리(수급/장애/한부모/신혼/소득N%↓ 등)가 하나라도 있으면 OR(택1), 없으면 속성조합 AND(전부 충족).
    const 독립카테고리 = /신생아|한부모|신혼|예비신혼|혼인가구|수급|차상위|장애|고령자|\d+\s*%\s*이하/;
    let 가능 = false;   // 어느 순위든 충족 가능성(미상 포함)이 남아있나
    for (const r of ranks) {
      const conds = r.조건 || [];
      const vs = conds.map(c => 순위조건Match(req, c));
      if (conds.some(c => 독립카테고리.test(String(c)))) {           // OR: 카테고리 택1
        if (vs.includes('yes')) return { s: 'pass', m: '순위 자격유형 해당' };
        if (vs.includes('unknown')) 가능 = true;
      } else {                                                        // AND: 단일 자격 프로파일(무주택+연령+거주+직군 등) 전부 충족
        if (vs.every(v => v === 'yes')) return { s: 'pass', m: '순위 자격유형 해당' };
        if (!vs.includes('no')) 가능 = true;
      }
    }
    return 가능
      ? { s: 'check', m: '순위 자격유형(수급/장애/한부모/신혼/저소득/직군 등) 해당여부 확인필요' }
      : { s: 'fail', m: '매입임대 순위 자격유형 비해당(수급/장애/한부모/신혼/청년/저소득 순위 아님)' };
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
    const 공고시도 = 시도canon((req.지역 || '').split(' ')[0]);
    const hay = [req.지역, ...(req.단지 || []).map(d => d.주소), ...Object.keys(req.주택목록?.지역분포 || {})].join(' ');
    // 시도 단축명(서울·광주 등)은 공고 시도와 캐논 비교(#15: '광주'가 경기 '광주시'에 substring 오매칭되던 것 방지). 시군구(성남시 등)는 substring.
    const hit = want.filter(w => SIDO.has(w) ? 공고시도 === w : hay.includes(w));
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
    let got = 0, max = 0, floors = 0; const used = [], skipped = [], items = [];
    // 괄호 부연(예: "대학생 거주지(부모 거주지)")은 제거 후 핵심 라벨만 — 기계적 자르기로 괄호 깨지는 것 방지
    const lbl = s => String(s).replace(/[（(].*$/, '').replace(/\s+/g, ' ').trim().slice(0, 22);
    for (const item of tbl) {
      const name = item.항목 || ''; const bands = item.구간 || [];
      const top = Math.max(0, ...bands.map(b => b[1] || 0)); max += top;
      // floored: 입력이 없어 0으로 처리 → 배점표 최저구간(0점 구간 없으면 바닥점수)이 잡힘. 확정 아닌 '최소 보장점'으로 구분(입력 시 상향).
      let v = null, floored = false;
      if (/거주\s*기간|연속\s*거주/.test(name)) { floored = P.거주개월 == null; v = (P.거주개월 ?? 0) / 12; }
      else if (/자녀/.test(name)) v = 미성년자녀;
      else if (/납입\s*횟수|청약/.test(name)) { floored = P.청약저축?.납입횟수 == null; v = P.청약저축?.납입횟수 ?? 0; }
      else if (/무주택\s*기간/.test(name)) { floored = P.무주택기간개월 == null; v = (P.무주택기간개월 ?? 0) / 12; }
      if (v == null) { skipped.push(lbl(name)); items.push({ 항목: lbl(name), 점수: null, 만점: top, 자동: false }); continue; }
      const sc = pickBand(bands, v); got += sc; if (floored) floors++; else used.push(`${lbl(name)}:${sc}`);
      items.push({ 항목: lbl(name), 점수: sc, 만점: top, 자동: true, 최소: floored });
    }
    return { got, max, used, skipped, items, floors };
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
    // 부양 직계비속 = 미혼·만30세미만(SCHEMA §6-3). 과거버그: (P.자녀||[]).length로 성인·기혼 자녀까지 +5점씩 → 가점 과대계상.
    //   웹 UI는 미성년 자녀수만 받아 전부 만19세 미만이라 무영향이나, profile.json/CLI는 임의 생년월일 가능 → 일괄 필터로 정정.
    const 미혼자녀 = (P.자녀 || []).filter(c =>
      c.태아 || (c.생년월일 && (TODAY - new Date(c.생년월일)) / (365.25 * 864e5) < 30 && !c.기혼)).length;
    const 부양수 = 배우자 + 미혼자녀 + 직계존속;
    const 부양점 = Math.min(35, 5 + 부양수 * 5);
    if ((P.자녀 || []).length > 미혼자녀) notes.push(`자녀 ${(P.자녀 || []).length - 미혼자녀}명 부양제외(만30세이상/기혼)`);

    let 통장점;
    if (!P.청약저축?.가입) 통장점 = 0;
    else if (P.청약저축?.가입개월 == null) 통장점 = null;
    else { const g = P.청약저축.가입개월; 통장점 = g < 6 ? 1 : g < 12 ? 2 : Math.min(17, 3 + Math.floor((g - 12) / 12)); }

    const known = [무주택점, 부양점, 통장점].every(p => p != null);
    const total = (무주택점 || 0) + (부양점 || 0) + (통장점 || 0);
    return { 무주택점, 부양점, 통장점, 부양수, total, known, notes };
  }
  function 청약순위(req) {
    if (P.청약저축?.가입 !== true) return { m: P.청약저축?.가입 === false ? '청약통장 미가입' : '청약통장 정보 미입력' };
    const reg = req.규제?.투기과열지구 || req.규제?.조정대상지역;
    const capital = ['서울', '경기', '인천'].includes(시도canon(P.거주지?.시도));
    const th = reg ? 24 : capital ? 12 : 6;
    const g = P.청약저축?.가입개월;
    if (g == null) return { m: '청약통장 가입기간 미입력' };
    return g >= th ? { rank: 1, m: `청약 1순위 (가입 ${g}개월 ≥ 기준 ${th}개월)` } : { rank: 2, m: `청약 2순위 (가입 ${g}개월 < 기준 ${th}개월)` };
  }
  function 지역우선(req) {
    const tiers = (req.순위규칙 || []).map(r => (r.조건 || [])[0]).filter(Boolean);
    const sgg = P.거주지?.시군구, sd = P.거주지?.시도;
    const 공고시도 = (req.지역 || '').split(' ')[0];
    const 공고주소 = [req.지역, ...(req.단지 || []).map(d => d.주소)].join(' ');
    let mine = '기타지역';
    if (sgg && 공고주소.includes(sgg)) mine = '해당지역';
    else if (sd && 공고시도 && 시도canon(sd) === 시도canon(공고시도)) mine = '기타경기/광역';
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
      const 추첨 = req.선정방식 === '추첨';
      const 재당첨확정 = req.재당첨제한 && typeof req.재당첨제한 === 'object' && req.재당첨제한.기간;
      const 무주택무관 = /제한없음|누구나|무관/.test(req.자격요건?.무주택 || '');
      if (추첨 && 무주택무관) {
        // 오피스텔/도시형/생숙·임의공급: 만 19세 이상 추첨, 무주택·청약통장 무관
        gp = null;
        배점 = '추첨제 — 만 19세 이상 추첨(무주택·청약통장 무관)';
        참고.push(`누구나 신청 가능 — 청약통장·무주택 조건 없이 만 19세 이상이면 추첨으로 뽑아요 (세부 조건${재당첨확정 ? '' : '·재당첨 제한'}은 공고문 확인)`);
      } else {
        const gH = gateHousing();
        if (gH.s === 'fail') fails.push(`무주택:${gH.m}`); else if (gH.s === 'check') checks.push(`무주택:${gH.m}`);
        if (추첨) {
          // 무순위/잔여: 무주택(해당지역) 요건, 청약통장 무관
          gp = null;
          배점 = '추첨제 — 무주택 요건 충족 시 추첨(청약통장 무관)';
          참고.push(`무순위·잔여세대 추첨 — 청약통장 없이 신청 가능 (거주지${재당첨확정 ? '' : '·재당첨'} 제한은 공고문 확인)`);
        } else {
          const gS = P.청약저축?.가입 === true ? { s: 'pass', m: '청약통장 가입' }
            : P.청약저축?.가입 === false ? { s: 'fail', m: '청약통장 미가입' } : { s: 'check', m: '청약통장 미입력' };
          if (gS.s === 'fail') fails.push(`청약:${gS.m}`); else if (gS.s === 'check') checks.push(`청약:${gS.m}`);
          if (!민영) checks.push('소득·자산:공공분양 일반공급 컷 원문확인');
          gp = 민영 ? 가점Calc() : null;
          배점 = 민영
            ? `가점 ${gp.total}/84점${gp.known ? '' : ' (일부 미입력)'} [무주택기간 ${gp.무주택점 ?? '미입력'} · 부양가족 ${gp.부양점}(${gp.부양수}명) · 청약통장 ${gp.통장점 ?? '미입력'}]`
            : `순차제 (저축총액 ${won(P.청약저축?.저축총액)} · 납입 ${P.청약저축?.납입횟수 ?? '미입력'}회)`;
        }
      }
    }

    // 공고문 표서 결정론 추출된 전매/실거주/재당첨은 사실로 노출(헤지 대체). inject-applyhome-notice가 채움.
    const 확정 = v => v && typeof v === 'object' && v.기간;
    const fact = (label, v) => { if (확정(v)) 참고.push(`${label}: ${v.적용 === false ? '없음' : v.기간} (공고문)`); };
    fact('전매제한', req.전매제한); fact('실거주의무', req.실거주의무); fact('재당첨제한', req.재당첨제한);
    for (const g of (req._갭 || [])) {
      if (g === '가점추첨비율') 참고.push('가점/추첨 비율 원문확인(면적·규제별)');
      else if (g === '전매제한' && !확정(req.전매제한)) 참고.push('전매제한 원문확인');
      else if (g === '실거주의무' && !확정(req.실거주의무)) 참고.push('실거주의무 원문확인');
    }
    if (req.규제?.투기과열지구 || req.규제?.조정대상지역 || req.규제?.분양가상한제)
      참고.push(`규제: ${[req.규제.투기과열지구 && '투기과열', req.규제.조정대상지역 && '조정대상', req.규제.분양가상한제 && '분양가상한제'].filter(Boolean).join('·')}`);

    let 판정 = fails.length ? '지원불가' : checks.length ? '확인필요' : '지원가능';
    const 순위 = 청약순위(req), 지역t = 지역우선(req), 특공 = 신혼 ? [] : 특공Match(req);
    const tierLabel = { '해당지역': '공고 지역 거주', '기타경기/광역': '같은 시·도 거주', '기타지역': '타 시·도 거주' }[지역t.tier] || 지역t.tier;
    const 지역문구 = 지역t.exists ? `거주지 우선순위 해당 (${tierLabel})` : `거주지 우선순위 없음 (${tierLabel})`;
    const 청약지역줄 = req.선정방식 === '추첨' ? '추첨제 — 청약순위·거주지 우선 미적용' : `${순위.m} · ${지역문구}`;
    const amts = (req.공급형 || []).map(f => f.분양가만원).filter(Boolean);
    const 분양가 = amts.length ? `${Math.min(...amts).toLocaleString()}~${Math.max(...amts).toLocaleString()}만` : null;
    const area = areaMatch(req), region = regionMatch(req);
    const dday = req.마감일 ? Math.round((new Date(req.마감일) - TODAY) / 864e5) : null;
    if (특공.length) 참고.push(`특공 해당(${특공.map(s => s.split('(')[0]).join('·')}) — 자격컷(소득·자산·거주) 원문확인`);

    return {
      panId: req.panId ?? req.no, 유형: req.유형, 공고명: req.공고명, 지역: req.지역,
      상태: req.상태, 마감일: req.마감일, 마감일미상: req.마감일미상 || false, dday, 판정,
      공급형태: '분양', 공급형태설명: `분양 · 분양가 ${분양가 || '공고 확인'} · ${특공.length ? `특별공급 가능: ${특공.join('·')}` : '특별공급 해당 없음 (원문 확인)'}`,
      분양전환: false,
      실격사유: fails, 확인필요: checks, 참고,
      통과: [],
      거주지순위: 청약지역줄,
      선정방식: req.선정방식,
      예상배점: 배점, 가점: gp ? gp.total : null,
      면적: area ? (area.ok == null ? '면적정보없음' : area.ok ? `맞음(${area.range[0]}~${area.range[1]}㎡)` : `안맞음(공고 ${area.range[0]}~${area.range[1]}㎡)`) : null,
      지역희망: region ? (region.ok ? `맞음(${region.hit.join(',')})` : '희망지역 아님') : null,
      희망지역매칭: region ? region.ok : null,
      링크: pickLink(req).url, 링크라벨: pickLink(req).label,
    };
  }

  function evaluate(req) {
    if (req.상품군 === '분양' || req.상품구조 === '분양') return evaluateSale(req);
    // 공공임대 공식 '총자산'은 자동차가액을 포함하는 개념이나, 프로필은 총자산(차량 제외)·자동차가액을 따로 입력받음
    //   → 자산상한(차량포함 기준)과 비교할 땐 둘을 합산. 자동차상한이 따로 있는 공고는 자동차 게이트가 별도로 또 검사.
    const 총자산_차량포함 = P.총자산 == null ? null : P.총자산 + (P.자동차가액 || 0);
    const gates = {
      무주택: gateHousing(), 소득: gateIncome(req),
      자산: tierLimit(req, req.자격요건?.자산상한, '자산상한', '총자산(차량포함)', 총자산_차량포함),
      자동차: tierLimit(req, req.자격요건?.자동차상한, '자동차상한', '차량가액', P.자동차가액),
      청약: gateSubscription(req), 거주지: gateResidence(req), 계층: gateTier(req),
      순위자격: gate매입순위(req),
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
      상태: req.상태, 마감일: req.마감일, 마감일미상: req.마감일미상 || false, dday, 판정,
      공급형태: supply.code, 공급형태설명: supply.label,
      분양전환: req.분양전환 === '분양전환형',
      실격사유: fails.map(([k, g]) => `${k}:${g.m}`),
      확인필요: checks.map(([k, g]) => `${k}:${g.m}`),
      참고: [],
      통과: Object.entries(gates).filter(([, g]) => g.s === 'pass').map(([k]) => k),
      거주지순위: rank ? (rank.rank ? `거주지 우선 ${rank.rank}순위` : `거주지 우선순위 미해당 (최하 ${rank.maxRank}순위 추정)`) : '거주지 우선순위 없음 (추첨 등)',
      선정방식: req.선정방식,
      예상배점: score ? `${score.floors ? '최소 ' : ''}${score.got}/${score.max}점 (추정)${score.floors ? ' · 미입력 항목 입력 시 상향' : ''}${score.skipped.length ? ` · 미반영 항목: ${score.skipped.join('·')}` : ''}` : null,
      배점내역: score ? score.items : null,
      가점: null,
      면적: area ? (area.ok == null ? '면적정보없음' : area.ok ? `맞음(${area.range[0]}~${area.range[1]}㎡)` : `안맞음(공고 ${area.range[0]}~${area.range[1]}㎡)`) : null,
      지역희망: region ? (region.ok ? `맞음(${region.hit.join(',')})` : '희망지역 아님') : null,
      희망지역매칭: region ? region.ok : null,
      링크: pickLink(req).url, 링크라벨: pickLink(req).label,
    };
  }

  return { evaluate, age, 미성년자녀 };
}
