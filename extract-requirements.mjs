// 공고문 PDF → 요건 JSON 추출 (pdftotext + Claude)
// 실행: node extract-requirements.mjs <pdf경로>
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const pdfPath = process.argv[2] || '/tmp/gonggo.pdf';

// 1) Anthropic 키 (CertiQ/.env 재사용)
let KEY = '';
for (const line of readFileSync('/Users/snfddl/project/active/CertiQ/.env', 'utf8').split('\n')) {
  const m = line.match(/^ANTHROPIC_API_KEY=(.+)$/);
  if (m) KEY = m[1].trim();
}
if (!KEY) { console.error('❌ ANTHROPIC_API_KEY 없음'); process.exit(1); }

// 2) PDF → 텍스트
const text = execFileSync('pdftotext', ['-layout', pdfPath, '-'], { encoding: 'utf8', maxBuffer: 50e6 });
console.log(`PDF 텍스트 추출: ${text.length}자`);

// 3) 추출 스키마 (도구로 강제)
const schema = {
  type: 'object',
  properties: {
    공고명: { type: 'string' },
    공고일_판단기준일: { type: 'string', description: 'YYYY-MM-DD' },
    공급유형: { type: 'string', description: '행복주택/국민임대/통합공공임대 등' },
    단지명: { type: 'string' },
    소재지: { type: 'string' },
    모집세대수: { type: 'string' },
    신청접수기간: { type: 'string' },
    당첨자발표일: { type: 'string' },
    선정방식: { type: 'string', enum: ['가점제', '추첨제', '가점제+추첨제', '순위순차제', '불명'] },
    공급계층: { type: 'array', items: { type: 'string' }, description: '청년/신혼부부/한부모/고령자/일반 등' },
    무주택요건: { type: 'string' },
    소득요건: { type: 'string', description: '도시근로자 월평균소득 대비 % 등. 완화/배제면 그대로 기재' },
    총자산요건: { type: 'string' },
    자동차가액요건: { type: 'string' },
    거주지역요건: { type: 'string' },
    임대조건: { type: 'string', description: '보증금/월임대료 범위' },
    특이사항: { type: 'array', items: { type: 'string' }, description: '입주자격 완화 등 이번 공고 특수조건' },
  },
  required: ['공고명', '공급유형', '선정방식', '공급계층', '소득요건', '총자산요건', '무주택요건'],
};

// 4) Claude 호출
const res = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    tools: [{ name: 'emit_requirements', description: 'LH 임대주택 공고문에서 신청 요건을 구조화', input_schema: schema }],
    tool_choice: { type: 'tool', name: 'emit_requirements' },
    messages: [{
      role: 'user',
      content: `다음은 LH 임대주택 입주자 모집공고문 전문이다. 신청자가 "내가 지원 가능한지"를 판단하는 데 필요한 핵심 요건만 정확히 추출하라. 본문에 없는 값은 "공고문미기재"로 채워라. 수치는 공고문 표현 그대로 옮겨라.\n\n=== 공고문 ===\n${text.slice(0, 120000)}`,
    }],
  }),
});
const data = await res.json();
if (data.type === 'error') { console.error('API 오류:', JSON.stringify(data.error)); process.exit(1); }
const tool = data.content.find(c => c.type === 'tool_use');
console.log('\n===== 추출된 요건 JSON =====');
console.log(JSON.stringify(tool.input, null, 2));
console.log('\n[토큰] in:', data.usage.input_tokens, 'out:', data.usage.output_tokens);
