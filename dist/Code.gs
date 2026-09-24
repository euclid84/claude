// 자동 생성 파일 — 원본은 apps-script/*.gs (scripts/build.sh 로 생성)

// ===================== Code.gs =====================
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
  SHARES: 'Shares',
  AUDIT: 'AuditLog'
};

const HEADERS = {
  Config: ['key', 'value', 'description'],
  DoctorPresets: ['preset_id', 'name', 'prompt', 'active'],
  Users: [
    'user_id', 'username', 'created_at',
    'kdf_salt', 'kdf_iter', 'auth_salt', 'auth_hash', 'wrapped_dek',
    'rc_kdf_salt', 'rc_auth_salt', 'rc_auth_hash', 'wrapped_dek_rc',
    'failed_count', 'locked_until', 'last_login_at',
    'public_key', 'enc_private_key'
  ],
  Records: ['record_id', 'user_id', 'created_at', 'updated_at', 'enc_data', 'image_ids'],
  Chats: ['message_id', 'user_id', 'record_id', 'created_at', 'enc_data', 'author_id', 'shared'],
  DoctorProfiles: ['user_id', 'updated_at', 'enc_data'],
  Shares: ['share_id', 'owner_id', 'guardian_id', 'enc_dek', 'perm', 'created_at'],
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
    'TRUE'],
  ['preset_liver', '간 전문 내과 (B형간염 정기검사)',
    '소화기내과(간) 전문의 관점에서 만성 B형간염 정기 추적검사 결과를 설명합니다. AST/ALT(간수치), HBeAg/Anti-HBe, HBV-DNA(바이러스 양), AFP·PIVKA-II(간암표지자)가 각각 무엇을 뜻하는지 쉽게 풀고, 반드시 지난 결과들과 비교해 추이를 알려주세요. 간수치가 일시적으로 오를 수 있는 흔한 요인(음주, 과로, 격한 운동, 새로 먹은 약·건강식품)을 설명하되, 담당 선생님의 판단을 우선으로 존중하세요. 6개월 간격 채혈·초음파·간섬유화스캔 정기검사를 빠뜨리지 않도록 챙겨주세요. 항바이러스제(비리어드·베믈리디·바라크루드 등)를 복용 중이면: 바이러스가 검출되지 않는 것이 약이 잘 듣고 있다는 뜻임을 설명하고, 임의로 끊으면 간염이 급격히 나빠질 수 있으니 절대 스스로 중단하지 말라고 안내하세요. 비리어드(테노포비르 디소프록실)를 오래 복용 중이면 신장기능(크레아티닌·eGFR)·인 수치·골밀도 검사 여부를 담당 선생님께 확인해 보도록 권하세요. 약 변경 여부는 담당 선생님이 정할 일이므로 직접 권하지 마세요.',
    'TRUE']
];

/** 웹앱 진입점 */
function doGet() {
  ensureSchema_();
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
  props.setProperty('SCHEMA_VERSION', SCHEMA_VERSION);

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

/**
 * 새 버전에서 추가된 시트/열을 자동으로 만든다 (기존 데이터는 건드리지 않음).
 * 새 열은 항상 오른쪽 끝에 추가되므로 기존 행과 어긋나지 않는다.
 */
const SCHEMA_VERSION = '3';
function ensureSchema_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('SCHEMA_VERSION') === SCHEMA_VERSION) return;
  const ss = getSs_();
  Object.keys(HEADERS).forEach(function (name) {
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    const headers = HEADERS[name];
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
  props.setProperty('SCHEMA_VERSION', SCHEMA_VERSION);
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

// ===================== Db.gs =====================
/**
 * 스프레드시트를 간단한 테이블(DB)처럼 쓰기 위한 도우미 함수
 */

function getSs_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name) {
  const sh = getSs_().getSheetByName(name);
  if (!sh) throw new Error('시트 "' + name + '"가 없습니다. 관리자에게 초기 설정을 요청하세요.');
  return sh;
}

/** 시트 전체를 [{헤더: 값, _row: 행번호}] 배열로 읽는다 */
function readAll_(name) {
  const sh = sheet_(name);
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];
  const values = sh.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = values[0];
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const obj = { _row: i + 1 };
    for (let j = 0; j < headers.length; j++) {
      const v = values[i][j];
      obj[headers[j]] = v instanceof Date ? v.toISOString() : v;
    }
    out.push(obj);
  }
  return out;
}

function findRows_(name, column, value) {
  return readAll_(name).filter(function (r) { return String(r[column]) === String(value); });
}

/**
 * 문자열 앞에 작은따옴표를 붙여서 시트가 수식/숫자/날짜로 자동 변환하지 않게 한다.
 * (읽을 때는 작은따옴표 없이 원래 문자열이 돌아온다)
 */
function cell_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v === '' ? '' : "'" + v;
  return v;
}

function appendRow_(name, obj) {
  const sh = sheet_(name);
  const headers = HEADERS[name];
  const row = headers.map(function (h) { return cell_(obj[h]); });
  sh.getRange(sh.getLastRow() + 1, 1, 1, headers.length).setValues([row]);
}

/** 지정한 열만 부분 수정 */
function updateRow_(name, rowIndex, patch) {
  const sh = sheet_(name);
  const headers = HEADERS[name];
  Object.keys(patch).forEach(function (key) {
    const col = headers.indexOf(key);
    if (col === -1) throw new Error('알 수 없는 열: ' + key);
    sh.getRange(rowIndex, col + 1).setValue(cell_(patch[key]));
  });
}

/** 여러 행 삭제 (아래쪽부터 지워야 행번호가 밀리지 않는다) */
function deleteRows_(name, rowIndexes) {
  const sh = sheet_(name);
  rowIndexes.slice().sort(function (a, b) { return b - a; })
    .forEach(function (r) { sh.deleteRow(r); });
}

/** 동시 쓰기 충돌 방지용 잠금 */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function nowIso_() { return new Date().toISOString(); }

function newId_(prefix) {
  return prefix + '_' + Utilities.getUuid().replace(/-/g, '');
}

// ===================== Auth.gs =====================
/**
 * 아이디/비밀번호 인증
 *
 * 비밀번호는 서버로 전송되지 않는다. 브라우저가 비밀번호 + kdf_salt로 PBKDF2(SHA-256)를 돌려
 *   - 앞 32바이트 → 데이터 암호화 키를 감싸는 키(KEK, 브라우저에만 존재)
 *   - 뒤 32바이트 → 로그인 확인용 authKey (서버로 전송)
 * 를 만든다. 서버는 authKey를 한 번 더 솔트+SHA-256 해서 저장한다.
 */

const USERNAME_RE = /^[a-z0-9가-힣_.-]{2,20}$/;
const B64_RE = /^[A-Za-z0-9+/=]+$/;
const DEFAULT_KDF_ITER = 300000;

/* ---------------- 공개 API (google.script.run 으로 호출) ---------------- */

/** 로그인 전에 해당 아이디의 키 유도 정보(솔트)를 돌려준다. 없는 아이디도 가짜 솔트를 돌려줘서 아이디 존재 여부를 숨긴다. */
function api_prelogin(username) {
  username = normalizeUsername_(username);
  const user = findUserByUsername_(username);
  if (user) return { kdfSalt: String(user.kdf_salt), kdfIter: Number(user.kdf_iter) };
  return { kdfSalt: fakeSalt_('login:' + username), kdfIter: DEFAULT_KDF_ITER };
}

function api_signupInfo() {
  return {
    allowSignup: String(getConfig_('ALLOW_SIGNUP', 'TRUE')).toUpperCase() === 'TRUE',
    kdfIter: DEFAULT_KDF_ITER
  };
}

/**
 * 회원가입
 * req: { username, inviteCode, kdfSalt, kdfIter, authKey, wrappedDek, rcKdfSalt, rcAuthKey, wrappedDekRc }
 */
function api_signup(req) {
  if (String(getConfig_('ALLOW_SIGNUP', 'TRUE')).toUpperCase() !== 'TRUE') {
    throw new Error('현재 새 계정 가입이 막혀 있습니다. 관리자에게 문의하세요.');
  }
  const invite = String(getConfig_('INVITE_CODE', ''));
  if (!invite || String(req.inviteCode || '').trim().toUpperCase() !== invite.toUpperCase()) {
    throw new Error('초대코드가 올바르지 않습니다.');
  }
  const username = normalizeUsername_(req.username);
  if (!USERNAME_RE.test(username)) {
    throw new Error('아이디는 2~20자의 한글/영문 소문자/숫자/_.- 만 쓸 수 있습니다.');
  }
  ['kdfSalt', 'authKey', 'wrappedDek', 'rcKdfSalt', 'rcAuthKey', 'wrappedDekRc'].forEach(function (k) {
    assertB64_(req[k], k);
  });
  const kdfIter = Number(req.kdfIter);
  if (!(kdfIter >= 100000 && kdfIter <= 5000000)) throw new Error('잘못된 요청입니다.');

  return withLock_(function () {
    if (findUserByUsername_(username)) throw new Error('이미 사용 중인 아이디입니다.');
    const userId = newId_('u');
    const authSalt = randomB64_();
    const rcAuthSalt = randomB64_();
    appendRow_(SHEETS.USERS, {
      user_id: userId,
      username: username,
      created_at: nowIso_(),
      kdf_salt: req.kdfSalt,
      kdf_iter: kdfIter,
      auth_salt: authSalt,
      auth_hash: hashAuth_(authSalt, req.authKey),
      wrapped_dek: req.wrappedDek,
      rc_kdf_salt: req.rcKdfSalt,
      rc_auth_salt: rcAuthSalt,
      rc_auth_hash: hashAuth_(rcAuthSalt, req.rcAuthKey),
      wrapped_dek_rc: req.wrappedDekRc,
      failed_count: 0,
      locked_until: '',
      last_login_at: ''
    });
    audit_(userId, 'signup', '');
    return { ok: true };
  });
}

/** 로그인: 성공하면 세션 토큰과 (비밀번호로 감싼) 데이터 키를 돌려준다 */
function api_login(username, authKey) {
  username = normalizeUsername_(username);
  assertB64_(authKey, 'authKey');
  const user = findUserByUsername_(username);
  if (!user) throw new Error('아이디 또는 비밀번호가 올바르지 않습니다.');
  assertNotLocked_(user);

  if (!safeEqual_(hashAuth_(String(user.auth_salt), authKey), String(user.auth_hash))) {
    recordFailure_(user);
    throw new Error('아이디 또는 비밀번호가 올바르지 않습니다.');
  }
  updateRow_(SHEETS.USERS, user._row, { failed_count: 0, locked_until: '', last_login_at: nowIso_() });
  audit_(user.user_id, 'login', '');
  return {
    token: createSession_(user),
    userId: String(user.user_id),
    username: String(user.username),
    wrappedDek: String(user.wrapped_dek),
    encPrivateKey: user.public_key ? String(user.enc_private_key) : ''
  };
}

function api_logout(token) {
  if (token) CacheService.getScriptCache().remove('sess_' + token);
  return { ok: true };
}

/** 로그인 상태에서 비밀번호 변경: 데이터 키는 그대로 두고 감싸는 키만 바꾼다 */
function api_changePassword(token, req) {
  const session = requireSession_(token);
  assertB64_(req.oldAuthKey, 'oldAuthKey');
  ['kdfSalt', 'authKey', 'wrappedDek'].forEach(function (k) { assertB64_(req[k], k); });
  return withLock_(function () {
    const user = findUserById_(session.userId);
    if (!safeEqual_(hashAuth_(String(user.auth_salt), req.oldAuthKey), String(user.auth_hash))) {
      throw new Error('현재 비밀번호가 올바르지 않습니다.');
    }
    const authSalt = randomB64_();
    updateRow_(SHEETS.USERS, user._row, {
      kdf_salt: req.kdfSalt,
      kdf_iter: Number(req.kdfIter) || DEFAULT_KDF_ITER,
      auth_salt: authSalt,
      auth_hash: hashAuth_(authSalt, req.authKey),
      wrapped_dek: req.wrappedDek
    });
    audit_(user.user_id, 'change_password', '');
    return { ok: true };
  });
}

/* ---- 비밀번호 분실 시: 가입 때 받은 복구코드로 재설정 ---- */

function api_recoveryPrelogin(username) {
  username = normalizeUsername_(username);
  const user = findUserByUsername_(username);
  if (user) return { rcKdfSalt: String(user.rc_kdf_salt), kdfIter: Number(user.kdf_iter) };
  return { rcKdfSalt: fakeSalt_('recovery:' + username), kdfIter: DEFAULT_KDF_ITER };
}

/** 복구코드 확인 후, 복구코드로 감싼 데이터 키를 돌려준다 */
function api_recoveryBegin(username, rcAuthKey) {
  const user = verifyRecovery_(username, rcAuthKey);
  return { wrappedDekRc: String(user.wrapped_dek_rc) };
}

/** 새 비밀번호로 데이터 키를 다시 감싸 저장 */
function api_recoveryFinish(username, rcAuthKey, req) {
  ['kdfSalt', 'authKey', 'wrappedDek'].forEach(function (k) { assertB64_(req[k], k); });
  return withLock_(function () {
    const user = verifyRecovery_(username, rcAuthKey);
    const authSalt = randomB64_();
    updateRow_(SHEETS.USERS, user._row, {
      kdf_salt: req.kdfSalt,
      kdf_iter: Number(req.kdfIter) || DEFAULT_KDF_ITER,
      auth_salt: authSalt,
      auth_hash: hashAuth_(authSalt, req.authKey),
      wrapped_dek: req.wrappedDek,
      failed_count: 0,
      locked_until: ''
    });
    audit_(user.user_id, 'recovery_reset', '');
    return { ok: true };
  });
}

/* ---------------- 내부 함수 ---------------- */

function verifyRecovery_(username, rcAuthKey) {
  username = normalizeUsername_(username);
  assertB64_(rcAuthKey, 'rcAuthKey');
  const user = findUserByUsername_(username);
  if (!user) throw new Error('아이디 또는 복구코드가 올바르지 않습니다.');
  assertNotLocked_(user);
  if (!safeEqual_(hashAuth_(String(user.rc_auth_salt), rcAuthKey), String(user.rc_auth_hash))) {
    recordFailure_(user);
    throw new Error('아이디 또는 복구코드가 올바르지 않습니다.');
  }
  return user;
}

function createSession_(user) {
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  const hours = Math.min(Math.max(getConfigNumber_('SESSION_HOURS', 6), 1), 6);
  CacheService.getScriptCache().put(
    'sess_' + token,
    JSON.stringify({ userId: String(user.user_id), username: String(user.username) }),
    hours * 3600
  );
  return token;
}

/** 모든 데이터 API는 이 함수로 세션을 확인하고, 반환된 userId의 데이터만 다룬다 */
function requireSession_(token) {
  if (!token || typeof token !== 'string') throw new Error('SESSION_EXPIRED');
  const raw = CacheService.getScriptCache().get('sess_' + token);
  if (!raw) throw new Error('SESSION_EXPIRED');
  return JSON.parse(raw);
}

function assertNotLocked_(user) {
  const until = user.locked_until ? new Date(user.locked_until) : null;
  if (until && until.getTime() > Date.now()) {
    const mins = Math.ceil((until.getTime() - Date.now()) / 60000);
    throw new Error('로그인 실패가 많아 잠겼습니다. ' + mins + '분 후 다시 시도하세요.');
  }
}

function recordFailure_(user) {
  const fails = (Number(user.failed_count) || 0) + 1;
  const max = getConfigNumber_('MAX_LOGIN_FAILS', 5);
  const patch = { failed_count: fails };
  if (fails >= max) {
    patch.locked_until = new Date(Date.now() + getConfigNumber_('LOCK_MINUTES', 15) * 60000).toISOString();
    patch.failed_count = 0;
  }
  updateRow_(SHEETS.USERS, user._row, patch);
  audit_(user.user_id, 'login_failed', String(fails));
}

function normalizeUsername_(username) {
  return String(username || '').trim().toLowerCase();
}

function findUserByUsername_(username) {
  return findRows_(SHEETS.USERS, 'username', username)[0] || null;
}

function findUserById_(userId) {
  const user = findRows_(SHEETS.USERS, 'user_id', userId)[0];
  if (!user) throw new Error('SESSION_EXPIRED');
  return user;
}

function hashAuth_(salt, authKey) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + authKey, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomB64_() {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Utilities.getUuid() + Date.now());
  return Utilities.base64Encode(bytes.slice(0, 16));
}

/** 없는 아이디에 대해 항상 같은 가짜 솔트를 돌려줘 아이디 존재 여부 탐색을 막는다 */
function fakeSalt_(seed) {
  const secret = PropertiesService.getScriptProperties().getProperty('SERVER_SECRET') || 'x';
  const mac = Utilities.computeHmacSha256Signature(seed, secret);
  return Utilities.base64Encode(mac.slice(0, 16));
}

function assertB64_(v, name) {
  if (typeof v !== 'string' || !v || v.length > 20000 || !B64_RE.test(v)) {
    throw new Error('잘못된 요청입니다. (' + name + ')');
  }
}

// ===================== Records.gs =====================
/**
 * 진료기록 / 사진 / 질의응답 / 의사 설정 저장
 *
 * 여기로 들어오는 enc_data 와 사진은 모두 브라우저에서 이미 암호화된 값이다.
 * 서버는 "누구의 데이터인지(user_id)"와 "보호자 권한(Shares)"만 확인한다.
 *
 * 모든 API의 마지막 인자 ownerId: 비우면 본인, 채우면 보호자로서 그 사람의 기록을 다룬다.
 *   (resolveOwner_ 가 Shares 시트로 권한을 확인한다)
 */

const MAX_CELL_CHARS = 49000;       // 구글시트 셀 한도(50,000자) 여유분
const MAX_IMAGE_B64_CHARS = 14500000; // 암호화된 사진/PDF 1개 최대 약 10MB

/* ---------------- 진료기록 ---------------- */

function api_listRecords(token, ownerId) {
  const owner = resolveOwner_(requireSession_(token), ownerId, 'read');
  return findRows_(SHEETS.RECORDS, 'user_id', owner).map(function (r) {
    return {
      recordId: String(r.record_id),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      encData: String(r.enc_data),
      imageIds: r.image_ids ? String(r.image_ids).split(',') : []
    };
  });
}

/** req: { recordId?(수정 시), encData, imageIds: [] } */
function api_saveRecord(token, req, ownerId) {
  const s = requireSession_(token);
  const owner = resolveOwner_(s, ownerId, 'write');
  assertEnc_(req.encData);
  const imageIds = (req.imageIds || []).map(String);
  imageIds.forEach(function (id) { assertOwnImage_(owner, id); });

  return withLock_(function () {
    if (req.recordId) {
      const rec = ownRecord_(owner, req.recordId);
      // 수정하면서 빠진 사진은 휴지통으로
      const oldIds = rec.image_ids ? String(rec.image_ids).split(',') : [];
      trashIfUnused_(owner, oldIds.filter(function (id) { return imageIds.indexOf(id) === -1; }), rec.record_id);
      updateRow_(SHEETS.RECORDS, rec._row, {
        updated_at: nowIso_(),
        enc_data: req.encData,
        image_ids: imageIds.join(',')
      });
      return { recordId: String(rec.record_id) };
    }
    const recordId = newId_('r');
    const now = nowIso_();
    appendRow_(SHEETS.RECORDS, {
      record_id: recordId, user_id: owner, created_at: now, updated_at: now,
      enc_data: req.encData, image_ids: imageIds.join(',')
    });
    audit_(s.userId, 'record_create', recordId + (owner !== s.userId ? ' for ' + owner : ''));
    return { recordId: recordId };
  });
}

/**
 * 여러 건 한 번에 저장 (문자 캡처처럼 한 번에 여러 기록이 나올 때)
 * items: [{ encData, imageIds }]  — 같은 사진을 여러 기록이 함께 가리킬 수 있다.
 */
function api_saveRecords(token, items, ownerId) {
  const s = requireSession_(token);
  const owner = resolveOwner_(s, ownerId, 'write');
  if (!Array.isArray(items) || !items.length || items.length > 100) throw new Error('잘못된 요청입니다.');
  const checked = {};
  items.forEach(function (it) {
    assertEnc_(it.encData);
    (it.imageIds || []).forEach(function (id) {
      if (!checked[id]) { assertOwnImage_(owner, String(id)); checked[id] = true; }
    });
  });
  return withLock_(function () {
    const now = nowIso_();
    const sh = sheet_(SHEETS.RECORDS);
    const rows = items.map(function (it) {
      return {
        record_id: newId_('r'), user_id: owner, created_at: now, updated_at: now,
        enc_data: it.encData, image_ids: (it.imageIds || []).map(String).join(',')
      };
    });
    const values = rows.map(function (r) { return HEADERS.Records.map(function (h) { return cell_(r[h]); }); });
    sh.getRange(sh.getLastRow() + 1, 1, values.length, HEADERS.Records.length).setValues(values);
    audit_(s.userId, 'record_create_batch', String(rows.length) + (owner !== s.userId ? ' for ' + owner : ''));
    return { recordIds: rows.map(function (r) { return r.record_id; }) };
  });
}

function api_deleteRecord(token, recordId, ownerId) {
  const s = requireSession_(token);
  const owner = resolveOwner_(s, ownerId, 'write');
  return withLock_(function () {
    const rec = ownRecord_(owner, recordId);
    trashIfUnused_(owner, rec.image_ids ? String(rec.image_ids).split(',') : [], rec.record_id);
    const chatRows = readAll_(SHEETS.CHATS)
      .filter(function (c) { return String(c.user_id) === owner && String(c.record_id) === String(recordId); })
      .map(function (c) { return c._row; });
    deleteRows_(SHEETS.CHATS, chatRows);
    deleteRows_(SHEETS.RECORDS, [rec._row]);
    audit_(s.userId, 'record_delete', recordId);
    return { ok: true };
  });
}

/* ---------------- 사진·PDF (암호화된 파일로 드라이브에 저장) ---------------- */

function api_uploadImage(token, encB64, ownerId) {
  const owner = resolveOwner_(requireSession_(token), ownerId, 'write');
  if (typeof encB64 !== 'string' || !B64_RE.test(encB64) || encB64.length > MAX_IMAGE_B64_CHARS) {
    throw new Error('파일이 너무 크거나(최대 10MB) 형식이 올바르지 않습니다.');
  }
  const folder = DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty('IMAGE_FOLDER_ID'));
  const blob = Utilities.newBlob(Utilities.base64Decode(encB64), 'application/octet-stream', newId_('img') + '.enc');
  const file = folder.createFile(blob);
  file.setDescription(owner); // 소유자 표시 (내용은 암호문)
  return { imageId: file.getId() };
}

function api_getImage(token, imageId, ownerId) {
  const owner = resolveOwner_(requireSession_(token), ownerId, 'read');
  const file = assertOwnImage_(owner, imageId);
  return { encB64: Utilities.base64Encode(file.getBlob().getBytes()) };
}

/** 저장하지 않고 버린 사진 정리 */
function api_discardImages(token, imageIds, ownerId) {
  const owner = resolveOwner_(requireSession_(token), ownerId, 'write');
  const used = {};
  findRows_(SHEETS.RECORDS, 'user_id', owner).forEach(function (r) {
    (r.image_ids ? String(r.image_ids).split(',') : []).forEach(function (id) { used[id] = true; });
  });
  (imageIds || []).forEach(function (id) {
    if (used[id]) return;
    try { assertOwnImage_(owner, id); trashImage_(id); } catch (e) { /* 무시 */ }
  });
  return { ok: true };
}

/* ---------------- 질의응답 기록 ---------------- */
// 상담 내역은 "누구의 기록에 대해(user_id)" + "누가 물었는지(author_id)"로 저장한다.
//  - 기록 주인(장모님): 본인 상담 + 보호자가 "보내준" 상담만 보인다.
//  - 보호자(사위·딸): 한 팀이다. 보호자들이 나눈 상담 전부 + 장모님 본인 상담(읽기)이 보인다.
//  - 보호자는 자기 팀 상담 중 원하는 것을 골라 장모님께 보낼 수 있다 (shared = TRUE).

function chatAuthor_(c) { return String(c.author_id || c.user_id); }
function isShared_(c) { return String(c.shared).toUpperCase() === 'TRUE'; }

/** recordId: 기록 ID, 'ALL'(전체 기록 상담), '*'(모든 상담 — 가족이 보내준 설명 모아보기용) */
function api_listChats(token, recordId, ownerId) {
  const s = requireSession_(token);
  const owner = resolveOwner_(s, ownerId, 'read');
  const isOwner = owner === s.userId;
  const names = usernameMap_();
  return readAll_(SHEETS.CHATS)
    .filter(function (c) {
      if (String(c.user_id) !== owner) return false;
      if (recordId !== '*' && String(c.record_id) !== String(recordId)) return false;
      const fromOwner = chatAuthor_(c) === owner;
      return isOwner ? (fromOwner || isShared_(c)) : true;
    })
    .map(function (c) {
      const author = chatAuthor_(c);
      return {
        messageId: String(c.message_id), recordId: String(c.record_id), createdAt: String(c.created_at),
        encData: String(c.enc_data), mine: author === s.userId, fromOwner: author === owner,
        authorName: names[author] || '', shared: isShared_(c)
      };
    });
}

function api_saveChat(token, recordId, encData, ownerId) {
  const s = requireSession_(token);
  const owner = resolveOwner_(s, ownerId, 'read');
  assertEnc_(encData);
  if (recordId !== 'ALL') ownRecord_(owner, recordId);
  const messageId = newId_('m');
  withLock_(function () {
    appendRow_(SHEETS.CHATS, {
      message_id: messageId, user_id: owner, record_id: recordId, created_at: nowIso_(),
      enc_data: encData, author_id: s.userId, shared: ''
    });
  });
  return { messageId: messageId };
}

/** 지우기: 기록 주인은 본인 상담만, 보호자는 보호자 팀 상담만 지운다 */
function api_clearChats(token, recordId, ownerId) {
  const s = requireSession_(token);
  const owner = resolveOwner_(s, ownerId, 'read');
  const isOwner = owner === s.userId;
  return withLock_(function () {
    const rows = readAll_(SHEETS.CHATS)
      .filter(function (c) {
        if (String(c.user_id) !== owner || String(c.record_id) !== String(recordId)) return false;
        const fromOwner = chatAuthor_(c) === owner;
        return isOwner ? fromOwner : !fromOwner;
      })
      .map(function (c) { return c._row; });
    deleteRows_(SHEETS.CHATS, rows);
    return { ok: true };
  });
}

/** 보호자 상담 중 골라서 기록 주인(장모님)에게 보내기 / 보내기 취소 */
function api_shareChats(token, messageIds, shared, ownerId) {
  const s = requireSession_(token);
  const owner = resolveOwner_(s, ownerId, 'read');
  if (owner === s.userId) throw new Error('보호자만 보낼 수 있습니다.');
  const ids = (messageIds || []).map(String);
  return withLock_(function () {
    readAll_(SHEETS.CHATS).forEach(function (c) {
      if (ids.indexOf(String(c.message_id)) === -1) return;
      if (String(c.user_id) !== owner || chatAuthor_(c) === owner) return;
      updateRow_(SHEETS.CHATS, c._row, { shared: shared ? 'TRUE' : '' });
    });
    audit_(s.userId, shared ? 'chat_share' : 'chat_unshare', ids.length + ' to ' + owner);
    return { ok: true };
  });
}

/* ---------------- 의사 선생님 설정 ---------------- */

function api_getDoctorProfile(token, ownerId) {
  const owner = resolveOwner_(requireSession_(token), ownerId, 'read');
  const row = findRows_(SHEETS.PROFILES, 'user_id', owner)[0];
  return { encData: row ? String(row.enc_data) : '', presets: listPresets_() };
}

function api_saveDoctorProfile(token, encData, ownerId) {
  const owner = resolveOwner_(requireSession_(token), ownerId, 'write');
  assertEnc_(encData);
  return withLock_(function () {
    const row = findRows_(SHEETS.PROFILES, 'user_id', owner)[0];
    if (row) updateRow_(SHEETS.PROFILES, row._row, { updated_at: nowIso_(), enc_data: encData });
    else appendRow_(SHEETS.PROFILES, { user_id: owner, updated_at: nowIso_(), enc_data: encData });
    return { ok: true };
  });
}

/** 관리자가 DoctorPresets 시트에 적어둔 의사 선생님 프리셋 (이름만 앱에 보여준다) */
function listPresets_() {
  return readAll_(SHEETS.PRESETS)
    .filter(function (p) { return String(p.active).toUpperCase() !== 'FALSE' && p.preset_id; })
    .map(function (p) { return { id: String(p.preset_id), name: String(p.name) }; });
}

function getPresetPrompt_(presetId) {
  if (!presetId) return '';
  const p = findRows_(SHEETS.PRESETS, 'preset_id', presetId)[0];
  return p && String(p.active).toUpperCase() !== 'FALSE' ? String(p.prompt) : '';
}

/* ---------------- 내부 함수 ---------------- */

function ownRecord_(userId, recordId) {
  const rec = findRows_(SHEETS.RECORDS, 'record_id', recordId)[0];
  if (!rec || String(rec.user_id) !== userId) throw new Error('기록을 찾을 수 없습니다.');
  return rec;
}

function assertOwnImage_(userId, imageId) {
  let file;
  try { file = DriveApp.getFileById(imageId); } catch (e) { throw new Error('사진을 찾을 수 없습니다.'); }
  if (file.getDescription() !== userId || file.isTrashed()) throw new Error('사진을 찾을 수 없습니다.');
  return file;
}

/** 다른 기록이 같은 사진을 쓰고 있으면 남겨두고, 아무도 안 쓰면 휴지통으로 */
function trashIfUnused_(userId, imageIds, exceptRecordId) {
  if (!imageIds.length) return;
  const used = {};
  findRows_(SHEETS.RECORDS, 'user_id', userId).forEach(function (r) {
    if (String(r.record_id) === String(exceptRecordId)) return;
    (r.image_ids ? String(r.image_ids).split(',') : []).forEach(function (id) { used[id] = true; });
  });
  imageIds.forEach(function (id) { if (!used[id]) trashImage_(id); });
}

function trashImage_(imageId) {
  try { DriveApp.getFileById(imageId).setTrashed(true); } catch (e) { /* 이미 없음 */ }
}

function assertEnc_(encData) {
  if (typeof encData !== 'string' || encData.indexOf('v1:') !== 0) throw new Error('잘못된 데이터 형식입니다.');
  if (encData.length > MAX_CELL_CHARS) {
    throw new Error('내용이 너무 깁니다. 원문 텍스트를 줄이거나 기록을 나눠서 저장해 주세요.');
  }
}

// ===================== Shares.gs =====================
/**
 * 보호자(가족) 공유
 *
 * 예) 장모님이 설정에서 "사위", "딸"을 보호자로 추가하면 두 사람이 장모님 기록을 볼 수 있다.
 *     반대 방향(장모님이 사위 기록 보기)은 사위가 따로 추가하지 않는 한 불가능하다.
 *
 * 암호화 방식
 *  - 가입자마다 공개키/개인키(RSA-OAEP) 한 쌍이 있다. 개인키는 본인 데이터키로 암호화해서 저장한다.
 *  - 보호자를 추가하면, 기록 주인의 데이터키를 보호자의 공개키로 암호화해서 Shares 시트에 저장한다.
 *  - 보호자는 로그인할 때 자기 개인키로 그 데이터키를 풀어서 기록을 연다.
 *  → 시트에는 여전히 암호문만 있고, 서버는 누가 누구의 기록을 열 수 있는지만 확인한다.
 */

const SHARE_PERMS = ['read', 'write'];

/**
 * ownerId 가 비어 있거나 본인이면 본인, 아니면 Shares 시트에서 권한을 확인한다.
 * need: 'read' (보기·질문) 또는 'write' (등록·수정·삭제)
 */
function resolveOwner_(session, ownerId, need) {
  if (!ownerId || String(ownerId) === session.userId) return session.userId;
  const share = findShare_(String(ownerId), session.userId);
  if (!share) throw new Error('이 기록을 볼 권한이 없습니다.');
  if (need === 'write' && String(share.perm) !== 'write') {
    throw new Error('보기 권한만 있어서 등록·수정·삭제는 할 수 없습니다.');
  }
  return String(ownerId);
}

function findShare_(ownerId, guardianId) {
  return readAll_(SHEETS.SHARES).filter(function (r) {
    return String(r.owner_id) === ownerId && String(r.guardian_id) === guardianId;
  })[0] || null;
}

/** 로그인 직후 공개키/개인키가 없는 계정(기존 가입자 포함)에 한 번 등록 */
function api_setKeypair(token, publicKey, encPrivateKey) {
  const s = requireSession_(token);
  assertB64_(publicKey, 'publicKey');
  if (typeof encPrivateKey !== 'string' || !B64_RE.test(encPrivateKey) || encPrivateKey.length > 20000) {
    throw new Error('잘못된 요청입니다. (encPrivateKey)');
  }
  return withLock_(function () {
    const user = findUserById_(s.userId);
    if (user.public_key) return { ok: true, already: true }; // 이미 있으면 바꾸지 않는다 (공유가 깨지지 않도록)
    updateRow_(SHEETS.USERS, user._row, { public_key: publicKey, enc_private_key: encPrivateKey });
    return { ok: true };
  });
}

/** 보호자로 추가할 사람 찾기 (아이디로) */
function api_findUser(token, username) {
  const s = requireSession_(token);
  const user = findUserByUsername_(normalizeUsername_(username));
  if (!user) throw new Error('해당 아이디를 찾을 수 없습니다.');
  if (String(user.user_id) === s.userId) throw new Error('본인은 보호자로 추가할 수 없습니다.');
  if (!user.public_key) throw new Error('그 분이 새 버전 앱에 한 번 로그인한 뒤에 추가할 수 있습니다.');
  return { userId: String(user.user_id), username: String(user.username), publicKey: String(user.public_key) };
}

/** 내 기록을 볼 보호자 추가 (encDek: 내 데이터키를 보호자 공개키로 암호화한 값) */
function api_addGuardian(token, guardianId, encDek, perm) {
  const s = requireSession_(token);
  assertB64_(encDek, 'encDek');
  if (SHARE_PERMS.indexOf(perm) === -1) throw new Error('잘못된 권한입니다.');
  guardianId = String(guardianId);
  if (guardianId === s.userId) throw new Error('본인은 보호자로 추가할 수 없습니다.');
  const guardian = findRows_(SHEETS.USERS, 'user_id', guardianId)[0];
  if (!guardian) throw new Error('해당 사용자를 찾을 수 없습니다.');
  return withLock_(function () {
    const existing = findShare_(s.userId, guardianId);
    if (existing) {
      updateRow_(SHEETS.SHARES, existing._row, { enc_dek: encDek, perm: perm });
    } else {
      appendRow_(SHEETS.SHARES, {
        share_id: newId_('s'), owner_id: s.userId, guardian_id: guardianId,
        enc_dek: encDek, perm: perm, created_at: nowIso_()
      });
    }
    audit_(s.userId, 'guardian_add', guardianId + ' ' + perm);
    return { ok: true };
  });
}

/** 내가 추가한 보호자 목록 */
function api_listGuardians(token) {
  const s = requireSession_(token);
  const names = usernameMap_();
  return readAll_(SHEETS.SHARES)
    .filter(function (r) { return String(r.owner_id) === s.userId; })
    .map(function (r) {
      return { shareId: String(r.share_id), userId: String(r.guardian_id), username: names[r.guardian_id] || '(탈퇴)', perm: String(r.perm) };
    });
}

/** 나를 보호자로 추가한 사람들 (내가 챙겨볼 수 있는 가족) */
function api_listSharedWithMe(token) {
  const s = requireSession_(token);
  const names = usernameMap_();
  return readAll_(SHEETS.SHARES)
    .filter(function (r) { return String(r.guardian_id) === s.userId && names[r.owner_id]; })
    .map(function (r) {
      return { shareId: String(r.share_id), ownerId: String(r.owner_id), username: names[r.owner_id], encDek: String(r.enc_dek), perm: String(r.perm) };
    });
}

/** 공유 해제: 기록 주인 또는 보호자 본인이 할 수 있다 */
function api_removeShare(token, shareId) {
  const s = requireSession_(token);
  return withLock_(function () {
    const row = findRows_(SHEETS.SHARES, 'share_id', shareId)[0];
    if (!row) return { ok: true };
    if (String(row.owner_id) !== s.userId && String(row.guardian_id) !== s.userId) throw new Error('권한이 없습니다.');
    deleteRows_(SHEETS.SHARES, [row._row]);
    audit_(s.userId, 'share_remove', String(row.owner_id) + '->' + String(row.guardian_id));
    return { ok: true };
  });
}

function usernameMap_() {
  const map = {};
  readAll_(SHEETS.USERS).forEach(function (u) { map[u.user_id] = String(u.username); });
  return map;
}

// ===================== Gemini.gs =====================
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
  '크레아티닌', 'eGFR', '인(P)', '요산', '혈색소(Hb)', '혈소판', '백혈구',
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
      '결과지 사진, 건강검진 결과표(PDF 포함), 처방전, 병원 문자메시지(또는 문자 대화 화면 캡처) 등.',
      '',
      '[기록 나누기]',
      '- 자료 안에 서로 다른 날짜의 결과가 여러 개 있으면(예: 문자 대화 캡처에 몇 년치 결과 문자가 있는 경우) 날짜/방문별로 records를 나누세요.',
      '- 한 결과지의 여러 페이지(또는 PDF의 여러 쪽)는 하나의 record로 합치세요. 단, 한 PDF 안에 서로 다른 날짜의 결과가 있으면 날짜별로 나누세요.',
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
    if (!/^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/.test(img.mimeType) || !B64_RE.test(img.data)) {
      throw new Error('지원하지 않는 파일 형식입니다. 사진 또는 PDF만 올릴 수 있어요.');
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
      systemInstruction: { parts: [{ text: buildDoctorPrompt_(req.doctor || {}, recordsJson, !!req.asGuardian) }] },
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

function buildDoctorPrompt_(d, recordsJson, asGuardian) {
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

  if (asGuardian) {
    lines.push('[질문하는 사람]',
      '이 질문은 환자 본인이 아니라 환자를 돌보는 가족(보호자)이 하고 있습니다. 보호자에게 설명하듯 답하고, 환자는 3인칭(호칭이 있으면 그 호칭)으로 가리키세요. 보호자가 병원에 동행하거나 챙겨드릴 때 도움이 될 점도 알려주세요.', '');
  }
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
