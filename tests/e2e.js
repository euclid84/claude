// 두 사람(사위, 장모님)을 실제 브라우저 화면으로 움직여 보호자 공유 전체 흐름을 검증한다.
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

  // 1) 사위 가입 + 본인 기록 1건
  const me = await newUserPage(browser);
  await signupAndLogin(me, 'sawi', 'sawi-pass-123');
  await addManualRecord(me, '사위 본인 기록');
  check(await me.evaluate(() => S.records.length === 1), '사위: 본인 기록 1건 저장');

  // 2) 장모님 가입 + 기록 1건
  const mom = await newUserPage(browser);
  await signupAndLogin(mom, '장모님', 'mom-pass-456');
  await addManualRecord(mom, '장모님 혈액검사');
  check(await mom.evaluate(() => S.records.length === 1 && S.records[0].data.title === '장모님 혈액검사'), '장모님: 본인 기록 1건 저장');

  // 3) 장모님이 사위를 보호자(보기만)로 추가
  await mom.click('#settings'); await waitIdle(mom);
  await mom.click('#guard'); await waitIdle(mom);
  await mom.fill('#gname', 'sawi');
  await mom.click('#addG'); await mom.waitForSelector('[data-a="yes"]'); await mom.click('[data-a="yes"]'); await waitIdle(mom);
  await mom.screenshot({ path: OUT + '/guardians_mom.png' });
  check(gas.sheets.Shares._rows.length === 2, 'Shares 시트에 공유 1건 저장');
  const shareCell = gas.sheets.Shares._rows[1][3];
  check(typeof shareCell === 'string' && shareCell.length > 300, 'Shares에 저장된 데이터키는 암호문(평문 아님)');

  // 4) 사위 다시 로그인 → 장모님 기록 보기
  await me.reload(); await login(me, 'sawi', 'sawi-pass-123');
  check(await me.evaluate(() => S.people.length === 2), '사위: 가족 목록에 장모님 표시');
  await me.click('.chip[data-p="1"]'); await waitIdle(me);
  check(await me.evaluate(() => S.records.length === 1 && S.records[0].data.title === '장모님 혈액검사'), '사위: 장모님 기록 복호화해서 보기');
  check(!(await me.$('#add')), '사위: 보기 전용이라 등록 버튼 없음');
  await me.screenshot({ path: OUT + '/sawi_views_mom.png' });

  // 5) 사위가 장모님 기록으로 AI 질문 → 보호자 모드 + 질문은 사위에게만 보임
  const momRecordId = await me.evaluate(() => S.records[0].recordId);
  await me.click('.card[data-id]'); await waitIdle(me);
  await me.click('#ask'); await waitIdle(me);
  await me.fill('#q', '장모님 결과 괜찮나요?'); await me.click('#send'); await waitIdle(me);
  check(await me.evaluate(() => document.body.innerText.includes('보호자 모드=true')), '사위 질문 시 AI에 "보호자가 묻는 중" 전달');
  const momSees = await mom.evaluate(id => new Promise(res => google.script.run.withSuccessHandler(res).withFailureHandler(e => res('ERR ' + e.message)).api_listChats(S.token, id, null)), momRecordId);
  check(Array.isArray(momSees) && momSees.length === 0, '장모님에게는 사위의 질문이 보이지 않음');

  // 6) 권한 검사 (서버를 직접 호출해서 우회 시도)
  const momId = await mom.evaluate(() => S.me.userId);
  const meId = await me.evaluate(() => S.me.userId);
  const tryCall = (page, fn, args) => page.evaluate(([fn, args]) => new Promise(res => {
    const r = google.script.run.withSuccessHandler(v => res({ ok: v })).withFailureHandler(e => res({ err: e.message }));
    r[fn].apply(r, args);
  }), [fn, args]);
  const w = await tryCall(me, 'api_deleteRecord', [await me.evaluate(() => S.token), momRecordId, momId]);
  check(w.err && w.err.includes('보기 권한만'), '사위(보기 전용)가 장모님 기록 삭제 시도 → 거부: ' + w.err);
  const r2 = await tryCall(mom, 'api_listRecords', [await mom.evaluate(() => S.token), meId]);
  check(r2.err && r2.err.includes('권한이 없습니다'), '장모님이 사위 기록 열람 시도 → 거부: ' + r2.err);
  check(await mom.evaluate(() => S.people.length === 1), '장모님 화면에는 사위 기록 선택지가 없음');

  // 7) 장모님이 권한을 "보기 + 등록"으로 바꾸면 사위가 대신 등록 가능
  await mom.click('#back'); await waitIdle(mom); await mom.click('#guard'); await waitIdle(mom);
  await mom.fill('#gname', 'sawi'); await mom.check('input[name="perm"][value="write"]');
  await mom.click('#addG'); await mom.waitForSelector('[data-a="yes"]'); await mom.click('[data-a="yes"]'); await waitIdle(mom);
  await me.reload(); await login(me, 'sawi', 'sawi-pass-123');
  await me.click('.chip[data-p="1"]'); await waitIdle(me);
  await addManualRecord(me, '사위가 대신 등록한 기록');
  await mom.reload(); await login(mom, '장모님', 'mom-pass-456');
  check(await mom.evaluate(() => S.records.some(r => r.data.title === '사위가 대신 등록한 기록')), '사위가 대신 등록한 기록이 장모님 계정에 보임');

  // 8) 시트에는 평문이 없는지
  const allText = JSON.stringify(gas.sheets);
  check(!allText.includes('장모님 혈액검사') && !allText.includes('사위 본인 기록'), '시트 어디에도 기록 제목(평문)이 없음');

  // 9) 공유 해제 후 사위는 못 봄
  await mom.click('#settings'); await waitIdle(mom); await mom.click('#guard'); await waitIdle(mom);
  await mom.click('[data-rm]'); await mom.waitForSelector('[data-a="yes"]'); await mom.click('[data-a="yes"]'); await waitIdle(mom);
  const r3 = await tryCall(me, 'api_listRecords', [await me.evaluate(() => S.token), momId]);
  check(r3.err && r3.err.includes('권한이 없습니다'), '공유 해제 후 사위 열람 거부');

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
