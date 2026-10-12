'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{pathToFileURL}=require('node:url'),path=require('node:path');
const locales=Object.fromEntries(['ko','en','zh-Hans','ja'].map(code=>[code,require('../locales/'+code+'.json')]));
const url=pathToFileURL(path.resolve(__dirname,'../index.html')).href+'?test=1';let browser;
before(async()=>{browser=await chromium.launch({headless:true,args:['--mute-audio'],...(process.env.INK_LASSO_BROWSER_PATH?{executablePath:process.env.INK_LASSO_BROWSER_PATH}:{})})});
after(async()=>{await browser.close()});
// Language is chosen on Home or in the pause menu; start=false stays on Home.
async function open(t,options={},start=true){const p=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce',...options});const errors=[];p.on('pageerror',e=>errors.push(e.message));t.after(async()=>{await p.close();assert.deepEqual(errors,[])});await p.clock.install();await p.goto(url);await p.clock.runFor(40);if(start)await p.locator('[data-action="home-start"]').click();return p;}
test('four native language choices translate the tutorial and HUD without changing the world',async t=>{
 const p=await open(t,{},false);let before;
 assert.deepEqual(await p.locator('#language option').allTextContents(),['한국어','English','简体中文','日本語']);
 for(const [code,m] of Object.entries(locales)){
  await p.getByRole('combobox').selectOption(code);await p.clock.runFor(40);
  assert.equal(await p.locator('html').getAttribute('lang'),code);
  await p.locator('[data-action="home-start"]').click();
  before??=await p.evaluate(()=>inkfill.state());
  assert.equal(await p.locator('#panel-title').innerText(),m['intro.first.title']);
  assert.equal(await p.locator('#stage-num').getAttribute('title'),m['stage.first-line']);
  assert.equal(await p.locator('#cov-target').innerText(),m['hud.target'].replace('{target}','58'));
  assert.deepEqual(await p.evaluate(()=>inkfill.state()),before,'every language starts the same stage, hearts, shots and physics');
  await p.getByRole('button',{name:m['ui.next'],exact:true}).click();
  assert.equal(await p.getByText(m['intro.first.1'],{exact:true}).isVisible(),true);
  await p.getByRole('button',{name:m['ui.previous'],exact:true}).click();
  if(code!=='ko'){
   assert.doesNotMatch(await p.locator('#panel').evaluate(panel=>panel.textContent+[...panel.querySelectorAll('[aria-label]')].map(n=>n.ariaLabel).join(' ')),/[가-힣]/,'no untranslated Korean in the tutorial');
   assert.doesNotMatch(await p.locator('#board').getAttribute('aria-label'),/[가-힣]/);
  }
  await p.reload();await p.clock.runFor(40);
 }
 // The language selector participates in the Home keyboard loop.
 await p.locator('[data-action="home-start"]').focus();await p.keyboard.press('Tab');await p.keyboard.press('Tab');assert.equal(await p.locator('[data-action="settings"]').evaluate(e=>e===document.activeElement),true);
 await p.keyboard.press('Tab');assert.equal(await p.getByRole('combobox').evaluate(e=>e===document.activeElement),true);
});
test('locale choice survives reload and preserves records; unsupported and unavailable storage are safe',async t=>{
 const p=await open(t,{},false);const records=JSON.stringify({'first-blade':2});
 await p.evaluate(records=>localStorage.setItem('inkfill.stars.v7',records),records);await p.reload();await p.clock.runFor(40);
 const stage=await p.evaluate(()=>inkfill.state().stage.id);
 await p.getByRole('combobox').selectOption('en');await p.reload();await p.clock.runFor(40);
 assert.equal(await p.locator('html').getAttribute('lang'),'en');assert.equal(await p.evaluate(()=>inkfill.state().stage.id),stage);
 assert.equal(await p.evaluate(()=>localStorage.getItem('inkfill.stars.v7')),records);
 await p.evaluate(()=>localStorage.setItem('inkfill.locale.v1',JSON.stringify('unsupported')));await p.reload();await p.clock.runFor(40);assert.equal(await p.locator('html').getAttribute('lang'),'ko');
 await p.evaluate(()=>Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new Error('denied')}}));
 await p.getByRole('combobox').selectOption('ja');assert.equal(await p.locator('html').getAttribute('lang'),'ja');
 await p.locator('[data-action="home-start"]').click();await p.getByRole('button',{name:locales.ja['ui.start'],exact:true}).click();assert.equal((await p.evaluate(()=>inkfill.state())).panel,null);
});
test('localized modals fit narrow screens and render accessible pause, stages and outcome text',async t=>{
 const p=await open(t,{viewport:{width:390,height:844}});
 for(const [code,m]of Object.entries(locales)){
  await p.evaluate(()=>{inkfill.load('first-line');inkfill.start();});await p.locator('#menu').click();await p.getByRole('combobox').selectOption(code);await p.keyboard.press('Escape');
  for(const id of ['first-line','stored-guard','lasting-frost','first-erase']){
   await p.evaluate(id=>inkfill.load(id),id);await p.clock.runFor(40);
   assert.ok(await p.locator('#panel').evaluate(e=>e.scrollWidth<=e.clientWidth+1),'modal has no horizontal overflow '+code+'/'+id);
   assert.ok(await p.locator('#panel').evaluate(e=>e.scrollHeight<=e.clientHeight+1),'single visual lesson fits portrait '+code+'/'+id);
  }
  await p.getByRole('button',{name:m['ui.start'],exact:true}).click();await p.getByRole('button',{name:m['ui.menu'],exact:true}).click();
  assert.equal(await p.getByRole('combobox').inputValue(),code);assert.equal(await p.locator('#panel-title').innerText(),m['ui.pause']);
  await p.getByRole('combobox').focus();await p.keyboard.press('Escape');assert.equal((await p.evaluate(()=>inkfill.state())).panel,null,'Escape resumes from focused language control');
  await p.getByRole('button',{name:m['ui.menu'],exact:true}).click();
  await p.getByRole('button',{name:m['ui.stages'],exact:true}).click();
  assert.equal(await p.locator('#panel-title').innerText(),m['ui.stages']);
  const savedStars=await p.evaluate(()=>JSON.parse(localStorage.getItem('inkfill.stars.v7')||'{}')['first-line']||0);
  const firstLabel=m['aria.openStage'].replace('{number}','1').replace('{name}',m['stage.first-line']).replace('{count}',String(savedStars));
  assert.equal(await p.getByRole('button',{name:firstLabel,exact:true}).isEnabled(),true);
  await p.getByRole('button',{name:firstLabel,exact:true}).click();await p.getByRole('button',{name:m['ui.start'],exact:true}).click();
  const actions=require('./campaign-certificate.json').stages['first-line'].routes[0].actions;
  await p.evaluate(actions=>{for(const action of actions){const s=inkfill.state();inkfill.shoot(Math.atan2(action.y-s.ball.y,action.x-s.ball.x),action.power);inkfill.settle();}},actions);
  await p.clock.runFor(1400);assert.equal((await p.evaluate(()=>inkfill.state())).result,'win');
  assert.equal(await p.locator('#panel-title').innerText(),m['ui.win']);
  assert.equal(await p.getByRole('img',{name:m['ui.stars'].replace('{count}','3'),exact:true}).isVisible(),true);

 }
});
test('tutorial animation can pause and resume without playing the world',async t=>{
 const p=await open(t,{reducedMotion:'no-preference'});const initial=await p.evaluate(()=>inkfill.state());
 await p.getByRole('button',{name:locales.ko['ui.tutorialPause'],exact:true}).click();await p.clock.runFor(50);
 const paused=await p.locator('[data-diagram]').evaluate(c=>c.toDataURL());await p.clock.runFor(1800);
 assert.equal(await p.locator('[data-diagram]').evaluate(c=>c.toDataURL()),paused,'paused diagram stays at a readable outcome');
 await p.getByRole('button',{name:locales.ko['ui.next'],exact:true}).click();
 assert.equal(await p.getByRole('button',{name:locales.ko['ui.tutorialPlay'],exact:true}).getAttribute('aria-pressed'),'true','the pause carries to the next lesson');
 await p.getByRole('button',{name:locales.ko['ui.previous'],exact:true}).click();
 await p.getByRole('button',{name:locales.ko['ui.tutorialPlay'],exact:true}).click();await p.clock.runFor(400);
 assert.notEqual(await p.locator('[data-diagram]').evaluate(c=>c.toDataURL()),paused);
 assert.deepEqual(await p.evaluate(()=>inkfill.state()),initial,'presentation does not advance the game');
});
