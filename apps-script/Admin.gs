/**
 * 관리자 콘솔 (앱 안에서 관리자만 사용)
 *  - 가족 구성원 목록과 역할(관리자 지정/해제)
 *  - 누가 누구의 기록을 볼 수 있는지 (조회 권한) — 실제 권한 부여/해제는 Shares.gs 의
 *    api_addGuardian / api_removeShare 를 쓴다 (데이터키 암호화는 브라우저에서 해야 하므로)
 *  - 가입 허용, 초대코드
 *
 * 관리자 목록은 Config 시트 ADMIN_USERNAMES 에 저장되지만, 시트를 직접 고칠 필요 없이 여기서 바꾼다.
 */

function requireAdmin_(token) {
  const s = requireSession_(token);
  const me = findRows_(SHEETS.USERS, 'user_id', s.userId)[0];
  if (!me || !isAdminUser_(me)) throw new Error('관리자만 사용할 수 있습니다.');
  return s;
}

/** 콘솔 화면에 필요한 정보 (기록 내용은 없음 — 누가 있고, 누가 누구를 볼 수 있는지만) */
function api_adminState(token) {
  requireAdmin_(token);
  const users = readAll_(SHEETS.USERS).map(function (u) {
    return {
      userId: String(u.user_id), username: String(u.username), name: String(u.display_name || u.username),
      managed: isManaged_(u), isAdmin: isAdminUser_(u), publicKey: u.public_key ? String(u.public_key) : '',
      createdAt: String(u.created_at || '')
    };
  });
  const shares = readAll_(SHEETS.SHARES).map(function (r) {
    return { shareId: String(r.share_id), ownerId: String(r.owner_id), guardianId: String(r.guardian_id), perm: String(r.perm) };
  });
  return {
    users: users,
    shares: shares,
    settings: {
      allowSignup: String(getConfig_('ALLOW_SIGNUP', 'TRUE')).toUpperCase() === 'TRUE',
      inviteCode: String(getConfig_('INVITE_CODE', ''))
    }
  };
}

/** 관리자 지정/해제 */
function api_adminSetRole(token, userId, makeAdmin) {
  const s = requireAdmin_(token);
  const u = findRows_(SHEETS.USERS, 'user_id', String(userId))[0];
  if (!u) throw new Error('해당 사용자를 찾을 수 없습니다.');
  if (isManaged_(u)) throw new Error('대신 관리하는 가족은 관리자가 될 수 없어요. 먼저 본인 계정을 만들어 주세요.');
  const list = adminUsernames_();
  const name = String(u.username);
  let next = list.filter(function (x) { return x !== name; });
  if (makeAdmin) next.push(name);
  if (!next.length) throw new Error('관리자는 최소 1명 있어야 합니다.');
  setConfig_('ADMIN_USERNAMES', next.join(','));
  audit_(s.userId, makeAdmin ? 'admin_grant' : 'admin_revoke', String(userId));
  return { ok: true };
}

/** 가입 허용 / 초대코드 새로 만들기 */
function api_adminSettings(token, req) {
  const s = requireAdmin_(token);
  if (req && typeof req.allowSignup === 'boolean') setConfig_('ALLOW_SIGNUP', req.allowSignup ? 'TRUE' : 'FALSE');
  if (req && req.rotateInvite) setConfig_('INVITE_CODE', newInviteCode_());
  audit_(s.userId, 'admin_settings', JSON.stringify(req || {}));
  return {
    allowSignup: String(getConfig_('ALLOW_SIGNUP', 'TRUE')).toUpperCase() === 'TRUE',
    inviteCode: String(getConfig_('INVITE_CODE', ''))
  };
}
