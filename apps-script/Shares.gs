/**
 * 보호자(가족) 공유
 *
 * 두 가지 가족 형태
 *  1) 본인이 직접 쓰는 가족: 각자 가입 → 기록 주인이 설정에서 보호자를 추가한다.
 *     예) 어머니가 아들을 보호자로 추가하면 아들이 어머니 기록을 본다. 반대 방향은 따로 추가해야 한다.
 *  2) 내가 대신 관리하는 가족 프로필(managed): 로그인 없이 보호자가 만들어 관리한다.
 *     예) 앱을 안 쓰시는 아버지 프로필을 아들이 만들어 결과지를 대신 올린다.
 *     나중에 본인이 쓰고 싶어 하면 아이디/비밀번호를 만들어 일반 계정으로 넘겨준다 (api_claimProfile).
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

/**
 * 보호자 추가 (encDek: 기록 주인의 데이터키를 보호자 공개키로 암호화한 값)
 * ownerId 가 비어 있으면 내 기록, 채우면 내가 관리하는 가족 프로필의 보호자를 추가한다.
 */
function api_addGuardian(token, guardianId, encDek, perm, ownerId) {
  const s = requireSession_(token);
  const owner = resolveManageable_(s, ownerId);
  assertB64_(encDek, 'encDek');
  if (SHARE_PERMS.indexOf(perm) === -1) throw new Error('잘못된 권한입니다.');
  guardianId = String(guardianId);
  if (guardianId === owner) throw new Error('본인은 보호자로 추가할 수 없습니다.');
  const guardian = findRows_(SHEETS.USERS, 'user_id', guardianId)[0];
  if (!guardian) throw new Error('해당 사용자를 찾을 수 없습니다.');
  return withLock_(function () {
    const existing = findShare_(owner, guardianId);
    if (existing) {
      updateRow_(SHEETS.SHARES, existing._row, { enc_dek: encDek, perm: perm });
    } else {
      appendRow_(SHEETS.SHARES, {
        share_id: newId_('s'), owner_id: owner, guardian_id: guardianId,
        enc_dek: encDek, perm: perm, created_at: nowIso_()
      });
    }
    audit_(s.userId, 'guardian_add', owner + ' -> ' + guardianId + ' ' + perm);
    return { ok: true };
  });
}

/** 보호자 목록 (ownerId 비우면 내 기록, 채우면 내가 관리하는 가족 프로필) */
function api_listGuardians(token, ownerId) {
  const s = requireSession_(token);
  const owner = resolveManageable_(s, ownerId);
  const names = usernameMap_();
  return readAll_(SHEETS.SHARES)
    .filter(function (r) { return String(r.owner_id) === owner; })
    .map(function (r) {
      return { shareId: String(r.share_id), userId: String(r.guardian_id), username: names[r.guardian_id] || '(탈퇴)', perm: String(r.perm) };
    });
}

/** 나를 보호자로 추가한 사람들 (내가 챙겨볼 수 있는 가족) */
function api_listSharedWithMe(token) {
  const s = requireSession_(token);
  const names = usernameMap_();
  const managed = {};
  readAll_(SHEETS.USERS).forEach(function (u) { if (isManaged_(u)) managed[u.user_id] = true; });
  return readAll_(SHEETS.SHARES)
    .filter(function (r) { return String(r.guardian_id) === s.userId && names[r.owner_id]; })
    .map(function (r) {
      return {
        shareId: String(r.share_id), ownerId: String(r.owner_id), username: names[r.owner_id],
        encDek: String(r.enc_dek), perm: String(r.perm), managed: !!managed[r.owner_id]
      };
    });
}

/** 공유 해제: 기록 주인 또는 보호자 본인이 할 수 있다 */
function api_removeShare(token, shareId) {
  const s = requireSession_(token);
  return withLock_(function () {
    const row = findRows_(SHEETS.SHARES, 'share_id', shareId)[0];
    if (!row) return { ok: true };
    const canManage = function () { try { resolveManageable_(s, String(row.owner_id)); return true; } catch (e) { return false; } };
    if (String(row.owner_id) !== s.userId && String(row.guardian_id) !== s.userId && !canManage()) throw new Error('권한이 없습니다.');
    if (String(row.guardian_id) === s.userId && isManaged_(findRows_(SHEETS.USERS, 'user_id', String(row.owner_id))[0] || {}) &&
        readAll_(SHEETS.SHARES).filter(function (r) { return String(r.owner_id) === String(row.owner_id) && String(r.perm) === 'write'; }).length <= 1) {
      throw new Error('이 가족 프로필을 관리하는 사람이 나뿐이라 그만 볼 수 없습니다. 먼저 다른 가족을 "보기 + 대신 등록"으로 추가하거나 본인 계정으로 넘겨주세요.');
    }
    deleteRows_(SHEETS.SHARES, [row._row]);
    audit_(s.userId, 'share_remove', String(row.owner_id) + '->' + String(row.guardian_id));
    return { ok: true };
  });
}

function usernameMap_() {
  const map = {};
  readAll_(SHEETS.USERS).forEach(function (u) { map[u.user_id] = String(u.display_name || u.username); });
  return map;
}

function isManaged_(u) { return String(u.managed).toUpperCase() === 'TRUE'; }

/**
 * 보호자 추가/목록을 다룰 대상: 비우면 나, 채우면 "내가 대신 관리하는 가족 프로필"이어야 하고
 * 나에게 그 프로필의 "보기 + 대신 등록" 권한이 있어야 한다.
 */
function resolveManageable_(session, ownerId) {
  if (!ownerId || String(ownerId) === session.userId) return session.userId;
  const u = findRows_(SHEETS.USERS, 'user_id', String(ownerId))[0];
  if (!u || !isManaged_(u)) throw new Error('본인이 직접 쓰는 가족의 보호자는 그분이 직접 정해야 합니다.');
  const share = findShare_(String(ownerId), session.userId);
  if (!share || String(share.perm) !== 'write') throw new Error('이 가족 프로필을 관리할 권한이 없습니다.');
  return String(ownerId);
}

/* ---------------- 내가 대신 관리하는 가족 프로필 ---------------- */

/**
 * 가족 프로필 만들기 (로그인 없음)
 * encDekForMe: 새 프로필의 데이터키를 내 공개키로 암호화한 값 (브라우저에서 만든다)
 */
function api_createProfile(token, displayName, encDekForMe) {
  const s = requireSession_(token);
  displayName = String(displayName || '').trim();
  if (!displayName || displayName.length > 20) throw new Error('이름(호칭)을 1~20자로 입력해 주세요.');
  assertB64_(encDekForMe, 'encDek');
  return withLock_(function () {
    const userId = newId_('u');
    appendRow_(SHEETS.USERS, {
      user_id: userId, username: '#' + userId.slice(-10), created_at: nowIso_(),
      failed_count: 0, display_name: displayName, managed: 'TRUE'
    });
    appendRow_(SHEETS.SHARES, {
      share_id: newId_('s'), owner_id: userId, guardian_id: s.userId,
      enc_dek: encDekForMe, perm: 'write', created_at: nowIso_()
    });
    audit_(s.userId, 'profile_create', userId);
    return { ownerId: userId };
  });
}

/** 관리하는 가족 프로필의 이름(호칭) 바꾸기 */
function api_renameProfile(token, ownerId, displayName) {
  const s = requireSession_(token);
  const owner = resolveManageable_(s, ownerId);
  if (owner === s.userId) throw new Error('잘못된 요청입니다.');
  displayName = String(displayName || '').trim();
  if (!displayName || displayName.length > 20) throw new Error('이름(호칭)을 1~20자로 입력해 주세요.');
  return withLock_(function () {
    const u = findRows_(SHEETS.USERS, 'user_id', owner)[0];
    updateRow_(SHEETS.USERS, u._row, { display_name: displayName });
    return { ok: true };
  });
}

/**
 * 가족 프로필을 본인 계정으로 넘겨주기: 그분이 정한 아이디/비밀번호로 로그인할 수 있게 된다.
 * 데이터키는 그대로이므로 기록은 모두 유지되고, 관리하던 사람은 계속 보호자로 남는다.
 * req: { username, kdfSalt, kdfIter, authKey, wrappedDek, rcKdfSalt, rcAuthKey, wrappedDekRc, publicKey, encPrivateKey }
 */
function api_claimProfile(token, ownerId, req) {
  const s = requireSession_(token);
  const owner = resolveManageable_(s, ownerId);
  if (owner === s.userId) throw new Error('잘못된 요청입니다.');
  const username = normalizeUsername_(req.username);
  if (!USERNAME_RE.test(username)) throw new Error('아이디는 2~20자의 한글/영문 소문자/숫자/_.- 만 쓸 수 있습니다.');
  ['kdfSalt', 'authKey', 'wrappedDek', 'rcKdfSalt', 'rcAuthKey', 'wrappedDekRc', 'publicKey'].forEach(function (k) { assertB64_(req[k], k); });
  if (typeof req.encPrivateKey !== 'string' || !B64_RE.test(req.encPrivateKey)) throw new Error('잘못된 요청입니다.');
  const kdfIter = Number(req.kdfIter);
  if (!(kdfIter >= 100000 && kdfIter <= 5000000)) throw new Error('잘못된 요청입니다.');
  return withLock_(function () {
    if (findUserByUsername_(username)) throw new Error('이미 사용 중인 아이디입니다.');
    const u = findRows_(SHEETS.USERS, 'user_id', owner)[0];
    const authSalt = randomB64_(), rcAuthSalt = randomB64_();
    updateRow_(SHEETS.USERS, u._row, {
      username: username, kdf_salt: req.kdfSalt, kdf_iter: kdfIter,
      auth_salt: authSalt, auth_hash: hashAuth_(authSalt, req.authKey), wrapped_dek: req.wrappedDek,
      rc_kdf_salt: req.rcKdfSalt, rc_auth_salt: rcAuthSalt, rc_auth_hash: hashAuth_(rcAuthSalt, req.rcAuthKey),
      wrapped_dek_rc: req.wrappedDekRc, public_key: req.publicKey, enc_private_key: req.encPrivateKey,
      failed_count: 0, locked_until: '', managed: ''
    });
    audit_(s.userId, 'profile_claim', owner);
    return { ok: true };
  });
}
