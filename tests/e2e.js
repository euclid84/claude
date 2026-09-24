// 관리자(나)와 가족(어머니·아내·아빠)을 실제 브라우저 화면으로 움직여 가족 공유 전체 흐름을 검증한다.
// 실행: ./scripts/build.sh && cd tests && npm install && npm test
//   (Chromium 경로는 CHROMIUM_PATH 환경변수로 바꿀 수 있다)
const { chromium } = require('playwright-core');
const fs = require('fs');
const { createGas } = require('./fakegas');

const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'dist', 'Index.html'), 'utf8');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const gas = createGas({
  geminiReply: body => body.systemInstruction
    ? '(가짜 AI 답변) 보호자 모드=' + /보호자\)이 하고 있습니다/.test(body.systemInstruction.parts[0].text)
    : JSON.stringify({ records: [] })
});
gas.ctx.setup();
gas.props.GEMINI_API_KEY = 'test-key';
const invite = gas.ctx.getConfig_('INVITE_CODE');

let failures = 0;
function check(cond, msg) { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; }

const mock = `
function makeRunner(){ let ok=function(){}, fail=function(){};
  const r = new Proxy({}, { get(_, p){
    if (p==='withSuccessHandler') return f=>{ok=f;return r};
    if (p==='withFailureHandler') return f=>{fail=f;return r};
    return (...a)=>{ window.__gas(p, JSON.stringify(a)).then(res => { const o = JSON.parse(res); if (o.error) fail(new Error(o.error)); else ok(o.value); }); };
  }}); return r; }
window.google = { script: {} };
Object.defineProperty(window.google.script, 'run', { get: makeRunner });`;

async function newUserPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.exposeFunction('__gas', (fn, argsJson) => {
    try {
      const v = gas.ctx[fn].apply(null, JSON.parse(argsJson));
      return JSON.stringify({ value: v === undefined ? null : v });
    } catch (e) { return JSON.stringify({ error: e.message }); }
  });
  await ctx.addInitScript(mock);
  await ctx.route('https://app.local/**', r => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('PAGE ERROR', e.message); failures++; });
  await page.goto('https://app.local/');
  return page;
}

async function waitIdle(page) {
  await page.waitForFunction(() => !document.getElementById('loading').classList.contains('on'), null, { timeout: 60000 });
  await page.waitForTimeout(150);
}
async function signupAndLogin(page, user, pw) {
  await page.click('#toSignup'); await waitIdle(page);
  await page.fill('#inv', invite); await page.fill('#u', user); await page.fill('#p', pw); await page.fill('#p2', pw);
  await page.click('#go'); await waitIdle(page);
  await page.check('#ok'); await page.click('#go');
  await login(page, user, pw);
}
async function login(page, user, pw) {
  await page.fill('#u', user); await page.fill('#p', pw); await page.click('#login'); await waitIdle(page);
  if (await page.$('#skip')) { await page.click('#skip'); await waitIdle(page); }
}
async function addManualRecord(page, title) {
  await page.click('#add'); await waitIdle(page);
  await page.click('#manual'); await waitIdle(page);
  await page.fill('[data-bind="title"]', title);
  await page.click('#save'); await waitIdle(page);
  await page.click('#back'); await waitIdle(page);
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const tryCall = (page, fn, args) => page.evaluate(([fn, args]) => new Promise(res => {
    const r = google.script.run.withSuccessHandler(v => res({ ok: v })).withFailureHandler(e => res({ err: e.message }));
    r[fn].apply(r, args);
  }), [fn, args]);
  const listAs = (page, recordId, ownerId) => page.evaluate(([id, o]) => new Promise(res =>
    google.script.run.withSuccessHandler(res).withFailureHandler(e => res('ERR ' + e.message)).api_listChats(S.token, id, o)), [recordId, ownerId]);
  const tok = page => page.evaluate(() => S.token);
  const uid = page => page.evaluate(() => S.me.userId);

  // 1) 관리자(나) 첫 가입 → 자동으로 관리자
  const me = await newUserPage(browser);
  await signupAndLogin(me, 'admin', 'admin-pass-123');
  check(gas.ctx.getConfig_('ADMIN_USERNAMES') === 'admin', '첫 가입자가 관리자로 지정됨');
  check(await me.evaluate(() => S.me.isAdmin === true), '관리자 로그인 시 관리자 표시');
  await addManualRecord(me, '내 간기능 검사');

  // 2) 어머니 가입 → 가입 화면에 관리자 안내 → 로그인하면 관리자에게 자동 연결
  const mom = await newUserPage(browser);
  await mom.click('#toSignup'); await waitIdle(mom);
  check(await mom.evaluate(() => document.body.innerText.includes('관리자(admin)')), '가입 화면에 "관리자가 함께 본다" 안내');
  await mom.click('#back'); await waitIdle(mom);
  await signupAndLogin(mom, '어머니', 'mom-pass-456');
  await addManualRecord(mom, '어머니 혈액검사');
  const momId = await uid(mom), meId = await uid(me);
  const shareRow = gas.sheets.Shares._rows.find(r => r[1] === momId && r[2] === meId);
  check(!!shareRow && shareRow[4] === 'write', '어머니 로그인 시 관리자에게 자동 연결 (등록·수정 권한)');
  check(typeof shareRow[3] === 'string' && shareRow[3].length > 300, '연결에 쓰인 데이터키는 암호문');
  check(await mom.evaluate(() => S.people.length === 1), '어머니 화면에는 다른 가족 선택지가 없음');
  await mom.click('#settings'); await waitIdle(mom); await mom.click('#guard'); await waitIdle(mom);
  check(await mom.evaluate(() => document.body.innerText.includes('👑 admin') && !document.querySelector('[data-rm]')), '어머니: 관리자 연결은 해제 버튼 없음');
  await mom.screenshot({ path: OUT + '/member_sharing.png' });
  const rmTry = await tryCall(mom, 'api_removeShare', [await tok(mom), shareRow[0]]);
  check(rmTry.err && rmTry.err.includes('관리자와의 연결'), '어머니가 관리자 연결 해제 시도 → 거부');
  const peek = await tryCall(mom, 'api_listRecords', [await tok(mom), meId]);
  check(peek.err && peek.err.includes('권한이 없습니다'), '어머니가 관리자 기록 열람 시도 → 거부');

  // 3) 아내 가입 → 관리자 연결, 어머니 기록은 못 봄
  const wife = await newUserPage(browser);
  await signupAndLogin(wife, 'wife', 'wife-pass-789');
  check(await wife.evaluate(() => S.people.length === 1), '아내 화면에는 어머니 기록이 없음 (가족끼리는 서로 안 보임)');
  const wifePeek = await tryCall(wife, 'api_listRecords', [await tok(wife), momId]);
  check(wifePeek.err && wifePeek.err.includes('권한이 없습니다'), '아내가 어머니 기록 열람 시도 → 거부');

  // 4) 관리자 다시 로그인 → 가족 전체 보기
  await me.reload(); await login(me, 'admin', 'admin-pass-123');
  check(await me.evaluate(() => S.people.map(p => p.username).sort().join(',') === ['admin', 'wife', '어머니'].sort().join(',')), '관리자: 나 + 어머니 + 아내 모두 보임');
  await me.click('#settings'); await waitIdle(me); await me.click('#guard'); await waitIdle(me);
  await me.click('#overview'); await waitIdle(me);
  check(await me.evaluate(() => document.body.innerText.includes('어머니') && document.body.innerText.includes('기록 1건')), '가족 한눈에 보기: 어머니 기록 1건 표시');
  await me.screenshot({ path: OUT + '/admin_overview.png' });
  await me.click('[data-who="' + (await me.evaluate(() => S.people.findIndex(p => p.username === '어머니'))) + '"]'); await waitIdle(me);
  check(await me.evaluate(() => S.viewName === '어머니' && S.records[0].data.title === '어머니 혈액검사'), '한눈에 보기에서 어머니 선택 → 어머니 기록 화면');
  await me.screenshot({ path: OUT + '/admin_views_mom.png' });
  await addManualRecord(me, '관리자가 대신 올린 어머니 기록');
  check(await me.evaluate(() => S.records.length === 2), '관리자가 어머니 기록 대신 등록');

  // 5) 상담: 어머니 질문 → 관리자가 봄 / 관리자 질문 → 보내기 전엔 어머니에게 안 보임 → 보내기
  const momRecordId = await mom.evaluate(() => S.records[0].recordId);
  await mom.click('#back'); await waitIdle(mom); await mom.click('#back'); await waitIdle(mom);
  await mom.click('.card[data-id]'); await waitIdle(mom); await mom.click('#ask'); await waitIdle(mom);
  await mom.fill('#q', '제가 물어봐요'); await mom.click('#send'); await waitIdle(mom);
  check(await mom.evaluate(() => document.body.innerText.includes('보호자 모드=false')), '어머니 본인 질문은 가족 대신 묻는 모드 아님');
  await me.evaluate(id => viewDetail(id), momRecordId); await waitIdle(me);
  await me.click('#ask'); await waitIdle(me);
  await me.fill('#q', '어머니 결과 괜찮나요?'); await me.click('#send'); await waitIdle(me);
  check(await me.evaluate(() => document.body.innerText.includes('보호자 모드=true')), '관리자 질문 시 AI에 "가족이 대신 묻는 중" 전달');
  check((await listAs(mom, momRecordId, null)).filter(m => !m.fromOwner).length === 0, '보내기 전: 어머니에게 관리자 질문 안 보임');
  await me.click('.chip[data-tab="owner"]'); await waitIdle(me);
  check(await me.evaluate(() => document.body.innerText.includes('제가 물어봐요')), '관리자: 어머니 상담 탭에서 어머니 질문 보기');
  await me.click('.chip[data-tab="team"]'); await waitIdle(me);
  await me.click('[data-share]'); await me.waitForSelector('[data-a="yes"]'); await me.click('[data-a="yes"]'); await waitIdle(me);
  await me.screenshot({ path: OUT + '/admin_shared.png' });
  check((await listAs(mom, momRecordId, null)).filter(m => !m.fromOwner && m.shared).length === 2, '보낸 뒤: 어머니가 질문·답변을 받음');
  await mom.reload(); await login(mom, '어머니', 'mom-pass-456');
  check(!!(await mom.$('#notes')), '어머니 홈에 "가족이 보내준 설명" 카드');
  await mom.screenshot({ path: OUT + '/member_home_notes.png' });
  await mom.click('.card[data-id="' + momRecordId + '"]'); await waitIdle(mom); await mom.click('#ask'); await waitIdle(mom);
  check(await mom.evaluate(() => document.body.innerText.includes('admin님이 보내준 답변')), '어머니 상담 화면에 보내준 답변 표시');
  await mom.screenshot({ path: OUT + '/member_chat_shared.png' });
  await mom.click('#clear'); await mom.waitForSelector('[data-a="yes"]'); await mom.click('[data-a="yes"]'); await waitIdle(mom);
  check((await listAs(mom, momRecordId, null)).filter(m => m.fromOwner).length === 0, '어머니 상담 지우기 → 본인 상담만 삭제');
  await me.click('[data-unshare]'); await waitIdle(me);
  check((await listAs(mom, momRecordId, null)).length === 0, '보내기 취소 → 어머니 화면에서 사라짐');
  check((await listAs(me, momRecordId, momId)).length === 2, '관리자 상담은 그대로 남음');

  // 6) 대신 관리하는 가족 프로필 (아빠) → 아내와 함께 보기 → 본인 계정으로 넘겨주기
  await me.reload(); await login(me, 'admin', 'admin-pass-123');
  await me.click('#settings'); await waitIdle(me); await me.click('#guard'); await waitIdle(me);
  await me.screenshot({ path: OUT + '/admin_family.png' });
  await me.fill('#pname', '아빠'); await me.click('#addP'); await waitIdle(me);
  check(await me.evaluate(() => S.viewName === '아빠' && S.managed === true && canWrite()), '가족 프로필 "아빠" 생성 후 아빠 화면');
  await me.screenshot({ path: OUT + '/dad_home.png' });
  await addManualRecord(me, '아빠 건강검진');
  const dadId = await me.evaluate(() => S.ownerId);
  const dadUsername = gas.sheets.Users._rows.find(r => r[0] === dadId)[1];
  check(!!(await tryCall(mom, 'api_login', [dadUsername, 'AAAA'])).err, '관리 프로필은 로그인할 수 없음');
  await me.click('#settings'); await waitIdle(me); await me.click('#guard'); await waitIdle(me);
  await me.click('[data-manage]'); await waitIdle(me);
  await me.fill('#gname', 'wife');
  await me.click('#addG'); await me.waitForSelector('[data-a="yes"]'); await me.click('[data-a="yes"]'); await waitIdle(me);
  await wife.reload(); await login(wife, 'wife', 'wife-pass-789');
  check(await wife.evaluate(() => S.people.some(p => p.username === '아빠') && !S.people.some(p => p.username === '어머니')), '아내: 아빠 프로필만 추가로 보임 (어머니는 여전히 안 보임)');
  await me.fill('#cu', 'dad'); await me.fill('#cp', 'dad-pass-000'); await me.fill('#cp2', 'dad-pass-000');
  await me.click('#claim'); await me.waitForSelector('[data-a="yes"]'); await me.click('[data-a="yes"]'); await waitIdle(me);
  check(await me.evaluate(() => /[A-Z0-9]{4}-/.test(document.querySelector('.code').textContent)), '넘겨주기 후 복구코드 표시');
  const dad = await newUserPage(browser);
  await login(dad, 'dad', 'dad-pass-000');
  check(await dad.evaluate(() => S.records.length === 1 && S.records[0].data.title === '아빠 건강검진'), '아빠: 본인 아이디로 로그인해서 기존 기록 보기');
  check(await dad.evaluate(() => S.people.length === 1), '아빠 화면에는 다른 가족이 안 보임');

  // 7) 시트에는 평문이 없음
  const allText = JSON.stringify(gas.sheets);
  check(!allText.includes('어머니 혈액검사') && !allText.includes('내 간기능 검사') && !allText.includes('아빠 건강검진'), '시트 어디에도 기록 제목(평문)이 없음');

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
