/**
 * 접근 권한 엔진 — "정책(원하는 상태)"과 "열쇠(실제 상태)"를 분리하고 자동으로 맞춘다.
 *
 *  1) 정책
 *     - 역할: 관리자는 모든 구성원의 기록에 조회·등록(write). (Config ADMIN_USERNAMES)
 *     - 구성원 간 권한: AccessPolicy 시트 (관리자 콘솔 또는 기록 주인이 정함)
 *  2) 열쇠: Shares 시트 — 기록 주인의 데이터키를 조회자 공개키로 암호화한 값.
 *     서버의 모든 기록 접근 검사(resolveOwner_)는 이 열쇠를 기준으로 한다.
 *  3) 동기화 (reconcileAccess_)
 *     - 정책에 없는 열쇠 → 즉시 삭제 (관리자 해제, 권한 '없음' 등) — 서버만으로 처리
 *     - 권한 수준만 다른 열쇠 → 즉시 수정 — 서버만으로 처리
 *     - 정책에는 있는데 열쇠가 없음 → '대기'. 데이터키는 브라우저에만 있으므로
 *       키를 가진 사람(기록 주인 또는 이미 열쇠가 있는 관리자)의 앱이 로그인·콘솔 조작 때
 *       api_syncAccess → api_fulfillAccess 로 자동 발급한다.
 *       조회자가 아직 첫 로그인 전(공개키 없음)이면 첫 로그인 이후 자동으로 이어진다.
 *
 *  안전장치: 대신 관리하는 구성원(로그인 없음)은 데이터키가 열쇠에만 있으므로,
 *  남는 열쇠가 하나도 없게 되는 삭제는 하지 않는다 (기록 영구 손실 방지).
 */

const ACCESS_PERMS = ['none', 'read', 'write'];

/** 사용자·역할·정책·열쇠를 한 번에 읽어 원하는 상태를 계산한다 */
function accessModel_() {
  const users = readAll_(SHEETS.USERS);
  const adminNames = adminUsernames_();
  const byId = {}, isAdmin = {};
  users.forEach(function (u) {
    const id = String(u.user_id);
    byId[id] = u;
    if (!isManaged_(u) && adminNames.indexOf(String(u.username)) !== -1) isAdmin[id] = true;
  });

  const desired = {};
  readAll_(SHEETS.POLICY).forEach(function (p) {
    const o = String(p.owner_id), v = String(p.viewer_id), perm = String(p.perm);
    if (!byId[o] || !byId[v] || o === v || isManaged_(byId[v]) || SHARE_PERMS.indexOf(perm) === -1) return;
    desired[o + '|' + v] = { ownerId: o, viewerId: v, perm: perm, source: 'policy' };
  });
  Object.keys(isAdmin).forEach(function (a) {
    users.forEach(function (u) {
      const o = String(u.user_id);
      if (o !== a) desired[o + '|' + a] = { ownerId: o, viewerId: a, perm: 'write', source: 'role' };
    });
  });
  return { users: users, byId: byId, isAdmin: isAdmin, desired: desired, shares: readAll_(SHEETS.SHARES) };
}

/** userId 가 ownerId 의 데이터키를 가지고 있는가 (본인이거나 열쇠를 받은 사람) */
function holdsKey_(m, ownerId, userId, shares) {
  if (ownerId === userId && m.byId[ownerId] && !isManaged_(m.byId[ownerId])) return true;
  return (shares || m.shares).some(function (r) { return String(r.owner_id) === ownerId && String(r.guardian_id) === userId; });
}

/**
 * 열쇠를 정책에 맞춘다. 반드시 withLock_ 안에서 호출.
 * 반환: { model, kept(남은 열쇠), pending(발급 대기 목록), removed, changed }
 */
function reconcileAccess_(actorId) {
  const m = accessModel_();
  const seen = {}, keep = [], drop = [];
  m.shares.forEach(function (r) {
    const k = String(r.owner_id) + '|' + String(r.guardian_id);
    if (m.desired[k] && !seen[k]) { seen[k] = true; keep.push(r); } else drop.push(r);
  });

  // 대신 관리하는 구성원: 남는 열쇠가 없으면 삭제하지 않는다
  const rescued = drop.filter(function (r) {
    const o = String(r.owner_id);
    return m.byId[o] && isManaged_(m.byId[o]) && !keep.some(function (x) { return String(x.owner_id) === o; });
  });
  rescued.forEach(function (r) { keep.push(r); });
  const removeRows = drop.filter(function (r) { return rescued.indexOf(r) === -1; });

  let changed = 0;
  keep.forEach(function (r) {
    const d = m.desired[String(r.owner_id) + '|' + String(r.guardian_id)];
    if (d && String(r.perm) !== d.perm) { updateRow_(SHEETS.SHARES, r._row, { perm: d.perm }); r.perm = d.perm; changed++; }
  });
  if (removeRows.length) deleteRows_(SHEETS.SHARES, removeRows.map(function (r) { return r._row; }));
  if (removeRows.length || changed) {
    audit_(actorId, 'access_reconcile', '해제 ' + removeRows.length + ' / 변경 ' + changed);
  }

  const pending = Object.keys(m.desired)
    .filter(function (k) { return !seen[k]; })
    .map(function (k) { return m.desired[k]; });
  return { model: m, kept: keep, pending: pending, removed: removeRows.length, changed: changed };
}

/** 각 권한 쌍의 상태 (콘솔 표시용) */
function accessStatus_(m, kept, pending) {
  const list = [];
  kept.forEach(function (r) {
    const k = String(r.owner_id) + '|' + String(r.guardian_id), d = m.desired[k];
    list.push({
      ownerId: String(r.owner_id), viewerId: String(r.guardian_id), perm: String(r.perm),
      source: d ? d.source : 'orphan', state: d ? 'active' : 'orphan'
    });
  });
  pending.forEach(function (p) {
    const viewer = m.byId[p.viewerId];
    const canIssue = m.users.some(function (u) { return holdsKey_(m, p.ownerId, String(u.user_id), kept); });
    list.push({
      ownerId: p.ownerId, viewerId: p.viewerId, perm: p.perm, source: p.source,
      state: !viewer.public_key ? 'wait_viewer'
        : (!isManaged_(m.byId[p.ownerId]) && !m.byId[p.ownerId].public_key) ? 'wait_owner'
        : (canIssue ? 'wait_holder' : 'no_holder')
    });
  });
  return list;
}

/**
 * 로그인 직후·콘솔 조작 후 브라우저가 호출: 정책을 맞추고, 내가 발급해 줄 수 있는 열쇠 목록을 돌려준다.
 */
function api_syncAccess(token) {
  const s = requireSession_(token);
  return withLock_(function () {
    const r = reconcileAccess_(s.userId);
    const tasks = r.pending.filter(function (p) {
      const viewer = r.model.byId[p.viewerId];
      return viewer.public_key && holdsKey_(r.model, p.ownerId, s.userId, r.kept);
    }).map(function (p) {
      return { ownerId: p.ownerId, viewerId: p.viewerId, perm: p.perm, publicKey: String(r.model.byId[p.viewerId].public_key) };
    });
    return { tasks: tasks, pending: r.pending.length, removed: r.removed, changed: r.changed };
  });
}

/** 브라우저가 암호화한 열쇠를 등록. 정책에 있는 것만, 키를 가진 사람만 발급할 수 있다. */
function api_fulfillAccess(token, items) {
  const s = requireSession_(token);
  if (!Array.isArray(items) || items.length > 500) throw new Error('잘못된 요청입니다.');
  return withLock_(function () {
    const m = accessModel_();
    let added = 0;
    items.forEach(function (it) {
      const o = String(it.ownerId), v = String(it.viewerId), d = m.desired[o + '|' + v];
      assertB64_(it.encDek, 'encDek');
      if (!d) throw new Error('정책에 없는 권한입니다.');
      if (!holdsKey_(m, o, s.userId)) throw new Error('이 기록의 열쇠를 발급할 권한이 없습니다.');
      if (m.shares.some(function (r) { return String(r.owner_id) === o && String(r.guardian_id) === v; })) return; // 이미 있음
      const row = {
        share_id: newId_('s'), owner_id: o, guardian_id: v, enc_dek: it.encDek, perm: d.perm, created_at: nowIso_()
      };
      appendRow_(SHEETS.SHARES, row);
      m.shares.push(row);
      added++;
    });
    if (added) audit_(s.userId, 'access_grant', added + '건');
    return { added: added };
  });
}

/** 구성원 간 정책 쓰기 (perm: none/read/write). 호출하는 쪽에서 권한 확인과 withLock_ 을 한다. */
function writePolicy_(actorId, ownerId, viewerId, perm) {
  if (ACCESS_PERMS.indexOf(perm) === -1) throw new Error('잘못된 권한입니다.');
  const rows = readAll_(SHEETS.POLICY).filter(function (p) {
    return String(p.owner_id) === ownerId && String(p.viewer_id) === viewerId;
  });
  if (perm === 'none') {
    if (rows.length) deleteRows_(SHEETS.POLICY, rows.map(function (r) { return r._row; }));
  } else if (rows.length) {
    updateRow_(SHEETS.POLICY, rows[0]._row, { perm: perm, updated_at: nowIso_(), updated_by: actorId });
    if (rows.length > 1) deleteRows_(SHEETS.POLICY, rows.slice(1).map(function (r) { return r._row; }));
  } else {
    appendRow_(SHEETS.POLICY, { owner_id: ownerId, viewer_id: viewerId, perm: perm, updated_at: nowIso_(), updated_by: actorId });
  }
  audit_(actorId, 'policy_set', ownerId + ' -> ' + viewerId + ' ' + perm);
}

/**
 * 이전 버전(열쇠만 있던 시절)의 구성원 간 공유를 정책으로 옮긴다 — 업그레이드 시 1회.
 * 관리자 열쇠는 역할에서 나오므로 옮기지 않는다.
 */
function migrateSharesToPolicy_() {
  if (readAll_(SHEETS.POLICY).length) return;
  const adminNames = adminUsernames_();
  const users = {};
  readAll_(SHEETS.USERS).forEach(function (u) { users[String(u.user_id)] = u; });
  readAll_(SHEETS.SHARES).forEach(function (r) {
    const g = users[String(r.guardian_id)];
    if (!g || adminNames.indexOf(String(g.username)) !== -1) return;
    appendRow_(SHEETS.POLICY, {
      owner_id: String(r.owner_id), viewer_id: String(r.guardian_id), perm: String(r.perm),
      updated_at: nowIso_(), updated_by: 'migration'
    });
  });
}
