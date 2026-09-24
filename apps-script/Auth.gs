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
