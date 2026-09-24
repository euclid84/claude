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
