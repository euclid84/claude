/**
 * 관리자 콘솔 (앱 안에서 관리자만 사용)
 *  - 가족 구성원 목록과 역할(관리자 지정/해제)
 *  - 누가 누구의 기록을 볼 수 있는지 (조회 권한 정책) — 정책만 바꾸면 Access.gs 의 동기화가
 *    열쇠를 즉시 회수하거나, 키를 가진 사람의 앱에서 자동으로 발급한다
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
  const sync = withLock_(function () { return reconcileAccess_(''); });
  const users = readAll_(SHEETS.USERS).map(function (u) {
    return {
      userId: String(u.user_id), username: String(u.username), name: String(u.display_name || u.username),
      managed: isManaged_(u), isAdmin: isAdminUser_(u), publicKey: u.public_key ? String(u.public_key) : '',
      createdAt: String(u.created_at || ''), lastLoginAt: String(u.last_login_at || '')
    };
  });
  return {
    users: users,
    access: accessStatus_(sync.model, sync.kept, sync.pending),
    settings: {
      allowSignup: String(getConfig_('ALLOW_SIGNUP', 'TRUE')).toUpperCase() === 'TRUE',
      inviteCode: String(getConfig_('INVITE_CODE', ''))
    }
  };
}

/**
 * 관리자 지정/해제. 역할이 바뀌면 동기화가 이어서 처리한다.
 *  - 지정: 모든 구성원 기록에 대한 열쇠가 '대기'가 되고, 키를 가진 앱(지정한 관리자 포함)이 곧바로 발급
 *  - 해제: 역할로 받았던 열쇠는 즉시 회수. 콘솔에서 따로 준 구성원 간 권한(정책)은 유지
 */
function api_adminSetRole(token, userId, makeAdmin) {
  const s = requireAdmin_(token);
  return withLock_(function () {
    const u = findRows_(SHEETS.USERS, 'user_id', String(userId))[0];
    if (!u) throw new Error('해당 사용자를 찾을 수 없습니다.');
    if (isManaged_(u)) throw new Error('대신 관리하는 구성원은 관리자가 될 수 없습니다. 먼저 본인 계정으로 전환하세요.');
    if (makeAdmin && !u.public_key) throw new Error('첫 로그인 이후에 관리자로 지정할 수 있습니다.');
    const list = adminUsernames_();
    const name = String(u.username);
    const next = list.filter(function (x) { return x !== name; });
    if (makeAdmin) next.push(name);
    if (!next.length) throw new Error('관리자는 최소 1명 있어야 합니다.');
    if (!makeAdmin) {
      // 해제로 대신 관리 구성원의 열쇠 보유자가 사라지면 기록을 잃으므로 막는다
      const others = readAll_(SHEETS.USERS).filter(function (x) {
        return next.indexOf(String(x.username)) !== -1 && x.public_key;
      }).map(function (x) { return String(x.user_id); });
      const shares = readAll_(SHEETS.SHARES);
      const orphan = readAll_(SHEETS.USERS).filter(isManaged_).filter(function (p) {
        return !shares.some(function (r) { return String(r.owner_id) === String(p.user_id) && others.indexOf(String(r.guardian_id)) !== -1; });
      });
      if (orphan.length) {
        throw new Error('다른 관리자가 아직 ' + orphan.map(function (p) { return p.display_name; }).join(', ') +
          ' 구성원의 열쇠를 받지 못해 해제할 수 없습니다. 다른 관리자가 한 번 로그인한 뒤 다시 시도하세요.');
      }
    }
    setConfig_('ADMIN_USERNAMES', next.join(','));
    audit_(s.userId, makeAdmin ? 'admin_grant' : 'admin_revoke', String(userId));
    const r = reconcileAccess_(s.userId);
    return { ok: true, pending: r.pending.length, removed: r.removed };
  });
}

/**
 * 구성원 간 조회 권한 정책 설정 (perm: none/read/write)
 * 관리자는 역할로 항상 전체 권한이므로 대상이 아니다.
 */
function api_adminSetAccess(token, ownerId, viewerId, perm) {
  const s = requireAdmin_(token);
  ownerId = String(ownerId); viewerId = String(viewerId);
  return withLock_(function () {
    const owner = findRows_(SHEETS.USERS, 'user_id', ownerId)[0];
    const viewer = findRows_(SHEETS.USERS, 'user_id', viewerId)[0];
    if (!owner || !viewer) throw new Error('해당 사용자를 찾을 수 없습니다.');
    if (ownerId === viewerId) throw new Error('본인 기록에는 권한을 설정할 수 없습니다.');
    if (isManaged_(viewer)) throw new Error('대신 관리하는 구성원은 로그인하지 않으므로 조회자가 될 수 없습니다.');
    if (isAdminUser_(viewer)) throw new Error('관리자는 역할에 따라 항상 전체 권한을 가집니다.');
    writePolicy_(s.userId, ownerId, viewerId, perm);
    const r = reconcileAccess_(s.userId);
    return { ok: true, pending: r.pending.length };
  });
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

/** 활동 기록 (최근 순). 기록 내용은 없고 "누가 언제 무엇을 했는지"만 보여준다. */
const AUDIT_LABELS = {
  signup: '가입', login: '로그인', login_failed: '로그인 실패', change_password: '비밀번호 변경', recovery_reset: '복구코드로 비밀번호 재설정',
  record_create: '기록 등록', record_create_batch: '기록 여러 건 등록', record_delete: '기록 삭제',
  guardian_add: '조회 권한 부여(본인 설정)', share_remove: '조회 권한 해제', policy_set: '권한 정책 변경',
  access_grant: '열쇠 자동 발급', access_reconcile: '권한 자동 정리', chat_share: '상담 보내기', chat_unshare: '상담 보내기 취소',
  profile_create: '대신 관리 가족 추가', profile_claim: '본인 계정으로 전환',
  admin_grant: '관리자 지정', admin_revoke: '관리자 해제', admin_settings: '가입 설정 변경'
};

function api_adminAudit(token, limit) {
  requireAdmin_(token);
  const names = usernameMap_();
  const rows = readAll_(SHEETS.AUDIT);
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return rows.slice(-n).reverse().map(function (r) {
    const detail = /^(policy_set|admin_grant|admin_revoke|profile_create|profile_claim|share_remove|guardian_add|access_grant|access_reconcile)$/.test(String(r.action))
      ? String(r.detail || '').replace(/u_[0-9a-f]+/g, function (id) { return names[id] || '?'; })
          .replace(/ (read|write|none)$/, function (m, p) { return ' : ' + ({ read: '조회', write: '조회·등록', none: '없음' })[p]; })
      : '';
    return {
      time: String(r.time), user: names[r.user_id] || (r.user_id ? '(알 수 없음)' : '시스템'),
      action: AUDIT_LABELS[r.action] || String(r.action), detail: detail
    };
  });
}
