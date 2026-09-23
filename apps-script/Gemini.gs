/**
 * Gemini API 연동: 결과지 사진/문자 → 구조화된 기록, 그리고 검사결과 질의응답
 *
 * 주의: 여기로 들어오는 사진/문자/기록은 복호화된 원문이지만, 서버는 저장하지 않고
 *       Gemini에 전달만 한 뒤 결과를 돌려준다.
 */

const RECORD_TYPES = ['정기건강검진', '외래진료', '입원·수술', '검사결과', '처방·약', '문자·알림', '기타'];
const TEST_FLAGS = ['정상', '높음', '낮음', '경계', '이상', '판정없음'];

const RECORD_SCHEMA = {
  type: 'OBJECT',
  properties: {
    record_type: { type: 'STRING', enum: RECORD_TYPES, description: '결과지의 종류' },
    title: { type: 'STRING', description: '한눈에 알아볼 짧은 제목. 예: "2026 국가건강검진", "정형외과 무릎 X-ray"' },
    date: { type: 'STRING', description: '진료/검사 날짜 YYYY-MM-DD. 모르면 빈 문자열' },
    date_confidence: { type: 'STRING', enum: ['확실', '추정', '모름'], description: '날짜가 자료에 분명히 보이면 확실, 앞뒤 문맥으로 짐작했으면 추정' },
    hospital: { type: 'STRING' },
    department: { type: 'STRING', description: '진료과' },
    doctor: { type: 'STRING', description: '담당 의사 이름. 없으면 빈 문자열' },
    diagnoses: { type: 'ARRAY', items: { type: 'STRING' }, description: '진단명/질병코드/판정' },
    doctor_opinion: { type: 'STRING', description: '결과지에 적힌 의사 소견/종합판정 원문 요약' },
    summary: { type: 'STRING', description: '어르신도 이해할 수 있는 쉬운 말로 3~5문장 요약' },
    tests: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          category: { type: 'STRING', description: '예: 혈액, 소변, 간기능, 신장기능, 영상, 신체계측' },
          name: { type: 'STRING', description: '표준 검사명 (원문 표기가 다르면 note에 원문 표기)' },
          value: { type: 'STRING' },
          unit: { type: 'STRING' },
          reference_range: { type: 'STRING', description: '참고치/정상범위' },
          flag: { type: 'STRING', enum: TEST_FLAGS },
          note: { type: 'STRING' }
        },
        required: ['name', 'value', 'flag']
      }
    },
    medications: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          dosage: { type: 'STRING' },
          schedule: { type: 'STRING', description: '복용법. 예: 1일 2회 식후' },
          days: { type: 'STRING' }
        },
        required: ['name']
      }
    },
    next_visit: { type: 'STRING', description: '다음 예약/재검 안내' },
    follow_up: { type: 'ARRAY', items: { type: 'STRING' }, description: '환자가 해야 할 일(재검, 금식, 생활습관 등)' },
    raw_text: { type: 'STRING', description: '이 기록에 해당하는 원문 텍스트 (문자라면 그 문자 1건 전체)' }
  },
  required: ['record_type', 'title', 'date', 'date_confidence', 'summary', 'tests']
};

const EXTRACT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    records: { type: 'ARRAY', items: RECORD_SCHEMA, description: '날짜/방문별로 나눈 기록들. 오래된 것부터' }
  },
  required: ['records']
};

/** 검사명 표준화: 같은 검사가 다른 이름으로 들어와도 추이 비교가 되도록 */
const TEST_NAME_GUIDE = [
  'AST(SGOT)', 'ALT(SGPT)', '감마지티피(γ-GTP)', '총빌리루빈', '알부민',
  'HBsAg', 'Anti-HBs', 'HBeAg', 'Anti-HBe', 'HBV-DNA', 'AFP', 'PIVKA-II',
  '총콜레스테롤', 'LDL 콜레스테롤', 'HDL 콜레스테롤', '중성지방', '공복혈당', '당화혈색소(HbA1c)',
  '크레아티닌', 'eGFR', '요산', '혈색소(Hb)', '혈소판', '백혈구',
  '수축기 혈압', '이완기 혈압', '체질량지수(BMI)', '허리둘레'
].join(', ');

/**
 * 결과지 분석
 * req: { images: [{mimeType, data(base64)}], text: '문자/메모 원문', hint: '사용자 메모' }
 */
function api_extract(token, req) {
  const s = requireSession_(token);
  checkRateLimit_(s.userId);

  const images = (req.images || []).slice(0, 10);
  const text = String(req.text || '').slice(0, 20000);
  if (!images.length && !text.trim()) throw new Error('사진이나 문자 내용을 넣어주세요.');

  const parts = [{
    text: [
      '다음은 한국 병원/검진기관의 진료 결과 자료입니다. 형태가 다양합니다:',
      '결과지 사진, 건강검진 결과표, 처방전, 병원 문자메시지(또는 문자 대화 화면 캡처) 등.',
      '',
      '[기록 나누기]',
      '- 자료 안에 서로 다른 날짜의 결과가 여러 개 있으면(예: 문자 대화 캡처에 몇 년치 결과 문자가 있는 경우) 날짜/방문별로 records를 나누세요.',
      '- 한 결과지의 여러 페이지는 하나의 record로 합치세요.',
      '- 여러 캡처에 같은 문자가 겹쳐 보이면 한 번만 넣으세요.',
      '- 예약 안내·검진 시기 알림 문자는 record_type을 "문자·알림"으로 하고 tests는 비우고 next_visit/follow_up에 내용을 적으세요.',
      '- records는 오래된 날짜부터 정렬하세요.',
      '',
      '[날짜]',
      '- 문자 캡처에서는 말풍선 위의 날짜 구분선(수신 시각)을 그 문자의 날짜로 쓰세요. 연도가 없으면 기준일 이전의 가장 가까운 날짜입니다.',
      '- 상대 날짜는 아래 표로 바꾸세요. 요일 계산을 직접 하지 말고 표를 그대로 쓰세요.',
      relativeDateTable_(req.referenceDate),
      '- 날짜 구분선이 잘려서 안 보이면 앞뒤 문자의 날짜와 검사 주기를 보고 추정한 날짜를 넣고 date_confidence를 "추정"으로 하세요.',
      '',
      '[검사 수치]',
      '- 자료에 적힌 값만 추출하고 없는 값은 만들지 마세요.',
      '- "SGOT/PT 30/40"처럼 묶인 값은 AST(SGOT)=30, ALT(SGPT)=40 두 항목으로 나누세요. 혈압 "130/85"도 수축기/이완기로 나누세요.',
      '- 검사명은 가능하면 다음 표준 이름을 쓰세요: ' + TEST_NAME_GUIDE,
      '- "<146 cpm" 같은 부등호 값은 value="<146", unit="cpm"처럼 그대로 두세요. 정성 결과는 "양성(+)", "음성(-)"으로 적으세요.',
      '- reference_range는 자료에 적힌 경우에만 채우세요.',
      '- flag: 자료의 H/L 표시나 판정을 우선 쓰세요. 참고치가 없으면 의사 코멘트를 따르세요(예: "정상"이면 정상, "약간 높지만 임상적 의미 없음"이면 해당 수치를 경계). 판단 근거가 없는 정성검사는 판정없음.',
      '- doctor_opinion에는 의사 코멘트 원문을 최대한 그대로 적으세요.',
      '',
      '[기타]',
      '- 환자 이름, 주민번호, 전화번호는 어디에도 적지 마세요. raw_text에서도 이름은 "OOO"로 가리세요.',
      req.hint ? '- 사용자 메모: ' + String(req.hint).slice(0, 500) : ''
    ].join('\n')
  }];
  images.forEach(function (img) {
    if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(img.mimeType) || !B64_RE.test(img.data)) {
      throw new Error('지원하지 않는 사진 형식입니다.');
    }
    parts.push({ inline_data: { mime_type: img.mimeType, data: img.data } });
  });
  if (text.trim()) parts.push({ text: '--- 문자/텍스트 원문 ---\n' + text });

  const result = callGemini_({
    contents: [{ role: 'user', parts: parts }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: EXTRACT_SCHEMA
    }
  });
  try {
    const parsed = JSON.parse(result);
    const records = Array.isArray(parsed) ? parsed : (parsed.records || [parsed]);
    return { records: records };
  } catch (e) {
    throw new Error('AI 응답을 해석하지 못했습니다. 다시 시도하거나 사진을 더 선명하게 찍어주세요.');
  }
}

/**
 * 문자 캡처의 "어제/그저께/(목요일)" 같은 표현을 실제 날짜로 바꿀 수 있게 표를 만든다.
 * referenceDate: 캡처한 날(YYYY-MM-DD). 없으면 오늘.
 */
function relativeDateTable_(referenceDate) {
  const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
  let base = new Date();
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(referenceDate || ''))) base = new Date(referenceDate + 'T12:00:00+09:00');
  const fmt = function (d) { return Utilities.formatDate(d, 'Asia/Seoul', 'yyyy-MM-dd'); };
  const dayOf = function (d) { return DAYS[Number(Utilities.formatDate(d, 'Asia/Seoul', 'u')) % 7]; };
  const lines = ['  기준일(캡처한 날, 오늘): ' + fmt(base) + ' (' + dayOf(base) + ')'];
  for (let i = 1; i <= 6; i++) {
    const d = new Date(base.getTime() - i * 86400000);
    const label = i === 1 ? '어제' : i === 2 ? '그저께' : '';
    lines.push('  ' + (label ? label + ' = ' : '') + '(' + dayOf(d) + '요일) = ' + fmt(d));
  }
  return lines.join('\n');
}

/**
 * 검사결과 질의응답
 * req: {
 *   question, history: [{role:'user'|'model', text}],
 *   records: [복호화된 기록 객체...],   // 선택한 기록 1건 또는 전체
 *   doctor: { 의사 설정(복호화) }
 * }
 */
function api_ask(token, req) {
  const s = requireSession_(token);
  checkRateLimit_(s.userId);

  const question = String(req.question || '').trim().slice(0, 2000);
  if (!question) throw new Error('질문을 입력해 주세요.');

  let recordsJson = JSON.stringify(req.records || []);
  if (recordsJson.length > 150000) recordsJson = recordsJson.slice(0, 150000) + ' …(이하 생략)';

  const contents = [];
  (req.history || []).slice(-12).forEach(function (h) {
    contents.push({ role: h.role === 'model' ? 'model' : 'user', parts: [{ text: String(h.text).slice(0, 4000) }] });
  });
  contents.push({ role: 'user', parts: [{ text: question }] });

  return {
    answer: callGemini_({
      systemInstruction: { parts: [{ text: buildDoctorPrompt_(req.doctor || {}, recordsJson) }] },
      contents: contents,
      generationConfig: { temperature: 0.4 }
    })
  };
}

/** 의사 설정 미리보기 (앱 설정 화면에서 최종 프롬프트 확인용) */
function api_previewDoctorPrompt(token, doctor) {
  requireSession_(token);
  return { prompt: buildDoctorPrompt_(doctor || {}, '[여기에 진료기록이 들어갑니다]') };
}

/* ---------------- 프롬프트 조립 ---------------- */

const SAFETY_PROMPT = [
  '[역할과 안전 원칙 — 반드시 지킬 것]',
  '- 당신은 환자 본인이 등록한 진료 기록을 바탕으로 결과를 설명해 주는 AI 의사 선생님 역할입니다. 실제 진료·진단·처방을 대신하지 않습니다.',
  '- 제공된 기록에 있는 내용만 근거로 답하고, 기록에 없는 내용은 "기록에 없어 알 수 없다"고 말하세요. 수치를 지어내지 마세요.',
  '- 약을 끊거나 용량을 바꾸라는 조언은 하지 말고, 반드시 담당 의사/약사와 상의하라고 안내하세요.',
  '- 가슴 통증, 호흡곤란, 의식 저하, 마비, 심한 출혈 등 응급 증상이 언급되면 즉시 119 또는 응급실을 안내하세요.',
  '- 결과가 기준치를 크게 벗어나거나 결과지에 재검/정밀검사 권고가 있으면 병원 방문을 분명히 권하세요.',
  '- 한국어로 답하고, 마지막에 필요하면 "다음 진료 때 의사에게 물어볼 질문"을 1~3개 제안하세요.'
].join('\n');

const TONE_TEXT = {
  friendly: '다정하고 친근한 말투(존댓말)로, 손주가 설명해 드리듯 따뜻하게',
  polite: '정중하고 차분한 존댓말로, 신뢰감 있게',
  concise: '간결하게 핵심만, 존댓말로'
};
const LEVEL_TEXT = {
  easy: '전문용어는 쓰지 말고 어르신도 바로 이해할 수 있는 쉬운 말과 비유로 설명하세요. 숫자는 꼭 필요한 것만.',
  normal: '일반인이 이해할 수 있게 설명하되, 중요한 의학 용어는 괄호로 함께 적어주세요.',
  expert: '의학 용어와 수치를 정확히 사용해 자세히 설명하세요.'
};
const LENGTH_TEXT = {
  short: '답변은 3~5문장 이내로 짧게.',
  medium: '답변은 필요한 만큼, 너무 길지 않게.',
  long: '항목별로 나눠서 자세히.'
};

function buildDoctorPrompt_(d, recordsJson) {
  const lines = [SAFETY_PROMPT, ''];

  const base = getConfig_('BASE_DOCTOR_PROMPT', '');
  if (base) lines.push('[기본 의사 선생님 설정 — 관리자 작성]', base, '');

  const preset = getPresetPrompt_(d.presetId);
  if (preset) lines.push('[선택한 의사 선생님 유형]', preset, '');

  lines.push('[의사 선생님 캐릭터]');
  if (d.doctorName) lines.push('- 당신의 이름: ' + d.doctorName);
  if (d.specialty) lines.push('- 전문 분야: ' + d.specialty);
  lines.push('- 말투: ' + (TONE_TEXT[d.tone] || TONE_TEXT.friendly));
  lines.push('- 설명 수준: ' + (LEVEL_TEXT[d.level] || LEVEL_TEXT.easy));
  lines.push('- 길이: ' + (LENGTH_TEXT[d.length] || LENGTH_TEXT.medium));
  if (d.lifestyleTips) lines.push('- 식습관·운동 등 생활습관 조언을 함께 해주세요.');
  lines.push('');

  lines.push('[환자 정보]');
  if (d.patientCall) lines.push('- 환자를 부르는 호칭: ' + d.patientCall);
  if (d.ageGroup) lines.push('- 나이대: ' + d.ageGroup);
  if (d.sex) lines.push('- 성별: ' + d.sex);
  if (d.conditions) lines.push('- 앓고 있는 질환/병력: ' + d.conditions);
  if (d.medications) lines.push('- 복용 중인 약: ' + d.medications);
  if (d.allergies) lines.push('- 알레르기: ' + d.allergies);
  if (d.concerns) lines.push('- 특히 걱정하는 점: ' + d.concerns);
  lines.push('');

  if (d.customPrompt) lines.push('[추가 지시사항 — 사용자 직접 작성]', String(d.customPrompt).slice(0, 4000), '');

  lines.push('[환자의 진료 기록 (JSON)]', recordsJson);
  return lines.join('\n');
}

/* ---------------- Gemini 호출 ---------------- */

function callGemini_(body) {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('관리자가 아직 Gemini API 키를 등록하지 않았습니다.');
  const model = getConfig_('GEMINI_MODEL', 'gemini-2.5-flash');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';

  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': key },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  const data = JSON.parse(res.getContentText() || '{}');
  if (code === 429) throw new Error('AI 사용량이 많습니다. 잠시 후 다시 시도해 주세요.');
  if (code !== 200) {
    console.error('Gemini error ' + code + ': ' + (data.error && data.error.message));
    throw new Error('AI 호출에 실패했습니다. (코드 ' + code + ')');
  }
  const cand = data.candidates && data.candidates[0];
  if (!cand || !cand.content || !cand.content.parts) {
    const reason = (data.promptFeedback && data.promptFeedback.blockReason) || (cand && cand.finishReason) || '알 수 없음';
    throw new Error('AI가 답변을 만들지 못했습니다. (' + reason + ')');
  }
  return cand.content.parts
    .filter(function (p) { return typeof p.text === 'string' && !p.thought; })
    .map(function (p) { return p.text; })
    .join('');
}

function checkRateLimit_(userId) {
  const limit = getConfigNumber_('GEMINI_HOURLY_LIMIT', 60);
  const cache = CacheService.getScriptCache();
  const key = 'rl_' + userId + '_' + Math.floor(Date.now() / 3600000);
  const count = Number(cache.get(key) || 0) + 1;
  if (count > limit) throw new Error('1시간 AI 사용 한도(' + limit + '회)를 넘었습니다. 잠시 후 다시 시도해 주세요.');
  cache.put(key, String(count), 3700);
}
