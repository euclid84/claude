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
