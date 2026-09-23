/**
 * 우리가족 진료기록 — 진입점, 초기 설정, 스프레드시트 메뉴
 *
 * 보안 모델 요약
 *  - 각 사용자는 본인이 정한 아이디/비밀번호로만 로그인한다.
 *  - 진료 내용·사진·질의응답은 브라우저에서 사용자 비밀번호로 만든 키로 암호화된 뒤 저장된다.
 *    (스프레드시트/드라이브에는 암호문만 남기 때문에 시트 소유자도 내용을 볼 수 없다.)
 *  - 서버(Apps Script)는 비밀번호도, 복호화 키도 저장하지 않는다.
 */

const APP_NAME = '우리가족 진료기록';

const SHEETS = {
  CONFIG: 'Config',
  PRESETS: 'DoctorPresets',
  USERS: 'Users',
  RECORDS: 'Records',
  CHATS: 'Chats',
  PROFILES: 'DoctorProfiles',
  AUDIT: 'AuditLog'
};

const HEADERS = {
  Config: ['key', 'value', 'description'],
  DoctorPresets: ['preset_id', 'name', 'prompt', 'active'],
  Users: [
    'user_id', 'username', 'created_at',
    'kdf_salt', 'kdf_iter', 'auth_salt', 'auth_hash', 'wrapped_dek',
    'rc_kdf_salt', 'rc_auth_salt', 'rc_auth_hash', 'wrapped_dek_rc',
    'failed_count', 'locked_until', 'last_login_at'
  ],
  Records: ['record_id', 'user_id', 'created_at', 'updated_at', 'enc_data', 'image_ids'],
  Chats: ['message_id', 'user_id', 'record_id', 'created_at', 'enc_data'],
  DoctorProfiles: ['user_id', 'updated_at', 'enc_data'],
  AuditLog: ['time', 'user_id', 'action', 'detail']
};

const DEFAULT_CONFIG = [
  ['GEMINI_MODEL', 'gemini-2.5-flash', 'Gemini 모델 이름. Google AI Studio에서 사용 가능한 모델명으로 바꿀 수 있습니다.'],
  ['ALLOW_SIGNUP', 'TRUE', 'FALSE로 바꾸면 새 계정 가입이 막힙니다. 가족 가입이 끝나면 FALSE 권장.'],
  ['INVITE_CODE', '', '가입할 때 입력해야 하는 초대코드. 메뉴 > 초대코드 새로 만들기로 재발급.'],
  ['BASE_DOCTOR_PROMPT',
    '당신은 가족 주치의처럼 따뜻하고 신뢰감 있는 의사 선생님입니다. 검사 결과를 환자가 이해할 수 있게 풀어서 설명하고, 걱정을 덜어주되 필요한 경우 분명하게 병원 방문을 권합니다.',
    '모든 사용자에게 공통으로 적용되는 의사 선생님 기본 프롬프트 (관리자가 직접 작성)'],
  ['GEMINI_HOURLY_LIMIT', '60', '사용자 1명당 1시간에 허용하는 AI 호출 횟수'],
  ['MAX_LOGIN_FAILS', '5', '연속 로그인 실패 허용 횟수'],
  ['LOCK_MINUTES', '15', '로그인 실패 초과 시 잠금 시간(분)'],
  ['SESSION_HOURS', '6', '로그인 유지 시간(시간, 최대 6)']
];

const DEFAULT_PRESETS = [
  ['preset_internal', '내과 주치의 (기본)',
    '내과 전문의 관점에서 혈액검사, 혈압, 혈당, 콜레스테롤, 간·신장 기능 수치를 중심으로 설명합니다. 수치가 기준을 벗어나면 얼마나 벗어났는지, 생활습관으로 개선 가능한지, 재검이 필요한지 순서로 알려주세요.',
    'TRUE'],
  ['preset_checkup', '건강검진 해설 선생님',
    '국가건강검진/종합검진 결과표를 항목별로 해설합니다. 판정(정상A, 정상B, 질환의심 등)의 의미를 설명하고 작년과 비교할 수 있으면 변화 추이를 알려주세요.',
    'TRUE']
];

/** 웹앱 진입점 */
function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle(APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/** HTML 템플릿에서 다른 파일을 끼워 넣을 때 사용 */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** 스프레드시트를 열 때 관리자 메뉴 추가 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🩺 진료기록 관리')
    .addItem('1. 초기 설정 (시트 만들기)', 'setup')
    .addItem('2. Gemini API 키 등록', 'promptApiKey')
    .addItem('초대코드 새로 만들기', 'rotateInviteCode')
    .addItem('계정 잠금 해제', 'promptUnlockUser')
    .addToUi();
}

/**
 * 최초 1회 실행: 시트/헤더/기본 설정/드라이브 폴더/서버 비밀값을 만든다.
 * 여러 번 실행해도 기존 데이터는 지우지 않는다.
 */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const props = PropertiesService.getScriptProperties();
  props.setProperty('SPREADSHEET_ID', ss.getId());

  Object.keys(HEADERS).forEach(function (name) {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const headers = HEADERS[name];
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });

  const configSheet = ss.getSheetByName(SHEETS.CONFIG);
  const existingKeys = readAll_(SHEETS.CONFIG).map(function (r) { return r.key; });
  DEFAULT_CONFIG.forEach(function (row) {
    if (existingKeys.indexOf(row[0]) === -1) {
      const value = row[0] === 'INVITE_CODE' ? newInviteCode_() : row[1];
      configSheet.appendRow([row[0], value, row[2]]);
    }
  });
  configSheet.setColumnWidth(2, 420);
  configSheet.getRange('B:B').setWrap(true);

  if (readAll_(SHEETS.PRESETS).length === 0) {
    const presetSheet = ss.getSheetByName(SHEETS.PRESETS);
    DEFAULT_PRESETS.forEach(function (row) { presetSheet.appendRow(row); });
    presetSheet.setColumnWidth(3, 520);
    presetSheet.getRange('C:C').setWrap(true);
  }

  if (!props.getProperty('SERVER_SECRET')) {
    props.setProperty('SERVER_SECRET', Utilities.getUuid() + Utilities.getUuid());
  }

  if (!props.getProperty('IMAGE_FOLDER_ID')) {
    const folder = DriveApp.createFolder(APP_NAME + ' - 암호화된 사진 (삭제 금지)');
    props.setProperty('IMAGE_FOLDER_ID', folder.getId());
  }

  // 기본으로 생기는 빈 시트 정리
  const blank = ss.getSheetByName('Sheet1') || ss.getSheetByName('시트1');
  if (blank && ss.getSheets().length > 1 && blank.getLastRow() === 0) ss.deleteSheet(blank);

  safeAlert_('초기 설정 완료!\n\n다음 단계: 메뉴 > "2. Gemini API 키 등록"\n초대코드: ' + getConfig_('INVITE_CODE'));
}

/** Gemini API 키는 시트가 아니라 스크립트 속성에 보관한다 (시트에 노출되지 않도록) */
function promptApiKey() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('Gemini API 키 등록', 'Google AI Studio에서 발급한 API 키를 붙여넣으세요.', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const key = res.getResponseText().trim();
  if (!key) return;
  PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', key);
  ui.alert('API 키가 저장되었습니다. (시트에는 표시되지 않습니다)');
}

function rotateInviteCode() {
  const code = newInviteCode_();
  setConfig_('INVITE_CODE', code);
  safeAlert_('새 초대코드: ' + code);
}

function promptUnlockUser() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('계정 잠금 해제', '잠금을 해제할 아이디를 입력하세요.', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const user = findUserByUsername_(normalizeUsername_(res.getResponseText()));
  if (!user) { ui.alert('해당 아이디가 없습니다.'); return; }
  updateRow_(SHEETS.USERS, user._row, { failed_count: 0, locked_until: '' });
  ui.alert('잠금이 해제되었습니다.');
}

function newInviteCode_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 8).toUpperCase();
}

function safeAlert_(msg) {
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { Logger.log(msg); }
}

/* ---------------- 설정값 ---------------- */

function getConfig_(key, fallback) {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('cfg_' + key);
  if (cached !== null) return cached;
  const row = readAll_(SHEETS.CONFIG).filter(function (r) { return r.key === key; })[0];
  const value = row && row.value !== '' ? String(row.value) : (fallback === undefined ? '' : String(fallback));
  cache.put('cfg_' + key, value, 60);
  return value;
}

function getConfigNumber_(key, fallback) {
  const n = Number(getConfig_(key, fallback));
  return isNaN(n) ? fallback : n;
}

function setConfig_(key, value) {
  const row = readAll_(SHEETS.CONFIG).filter(function (r) { return r.key === key; })[0];
  if (row) updateRow_(SHEETS.CONFIG, row._row, { value: value });
  else sheet_(SHEETS.CONFIG).appendRow([key, value, '']);
  CacheService.getScriptCache().remove('cfg_' + key);
}

function audit_(userId, action, detail) {
  try {
    sheet_(SHEETS.AUDIT).appendRow([new Date(), userId || '', action, detail || '']);
  } catch (e) { /* 감사 로그 실패는 무시 */ }
}
