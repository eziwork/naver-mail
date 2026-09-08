import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {SetupServer} from '../dist/setup-session.js';
import {UserFacingError} from '../dist/errors.js';
const browser=await chromium.launch({headless:true});
let release;
const gate=new Promise(r=>{release=r;});
let writes=0, calls=0;
const setup=new SetupServer({save:async()=>{writes++;}}, {openBrowser:async()=>false,verify:async(_c,p)=>{calls++;p('imap');await gate;p('smtp');},completionGraceMs:60000});
try {
  const {url}=await setup.open();
  const page=await browser.newPage({viewport:{width:1100,height:1000}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);await page.getByRole('button',{name:'이미 준비했어요 · 바로 입력'}).click();
  assert.equal(await page.getByRole('link',{name:/네이버 보안설정 열기 — 앱 비밀번호/}).getAttribute('target'),'_blank');
  await page.getByLabel('네이버 메일 주소',{exact:true}).fill('fixture');
  await page.getByLabel('애플리케이션 비밀번호',{exact:true}).fill('fixture-only-secret');
  await page.reload();
  await page.getByRole('heading',{name:'앱 전용 비밀번호를 붙여 넣어 주세요'}).waitFor();
  assert.equal(await page.locator('#email').inputValue(),'fixture');assert.equal(await page.locator('#appPassword').inputValue(),'');
  assert.doesNotMatch(await page.evaluate(()=>JSON.stringify({...sessionStorage})),/secret|appPassword/);
  await page.getByLabel('애플리케이션 비밀번호',{exact:true}).fill('fixture-only-secret');
  await page.getByLabel('네이버에서 만든 앱 비밀번호를 입력했어요.').check();
  await page.getByRole('button',{name:'연결 확인하기'}).click();
  await page.reload();await page.getByRole('heading',{name:'연결을 확인하고 있어요'}).waitFor();
  assert.equal(calls,1);release();
  await page.getByRole('heading',{name:'연결되었어요'}).waitFor();assert.equal(writes,1);
  assert.equal(await page.evaluate(()=>sessionStorage.length),0);
  await page.reload();await page.getByRole('heading',{name:'연결되었어요'}).waitFor();
  assert.equal(writes,1);
  assert.deepEqual(errors,[]);
  await page.close();await setup.close();

  const fresh=new SetupServer({save:async()=>{}},{openBrowser:async()=>false});
  try {
    const {url:freshUrl}=await fresh.open();const input=await browser.newPage({viewport:{width:390,height:844}});
    await input.goto(freshUrl);await input.getByRole('button',{name:'이미 준비했어요 · 바로 입력'}).click();
    assert.equal(await input.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await input.setViewportSize({width:640,height:900});await input.evaluate(()=>document.body.style.zoom='2');
    assert.equal(await input.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await fresh.close();await input.getByRole('status').filter({hasText:'끊겼어요'}).waitFor();
    assert.equal(await input.locator('#connect-button').isDisabled(),true);
    await input.close();
  } finally {await fresh.close();}
  for (const phase of ['imap','storage']) {
    const failing=new SetupServer({save:async()=>{throw new UserFacingError('KEYRING_ERROR','보안 저장소 접근을 허용해 주세요.');}},{openBrowser:async()=>false,verify:async(_c,p)=>{p('imap');if(phase==='imap')throw new UserFacingError('AUTH_FAILED','앱 비밀번호를 다시 확인해 주세요.');p('smtp');}});
    const p=await browser.newPage();
    try {
      const opened=await failing.open();await p.goto(opened.url);await p.getByRole('button',{name:'이미 준비했어요 · 바로 입력'}).click();
      await p.locator('#email').fill('fixture');await p.locator('#appPassword').fill('fixture-only-secret');await p.getByLabel('네이버에서 만든 앱 비밀번호를 입력했어요.').check();
      await p.locator('#connect-button').click();await p.locator('#notice').filter({hasText:phase==='imap'?'앱 비밀번호를 다시 확인':'보안 저장소 접근'}).waitFor();
      assert.equal(await p.locator(`[data-check="${phase}"]`).getAttribute('data-state'),'error');
      await p.getByRole('button',{name:'설정 취소'}).click();await p.locator('#server-status').filter({hasText:'취소했어요'}).waitFor();
      assert.equal(await p.evaluate(()=>sessionStorage.length),0);assert.equal(failing.isActive,false);
    } finally {await p.close();await failing.close();}
  }
  const expiring=new SetupServer({save:async()=>{throw Error('must not save');}},{openBrowser:async()=>false,ttlMs:2000});
  const expiredPage=await browser.newPage();
  try {const opened=await expiring.open();await expiredPage.goto(opened.url);await expiredPage.locator('#server-status').filter({hasText:'설정 시간이 끝났어요'}).waitFor();assert.equal(await expiredPage.evaluate(()=>sessionStorage.length),0);}
  finally {await expiredPage.close();await expiring.close();}
  let submits=0;
  const uncertain=new SetupServer({save:async()=>{}},{openBrowser:async()=>false});const uncertainPage=await browser.newPage();
  try {
    const opened=await uncertain.open();await uncertainPage.route('**/api/connect',route=>{submits++;return route.abort('connectionreset');});
    await uncertainPage.goto(opened.url);await uncertainPage.getByRole('button',{name:'이미 준비했어요 · 바로 입력'}).click();
    await uncertainPage.locator('#email').fill('fixture');await uncertainPage.locator('#appPassword').fill('fixture-only-secret');await uncertainPage.getByLabel('네이버에서 만든 앱 비밀번호를 입력했어요.').check();await uncertainPage.locator('#connect-button').click();
    await uncertainPage.locator('#notice').filter({hasText:'자동으로 다시 제출하지 않고'}).waitFor();
    await uncertainPage.locator('#server-status').filter({hasText:'제출 결과 확인 중'}).waitFor();
    assert.equal(submits,1);assert.equal(await uncertainPage.locator('#appPassword').inputValue(),'');assert.equal(await uncertainPage.locator('#connect-button').isDisabled(),true);
  } finally {await uncertainPage.close();await uncertain.close();}
  console.log(JSON.stringify({passed:true,refreshRestoresProgress:true,checkingAndSuccessRefresh:true,passwordNeverStored:true,disconnectDetected:true,authAndKeyringErrors:true,cancelAndExpiryClearProgress:true,uncertainSubmissionNeverReplayed:true,viewports:[390,640,1100],zoom:'200%'}));
} finally {release();await setup.close();await browser.close();}
