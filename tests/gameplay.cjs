'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const gameUrl = pathToFileURL(path.resolve(__dirname, '../index.html')).href;
const hostedGameUrl = 'https://ink-fill.example.test/index.html';
const CS = 4, GW = 240;
let browser;

const CERT = require('./campaign-certificate.json');
const ROUTES = Object.fromEntries(Object.entries(CERT.stages).map(([id,s])=>[id,s.routes[0].actions]));
const STAGE_IDS = require('../tools/campaign.cjs').loadEngine().CAMPAIGN.map(r=>r.id);
require('./campaign.cjs');

before(async () => {
  browser = await chromium.launch({ headless: true, args: ['--mute-audio'],
    ...(process.env.INK_LASSO_BROWSER_PATH ? { executablePath: process.env.INK_LASSO_BROWSER_PATH } : {}) });
});
after(async () => { await browser?.close(); });
async function open(t, { testMode = true, home = false, url = gameUrl, ...options } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await context.close(); assert.deepEqual(errors, [], 'no browser errors'); });
  if(url!==gameUrl)await context.route(url+'*',route=>route.fulfill({contentType:'text/html',path:path.resolve(__dirname,'../index.html')}));
  await page.clock.install();
  await page.goto(url + (testMode ? '?test=1' : ''));
  await page.clock.runFor(34);
  if (!home) await page.locator('[data-action="home-start"]').click();
  return page;
}
const state = page => page.evaluate(() => inkfill.state());
// Stage selection lives in the pause menu.
const openStages = async page => { await page.locator('#menu').click(); await page.getByRole('button', { name: '스테이지', exact: true }).click(); };
const load = (page, scenario) => page.evaluate(s => { inkfill.load(s); inkfill.start(); }, scenario);
const shootAndSettle = (page, angle, power) => page.evaluate(([a, p]) => { const fired = inkfill.shoot(a, p); inkfill.settle(); return fired; }, [angle, power]);
async function playRoute(page,id,actions) {
  return page.evaluate(([id,actions])=>{inkfill.load(id);inkfill.start();for(const action of actions){const s=inkfill.state();if(s.result)break;inkfill.shoot(Math.atan2(action.y-s.ball.y,action.x-s.ball.x),action.power);inkfill.settle();}return inkfill.state();},[id,actions]);
}

test('campaign public drag follows a forgiving three-star route', {timeout:45000}, async t=>{
  const page=await open(t);await load(page,'first-line');
  for(const action of ROUTES['first-line']) {
    const s=await state(page);if(s.result)break;
    const angle=Math.atan2(action.y-s.ball.y,action.x-s.ball.x);
    await drag(page,[480,320],[480-Math.cos(angle)*230*action.power,320-Math.sin(angle)*230*action.power]);
    await page.evaluate(()=>inkfill.settle());
  }
  assert.equal((await state(page)).result,'win');
  await page.getByRole('img',{name:'별 3개',exact:true}).waitFor();
});
const enemy = (x, y, dir = 0, speed = 0, kind = 'basic') => ({ kind, x, y, dir, speed });
const at = (s, x, y) => s.grid[Math.floor(y / CS) * GW + Math.floor(x / CS)];
const count = (s, v) => s.grid.filter(c => c === v).length;
async function drag(page, start, end, release = true) {
  // Board coordinates → client coordinates through the published view transform.
  const [from, to] = await page.evaluate(points => points.map(([x, y]) => toClient(x, y)), [start, end]);
  await page.mouse.move(...from);
  await page.mouse.down();
  await page.mouse.move(...to, { steps: 4 });
  if (release) await page.mouse.up();
}

test('campaign stages start unclaimed with bounded rosters, readable geometry and paused intros', {timeout:180000},async t=>{
  const page=await open(t,{url:hostedGameUrl}),initial=await state(page);
  assert.equal(initial.panel,'intro');assert.equal(initial.inkCount,0);assert.equal(count(initial,1),initial.playable);
  assert.equal(await page.evaluate(()=>inkfill.shoot(-Math.PI/2,1)),false);
  await page.clock.runFor(2000);assert.deepEqual((await state(page)).enemies,initial.enemies);
  await page.getByRole('button',{name:'시작',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>inkfill.stages),STAGE_IDS);assert.equal(STAGE_IDS.length,52);
  await openStages(page);
  assert.equal(await page.locator('.stage-tile').count(),52);assert.equal(await page.locator('.chapter-head').count(),7);
  assert.equal(await page.locator('.stage-tile .tile-boss').count(),7,'every world ends with a marked boss board');
  assert.equal(await page.locator('.stage-tile:enabled').count(),52);
  assert.equal(await page.locator('.stage-tile[data-stage="boss-final"]').isEnabled(),true);
  assert.equal(await page.evaluate(()=>inkfill.select('unknown-stage')),false);
  assert.equal((await state(page)).stage.id,'first-line','invalid selection preserves the ready stage');
  await page.getByRole('button',{name:'계속',exact:true}).click();
  const kinds=new Set();
  for(const [i,id]of STAGE_IDS.entries()){
    await load(page,id);const s=await state(page);
    assert.equal(s.stage.id,id);assert.equal(s.inkCount,0);assert.equal(s.lives,id==='first-heart'?2:3);assert.equal(s.shots,0);
    s.enemies.forEach(e=>kinds.add(e.kind));s.orbs.forEach(o=>kinds.add(o.kind));
    // Boards stay orthogonal: the first four worlds are plain rectangles, later ones may be notched.
    if(i<26)assert.deepEqual(s.stage.outline,[[0,0],[960,0],[960,640],[0,640]]);
    for(let k=0;k<s.stage.outline.length;k++){const a=s.stage.outline[k],b=s.stage.outline[(k+1)%s.stage.outline.length];assert.ok(a[0]===b[0]||a[1]===b[1]);a.forEach(v=>assert.equal(v%4,0));}
    s.stage.zones.forEach(z=>kinds.add(z.kind));if(s.stage.spikes.length)kinds.add('spikes');if(s.enemies.some(e=>e.boss))kinds.add('boss');
    for(const p of s.stage.blockers){assert.ok([4,6].includes(p.length));for(let k=0;k<p.length;k++){const a=p[k],b=p[(k+1)%p.length];assert.ok(a[0]===b[0]||a[1]===b[1]);a.forEach(v=>assert.equal(v%4,0));}}
    assert.equal(await page.locator('#stage-num').innerText(),String(i+1));
    assert.equal(await page.locator('#stage-num').getAttribute('title'),s.stage.name,'the stage name stays available without HUD text');
    assert.equal(await page.locator('#cov-target').innerText(),s.stage.target+'%');
    assert.equal(await page.locator('#shots').innerText(),'0 / '+s.stage.par);
    assert.ok(s.stage.blockers.length<=2,'at most two internal walls');
    assert.equal(await page.locator('#toast').innerText(),'','no stage tip text');
  }
  assert.deepEqual([...kinds].sort(),['basic','blackhole','blade','bomb','boost','boss','charger','chaser','eraser','freeze','haven','heart','ink','jumper','mine','mud','nest','protect','shooter','spikes','splitter']);
  for(const [id,title]of [['first-blade','칼날 구슬'],['first-blast','폭탄 구슬'],['lasting-frost','빙결 구슬'],['first-wall','장애물을 이용해 영역 나누기'],['stored-guard','방어막 구슬'],
    ['boss-garden','보스'],['first-boost','가속 발판'],['first-mud','늪'],['first-haven','보호 구역'],['first-spikes','가시'],['first-chaser','추적형'],['first-heart','하트 구슬'],['first-split','분열형'],['first-mine','기뢰'],['first-ink','먹물 구슬']]){
    await page.evaluate(id=>inkfill.load(id),id);assert.equal((await state(page)).panel,'intro');assert.equal(await page.locator('#panel-title').innerText(),title);
    await page.getByRole('button',{name:'시작',exact:true}).click();
  }
});

test('campaign records resume the first uncleared stage without restricting selection', {timeout:60000},async t=>{
  const page=await open(t,{url:hostedGameUrl});
  await playRoute(page,STAGE_IDS[0],ROUTES[STAGE_IDS[0]]);
  assert.equal((await state(page)).progress.unlockedThrough,1);
  assert.ok(await page.evaluate(()=>JSON.parse(localStorage.getItem('inkfill.stars.v7'))['first-line'])>=1);
  await page.getByRole('button',{name:'다음',exact:true}).click();
  assert.equal((await state(page)).stage.id,STAGE_IDS[1]);
  await page.reload();await page.clock.runFor(34);await page.locator('[data-action="home-start"]').click();
  assert.equal((await state(page)).stage.id,STAGE_IDS[1]);assert.equal((await state(page)).panel,'intro');
  // Seed already-earned one-star records at the storage boundary, then win the boundary board through the real engine.
  await page.evaluate(ids=>localStorage.setItem('inkfill.stars.v7',JSON.stringify(Object.fromEntries(ids.slice(0,5).map(id=>[id,1])))),STAGE_IDS);
  await page.reload();await page.clock.runFor(34);await page.locator('[data-action="home-start"]').click();assert.equal((await state(page)).stage.id,STAGE_IDS[5]);
  assert.equal(STAGE_IDS[5],'boss-garden','the first world ends with its boss');
  await playRoute(page,STAGE_IDS[5],ROUTES[STAGE_IDS[5]]);
  assert.equal((await state(page)).progress.unlockedThrough,6);
  await page.getByRole('button',{name:'다음 단계',exact:true}).click();
  assert.equal((await state(page)).stage.id,STAGE_IDS[6]);assert.equal((await state(page)).theme,'plain');
  await page.getByRole('button',{name:'시작',exact:true}).click();
  await openStages(page);
  assert.equal(await page.locator('.stage-tile:enabled').count(),52);
  assert.equal(await page.locator('.stage-tile[data-stage="'+STAGE_IDS[7]+'"]').isEnabled(),true);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>document.activeElement.closest('#panel')!==null&&!document.activeElement.disabled),true);
  await page.evaluate(ids=>localStorage.setItem('inkfill.stars.v7',JSON.stringify({[ids[0]]:1,[ids[2]]:3,[ids.at(-1)]:3})),STAGE_IDS);
  await page.reload();await page.clock.runFor(34);await page.locator('[data-action="home-start"]').click();
  assert.equal((await state(page)).stage.id,STAGE_IDS[1]);assert.equal((await state(page)).progress.unlockedThrough,1);
  assert.equal(await page.evaluate(id=>inkfill.select(id),STAGE_IDS[2]),true);
  assert.equal((await state(page)).progress.cleared,1,'selection does not fabricate the missing clear');
});

for(const url of [gameUrl,'http://localhost/index.html','http://127.0.0.1/index.html','http://[::1]/index.html','https://localhost/index.html',hostedGameUrl])test('all stages open without fabricated records on '+new URL(url).origin, {timeout:180000}, async t=>{
    const page=await open(t,{url,testMode:false,home:true,viewport:{width:960,height:720},reducedMotion:'reduce'});
    assert.equal(await page.evaluate(()=> 'inkfill' in window),false);
    const saved=await page.evaluate(()=>Object.entries(localStorage));
    await page.getByRole('button',{name:'스테이지',exact:true}).click();
    assert.equal(await page.locator('.stage-tile:enabled').count(),52,url);
    assert.equal(await page.locator('.tile-lock').count(),0,url);
    const ids=url===gameUrl||url===hostedGameUrl?STAGE_IDS:[STAGE_IDS.at(-1)];
    for(const id of ids){
      await page.locator('.stage-tile[data-stage="'+id+'"]').click();
      assert.equal(await page.locator('#stage-num').innerText(),String(STAGE_IDS.indexOf(id)+1));
      const start=page.locator('[data-action="start"]');if(await start.count())await start.click();
      assert.equal(await page.locator('#hud').isVisible(),true);
      await openStages(page);
    }
    assert.deepEqual(await page.evaluate(()=>Object.entries(localStorage)),saved,'selection never fabricates stars');
    await page.reload();await page.clock.runFor(34);
    await page.getByRole('button',{name:'스테이지',exact:true}).click();
    assert.equal(await page.locator('.stage-tile:disabled').count(),0,'reload keeps access open on every host');
});

test('local out-of-order clears allow Next without bypassing recorded progress',async t=>{
  const page=await open(t);
  await load(page,{id:STAGE_IDS[10],target:5,par:1,enemies:[enemy(800,100)]});
  await shootAndSettle(page,-Math.PI/2,1);
  const s=await state(page);assert.equal(s.result,'win');
  assert.deepEqual(s.progress,{cleared:0,unlockedThrough:0,complete:false});
  const saved=await page.evaluate(()=>Object.entries(localStorage).filter(([key])=>key.startsWith('inkfill.stars.')).map(([,value])=>JSON.parse(value)));
  assert.deepEqual(saved,[{[STAGE_IDS[10]]:3}],'only the actual clear is saved');
  assert.equal(await page.locator('[data-action="next"]').isEnabled(),true);
  await page.locator('[data-action="next"]').click();
  assert.equal((await state(page)).stage.id,STAGE_IDS[11]);
  assert.equal(await page.evaluate(()=>inkfill.select('unknown-stage')),false);
});

test('aiming: changing direction renders the current path on the next frame', { timeout: 45000 }, async t => {
  const page = await open(t);
  await page.getByRole('button', { name: '시작', exact: true }).click();
  // Continuous adjustment must draw the current trajectory on the very next frame.
  // Sample actual canvas pixels along the public prediction, away from the pull handle.
  const aimView = await page.evaluate(() => {
    const c = document.querySelector('#board');
    window.aimBaseline = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    return { ...view };
  });
  await page.mouse.move(aimView.ox + 350 * aimView.s, aimView.oy + 300 * aimView.s);
  await page.mouse.down();
  for (const dx of [0, -35, 35, -20]) {
    const power = Math.hypot(dx, 170) / 230, angle = Math.atan2(-170, -dx);
    const point = await page.evaluate(([a, p]) => inkfill.guide(a, p).ball[60], [angle, power]);
    await page.mouse.move(aimView.ox + (350 + dx) * aimView.s, aimView.oy + 470 * aimView.s);
    await page.clock.runFor(17);
    const changed = await page.evaluate(([x, y]) => {
      const c = document.querySelector('#board'), ctx = c.getContext('2d');
      const px = Math.round((view.ox + x * view.s) * view.dpr), py = Math.round((view.oy + y * view.s) * view.dpr);
      const pixels = ctx.getImageData(px - 8, py - 8, 16, 16).data, base = window.aimBaseline;
      let changed = 0;
      for (let j = 0; j < 16; j++) for (let i = 0; i < 16; i++) {
        const a = (j * 16 + i) * 4, b = ((py - 8 + j) * base.width + px - 8 + i) * 4;
        if (Math.abs(pixels[a] - base.data[b]) + Math.abs(pixels[a+1] - base.data[b+1]) + Math.abs(pixels[a+2] - base.data[b+2]) > 40) changed++;
      }
      return changed;
    }, point);
    assert.ok(changed > 5, 'current aim path is visible while the pointer keeps changing direction');
    assert.equal((await state(page)).shots, 0, 'preview never fires a shot');
  }
  await page.locator('#board').dispatchEvent('pointercancel');
  await page.mouse.up();
});

test('public input: drag fires away from the pull, cancels, pauses, restarts, and preserves plain display while toggling guides', { timeout: 45000 }, async t => {
  const page = await open(t);
  await page.getByRole('button', { name: '시작', exact: true }).click();
  const initialBall=(await state(page)).ball;
  const pullY=initialBall.y<320?200:400;
  await drag(page, [350, 300], [350, pullY]);
  await page.clock.runFor(250);
  let s = await state(page);
  assert.equal(s.shots, 1, 'drag fires');
  assert.ok((s.ball.y-initialBall.y)*(300-pullY)>0 && Math.abs(s.ball.x-initialBall.x)<2, 'ball travels opposite to the pull');
  await page.keyboard.press('Escape');
  const paused = await state(page); assert.equal(paused.panel, 'pause');
  await page.clock.runFor(1200);
  assert.deepEqual((await state(page)).ball, paused.ball, 'pause freezes the shot');
  await page.keyboard.press('Escape');
  await page.clock.runFor(100);
  assert.notDeepEqual((await state(page)).ball, paused.ball, 'resume continues the shot');
  await page.getByRole('button', { name: '다시 시작 (R)', exact: true }).click();
  s = await state(page); assert.equal(s.shots, 0); assert.equal(s.panel, null, 'restart returns straight to play without repeating the lesson');
  await drag(page, [350, 300], [352, 302]);
  assert.equal((await state(page)).shots, 0, 'tiny drag cancels');
  await drag(page, [350, 300], [350, pullY], false);
  await page.locator('#board').dispatchEvent('pointercancel');
  await page.mouse.up();
  assert.equal((await state(page)).shots, 0, 'cancelled drag does not shoot');
  await drag(page, [350, 300], [350, pullY], false);
  await page.mouse.down({ button: 'right' }); await page.mouse.up({ button: 'right' });
  assert.equal(await page.evaluate(() => document.body.classList.contains('aiming')), false, 'a right click cancels the aim');
  await page.mouse.up();
  assert.equal((await state(page)).shots, 0, 'releasing after a right-click cancel does not shoot');
  await drag(page, [350, 300], [350, pullY], false);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  s = await state(page); assert.equal(s.shots, 0, 'Escape cancels the aim'); assert.equal(s.panel, null, 'Escape during an aim does not open the menu');
  await drag(page, [350, 300], [350, pullY]);
  await page.keyboard.press('r');
  s = await state(page); assert.equal(s.shots, 0); assert.equal(s.wetCount, 0); assert.equal(s.lives, 3);

  s = await state(page); assert.equal(s.themeMode, 'auto'); assert.equal(s.theme, 'plain');
  await page.keyboard.press('t'); await page.keyboard.press('t');
  assert.deepEqual([(await state(page)).themeMode, (await state(page)).theme], ['auto', 'plain']);
  await page.keyboard.press('g');
  assert.equal((await state(page)).guides, false);
  await page.reload();await page.clock.runFor(34);await page.locator('[data-action="home-start"]').click();
  s = await state(page);
  assert.equal(s.themeMode, 'auto', 'disabled theme shortcut does not change the preference'); assert.equal(s.guides, false, 'guide preference persists');
  await page.getByRole('button', { name: '시작', exact: true }).click();
  assert.equal(await page.locator('#theme').isVisible(), false);
  assert.equal((await state(page)).theme, 'plain');
  const auto = await page.evaluate(() => { inkfill.setTheme('auto'); return [0, 6, 12, 18, 24].map(n => inkfill.stages[n]).map(id => { inkfill.load(id); return inkfill.state().theme; }); });
  assert.deepEqual(auto, ['plain', 'plain', 'plain', 'plain', 'plain'], 'all stages use the plain display');

  const production = await open(t, { testMode: false });
  assert.equal(await production.evaluate(() => 'inkfill' in window), false, 'no test hook in production');
});

test('enclosure uses geometry, excludes void and blockers, and keeps every enemy region', { timeout: 90000 }, async t => {
  const page = await open(t);
  const maps = [
    { id: 'rect' },
    { id: 'bevel', outline: [[80,0],[960,0],[960,640],[0,640],[0,80]], voidPoint: [4, 4] },
    { id: 'notch', outline: [[0,0],[960,0],[960,640],[640,640],[640,520],[560,520],[560,640],[0,640]], voidPoint: [600, 600] },
    { id: 'blocker', blockers: [[[620,280],[700,280],[700,360],[620,360]]], voidPoint: [660, 320] },
  ];
  for (const map of maps) {
    await load(page, { ...map, enemies: [enemy(740, 220)] });
    const start = await state(page);
    assert.equal(start.inkCount, 0);
    assert.equal(start.playable, start.grid.filter(c => c !== 0).length);
    if (map.voidPoint) { assert.equal(at(start, ...map.voidPoint), 0); assert.ok(start.playable < 38400); }
    assert.equal(await shootAndSettle(page, -Math.PI / 2, 1), true);
    const end = await state(page);
    assert.equal(at(end, 100, 320), 2, map.id + ': enemy-free side filled');
    assert.equal(at(end, 740, 220), 1, map.id + ': enemy side stays paper');
    assert.equal(end.enemies.length, 1, 'enemies are never captured');
    assert.equal(end.lives, 3); assert.equal(end.wetCount, 0); assert.ok(end.commits > 0);
    assert.equal(end.inkCount, count(end, 2));
    if (map.voidPoint) assert.equal(at(end, ...map.voidPoint), 0);
  }
  await load(page, { id: 'both-sides', enemies: [enemy(200, 200), enemy(740, 220)] });
  await shootAndSettle(page, -Math.PI / 2, 1);
  const both = await state(page);
  assert.equal(at(both, 200, 200), 1); assert.equal(at(both, 740, 220), 1);
  assert.ok(both.inkCount / both.playable < .03, 'only the trail dries when both sides hold enemies');

  await load(page, { id: 'reflect', outline: [[80,0],[960,0],[960,640],[0,640],[0,80]], blockers: [[[400,200],[560,200],[560,260],[400,260]]], ball: { x: 120, y: 632 } });
  const trace = await page.evaluate(() => inkfill.trace(-Math.PI * .75, 1, 240));
  assert.ok(trace.every(([x, y]) => x > 7.9 && y > 7.9 && x < 952.1 && y < 632.1 && x + y > 80 + 8 * Math.SQRT2 - .1 && !(x > 392.1 && x < 567.9 && y > 192.1 && y < 267.9)), 'a full-speed ball never tunnels through a bevel or blocker');

  // Oblique wall reconnection must really separate paper on every rectangular side.
  const cuts=[
    [{x:480,y:632},-Math.PI/4,enemy(180,180)],
    [{x:480,y:8},Math.PI/4,enemy(180,480)],
    [{x:8,y:320},-Math.PI/4,enemy(740,480)],
    [{x:952,y:320},-Math.PI*.75,enemy(740,480)],
  ];
  for(const [ball,angle,e]of cuts){await load(page,{id:'rect-wall-cut',ball,enemies:[e]});await shootAndSettle(page,angle,1);const s=await state(page);assert.equal(s.lives,3);assert.ok(s.events.some(ev=>ev.type==='commit'&&ev.cut&&ev.filled>1000),'wall reconnection fills a real region');assert.equal(at(s,e.x,e.y),1,'occupied side stays paper');assert.equal(s.inkCount,count(s,2));}
});

test('wet trails persist, the trail dries at the boundary, and territory closes new regions', { timeout: 30000 }, async t => {
  const page = await open(t);
  await load(page, { id: 'weak', enemies: [enemy(760, 140, 0, 60)] });
  await shootAndSettle(page, -Math.PI / 2, .3);
  const weak = await state(page);
  assert.ok(weak.wetCount > 0, 'a weak shot leaves a wet trail'); assert.equal(weak.inkCount, 0);
  const idle = weak.enemies[0];
  await page.clock.runFor(1500);
  assert.deepEqual((await state(page)).enemies[0], idle, 'enemies wait between shots');
  await shootAndSettle(page, -Math.PI / 2, 1);
  const closed = await state(page);
  assert.equal(closed.wetCount, 0); assert.equal(at(closed, 100, 320), 2, 'the continued trail closes the left side');

  await load(page, { id: 'wall-only', enemies: [enemy(300, 300)], ball: { x: 900, y: 632 } });
  await shootAndSettle(page, 0, .2);
  const wall = await state(page);
  assert.ok(wall.inkCount > 0 && wall.inkCount < 200, 'touching a wall without enclosing dries only the trail');

  await load(page, { id: 'from-ink', enemies: [enemy(760, 160)], ball: { x: 240, y: 632 } });
  await shootAndSettle(page, -Math.PI / 2, 1);
  const first = await state(page);
  assert.equal(at(first, 100, 320), 2);
  assert.equal(at(first, first.ball.x, first.ball.y), 2, 'the ball rests on its dried trail');
  await shootAndSettle(page, 0, .9);
  const fromInk = await state(page);
  assert.ok(fromInk.inkCount > first.inkCount + 1000, 'a trail from territory to the wall closes another region');
  assert.equal(at(fromInk, 760, 160), 1);
});

test('tears clear the wet trail and cost one heart; resting beside an enemy is not an instant tear', { timeout: 30000 }, async t => {
  const page = await open(t);
  await load(page, { id: 'tear', enemies: [enemy(560, 300, 180, 90)] });
  await shootAndSettle(page, -Math.PI / 2, .55);
  let s = await state(page);
  assert.equal(s.lives, 2); assert.equal(s.wetCount, 0); assert.equal(s.moving, false); assert.equal(s.inkCount, 0);
  assert.equal(s.enemies.length, 1);
  await page.evaluate(() => {   // three enemies drop onto successive trails: a deterministic loss
    inkfill.load({ id: 'three-tears', enemies: [330, 630, 480].map((x, k) => ({ kind: 'basic', x, y: k < 2 ? 540 : 420, dir: 90, speed: 110 })) }); inkfill.start();
    for (let k = 0; k < 8 && !inkfill.state().result; k++) { inkfill.shoot([Math.PI, 0, -Math.PI / 2][k % 3], .3); inkfill.settle(); }
  });
  s = await state(page);
  assert.equal(s.lives, 0); assert.equal(s.result, 'lose'); assert.equal(s.panel, 'result');
  await page.getByRole('button', { name: '다시 시작', exact: true }).click();
  assert.equal((await state(page)).lives, 3);

  await load(page, { id: 'grace', enemies: [enemy(480, 608, 270, 60)] });
  await shootAndSettle(page, 0, .4);
  s = await state(page);
  assert.equal(s.lives, 3, 'an enemy already touching the launch spot may leave without tearing');
});

test('every generated stage earns three stars through its retained route in the live browser', { timeout: 180000 }, async t => {
  const page = await open(t);
  for (const id of STAGE_IDS) {
    for (const [family, witness] of CERT.stages[id].routes.entries()) {
      const s = await playRoute(page, id, witness.actions);
      assert.equal(s.result, 'win', id + '/' + family + ' route wins');
      assert.ok(s.shots <= s.stage.par, id + ' earns three stars');
      assert.equal(s.lives, witness.results[0].lives, id + ' live hearts match offline replay');
      assert.equal(s.panel, 'result');
      assert.ok(s.inkCount / s.playable * 100 >= s.stage.target);
      await page.getByRole('img', { name: '별 3개', exact: true }).waitFor();
    }
  }
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('inkfill.stars.v7')));
  assert.deepEqual(Object.keys(saved).sort(), [...STAGE_IDS].sort());
  assert.ok(Object.values(saved).every(v => v === 3));
  const worse = await page.evaluate(() => {
    inkfill.load({ id: 'first-line', target: 5, par: 1, enemies: [{ kind: 'basic', x: 800, y: 100, dir: 0, speed: 0 }] }); inkfill.start();
    for (let k = 0; k < 3; k++) { inkfill.shoot(-Math.PI / 2, .08); inkfill.settle(); }
    inkfill.shoot(-Math.PI / 2, 1); inkfill.settle(); return inkfill.state();
  });
  assert.equal(worse.result, 'win'); assert.equal(worse.shots, 4);
  assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('inkfill.stars.v7'))))['first-line'], 3, 'a worse clear keeps the better record');
  await page.reload();await page.clock.runFor(34);await page.locator('[data-action="home-start"]').click();
  assert.equal((await state(page)).stage.id,'boss-final','a completed campaign resumes at the final board');
  await openStages(page);
  await page.getByRole('button', { name: /^1\. 첫 선, 별 3개$/ }).waitFor();
  const context = await browser.newContext();
  try {
    await context.addInitScript(() => { const fail = () => { throw Error('blocked'); }; Object.defineProperty(window, 'localStorage', { get: fail }); });
    const blocked = await context.newPage(), errors = [];
    blocked.on('pageerror', e => errors.push(e.message));
    await blocked.goto(gameUrl + '?test=1');
    assert.equal((await playRoute(blocked, 'first-line', ROUTES['first-line'])).result, 'win', 'play works without storage');
    assert.equal((await state(blocked)).progress.unlockedThrough,1,'denied storage retains session progress');
    await blocked.getByRole('button',{name:'다음',exact:true}).click();
    assert.equal((await state(blocked)).stage.id,STAGE_IDS[1]);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('boss completion requires defeat after reaching the coverage target',async t=>{
  const page=await open(t),fixture=require('./fixtures/boss-target-before-defeat.json');
  const stage=fixture.stage;
  let s=await playRoute(page,stage,fixture.actions);
  assert.ok(s.inkCount/s.playable*100>=s.stage.target);
  assert.ok(s.inkCount<s.playable,'the surviving boss still protects its occupied paper');
  assert.equal(s.result,null);
  assert.deepEqual(s.enemies.filter(e=>e.boss).map(e=>e.hp),[1]);
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('inkfill.stars.v7')||'{}')['boss-minhwa']),undefined,'reaching the target cannot save a boss clear early');
  for(const a of fixture.finishActions){await shootAndSettle(page,Math.atan2(a.y-s.ball.y,a.x-s.ball.x),a.power);s=await state(page);}
  assert.equal(s.result,'win');assert.equal(s.enemies.filter(e=>e.boss).length,0);
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('inkfill.stars.v7'))['boss-minhwa']),3,'the completed fight saves its stars');
});

test('every theme renders; responsive layout, DPR, focus, and reduced motion', { timeout: 150000 }, async t => {
  const page = await open(t);
  const cases = [...STAGE_IDS.map(id => ['auto', id]), ...['gouache', 'minhwa', 'glass', 'poster', 'collage'].flatMap(th => ['first-wall','gather-and-guard','first-hop','challenge-timing','final'].map(id => [th, id]))];
  for (const [theme, id] of cases) {
    await page.evaluate(([theme, id]) => { inkfill.setTheme(theme); inkfill.load(id); inkfill.start(); inkfill.shoot(-1.2, .6); }, [theme, id]);
    await page.clock.runFor(120);
  }
  await page.evaluate(() => { inkfill.load('first-erase'); inkfill.start(); inkfill.shoot(-1.57, 1); inkfill.settle(); });
  await page.clock.runFor(200);   // the eraser mark renders
  for (const [width, height] of [[1440, 900], [1024, 768], [844, 390], [667, 375], [390, 844], [320, 568]]) {
    const p = await open(t, { viewport: { width, height }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    const m = await p.evaluate(() => { const c = document.querySelector('#board'), r = c.getBoundingClientRect(); return { w: c.width, h: c.height, cw: r.width, ch: r.height, reduced: document.body.classList.contains('reduced'), v: { ...view } }; });
    assert.equal(m.w, Math.round(m.cw * 2)); assert.equal(m.h, Math.round(m.ch * 2));
    assert.ok(m.v.ox >= 0 && m.v.oy >= 0 && m.v.ox * 2 + m.v.bw <= width + .5 && m.v.oy + m.v.bh <= height + .5, 'board fits the viewport');
    assert.equal(m.v.rot, height > width, 'tall screens turn the board; wide screens keep it level');
    if (m.v.rot) assert.ok(m.v.bw >= width * .85, 'the turned board uses the phone width');
    if (width >= height * 1.6) assert.ok(m.v.bh >= height * .85 && await p.evaluate(() => document.body.classList.contains('side')), 'a wide desktop or landscape phone gives the board the height; the HUD stands in side rails');
    if (width === 1024) assert.equal(await p.evaluate(() => document.body.classList.contains('side')), false, 'a 4:3 window keeps the top bar because rails would shrink the board');
    assert.equal(m.reduced, true, 'reduced motion follows the OS setting');
    const forward=await p.locator('.lesson-forward').boundingBox();
    assert.ok(forward.height>=44&&forward.height<=48&&forward.width>forward.height*3,'tutorial action is thin, wide and touchable');
    for (const selector of ['#controls', '#coverage', '#status']) {
      const b = await p.locator(selector).boundingBox();
      assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.width <= width + .5 && b.y + b.height <= height + .5, selector + ' inside viewport');
      const board = {left:m.v.ox, top:m.v.oy, right:m.v.ox+m.v.bw, bottom:m.v.oy+m.v.bh};
      assert.ok(b.x+b.width <= board.left || b.x >= board.right || b.y+b.height <= board.top || b.y >= board.bottom, selector + ' does not overlap the board');
    }
    await p.keyboard.press('Tab'); await p.keyboard.press('Tab');
    assert.equal(await p.evaluate(() => document.activeElement.closest('#panel') !== null), true, 'focus stays in the panel');
    // A language selector is now in the tab order; activate the named primary action.
    await p.getByRole('button',{name:'시작',exact:true}).focus();
    await p.keyboard.press('Enter');
    assert.equal((await p.evaluate(() => inkfill.state())).panel, null);
    for (const button of await p.locator('#hud button:visible').all()) {
      const b = await button.boundingBox();
      assert.ok(b.width >= 44 && b.height >= 44, 'HUD targets are at least 44×44');
    }
    const restart = await p.locator('#restart').boundingBox(), menu = await p.locator('#menu').boundingBox();
    assert.ok(restart.x - (menu.x + menu.width) >= 8 || restart.y - (menu.y + menu.height) >= 8, 'menu and restart targets have an 8 px gap');
    await drag(p, [400, 320], [400, 400], false);
    await p.clock.runFor(300);
    if (m.v.rot) {   // a real pull on the turned board still launches the opposite way in board space
      const before = (await state(p)).ball; await p.mouse.up(); await p.clock.runFor(120);
      const moved = (await state(p)).ball;
      assert.ok(moved.y < before.y - 5 && Math.abs(moved.x - before.x) < 2, 'turned board maps the pull to the same board direction');
      await load(p, 'first-erase'); await drag(p, [400, 320], [400, 400], false); await p.clock.runFor(300);
    }
    assert.equal(await p.locator('#toast').evaluate(e => getComputedStyle(e).opacity), '0', 'hidden toast stays hidden while aiming');
    await p.keyboard.press('Escape'); await p.mouse.up();
    await load(p, 'first-line'); await p.clock.runFor(300);
    assert.equal(await p.locator('#toast').evaluate(e => getComputedStyle(e).opacity), '0', 'stage load hides the toast');
    assert.equal(await p.locator('#toast').textContent(), '', 'hidden toast clears stale text');
    for(const target of [58,94,100]){
      await p.evaluate(target=>{inkfill.load({id:'gauge-'+target,target,enemies:[{kind:'basic',x:80,y:80,dir:0,speed:0}]});inkfill.start();},target);
      await p.clock.runFor(40);
      const goal=await p.locator('.cov-goal').boundingBox(),tick=await p.locator('#cov-tick').boundingBox(),side=await p.evaluate(()=>document.body.classList.contains('side'));
      assert.ok(goal.x>=0&&goal.y>=0&&goal.x+goal.width<=width+1&&goal.y+goal.height<=height+1,'goal value is fully readable at '+width+'×'+height);
      assert.ok(side?Math.abs(goal.y+goal.height/2-tick.y-tick.height/2)<=9:Math.abs(goal.x+goal.width-tick.x-tick.width/2)<=2,'goal value follows the actual target line');
    }
    if(await p.evaluate(()=>document.body.classList.contains('side'))){
      const centered=async()=>{
        const m=await p.evaluate(()=>{
          const range=document.createRange();range.selectNodeContents(document.getElementById('cov-now'));
          const text=range.getBoundingClientRect(),bar=document.getElementById('cov-bar').getBoundingClientRect();
          return {textX:text.x+text.width/2,barX:bar.x+bar.width/2,left:text.x,right:text.right};
        });
        assert.ok(Math.abs(m.textX-m.barX)<=1,'coverage number stays centered above the vertical gauge');
        assert.ok(m.left>=0&&m.right<=width+1,'coverage number remains fully visible');
      };
      await centered();
      await load(p,{id:'full-gauge',target:100,enemies:[]});
      await shootAndSettle(p,-Math.PI/2,1);await p.clock.runFor(40);
      assert.equal(await p.locator('#cov-now').innerText(),'100%');
      await centered();await p.clock.runFor(140);await centered();
      await load(p,'first-line');
    }
    await p.keyboard.press('Escape');
    assert.equal((await p.evaluate(() => inkfill.state())).panel, 'pause');
    await p.keyboard.press('Escape');
    assert.equal((await p.evaluate(() => inkfill.state())).panel, null, 'resume does not repeat the intro');
    await openStages(p);
    const sheet=await p.locator('#panel').evaluate(el=>({width:el.clientWidth,contentWidth:el.scrollWidth}));
    assert.ok(sheet.contentWidth<=sheet.width+1,'stage choices fit without horizontal clipping at '+width+'×'+height);
    if (width >= 720) {
      // Hover translates a tile visually without changing its grid row. Measure layout, not animation progress.
      const rowCounts = await p.locator('.stage-grid').evaluateAll(grids => grids.map(grid => {
        const counts = {};
        for (const tile of grid.children) { const y = tile.offsetTop; counts[y] = (counts[y] || 0) + 1; }
        return Object.values(counts);
      }));
      assert.ok(rowCounts.every(counts => counts.every(count => count > 1)), 'wide stage sheets have no orphan rows');
    }
  }
});


test('plain display ignores retained themes and art seeds without affecting gameplay', { timeout: 45000 }, async t => {
  const page = await open(t, { reducedMotion: 'reduce' });
  const scenario = seed => ({ id: 'theme-pattern', seed, enemies: [enemy(850, 100, 0, 0)] });
  // The viewport-sized canvas sits behind the HUD; compare its rendered pixels,
  // excluding unrelated DOM/compositor variation in overlapping game chrome.
  const boardImage = async () => Buffer.from(await page.locator('#board').evaluate(canvas => canvas.toDataURL().split(',')[1]), 'base64');
  const capture = async (theme, seed) => {
    await page.evaluate(([theme, scenario]) => {
      inkfill.setTheme(theme); inkfill.load(scenario); inkfill.start(); inkfill.shoot(-Math.PI / 2, 1); inkfill.settle();
    }, [theme, scenario(seed)]);
    await page.clock.runFor(2000); // let cosmetic fill and score effects finish
    return { image: await boardImage(), state: await state(page) };
  };
  const reference = (await capture('gouache', 17)).state;
  for (const theme of ['minhwa', 'glass', 'poster', 'collage']) {
    const first = await capture(theme, 17);
    assert.deepEqual(first.state.grid, reference.grid, theme + ' keeps the same territory');
    assert.deepEqual(first.state.ball, reference.ball, theme + ' keeps ball physics');
    assert.deepEqual(first.state.enemies, reference.enemies, theme + ' keeps enemy physics');
    await page.evaluate(theme => { inkfill.setTheme('gouache'); inkfill.setTheme(theme); }, theme);
    await page.clock.runFor(40);
    assert.deepEqual(await boardImage(), first.image, theme + ' switching preserves pattern placement');
    const repeated = await capture(theme, 17);
    assert.deepEqual(repeated.image, first.image, theme + ' restarting the same seed preserves artwork');
    const changed = await capture(theme, 18);
    assert.deepEqual(changed.state.grid, first.state.grid, theme + ' an art seed does not change the filled side');
    assert.deepEqual(changed.image, first.image, theme + ' artwork seed has no effect in plain mode');
  }
});

const horizontal = (orbs=[], enemies=[], extra={}) => ({id:'scenario',ball:{x:100,y:320},orbs,enemies,...extra});
const orb = (kind,x=200,y=320) => ({kind,x,y});
const events = (s,type) => s.events.filter(e=>e.type===type);

test('physical orbs: head-on, glance, transfer, reactivation and dormant contact', async t=>{
 const page=await open(t);
 await load(page,horizontal([orb('bomb')]));
 let s=await page.evaluate(()=>{inkfill.shoot(0,.6);return inkfill.advance(20);});
 assert.ok(Math.abs(s.ball.vx)<1e-6);assert.ok(s.orbs[0].vx>500);assert.equal(s.orbs[0].armed,true);assert.equal(s.moving,true,'rolling tool keeps shot alive');
 const stopped={...s.ball},stoppedWet=s.wetCount;await page.evaluate(()=>inkfill.advance(20));s=await state(page);assert.equal(s.ball.x,stopped.x);assert.equal(s.wetCount,stoppedWet,'orb never stamps a trail');
 await page.evaluate(()=>inkfill.settle());s=await state(page);assert.equal(s.ends,1);assert.equal(s.commits,0,'orb wall contact cannot dry player trail');
 await load(page,horizontal([orb('bomb',200,334)]));
 s=await page.evaluate(()=>{inkfill.shoot(0,.6);return inkfill.advance(20);});
 assert.ok(s.ball.vy<0 && s.ball.vx>0,'glance retains tangential velocity and deflects player');assert.ok(s.orbs[0].vy>0);
 await load(page,horizontal([orb('bomb',200),orb('bomb',300)]));
 s=await page.evaluate(()=>{inkfill.shoot(0,.6);return inkfill.advance(45);});
 assert.ok(s.orbs[1].armed&&s.orbs[1].vx>0,'armed rolling orb transfers impulse');
 await load(page,horizontal([orb('bomb',180)],[],{outline:[[0,0],[500,0],[500,640],[0,640]]}));
 const tr=await page.evaluate(()=>inkfill.traceWorld(0,1,360));
 assert.ok(tr.timeline.some(s=>s.events.filter(e=>e.type==='contact').length>=2 && s.ball.moving),'banked orb reactivates stopped player');
 assert.ok(tr.timeline.every(s=>s.ball.x>=7.999&&s.ball.x<=492.001&&s.orbs.every(o=>o.x>=13.999&&o.x<=486.001)),'no geometry tunneling');
 await load(page,horizontal([orb('bomb',400,160)],[enemy(340,160,0,70)]));
 await shootAndSettle(page,Math.PI,.3);s=await state(page);assert.equal(s.orbs.length,1);assert.equal(s.enemies.length,1);assert.equal(s.orbs[0].armed,false,'walking over dormant tool does nothing');
});

test('territory closure: last removal waits for a true partition, survivors protect paper', async t=>{
 const page=await open(t);await load(page,horizontal([orb('bomb')],[enemy(340,320)]));
 await shootAndSettle(page,0,.6);let s=await state(page);assert.equal(s.enemies.length,0);assert.equal(s.inkCount,0);assert.equal(s.result,null);assert.ok(events(s,'remove').length===1);
 await shootAndSettle(page,-Math.PI/2,.6);s=await state(page);assert.equal(s.closures,0);assert.ok(s.inkCount<s.playable*.1,'unclosed drying cannot fill all paper');
 await shootAndSettle(page,Math.PI/2,1);s=await state(page);assert.equal(s.result,'win');assert.ok(s.closures>0);
 await load(page,horizontal([orb('bomb',200,200)],[enemy(700,100)],{ball:{x:240,y:632}}));await shootAndSettle(page,-Math.PI/2,1);s=await state(page);assert.equal(at(s,100,320),2);assert.equal(at(s,700,100),1);assert.equal(s.orbs.length,1,'claimed land does not swallow tools');
});

test('orb effects: proximity blast and permanent area freeze respect walls and preserve occupied space',async t=>{
 const page=await open(t);
 for(const kind of ['bomb','freeze']) {
  await load(page,horizontal([orb(kind)],[enemy(340,320),enemy(370,375),enemy(700,150)]));await shootAndSettle(page,0,.6);const s=await state(page),impact=events(s,'impact')[0];
  assert.equal(s.orbs.length,0);assert.ok(Math.hypot(impact.x-340,impact.y-320)>29,'effect triggers without direct contact');
  if(kind==='bomb'){assert.equal(s.enemies.length,1);assert.equal(events(s,'remove').length,2);}
  else {assert.equal(s.enemies.length,3);assert.ok(s.enemies.slice(0,2).every(e=>e.frozen));assert.equal(s.enemies[2].frozen,false);assert.equal(events(s,'freeze').length,2);}
 }
 for(const kind of ['bomb','freeze']) {
  await load(page,horizontal([orb(kind)],[enemy(340,320),enemy(375,375)],{blockers:[[[275,338],[390,338],[390,348],[275,348]]]}));await shootAndSettle(page,0,.6);const s=await state(page);
  assert.ok(s.enemies.some(e=>e.x===375&&e.y===375&&!e.frozen),'wall shields nearby enemy from area effect');
 }
 await load(page,horizontal([orb('freeze')],[enemy(340,320)]));await shootAndSettle(page,0,.6);
 let tr=await page.evaluate(()=>inkfill.traceWorld(0,.6,70));assert.equal(tr.final.lives,3);assert.ok(tr.final.ball.x>370);assert.ok(tr.final.enemies[0].frozen>0);assert.equal(events(tr.final,'tear').length,0,'frozen body cannot break the crossing trail');
 await page.evaluate(()=>inkfill.settle());await shootAndSettle(page,Math.PI,.2);let s=await state(page);assert.equal(s.enemies[0].frozen,true);assert.equal(s.lives,3,'later shots still cross the permanently frozen body safely');
 assert.equal(s.result,null,'freezing does not remove an occupied region');
 await load(page,horizontal([orb('blackhole',170),orb('freeze',230)],[enemy(340,320)]));await shootAndSettle(page,0,.6);s=await state(page);
 assert.equal(s.enemies[0].frozen,true);assert.ok(s.orbs.some(o=>o.kind==='blackhole'&&o.armed));const frozenPosition={x:s.enemies[0].x,y:s.enemies[0].y};
 for(let k=0;k<8;k++)await shootAndSettle(page,k%2?-Math.PI/2:Math.PI/2,.12);s=await state(page);
 assert.ok(s.time>3);assert.ok(s.shots>=9);assert.equal(s.enemies[0].frozen,true);assert.deepEqual({x:s.enemies[0].x,y:s.enemies[0].y},frozenPosition,'freeze holds the exact position across shots and blackhole attraction');
 await page.getByRole('button',{name:'다시 시작 (R)',exact:true}).click();assert.equal((await state(page)).enemies[0].frozen,false,'restart clears freeze');
 await load(page,horizontal([orb('bomb',400,160)],[enemy(340,160,0,70)]));await shootAndSettle(page,Math.PI,.3);s=await state(page);assert.equal(s.enemies.length,1);assert.equal(s.orbs[0].armed,false,'dormant tools do not trigger by proximity');
 await load(page,horizontal([orb('bomb')]));await shootAndSettle(page,0,.2);s=await state(page);assert.equal(s.orbs.length,1);assert.equal(s.orbs[0].armed,false,'missed bomb settles for reuse');
});

test('orb effects: blackhole pulls while rolling and after rest, carries indefinitely, moves nests and respects walls',async t=>{
 const page=await open(t);await load(page,horizontal([orb('blackhole')],[enemy(350,220,0,0),enemy(400,420,0,0,'nest')]));
 let tr=await page.evaluate(()=>inkfill.traceWorld(0,.2,70));
 assert.ok(tr.timeline.some(s=>s.orbs[0].moving&&s.orbs[0].armed&&s.enemies[0].x!==350),'pull starts before the orb stops');
 assert.ok(tr.timeline.some(s=>s.orbs[0].moving&&s.enemies.find(e=>e.kind==='nest').y<420),'stationary nests are pulled too');
 await page.evaluate(()=>inkfill.settle());let s=await state(page);assert.equal(s.orbs[0].state,'active');assert.equal(s.orbs[0].moving,false);const source={...s.orbs[0]},before=s.enemies.map(e=>Math.hypot(e.x-source.x,e.y-source.y));
 await page.clock.runFor(1500);assert.deepEqual((await state(page)).enemies,s.enemies,'aiming pauses attraction');
 await shootAndSettle(page,Math.PI,.12);s=await state(page);assert.ok(s.enemies.slice(0,2).every((e,i)=>Math.hypot(e.x-source.x,e.y-source.y)<=before[i]),'stationary source keeps pulling on later shots');
 for(let k=0;k<6&&!s.result;k++){await shootAndSettle(page,k%2?0:Math.PI,.12);s=await state(page);}assert.ok(s.time>4);assert.equal(s.orbs[0].armed,true,'blackhole has no timer expiry');assert.ok(!events(s,'remove').length,'attraction never kills');
 await load(page,horizontal([orb('blackhole')],[enemy(450,320)],{blockers:[[[380,0],[400,0],[400,640],[380,640]]]}));await shootAndSettle(page,0,.2);s=await state(page);assert.equal(s.enemies[0].x,450);assert.equal(s.enemies[0].blackholeId,null,'wall blocks influence');
});

test('orb effects: protection stacks, persists until a hit, and spends one charge per encounter',async t=>{
 const page=await open(t);await load(page,horizontal([orb('protect',170)],[enemy(340,320)]));
 let tr=await page.evaluate(()=>inkfill.traceWorld(0,.6,70));assert.equal(tr.final.lives,3);assert.equal(tr.final.moving,true);assert.ok(tr.final.wetCount>0);assert.ok(tr.final.ball.x>370);assert.equal(events(tr.final,'protect-block').length,1);assert.equal(tr.final.shield,0);
 await load(page,horizontal([orb('protect',170),orb('protect',230)],[enemy(340,320),enemy(500,320)]));await shootAndSettle(page,0,.6);let s=await state(page);assert.equal(events(s,'protect').length,2);assert.equal(events(s,'protect-block').length,2,'two pickups block two distinct encounters');assert.equal(events(s,'tear').length,0);assert.equal(s.lives,3);assert.equal(s.shield,0);
 await load(page,horizontal([orb('protect',170),orb('protect',230)],[enemy(340,320),enemy(500,320),enemy(650,320)]));await shootAndSettle(page,0,.6);s=await state(page);assert.equal(events(s,'protect-block').length,2);assert.equal(events(s,'tear').length,1);assert.equal(s.lives,2,'a third encounter tears after both charges are spent');assert.equal(s.shield,0);
 await load(page,{id:'protected-bullet',ball:{x:480,y:632},orbs:[orb('protect',480,560)],enemies:[enemy(660,470,0,0,'shooter')]});tr=await page.evaluate(()=>inkfill.traceWorld(-Math.PI/2,.6,360));assert.equal(tr.final.lives,3);assert.ok(events(tr.final,'protect-block').some(e=>e.source==='bullet'));assert.equal(events(tr.final,'tear').length,0);
 await load(page,horizontal([orb('protect',170),orb('protect',230)],[enemy(700,100)]));await shootAndSettle(page,0,.2);s=await state(page);assert.equal(events(s,'protect').length,2);assert.equal(s.shield,2,'unused charges survive acquisition shot');
 for(let k=0;k<4;k++)await shootAndSettle(page,k%2?0:Math.PI,.12);assert.equal((await state(page)).shield,2,'unused charges survive later shots');
 await page.clock.runFor(34);assert.equal(await page.getByRole('status').filter({hasText:/^남은 방어막 2회$/}).count(),1,'remaining charges have an accessible status');
 await page.getByRole('button',{name:'다시 시작 (R)',exact:true}).click();assert.equal((await state(page)).shield,0,'restart clears the charge inventory');
 await load(page,horizontal([orb('protect',170)],[enemy(340,320)]));await shootAndSettle(page,0,.12);assert.equal((await state(page)).shield,1);
 const before=await state(page),g=await page.evaluate(()=>inkfill.guide(0,.6));assert.deepEqual(await state(page),before,'prediction preserves stored charges');assert.equal(g.final.shield,0);assert.equal(events(g.final,'protect-block').length,1);
 const live=await page.evaluate(n=>inkfill.traceWorld(0,.6,n),g.frames);assert.deepEqual(live.timeline,g.timeline);assert.deepEqual(live.final,g.final);
});

test('orb effects: blade charges remove touched enemies, stack, persist and match prediction',async t=>{
 const page=await open(t);await load(page,horizontal([orb('blade',170)],[enemy(340,320),enemy(500,320)]));
 let s=await page.evaluate(()=>{inkfill.shoot(0,.6);return inkfill.advance(12);});assert.equal(s.blade,1);assert.equal(s.orbs.length,0);assert.ok(s.ball.vx>500,'pickup keeps the ball rolling');
 await page.evaluate(()=>inkfill.settle());s=await state(page);
 assert.deepEqual(events(s,'remove').map(e=>e.kind),['blade']);assert.equal(events(s,'blade-hit').length,1);assert.equal(s.blade,0);
 assert.equal(s.enemies.length,1);assert.equal(s.enemies[0].x,500);assert.equal(events(s,'tear').length,1);assert.equal(s.lives,2,'the next enemy tears once the charge is spent');
 await load(page,horizontal([orb('blade',170),orb('blade',230)],[enemy(340,320),enemy(500,320)]));await shootAndSettle(page,0,.6);s=await state(page);
 assert.equal(events(s,'blade').length,2);assert.equal(events(s,'remove').length,2);assert.equal(s.enemies.length,0);assert.equal(s.lives,3);assert.equal(s.inkCount,0,'removing enemies never claims territory by itself');
 await load(page,horizontal([orb('blade',170)],[enemy(700,100)]));await shootAndSettle(page,0,.2);
 for(let k=0;k<4;k++)await shootAndSettle(page,k%2?0:Math.PI,.12);s=await state(page);assert.equal(s.blade,1,'an unused charge survives later shots');assert.equal(s.enemies.length,1);
 await page.clock.runFor(34);assert.equal(await page.getByRole('status').filter({hasText:/^남은 칼날 1회$/}).count(),1,'remaining charges have an accessible status');
 await page.getByRole('button',{name:'다시 시작 (R)',exact:true}).click();assert.equal((await state(page)).blade,0,'restart clears the charge');
 await load(page,horizontal([orb('freeze',200),orb('blade',100,200)],[enemy(340,320)]));await shootAndSettle(page,0,.6);s=await state(page);assert.equal(s.enemies[0].frozen,true);
 await shootAndSettle(page,Math.atan2(200-s.ball.y,100-s.ball.x),.4);s=await state(page);assert.equal(s.blade,1);
 await shootAndSettle(page,Math.atan2(320-s.ball.y,340-s.ball.x),.6);s=await state(page);assert.equal(s.enemies.length,0,'a frozen enemy is removed by the blade too');assert.equal(s.lives,3);
 await load(page,horizontal([orb('blade',170)],[enemy(340,320),enemy(500,320)]));
 const before=await state(page),g=await page.evaluate(()=>inkfill.guide(0,.6));assert.deepEqual(await state(page),before,'prediction preserves the live world');
 assert.equal(g.final.blade,0);assert.equal(g.final.enemies.length,1);
 const live=await page.evaluate(n=>inkfill.traceWorld(0,.6,n),g.frames);assert.deepEqual(live.timeline,g.timeline);assert.deepEqual(live.final,g.final);
});

test('enemy actions: jumpers hold still between hops and nests show their spawn countdown',async t=>{
 const page=await open(t);const j={...enemy(700,200,0,60,'jumper'),jumpPoints:[{x:700,y:200},{x:700,y:450}]};
 await load(page,horizontal([],[j]));const tr=await page.evaluate(()=>inkfill.traceWorld(Math.PI,.6,160));
 const before=tr.timeline.filter(s=>!s.events.some(e=>e.type==='hop'));assert.ok(before.length>100);
 assert.ok(before.every(s=>s.enemies[0].x===700&&s.enemies[0].y===200),'a jumper only moves by hopping');assert.equal(tr.final.enemies[0].y,450);
 const marks=await page.evaluate(()=>{
  const paint=count=>{const cv=document.createElement('canvas');cv.width=cv.height=64;const c=cv.getContext('2d');T().drawEnemy(c,{kind:'nest',x:32,y:32,r:18,vx:1,vy:0,id:1,count,state:'rest'},0);return cv.toDataURL();};
  return [3,2,1].map(paint);
 });
 assert.equal(new Set(marks).size,3,'each remaining spawn count draws a distinct cue');
});

test('enemy actions: locked charge, remote fire, hop source and blocked destination', async t=>{
 const page=await open(t);
 await load(page,horizontal([],[enemy(400,200,0,0,'charger')]));let before=await state(page);const angle=before.enemies[0].intent.angle;let tr=await page.evaluate(()=>inkfill.traceWorld(Math.PI,.6,200));assert.ok(tr.final.events.some(e=>e.type==='dash'&&e.angle===angle));assert.equal(tr.final.events.filter(e=>e.type==='dash').length,1);
 await load(page,{id:'bullet',ball:{x:480,y:632},enemies:[enemy(660,470,0,0,'shooter')]});tr=await page.evaluate(()=>inkfill.traceWorld(-Math.PI/2,.6,360));assert.ok(tr.final.events.some(e=>e.type==='fire'));assert.equal(tr.final.lives,2);assert.ok(tr.final.events.some(e=>e.type==='tear'&&e.source==='bullet'),'bullet tears remotely');
 const j={...enemy(700,200,0,0,'jumper'),jumpPoints:[{x:700,y:200},{x:700,y:450}]};await load(page,horizontal([], [j]));before=await state(page);assert.equal(before.enemies[0].x,700);assert.equal(before.enemies[0].intent.y,450);tr=await page.evaluate(()=>inkfill.traceWorld(Math.PI,.6,160));assert.ok(tr.final.events.some(e=>e.type==='hop'));assert.equal(tr.final.enemies[0].y,450);
 await load(page,{id:'cancel-hop',ball:{x:480,y:632},enemies:[{...j,jumpPoints:[{x:700,y:200},{x:240,y:300}]}]});tr=await page.evaluate(()=>inkfill.traceWorld(-Math.PI/2,1,360));assert.ok(tr.final.events.some(e=>e.type==='hop-cancel'),'newly claimed destination cancels original intent');assert.equal(tr.final.enemies[0].x,700);
});

test('enemy actions: nest countdown, permanent freeze, children IDs and blocked spawn', async t=>{
 const page=await open(t);await load(page,horizontal([], [enemy(650,150,0,0,'nest')]));
 for(let k=0;k<3;k++)await shootAndSettle(page,k%2?0:Math.PI,.08);let s=await state(page);assert.equal(s.enemies.length,2);assert.equal(s.enemies[1].parentId,s.enemies[0].id);assert.ok(s.enemies[1].id>s.enemies[0].id);assert.equal(s.enemies[0].count,3);assert.equal(s.ends,3);
 await load(page,horizontal([orb('freeze')],[enemy(340,320,0,0,'nest')]));await shootAndSettle(page,0,.6);
 for(let k=0;k<6;k++)await shootAndSettle(page,k%2?-Math.PI/2:Math.PI/2,.12);s=await state(page);assert.equal(s.enemies.length,1);assert.equal(s.enemies[0].count,3,'frozen nest never advances its spawn countdown');
 await load(page,{id:'blocked-nest',outline:[[0,0],[60,0],[60,60],[0,60]],ball:{x:8,y:8},enemies:[enemy(30,30,0,0,'nest')]});
 for(let k=0;k<3;k++)await shootAndSettle(page,Math.PI,.025);s=await state(page);assert.equal(s.enemies.length,1);assert.equal(s.enemies[0].count,1);assert.equal(s.enemies[0].state,'blocked');assert.equal(events(s,'spawn-blocked').length,1);assert.equal(s.ends,3);
});

test('prediction: identical live timeline and detached final state for every effect and intent', async t=>{
 const page=await open(t);
 const cases=['bomb','freeze','blackhole','protect','blade'].map(kind=>horizontal([orb(kind)],[enemy(340,320),enemy(400,375)]));
 cases.push(horizontal([], [enemy(400,200,0,0,'charger')]),horizontal([], [enemy(400,200,0,0,'shooter')]),horizontal([], [enemy(650,150,0,0,'nest')]),horizontal([], [{...enemy(700,200,0,0,'jumper'),jumpPoints:[{x:700,y:200},{x:700,y:450}]}]));
 cases.push(horizontal([], [{...enemy(700,200,90,100),patrol:[{x:650,y:150},{x:750,y:250}]}]),horizontal([orb('freeze')],[{...enemy(340,320,90,40),patrol:[{x:340,y:280},{x:340,y:360}]}]));
 for(const scenario of cases){await load(page,scenario);const before=await state(page),g=await page.evaluate(()=>inkfill.guide(0,.6));assert.deepEqual(await state(page),before,'guide cannot mutate live world');const live=await page.evaluate(n=>inkfill.traceWorld(0,.6,n),g.frames);assert.deepEqual(live.timeline,g.timeline);assert.deepEqual(live.final,g.final);}
 const edgeCases=[{scenario:{id:'bullet-preview',ball:{x:480,y:632},enemies:[enemy(660,470,0,0,'shooter')]},a:-Math.PI/2,p:.6,event:'tear'}, {scenario:{id:'hop-preview',ball:{x:480,y:632},enemies:[{...enemy(700,200,0,0,'jumper'),jumpPoints:[{x:700,y:200},{x:240,y:300}]}]},a:-Math.PI/2,p:1,event:'hop-cancel'}, {scenario:horizontal([],[enemy(650,150,0,0,'nest')]),a:0,p:.025,event:'spawn',pre:2}];
 for(const {scenario,a,p,event,pre=0}of edgeCases){await load(page,scenario);for(let k=0;k<pre;k++)await shootAndSettle(page,0,.025);const before=await state(page),g=await page.evaluate(({a,p})=>inkfill.guide(a,p),{a,p});assert.deepEqual(await state(page),before);assert.ok(g.effects.some(e=>e.type===event),'guide reaches '+event);const live=await page.evaluate(({a,p,n})=>inkfill.traceWorld(a,p,n),{a,p,n:g.frames});assert.deepEqual(live.timeline,g.timeline);assert.deepEqual(live.final,g.final);}
 await load(page,horizontal());const g=await page.evaluate(()=>inkfill.guide(0,1));if(g.horizon==='horizon')assert.equal(g.stop,null,'moving horizon is not a stop');
});

test('enemy actions: freeze permanently stops special clocks; fired bullets survive owner removal',async t=>{
 const page=await open(t);
 for(const kind of ['charger','shooter','jumper']){
  const e=enemy(340,320,0,0,kind);if(kind==='jumper')e.jumpPoints=[{x:340,y:320},{x:600,y:450}];
  await load(page,horizontal([orb('freeze')],[e]));await shootAndSettle(page,0,.6);
  for(let k=0;k<6;k++){await shootAndSettle(page,k%2?-Math.PI/2:Math.PI/2,.12);const s=await state(page);assert.equal(s.enemies[0].frozen,true);assert.equal(s.enemies[0].clock,0);assert.equal(s.enemies[0].intent,null);assert.ok(!s.events.some(ev=>['fire','hop','dash'].includes(ev.type)),kind+' stays inactive across later shots');}
 }
 await load(page,horizontal([orb('freeze')],[enemy(340,320,0,0,'eraser')],{ball:{x:8,y:320}}));await shootAndSettle(page,Math.PI,.025);const marked=await state(page);assert.ok(marked.enemies[0].target);await shootAndSettle(page,0,.6);
 for(let k=0;k<6;k++){await shootAndSettle(page,k%2?-Math.PI/2:Math.PI/2,.12);const s=await state(page);assert.equal(s.enemies[0].frozen,true);assert.equal(s.enemies[0].count,3);assert.deepEqual(s.enemies[0].target,marked.enemies[0].target);assert.ok(s.inkCount>=marked.inkCount);assert.equal(events(s,'erase').length,0,'frozen eraser never resolves its pending mark');}
 // The player must roll past the .9 s firing cue before transferring motion into the bomb.
 await load(page,horizontal([orb('bomb',700)],[enemy(850,320,0,0,'shooter')]));await shootAndSettle(page,0,.75);const s=await state(page);assert.equal(s.enemies.length,0);assert.equal(s.lives,2);assert.ok(s.events.findIndex(e=>e.type==='fire')<s.events.findIndex(e=>e.type==='remove'));assert.ok(s.events.findIndex(e=>e.type==='remove')<s.events.findIndex(e=>e.type==='tear'),'already-fired bullet survives owner death');
});

test('enemy actions: nest global and parent caps, eraser countdown and death cancellation',async t=>{
 const page=await open(t);await load(page,{id:'caps',ball:{x:100,y:632},enemies:[enemy(150,200),...[250,650].map(x=>enemy(x,150,0,0,'nest'))]});
 for(let k=0;k<9;k++)await shootAndSettle(page,k%2?0:Math.PI,.025);let s=await state(page);assert.equal(s.enemies.length,6);const nests=s.enemies.filter(e=>e.kind==='nest');for(const nest of nests)assert.ok(s.enemies.filter(e=>e.parentId===nest.id).length<=2);assert.ok(nests.some(nest=>s.enemies.filter(e=>e.parentId===nest.id).length===2),'a parent reaches its own cap before the global cap blocks further growth');assert.equal(new Set(s.enemies.map(e=>e.id)).size,6);assert.ok(events(s,'spawn-blocked').length>0);
 await load(page,{id:'erase',ball:{x:240,y:632},enemies:[enemy(760,160,0,0,'eraser')]});await shootAndSettle(page,-Math.PI/2,1);s=await state(page);assert.equal(s.enemies[0].count,3);assert.ok(s.enemies[0].target);const target=s.enemies[0].target,ink=s.inkCount;
 for(let k=0;k<3;k++)await shootAndSettle(page,Math.PI,.025);s=await state(page);assert.ok(events(s,'erase').length===1);assert.ok(s.inkCount<ink);assert.equal(at(s,target.x,target.y),1);
 await shootAndSettle(page,Math.PI,.025);s=await state(page);assert.ok(s.enemies[0].target,'eraser marks again on a later ending');
 await load(page,{id:'erase-death',ball:{x:480,y:632},orbs:[orb('bomb',480,500)],enemies:[enemy(480,340,0,0,'eraser')]});await shootAndSettle(page,Math.PI,.025);s=await state(page);assert.ok(s.enemies[0].target);const id=s.enemies[0].id;await shootAndSettle(page,Math.atan2(500-s.ball.y,480-s.ball.x),.75);s=await state(page);assert.ok(events(s,'remove').some(e=>e.id===id));assert.equal(s.enemies.length,0);for(let k=0;k<3;k++){await shootAndSettle(page,Math.PI,.025);assert.equal(events(await state(page),'erase').length,0,'dead eraser has no deferred erase');}
});

test('persistence: v2 through v6 stay unchanged, v7 records are preserved, and corrupt storage plays',async t=>{
  const page=await open(t),old='{"first-line":3,"final":2}';
  await page.evaluate(old=>{
    for(const v of ['v2','v3','v4','v5','v6'])localStorage.setItem('inkfill.stars.'+v,old);
    localStorage.removeItem('inkfill.stars.v7');
    localStorage.setItem('inkfill.theme.v2',JSON.stringify('minhwa'));localStorage.setItem('inkfill.guides.v1','false');
  },old);
  await page.reload();await page.clock.runFor(34);await page.locator('[data-action="home-start"]').click();
  assert.equal((await state(page)).themeMode,'minhwa');assert.equal((await state(page)).guides,false);
  assert.equal((await state(page)).progress.unlockedThrough,0);
  assert.equal(await page.evaluate(()=>localStorage.getItem('inkfill.stars.v7')),null);
  assert.equal(await page.locator('#toast').innerText(),'');
  await page.getByRole('button',{name:'시작',exact:true}).click();
  await openStages(page);
  await page.getByRole('button',{name:/^1\. 첫 선, 별 0개$/}).waitFor();
  await playRoute(page,'first-line',ROUTES['first-line']);
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('inkfill.stars.v7'))['first-line']),3);
  await page.evaluate(()=>localStorage.setItem('inkfill.stars.v7','{bad'));
  await page.reload();await page.clock.runFor(34);await page.locator('[data-action="home-start"]').click();
  assert.equal((await state(page)).progress.unlockedThrough,0);
  assert.equal((await playRoute(page,'first-line',ROUTES['first-line'])).result,'win');
  assert.deepEqual(await page.evaluate(()=>['v2','v3','v4','v5','v6'].map(v=>localStorage.getItem('inkfill.stars.'+v))),[old,old,old,old,old]);
});

test('orb effects: gathering precedes blast and multiple blackholes select the nearest source',async t=>{
 const page=await open(t);
 await load(page,horizontal([orb('blackhole'),orb('blackhole',300)],[enemy(460,220)]));const tr=await page.evaluate(()=>inkfill.traceWorld(0,.2,250));assert.ok(tr.timeline.some(s=>s.orbs.filter(o=>o.armed).length===2));const e=tr.final.enemies[0],nearest=tr.final.orbs.slice().sort((a,b)=>Math.hypot(a.x-e.x,a.y-e.y)-Math.hypot(b.x-e.x,b.y-e.y)||a.id-b.id)[0];assert.equal(e.blackholeId,nearest.id,'nearest active source owns attraction');assert.equal(events(tr.final,'remove').length,0);
 await load(page,horizontal([orb('blackhole'),orb('bomb',230,350)],[enemy(300,512,270,70),enemy(350,512,270,70),enemy(700,120)]));await shootAndSettle(page,0,.2);let s=await state(page);assert.equal(events(s,'blackhole').length,1);assert.equal(s.enemies.length,3);const gatheredIds=s.enemies.slice(0,2).map(e=>e.id);assert.ok(s.enemies.slice(0,2).every(e=>e.y<360),'both bodies are gathered before the next shot');const angle=Math.atan2(30,230-s.ball.x);await shootAndSettle(page,angle,.6);s=await state(page);assert.equal(events(s,'bomb').length,1);assert.deepEqual(events(s,'remove').map(e=>e.id),gatheredIds);assert.equal(s.enemies.length,1);assert.equal(s.enemies[0].x,700,'the distant enemy survives the gathered blast');
});

test('territory: real ink-crossing hop changes later enclosure occupancy',async t=>{
 const page=await open(t);
 let s;
 await load(page,{id:'hop-cut',ball:{x:480,y:400},blockers:[[[468,0],[492,0],[492,232],[468,232]],[[468,408],[492,408],[492,640],[468,640]]],enemies:[enemy(720,100),{...enemy(400,320,0,60,'jumper'),jumpPoints:[{x:400,y:320},{x:560,y:320},{x:680,y:350}]}]});
 const tr=await page.evaluate(()=>inkfill.traceWorld(-Math.PI/2,1,420));const commit=tr.timeline.find(s=>s.events.some(e=>e.type==='commit'&&e.cut));assert.ok(commit.enemies.find(e=>e.kind==='jumper').x<480,'source protects left region before hop');assert.ok(tr.final.events.some(e=>e.type==='hop'));assert.equal(at(tr.final,480,320),2);assert.equal(at(tr.final,200,320),1);assert.equal(at(tr.final,720,100),1);assert.ok(tr.final.enemies.find(e=>e.kind==='jumper').x>480);await page.evaluate(()=>inkfill.settle());await shootAndSettle(page,Math.PI,1);s=await state(page);assert.equal(at(s,200,320),2,'later closure uses destination occupancy');assert.equal(at(s,720,100),1);
});


test('home presents the centered menu over the board backdrop in four languages and responsive sizes without changing progress', {timeout:90000}, async t=>{
  const p=await open(t,{home:true,reducedMotion:'reduce'});
  const initial=await state(p);
  assert.equal(initial.panel,'home');assert.equal(initial.shots,0);
  assert.equal(await p.locator('#hud').isVisible(),false);
  assert.equal(await p.locator('[data-action="home-start"]').evaluate(e=>e===document.activeElement),true);
  await p.keyboard.press('r');await p.keyboard.press('Escape');await p.clock.runFor(2500);
  assert.deepEqual(await state(p),initial,'home presentation never advances or restarts the live stage');
  assert.equal(await p.evaluate(()=>localStorage.getItem('inkfill.stars.v7')),null);
  // The backdrop is one isolated shot on the retained campaign board: it claims ground and costs no heart.
  const backdrop=await p.evaluate(()=>({ink:homePreview.world.inkCount/homePreview.world.playable*100,lives:homePreview.world.lives,shots:homePreview.world.shots,stage:homePreview.world.stage.id,aimed:!!homePreview.world.stage.preview}));
  assert.deepEqual([backdrop.stage,backdrop.shots,backdrop.lives,backdrop.aimed],['gather-and-guard',1,3,false]);assert.ok(backdrop.ink>=15,'the backdrop shows claimed ground: '+backdrop.ink);
  const stageCaptions={ko:'스테이지 1',en:'Stage 1','zh-Hans':'第 1 关',ja:'ステージ 1'};
  for(const code of Object.keys(stageCaptions)){
    await p.getByRole('combobox').selectOption(code);
    assert.equal(await p.getByText(stageCaptions[code],{exact:true}).isVisible(),true,'the ready stage is readable in the selected language');
    for(const [width,height] of [[1440,900],[1024,768],[844,390],[667,375],[568,320],[390,844],[320,568]]){
      await p.setViewportSize({width,height});await p.clock.runFor(40);
      const bounds=await p.locator('.home-menu button, .home-language select').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}}));
      for(const r of bounds){assert.ok(r.x>=0&&r.right<=width+1&&r.y>=0&&r.bottom<=height+1,code+' '+width+' '+JSON.stringify(r));assert.ok(r.height>=44);}
      assert.equal(await p.locator('#panel').evaluate(e=>e.scrollWidth<=e.clientWidth+1),true,'no horizontal home scrolling');
      assert.equal(await p.locator('.home-start').evaluate(button=>{const b=button.getBoundingClientRect();return [...button.querySelectorAll('span,svg')].every(e=>{const r=e.getBoundingClientRect();return r.left>=b.left&&r.right<=b.right&&r.top>=b.top&&r.bottom<=b.bottom;});}),true,'Start text and stage caption fit inside the single button');
      {
        const boxes=await p.locator('.home-title, .home-actions').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,cx:r.x+r.width/2}}));
        boxes.sort((a,b)=>a.top-b.top);
        for(let i=1;i<boxes.length;i++)assert.ok(boxes[i].top>=boxes[i-1].bottom,'the Home title sits above the menu');
        for(const r of boxes)assert.ok(Math.abs(r.cx-width/2)<2,'Home title and menu are centered');
      }
      if(process.env.INK_LASSO_HOME_SHOTS&&code==='ko'){
        const fs=require('node:fs/promises');await fs.mkdir(process.env.INK_LASSO_HOME_SHOTS,{recursive:true});
        await p.screenshot({path:path.join(process.env.INK_LASSO_HOME_SHOTS,'home-'+width+'.png')});
      }
    }
    assert.deepEqual(await state(p),initial);
  }
  await p.locator('[data-action="settings"]').click();
  assert.equal((await state(p)).panel,'pause');
  await p.locator('[data-action="guides"]').click();
  await p.locator('[data-action="motion"]').click();
  await p.locator('[data-action="resume"]').click();
  assert.equal((await state(p)).panel,'home');
  assert.equal((await state(p)).shots,initial.shots);
  await p.getByRole('combobox').focus();await p.keyboard.press('Tab');assert.equal(await p.locator('[data-action="home-start"]').evaluate(e=>e===document.activeElement),true);
});

test('home stages return home, start reaches the tutorial, and home preserves an active shot',async t=>{
  const p=await open(t,{home:true,url:hostedGameUrl});
  await p.getByRole('combobox').selectOption('en');
  assert.deepEqual(await p.locator('.home-menu button').allInnerTexts().then(a=>a.map(s=>s.replace(/\s+/g,' ').trim())),['Start Stage 1','Stages','Settings'],'home names its three actions in text');
  assert.equal(await p.locator('.home-art').evaluate(e=>{const r=e.getBoundingClientRect();return r.width===innerWidth&&r.height===innerHeight;}),true,'the board backdrop fills the screen');
  await p.getByRole('button',{name:'Stages',exact:true}).click();
  assert.equal(await p.locator('.stage-tile:disabled').count(),0);
  assert.equal(await p.locator('.stage-tile:enabled').count(),52);
  await p.getByRole('button',{name:'Back',exact:true}).click();assert.equal((await state(p)).panel,'home');
  await p.getByRole('button',{name:'Start',exact:true}).click();assert.equal((await state(p)).panel,'intro');
  await p.getByRole('button',{name:'Start',exact:true}).click();assert.equal((await state(p)).panel,null);
  assert.equal(await p.locator('#hud').isVisible(),true);
  await p.evaluate(()=>inkfill.shoot(-Math.PI/2,.7));await p.clock.runFor(100);
  await p.locator('#menu').click();await p.getByRole('button',{name:'Home',exact:true}).click();
  const held=await state(p);await p.clock.runFor(3000);assert.deepEqual(await state(p),held);
  // Click and read in one task: real time keeps flowing, so a frame between them would advance the resumed shot.
  const resumed=await p.evaluate(()=>{document.querySelector('[data-action="home-start"]').click();return inkfill.state();});
  assert.deepEqual({...resumed,panel:'home'},held,'resume retains the exact active shot');
  await p.clock.runFor(100);assert.notDeepEqual((await state(p)).ball,held.ball);
  await p.reload();await p.clock.runFor(40);assert.equal((await state(p)).panel,'home');
  assert.equal(await p.locator('html').getAttribute('lang'),'en');
});

test('focus indication follows keyboard use while retaining programmatic panel focus', async t => {
  const p = await open(t, {home: true});
  const outline = () => p.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  assert.equal(await p.locator('[data-primary]').evaluate(e => e === document.activeElement), true);
  assert.equal(await outline(), 'none', 'fresh home has no focus ring');
  await p.keyboard.press('Tab');
  assert.equal(await outline(), 'solid', 'Tab exposes the focused control');
  await p.locator('[data-action="home-start"]').click();
  assert.equal(await outline(), 'none', 'pointer entry into another panel clears the ring');
  await p.keyboard.press('Tab');
  assert.equal(await outline(), 'solid', 'keyboard focus remains visible inside the tutorial');
  await p.locator('[data-action="start"]').focus(); await p.keyboard.press('Enter');
  assert.equal(await outline(), 'solid', 'keyboard entry shows focus on the board');
});

test('touch aim: a wide cancel zone, a cancel target in place of the controls, and a second finger all cancel without a shot', async t => {
  for (const [width, height] of [[844, 390], [390, 844]]) {
    const p = await open(t, { viewport: { width, height }, hasTouch: true });
    await p.locator('[data-action="start"]').click();
    const cdp = await p.context().newCDPSession(p);
    const touch = (type, ...points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
    const [from, far] = await p.evaluate(() => [toClient(480, 320), toClient(480, 500)]);
    const shots = async () => (await state(p)).shots, aiming = () => p.evaluate(() => document.body.classList.contains('aiming'));
    await touch('touchStart', from); await touch('touchMove', far);
    assert.equal(await p.locator('#aim-cancel').isVisible(), true, 'the cancel target shows while a finger aims');
    const c = await p.locator('#aim-cancel').boundingBox(), m = await p.locator('#controls').boundingBox();
    assert.ok(c.width >= 44 && c.height >= 44 && Math.abs(c.width - m.width) < 1 && Math.abs(c.height - m.height) < 1, 'it covers the controls without moving the layout');
    await touch('touchMove', [from[0] + 20, from[1]]); await touch('touchEnd');
    assert.equal(await shots(), 0, 'letting go inside the cancel zone fires nothing');
    await touch('touchStart', from); await touch('touchMove', far); await touch('touchMove', [c.x + c.width / 2, c.y + c.height / 2]);
    await p.locator('#aim-cancel.hot').waitFor({ timeout: 2000 });   // the target lights up under the finger; moves arrive with the next real frame
    await touch('touchEnd');
    assert.equal(await shots(), 0, 'letting go on the cancel target fires nothing');
    assert.equal(await p.locator('#aim-cancel').isVisible(), false); assert.equal(await p.locator('#menu').isVisible(), true);
    await touch('touchStart', from); await touch('touchMove', far); await touch('touchStart', far, [from[0], from[1] - 40]);
    assert.equal(await aiming(), false, 'a second finger cancels the aim');
    await touch('touchEnd'); assert.equal(await shots(), 0);
    await touch('touchStart', from); await touch('touchMove', far); await touch('touchEnd');
    assert.equal(await shots(), 1, 'a full pull still fires');
  }
});

test('tutorial motion control has a 44×44 touch target on narrow screens', async t => {
  for (const [width, height] of [[390,844], [320,568]]) {
    const p = await open(t, {viewport: {width,height}, hasTouch: true});
    const b = await p.locator('.lesson-motion').boundingBox();
    assert.ok(b.width >= 44 && b.height >= 44);
    await p.locator('.lesson-motion').tap();
    assert.equal(await p.locator('.lesson-motion').getAttribute('aria-pressed'), 'true');
  }
});

test('a real teaching toast clears its text after a stage change', async t => {
  // CSS transitions use real compositor time; this case controls them through the supported motion preference.
  const p = await open(t, {reducedMotion: 'reduce'});
  await load(p, {id:'toast-wall', enemies:[enemy(300,300)], ball:{x:900,y:632}});
  await shootAndSettle(p, 0, .2); await p.clock.runFor(300);
  assert.equal(await p.locator('#toast').evaluate(e => e.classList.contains('hidden')), false, 'wall contact shows a real teaching toast');
  assert.ok((await p.locator('#toast').textContent()).length > 0);
  await load(p, 'gather-and-guard'); await p.clock.runFor(300);
  assert.equal(await p.locator('#toast').evaluate(e => getComputedStyle(e).opacity), '0');
  assert.equal(await p.locator('#toast').textContent(), '', 'old teaching text cannot return on the later stage');
});

test('startup keeps game chrome hidden before the Home script initializes', async t => {
  // Hold initialization at the browser's script-execution boundary to expose the first HTML paint.
  const context = await browser.newContext({javaScriptEnabled:false, viewport:{width:390,height:844}});
  t.after(() => context.close());
  const p = await context.newPage(); await p.goto(gameUrl);
  for (const selector of ['#hud','#board','#toast','#overlay']) {
    assert.equal(await p.locator(selector).isVisible(), false, selector + ' never flashes before Home');
  }
});

// ─── Terrain, bosses and the later enemies and orbs ─────────────────────────
const zone = (kind, x0, y0, x1, y1, dir) => ({ kind, x0, y0, x1, y1, ...(dir != null && { dir }) });
const speedOf = a => Math.hypot(a.vx, a.vy);
const giant = (kind, x, y, hp = 3, extra = {}) => ({ ...enemy(x, y, 0, 0, kind), boss: true, hp, ...extra });
const parity = async (page, scenario, angle, power) => {
 await load(page, scenario); const before = await state(page), g = await page.evaluate(([a, p]) => inkfill.guide(a, p), [angle, power]);
 assert.deepEqual(await state(page), before, 'prediction leaves the live world alone');
 const live = await page.evaluate(([a, p, n]) => inkfill.traceWorld(a, p, n), [angle, power, g.frames]);
 assert.deepEqual(live.timeline, g.timeline); assert.deepEqual(live.final, g.final); return g;
};

test('terrain: a boost pad throws rolling balls along its arrows and a swamp bogs them down, while enemies walk through', async t=>{
 const page=await open(t),pad=zone('boost',300,280,444,360,0),mud=zone('mud',300,240,476,400),far=enemy(900,60);
 const top=tr=>Math.max(...tr.timeline.map(s=>speedOf(s.ball))),past=(tr,x)=>speedOf(tr.timeline.find(s=>s.ball.x>x).ball);
 await load(page,horizontal([],[far]));const plain=await page.evaluate(()=>inkfill.traceWorld(0,.5,300));
 await load(page,horizontal([],[far],{zones:[pad]}));const boosted=await page.evaluate(()=>inkfill.traceWorld(0,.5,300));
 assert.ok(top(plain)<=600.01);assert.ok(top(boosted)>850,'the pad adds speed along its arrows');
 assert.ok(boosted.final.events.some(e=>e.type==='zone'&&e.kind==='boost'&&e.id===0));
 await load(page,horizontal([],[far],{zones:[{...pad,dir:180}]}));const against=await page.evaluate(()=>inkfill.traceWorld(0,.4,300));
 assert.ok(against.timeline.every(s=>s.ball.x<444),'a slow ball cannot push through against the arrows');assert.ok(against.final.ball.x>300&&!against.final.ball.moving,'it stalls on the pad');
 await load(page,horizontal([orb('bomb',200)],[far],{zones:[pad]}));const struck=await page.evaluate(()=>inkfill.traceWorld(0,.4,200));
 const rolling=struck.timeline.map(s=>speedOf(s.orbs[0])).filter(v=>v>0);assert.ok(Math.max(...rolling)>rolling[0]+200,'a struck orb is thrown by the pad too');
 await load(page,horizontal([],[far],{zones:[mud]}));await shootAndSettle(page,0,.5);let s=await state(page);
 assert.ok(s.ball.x>300&&s.ball.x<476,'a moderate shot dies inside the swamp');assert.ok(s.wetCount>0,'and leaves its trail unfinished');
 await load(page,horizontal([],[far]));await shootAndSettle(page,0,.5);assert.ok((await state(page)).ball.x>560,'the same shot crosses plain ground');
 await load(page,horizontal([],[far],{zones:[mud]}));const waded=await page.evaluate(()=>inkfill.traceWorld(0,1,200));
 await load(page,horizontal([],[far]));const dry=await page.evaluate(()=>inkfill.traceWorld(0,1,200));
 assert.ok(past(waded,476)<past(dry,476)-300,'even a full shot comes out of the swamp much slower');
 await load(page,{id:'walkers',ball:{x:100,y:600},zones:[pad,zone('mud',500,260,676,396)],enemies:[enemy(320,320,0,60),enemy(520,330,0,60)]});
 const walk=await page.evaluate(()=>inkfill.traceWorld(0,.3,120));
 assert.ok(walk.timeline.every(s=>s.enemies.every(e=>Math.abs(speedOf(e)-60)<1e-6)),'enemies keep their own pace on both kinds of ground');
 await parity(page,horizontal([orb('bomb',200)],[enemy(760,320)],{zones:[pad,zone('mud',520,240,640,400)]}),0,.6);
});

test('terrain: a protected zone keeps bodies, bullets, hops and spawns out while the ball passes freely', async t=>{
 const page=await open(t),haven=zone('haven',400,200,560,440);
 await load(page,{id:'fence',ball:{x:100,y:600},zones:[haven],enemies:[enemy(300,320,0,80)]});
 let tr=await page.evaluate(()=>inkfill.traceWorld(0,.3,240));
 assert.ok(tr.timeline.every(s=>s.enemies[0].x<=385.01),'a walker never overlaps the zone');assert.ok(tr.timeline.some(s=>s.enemies[0].vx<0),'it turns back at the fence');
 await load(page,horizontal([],[enemy(900,60)],{zones:[haven]}));tr=await page.evaluate(()=>inkfill.traceWorld(0,1,120));
 assert.ok(tr.timeline.some(s=>s.ball.x>420&&s.ball.x<540&&s.ball.moving),'the ball rolls straight through');assert.ok(tr.timeline.every(s=>speedOf(s.ball)<=1200.01),'and gains nothing from it');
 const shooter=enemy(660,470,0,0,'shooter');
 await load(page,{id:'open-fire',ball:{x:480,y:632},enemies:[shooter]});tr=await page.evaluate(()=>inkfill.traceWorld(-Math.PI/2,.6,360));assert.equal(tr.final.lives,2,'control: the bullet reaches the trail');
 await load(page,{id:'fenced-fire',ball:{x:480,y:632},zones:[zone('haven',404,520,556,636)],enemies:[shooter]});tr=await page.evaluate(()=>inkfill.traceWorld(-Math.PI/2,.6,360));
 assert.ok(tr.final.events.some(e=>e.type==='fire'));assert.equal(tr.final.lives,3,'the bullet stops at the fence');assert.equal(events(tr.final,'tear').length,0);
 await load(page,horizontal([],[{...enemy(700,200,0,0,'jumper'),jumpPoints:[{x:700,y:200},{x:480,y:320}]}],{zones:[haven]}));
 let s=await state(page);assert.equal(s.enemies[0].intent,null);assert.equal(s.enemies[0].state,'blocked','a landing inside the zone is never chosen');
 await load(page,{id:'fenced-nest',ball:{x:100,y:600},zones:[haven],enemies:[enemy(370,320,0,0,'nest')]});
 for(let k=0;k<3;k++)await shootAndSettle(page,k%2?0:Math.PI,.08);s=await state(page);
 assert.equal(s.enemies.length,2);assert.ok(s.enemies[1].x+15<=400.01||s.enemies[1].y+15<=200.01||s.enemies[1].y-15>=439.99,'offspring appear outside the zone');
 await assert.rejects(page.evaluate(z=>inkfill.load({id:'inside',zones:[z],enemies:[{kind:'basic',x:480,y:320,dir:0,speed:0}]}),haven),/protected zone/);
});

test('terrain: spikes cost the ball a heart once per approach and finish any enemy that touches them', async t=>{
 const page=await open(t),spikes=[{a:[960,200],b:[960,440]}];
 await load(page,horizontal([],[enemy(500,80)],{spikes}));await shootAndSettle(page,0,.9);let s=await state(page);
 assert.equal(s.lives,2);assert.equal(s.wetCount,0);assert.deepEqual(events(s,'tear').map(e=>e.source),['spike']);assert.ok(s.ball.x>930&&s.ball.x<950,'the teeth stop the ball at the wall');
 await load(page,horizontal([],[enemy(500,80)],{spikes,ball:{x:100,y:560}}));await shootAndSettle(page,0,.9);s=await state(page);
 assert.equal(s.lives,3,'the same wall is harmless beside the teeth');assert.ok(s.commits>0);
 await load(page,horizontal([orb('protect',170)],[enemy(500,80)],{spikes}));await shootAndSettle(page,0,.9);s=await state(page);
 assert.equal(s.lives,3);assert.deepEqual(events(s,'protect-block').map(e=>e.source),['spike'],'a shield absorbs one approach');assert.ok(s.commits>0,'and the ball banks off the wall as usual');
 await load(page,{id:'walk-in',ball:{x:100,y:600},spikes,enemies:[enemy(880,320,0,90)]});let tr=await page.evaluate(()=>inkfill.traceWorld(0,.3,200));
 assert.deepEqual(events(tr.final,'remove').map(e=>e.kind),['spike'],'a walker that reaches the teeth is finished');assert.equal(tr.final.enemies.length,0);
 await load(page,{id:'giant-in',ball:{x:100,y:600},spikes,enemies:[{...enemy(840,320,0,90),boss:true,hp:3}]});tr=await page.evaluate(()=>inkfill.traceWorld(0,.3,200));
 assert.equal(tr.final.enemies[0].hp,2,'a boss loses one pip per approach');assert.equal(events(tr.final,'hurt').length,1);
 await assert.rejects(page.evaluate(k=>inkfill.load({id:'on-teeth',spikes:k,enemies:[{kind:'basic',x:940,y:320,dir:0,speed:0}]}),spikes),/spikes/);
 await parity(page,{id:'spike-preview',ball:{x:100,y:320},spikes,enemies:[enemy(880,400,0,90)]},0,.9);
});

test('enemy actions: a chaser follows the ball, a splitter breaks in two unless frozen, and a mine blows up what its ring can see', async t=>{
 const page=await open(t);
 await load(page,{id:'chase',ball:{x:100,y:600},enemies:[enemy(700,150,0,90,'chaser')]});
 let tr=await page.evaluate(()=>inkfill.traceWorld(0,.5,200));
 const gap=s=>Math.hypot(s.enemies[0].x-s.ball.x,s.enemies[0].y-s.ball.y),facing=s=>Math.abs(Math.atan2(s.ball.y-s.enemies[0].y,s.ball.x-s.enemies[0].x)-s.enemies[0].intent.angle);
 assert.ok(tr.timeline.slice(1).every(s=>facing(s)<.02),'it always faces the ball');assert.ok(gap(tr.timeline.at(-1))<gap(tr.timeline[0])-200,'and closes on it');
 assert.ok(tr.timeline.slice(1).every((s,i)=>Math.abs(Math.hypot(s.enemies[0].x-tr.timeline[i].enemies[0].x,s.enemies[0].y-tr.timeline[i].enemies[0].y)-.75)<.01),'at its own steady pace');
 // territory still stops it: it slides along the edge instead of crossing
 await load(page,{id:'chase-edge',ball:{x:480,y:632},enemies:[enemy(760,160,0,90,'chaser')]});await shootAndSettle(page,-Math.PI/2,1);
 let s=await state(page);assert.equal(at(s,200,320),2,'the far side is claimed');const held={...s.enemies[0]};
 await shootAndSettle(page,Math.PI,.5);s=await state(page);
 assert.equal(at(s,s.enemies[0].x,s.enemies[0].y),1,'the chaser stays on paper');assert.ok(s.enemies[0].x>=486,'outside the claimed side');
 assert.ok(Math.hypot(s.enemies[0].x-held.x,s.enemies[0].y-held.y)>60,'yet it kept moving along the edge');
 // splitter
 await load(page,horizontal([orb('blade',170)],[enemy(340,320,0,0,'splitter')]));await shootAndSettle(page,0,.6);s=await state(page);
 assert.deepEqual(events(s,'remove').map(e=>e.kind),['blade']);assert.equal(events(s,'split').length,1);
 assert.equal(s.enemies.length,2);assert.ok(s.enemies.every(e=>e.kind==='basic'&&e.r===10&&e.parentId!=null),'two small plain bodies remain');
 assert.equal(s.lives,3,'the halves start clear of the trail that cut them');assert.ok(Math.min(...s.enemies.map(e=>e.y))<296&&Math.max(...s.enemies.map(e=>e.y))>344,'and drift apart sideways');
 await load(page,horizontal([orb('bomb')],[enemy(340,320,0,0,'splitter')]));await shootAndSettle(page,0,.6);s=await state(page);
 assert.equal(events(s,'bomb').length,1);assert.equal(s.enemies.length,2,'the halves outlive the blast that made them');
 await load(page,horizontal([orb('freeze',200),orb('blade',100,200)],[enemy(340,320,0,0,'splitter')]));await shootAndSettle(page,0,.6);s=await state(page);assert.equal(s.enemies[0].frozen,true);
 await shootAndSettle(page,Math.atan2(200-s.ball.y,100-s.ball.x),.4);s=await state(page);assert.equal(s.blade,1);
 await shootAndSettle(page,Math.atan2(320-s.ball.y,340-s.ball.x),.6);s=await state(page);assert.equal(s.enemies.length,0,'frozen solid, it breaks without splitting');assert.equal(events(s,'split').length,0);
 // mine
 const field=[enemy(500,320,0,0,'mine'),enemy(560,280),enemy(800,100)],bank={id:'mine',ball:{x:200,y:300},enemies:[enemy(520,520,0,0,'mine'),enemy(560,470),enemy(800,100)]},slant=40*Math.PI/180;
 await load(page,bank);tr=await page.evaluate(a=>inkfill.traceWorld(a,1,360),slant);
 const order=type=>tr.final.events.findIndex(e=>e.type===type);
 assert.ok(order('fuse')>=0&&order('fuse')<order('commit')&&order('commit')<order('mine'),'the ball crosses the ring and banks before the fuse runs out');
 assert.deepEqual(events(tr.final,'remove').map(e=>e.kind),['mine','mine'],'the mine goes, and takes the neighbour its ring can see');
 assert.deepEqual(tr.final.enemies.map(e=>e.x),[800]);assert.equal(tr.final.lives,3,'a trail that is already finished is safe');
 assert.ok(Math.abs(tr.final.events[order('mine')].t-tr.final.events[order('fuse')].t-.7)<.02,'the fuse always burns the same time');
 await load(page,{id:'mine-slow',ball:{x:100,y:400},enemies:field});await shootAndSettle(page,0,.45);s=await state(page);
 assert.equal(s.lives,2);assert.deepEqual(events(s,'tear').map(e=>e.source),['mine'],'an unfinished trail inside the ring is blown away');assert.ok(s.ball.moving===false&&events(s,'mine').length===1,'the shot waited for the fuse');
 await load(page,{id:'mine-guard',ball:{x:100,y:400},orbs:[orb('protect',170,400)],enemies:field});await shootAndSettle(page,0,.45);s=await state(page);
 assert.equal(s.lives,3);assert.deepEqual(events(s,'protect-block').map(e=>e.source),['mine']);
 await load(page,{id:'mine-far',ball:{x:100,y:600},enemies:field});await shootAndSettle(page,0,1);s=await state(page);
 assert.equal(events(s,'fuse').length,0,'a ball that stays outside the ring leaves it sleeping');assert.equal(s.enemies.length,3);
 await load(page,{id:'mine-frozen',ball:{x:100,y:400},orbs:[orb('freeze',300,400)],enemies:[enemy(500,360,0,0,'mine'),enemy(800,100)]});await shootAndSettle(page,0,.5);s=await state(page);
 assert.equal(s.enemies[0].frozen,true);await shootAndSettle(page,0,.4);s=await state(page);assert.equal(events(s,'fuse').length,0,'a frozen mine never arms');
 await parity(page,bank,slant,1);
 await parity(page,horizontal([orb('blade',170)],[enemy(340,320,0,0,'splitter'),enemy(700,150,0,90,'chaser')]),0,.6);
});

test('orb effects: a heart restores one lost heart and an ink orb claims the ground where it is struck', async t=>{
 const page=await open(t);
 await load(page,horizontal([orb('heart')],[enemy(700,100)]));await shootAndSettle(page,0,.3);let s=await state(page);
 assert.equal(s.orbs.length,1,'with full hearts the orb stays');assert.equal(s.lives,3);assert.ok(s.ball.x>230,'and the ball rolls through it');assert.equal(events(s,'contact').length,0);
 await load(page,horizontal([orb('heart',200,500)],[enemy(340,320)]));await shootAndSettle(page,0,.6);s=await state(page);assert.equal(s.lives,2);
 await shootAndSettle(page,Math.atan2(500-s.ball.y,200-s.ball.x),.5);s=await state(page);
 assert.equal(s.lives,3,'one lost heart comes back');assert.equal(s.orbs.length,0);assert.deepEqual(events(s,'heart').map(e=>e.lives),[3]);assert.ok(Math.hypot(s.ball.x-200,s.ball.y-500)>30,'the pickup does not stop the ball');
 await page.clock.runFor(34);assert.equal(await page.locator('#lives').getAttribute('aria-label'),'남은 하트 3개');
 await load(page,{id:'hurt-start',lives:2,ball:{x:100,y:320},orbs:[orb('heart')],enemies:[enemy(700,100)]});assert.equal((await state(page)).lives,2,'a board may start with a heart to win back');
 await shootAndSettle(page,0,.3);assert.equal((await state(page)).lives,3);
 await assert.rejects(page.evaluate(()=>inkfill.load({id:'too-many',lives:5})),/Invalid stage/);
 // ink
 await load(page,{id:'blot',ball:{x:8,y:320},orbs:[orb('ink',300)],enemies:[enemy(800,100)]});
 let tr=await page.evaluate(()=>inkfill.traceWorld(0,1,40)),hit=tr.timeline.find(f=>f.events.some(e=>e.type==='splat'));
 assert.ok(hit&&speedOf(hit.ball)>900,'the ball keeps its speed through the orb');assert.ok(hit.events.findIndex(e=>e.type==='splat')<hit.events.findIndex(e=>e.type==='commit'),'the trail that reached the blot is finished at once');
 await page.evaluate(()=>inkfill.settle());s=await state(page);
 assert.equal(at(s,300,320),2);assert.equal(at(s,300,272),2,'a disc around the orb is claimed');assert.equal(s.orbs.length,0);assert.equal(s.lives,3);
 assert.equal(at(s,480,500),2,'the blot anchored the rest of the cut: the empty side fills');assert.equal(at(s,480,100),1,'the occupied side stays');assert.ok(s.closures>0);
 await load(page,horizontal([orb('ink',300)],[enemy(700,100)],{target:1}));await shootAndSettle(page,0,.6);s=await state(page);
 assert.equal(s.result,'win','a blot that reaches the target wins by itself');assert.ok(s.inkCount>500&&s.inkCount<800);
 await load(page,horizontal([orb('ink',300)],[enemy(300,278,0,50)]));await shootAndSettle(page,0,.4);s=await state(page);
 const pocket={x:s.enemies[0].x,y:s.enemies[0].y};
 assert.equal(at(s,pocket.x,pocket.y),1,'an enemy inside the blot keeps a pocket of paper');assert.equal(at(s,260,320),2);assert.equal(s.lives,3);
 for(let k=0;k<3;k++)await shootAndSettle(page,k%2?0:Math.PI,.12);s=await state(page);
 assert.ok(Math.hypot(s.enemies[0].x-pocket.x,s.enemies[0].y-pocket.y)<=12,'and is shut inside it');
 await load(page,horizontal([orb('ink',300)],[enemy(700,100)],{blockers:[[[330,200],[340,200],[340,440],[330,440]]]}));await shootAndSettle(page,0,.4);s=await state(page);
 assert.equal(at(s,270,320),2);assert.equal(at(s,350,320),1,'a wall stops the spread');
 await parity(page,{id:'blot-preview',ball:{x:8,y:320},orbs:[orb('ink',300),orb('heart',500,320)],enemies:[enemy(800,100)],lives:2},0,1);
});

test('bosses: giant bodies lose one pip per primary hit, reel for the rest of the shot, shrug off freezing and pulling, and fall with their offspring', async t=>{
 const page=await open(t);
 await load(page,horizontal([orb('blade',170),orb('blade',230)],[giant('basic',500,320,2)]));
 let s=await state(page);assert.equal(s.enemies[0].r,45,'three times the usual body');assert.equal(s.enemies[0].hp,2);
 let tr=await page.evaluate(()=>inkfill.traceWorld(0,.8,400)),hurt=tr.timeline.findIndex(f=>f.events.some(e=>e.type==='hurt'));
 assert.ok(hurt>0);assert.equal(tr.final.enemies[0].hp,1);assert.equal(tr.final.blade,1,'two stored charges still cut once per approach');
 assert.ok(tr.timeline[hurt-1].ball.vx>0&&tr.timeline[hurt+1].ball.vx<0,'the ball is knocked back');
 assert.ok(tr.timeline.slice(hurt,-1).every(f=>f.enemies[0].stun&&f.enemies[0].x===500),'the boss reels until the shot ends');
 assert.equal(tr.final.lives,3,'and cannot break the trail while it reels');
 await page.evaluate(()=>inkfill.settle());s=await state(page);assert.equal(s.enemies[0].stun,false,'it recovers for the next shot');
 await page.clock.runFor(34);
 await shootAndSettle(page,Math.atan2(320-s.ball.y,500-s.ball.x),.8);s=await state(page);
 assert.equal(s.enemies.length,0);assert.ok(events(s,'remove').some(e=>e.boss&&e.kind==='blade'),'the last pip removes it');
 await load(page,horizontal([orb('freeze')],[giant('basic',360,320)]));await shootAndSettle(page,0,.6);s=await state(page);
 assert.equal(events(s,'resist').length,1);assert.equal(s.enemies[0].frozen,false,'a boss cannot be frozen');
 await load(page,horizontal([orb('blackhole')],[giant('basic',420,180),enemy(400,430)]));await shootAndSettle(page,0,.2);s=await state(page);
 assert.deepEqual([s.enemies[0].x,s.enemies[0].y],[420,180],'a boss is too heavy to pull');assert.ok(s.enemies[1].y<430,'while ordinary bodies still are');
 await load(page,{id:'fan',ball:{x:480,y:632},enemies:[giant('shooter',700,300)]});tr=await page.evaluate(()=>inkfill.traceWorld(Math.PI,.5,130));
 const fired=events(tr.final,'fire'),aim=Math.atan2(632-300,480-700);
 assert.equal(fired.length,3,'the giant shooter fires a fan');assert.deepEqual(fired.map(e=>Math.round((e.angle-aim)*100)/100),[-.3,0,.3]);
 await load(page,{id:'queen',ball:{x:100,y:632},orbs:[orb('blade',194,558),orb('blade',250,515)],enemies:[giant('nest',650,200,2)]});
 s=await state(page);assert.equal(s.enemies[0].count,2,'the giant nest breeds every second ending');
 for(let k=0;k<2;k++)await shootAndSettle(page,Math.PI,.025);s=await state(page);
 assert.equal(s.enemies.length,2);assert.equal(s.enemies[1].parentId,s.enemies[0].id);assert.equal(s.enemies[0].count,2);
 for(let k=0;k<2&&s.enemies.some(e=>e.boss);k++){await shootAndSettle(page,Math.atan2(200-s.ball.y,650-s.ball.x),.95);s=await state(page);}
 assert.equal(s.enemies.length,0,'its offspring fall with it');assert.ok(events(s,'remove').some(e=>e.kind==='fall'));
 await load(page,{id:'hydra',ball:{x:100,y:320},orbs:[orb('blade',170,320),orb('blade',230,320)],enemies:[giant('splitter',520,320,2)]});
 await shootAndSettle(page,0,.8);s=await state(page);assert.equal(s.enemies.length,2,'a hurt giant splitter sheds one small body');assert.equal(s.enemies[1].r,10);
 await parity(page,horizontal([orb('blade',170),orb('blade',230)],[giant('charger',520,200),enemy(700,500,0,0,'mine')]),0,.8);
});


test('territory: a shield-protected body straddling a closed trail preserves both occupied sides',async t=>{
  const page=await open(t);
  await load(page,{id:'shield-cut',target:100,ball:{x:480,y:632},enemies:[enemy(480,320)],orbs:[{kind:'protect',x:480,y:550}]});
  await shootAndSettle(page,-Math.PI/2,.9);
  const s=await state(page);
  assert.equal(s.lives,3);assert.equal(s.shield,0);
  assert.ok(s.events.some(e=>e.type==='protect-block'));
  assert.ok(s.events.some(e=>e.type==='commit'&&e.cut&&e.filled===0));
  assert.equal(at(s,200,320),1);assert.equal(at(s,720,320),1);
  assert.equal(at(s,480,320),2,'the protected trail still dries');
});

test('territory: closing one paper component leaves an unrelated empty room unclaimed',async t=>{
  const page=await open(t);
  await load(page,{id:'separate-rooms',target:100,ball:{x:240,y:632},blockers:[[[464,0],[496,0],[496,640],[464,640]]],enemies:[enemy(380,160)]});
  await shootAndSettle(page,-Math.PI/2,1);
  const s=await state(page);
  assert.equal(at(s,100,320),2);assert.equal(at(s,380,320),1);
  assert.equal(at(s,720,320),1,'the cut never entered or divided the other room');
});

test('enemy actions: a wet landing cancels the committed hop without damage or alternate teleport',async t=>{
  const page=await open(t);
  await load(page,{id:'wet-landing',ball:{x:480,y:632},enemies:[{...enemy(700,200,0,0,'jumper'),jumpPoints:[{x:700,y:200},{x:480,y:500}]}]});
  assert.equal((await state(page)).enemies[0].intent.y,500);
  await shootAndSettle(page,-Math.PI/2,.3);
  const s=await state(page);
  assert.ok(s.events.some(e=>e.type==='hop-cancel'));assert.ok(!s.events.some(e=>e.type==='hop'));
  assert.equal(s.enemies[0].x,700);assert.equal(s.enemies[0].y,200);assert.equal(s.lives,3);
  assert.equal(at(s,480,500),3);
});

test('enemy actions: rolling starts their clock and stopping the player pauses autonomy during the orb tail',async t=>{
  const page=await open(t);
  await load(page,{id:'rolling-window',target:100,ball:{x:300,y:320},enemies:[enemy(750,120,90,80),enemy(700,540,0,0,'shooter')],orbs:[{kind:'freeze',x:350,y:320}]});
  const idle=await state(page);await page.clock.runFor(600);assert.deepEqual((await state(page)).enemies,idle.enemies);
  assert.equal(await page.evaluate(()=>inkfill.shoot(0,1)),true);
  const paused=await page.evaluate(()=>inkfill.advance(20));
  assert.equal(paused.ball.moving,false);assert.equal(paused.moving,true);assert.ok(paused.orbs.some(o=>o.moving));
  assert.ok(paused.enemies[0].y>idle.enemies[0].y,'movement began with the rolling ball');
  const tail=await page.evaluate(()=>inkfill.advance(120));
  assert.equal(tail.ball.moving,false);assert.equal(tail.moving,true);
  for(const [i,e]of tail.enemies.entries()){assert.equal(e.x,paused.enemies[i].x);assert.equal(e.y,paused.enemies[i].y);assert.equal(e.clock,paused.enemies[i].clock);}
  assert.ok(!tail.events.some(e=>e.type==='fire'));
});

test('result sharing: one click copies only the game link after a win or loss and keeps the result open',async t=>{
  const page=await open(t,{url:hostedGameUrl});
  await page.context().grantPermissions(['clipboard-read']);
  for(const won of [true,false]){
    await load(page,{id:won?'share-win':'share-lose',target:won?20:100,par:2,lives:won?3:1,enemies:[enemy(won?780:480,won?120:470)]});
    await shootAndSettle(page,-Math.PI/2,1);
    const before=await state(page);assert.equal(before.result,won?'win':'lose');
    await page.getByRole('button',{name:'공유하기',exact:true}).click();
    await page.getByRole('status').filter({hasText:'링크를 복사했어요'}).waitFor();
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'https://playroom.mmonoo.com/games/ink-fill/#play');
    assert.equal((await state(page)).panel,'result');
    assert.deepEqual(await state(page),before,'sharing preserves the round and records');
    assert.equal(await page.getByRole('textbox').count(),0,'no extra copy field or dialog');
    assert.equal(await page.getByRole('button',{name:'공유하기',exact:true}).evaluate(e=>e===document.activeElement),true);
  }
});

test('result sharing: Clipboard API fallback copies the localized URL and never reports a failed copy as success',async t=>{
  const page=await open(t,{url:hostedGameUrl,home:true});
  await page.getByRole('combobox').selectOption('en');
  await load(page,{id:'share-api',target:20,par:2,enemies:[enemy(780,120)]});
  await shootAndSettle(page,-Math.PI/2,1);
  await page.evaluate(()=>{
    document.execCommand=()=>false;
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedLink=text;}}});
  });
  await page.getByRole('button',{name:'Share',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Link copied'}).waitFor();
  assert.equal(await page.evaluate(()=>window.copiedLink),'https://playroom.mmonoo.com/en/games/ink-fill/#play');
  await page.evaluate(()=>{navigator.clipboard.writeText=async()=>{throw Error('denied');};});
  await page.getByRole('button',{name:'Share',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Could not copy the link. Try again'}).waitFor();
  assert.equal((await state(page)).panel,'result');
  assert.equal(await page.getByRole('textbox').count(),0);
});
