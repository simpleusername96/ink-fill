'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
let browser;
before(async()=>{browser=await chromium.launch({headless:true,args:['--mute-audio'],...(process.env.INK_LASSO_BROWSER_PATH?{executablePath:process.env.INK_LASSO_BROWSER_PATH}:{})});});
after(async()=>{await browser?.close();});
async function open(t){const page=await browser.newPage({viewport:{width:1440,height:960},reducedMotion:'reduce'});const errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])});await page.clock.install();await page.goto(pathToFileURL(path.resolve(__dirname,'../index.html')).href+'?test=1');await page.clock.runFor(40);return page;}
test('plain display ignores all artwork metadata and retains stored preferences',async t=>{
 const page=await open(t);
 await page.evaluate(()=>localStorage.setItem('inkfill.theme.v2',JSON.stringify('minhwa')));await page.reload();
 for(const style of ['gouache','minhwa','glass','poster','collage']){
  const art=await page.evaluate(style=>{inkfill.load({id:'plain',art:{style,subject:'celestial',seed:91,palette:1}});inkfill.start();inkfill.setTheme(style);return inkfill.art()},style);
  assert.equal(art.style,'plain');assert.equal(art.composition,null);
 }
 assert.equal(await page.locator('#theme').isVisible(),false);
 await page.keyboard.press('t');assert.equal((await page.evaluate(()=>inkfill.state())).theme,'plain');
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('inkfill.theme.v2'))),'minhwa');
 await page.keyboard.press('Escape');assert.equal(await page.getByRole('button',{name:'과슈',exact:true}).count(),0);
});
test('effect footprints agree with gameplay visibility and render no blast behind a wall',async t=>{
 const page=await open(t);
 const r=await page.evaluate(()=>{
  inkfill.load({id:'effect-walls',blockers:[[[480,160],[520,160],[520,480],[480,480]]],enemies:[{kind:'basic',x:750,y:300,speed:0,dir:0}]});inkfill.start();
  const source={x:420,y:320},radius=140,path=effectFootprint(source,radius),cv=document.createElement('canvas');cv.width=960;cv.height=640;const c=cv.getContext('2d');
  let mismatch=0;
  for(let y=190;y<=450;y+=13)for(let x=290;x<=550;x+=13){const distance=Math.hypot(x-source.x,y-source.y);if(Math.abs(distance-radius)<2)continue;const expected=distance<radius&&lineOfSight(world,source,{x,y});if(c.isPointInPath(path,x,y)!==expected)mismatch++;}
  drawEffect(c,{type:'area',kind:'bomb',...source,r:radius,footprint:path,age:.12,dur:.5},T());
  let visible=0,occluded=0;const pixels=c.getImageData(0,0,960,640).data;
  for(let y=240;y<400;y++)for(let x=300;x<560;x++){const alpha=pixels[(y*960+x)*4+3];if(alpha){if(x>521)occluded++;else if(x<475)visible++;}}
  return {mismatch,visible,occluded};
 });
 assert.equal(r.mismatch,0);assert.equal(r.occluded,0);assert.ok(r.visible>100,'blast has visible foreground geometry');
});
test('reduced motion preserves distinct static effect shapes and frozen state without changing the world',async t=>{
 const page=await open(t);
 const r=await page.evaluate(()=>{
  const before=JSON.stringify(inkfill.state()),images=[];
  for(const type of ['bomb','frost','mine','freeze','implode','protect','protect-block','blade','slash','pop','cut-body','spawn','erase','tear','fire','heart','streak']){
   const cv=document.createElement('canvas');cv.width=cv.height=160;const c=cv.getContext('2d');
   const fx={type:['bomb','frost','mine'].includes(type)?'area':type,kind:type,x:80,y:80,r:55,age:.12,dur:.6,angle:0};
   // Spawn now communicates emergence through the child itself, including in reduced motion.
   if(type==='spawn')T().drawEnemy(c,{kind:'basic',x:80,y:80,r:15,vx:0,vy:0},0);
   drawEffect(c,fx,T());const pixels=c.getImageData(0,0,160,160).data;images.push({type,visible:pixels.filter((v,i)=>i%4===3&&v>16).length,data:cv.toDataURL()});
  }
  return {unchanged:before===JSON.stringify(inkfill.state()),images};
 });
 assert.equal(r.unchanged,true);assert.equal(new Set(r.images.map(i=>i.data)).size,r.images.length);
 for(const i of r.images)assert.ok(i.visible>15,i.type+' keeps a static signal');
});
test('real tool effects pause with aim and menus, resume, expire and reset without touching physics',async t=>{
 const page=await open(t);await page.emulateMedia({reducedMotion:'no-preference'});await page.reload();await page.clock.runFor(40);
 await page.evaluate(()=>{inkfill.load({id:'effect-clock',ball:{x:100,y:320},orbs:[{kind:'blackhole',x:170,y:320}],enemies:[{kind:'basic',x:350,y:250,speed:0,dir:0}]});inkfill.start();inkfill.shoot(0,.12);inkfill.settle();});
 const start=await page.evaluate(()=>({state:inkfill.state(),fx:effects.map(e=>e.type),time:effectTime}));assert.ok(start.fx.includes('implode'));
 await page.keyboard.press('Escape');const paused=await page.evaluate(()=>effectTime);await page.clock.runFor(400);assert.equal(await page.evaluate(()=>effectTime),paused);
 await page.keyboard.press('Escape');await page.clock.runFor(120);assert.ok(await page.evaluate(()=>effectTime)>paused);
 const point=await page.evaluate(()=>({x:view.ox+view.s*500,y:view.oy+view.s*400}));await page.mouse.move(point.x,point.y);await page.mouse.down();
 const held=await page.evaluate(()=>({time:effectTime,state:JSON.stringify(inkfill.state())}));await page.clock.runFor(350);
 assert.equal(await page.evaluate(()=>effectTime),held.time);assert.equal(await page.evaluate(()=>JSON.stringify(inkfill.state())),held.state);
 await page.keyboard.press('Escape');await page.mouse.up();await page.clock.runFor(1000);assert.equal(await page.evaluate(()=>effects.length),0,'transient effects expire');
 const unchanged=await page.evaluate(()=>{const before=JSON.stringify(inkfill.state());render();return before===JSON.stringify(inkfill.state());});assert.equal(unchanged,true);
 await page.keyboard.press('r');assert.equal(await page.evaluate(()=>effects.length),0);assert.equal(await page.evaluate(()=>world.orbs.some(o=>o.armed)),false);
});
test('the boss announcement shows on entering a boss board, ends with the first aim or launch and does not repeat on restart',async t=>{
 const page=await open(t);await page.emulateMedia({reducedMotion:'no-preference'});await page.reload();await page.clock.runFor(40);
 const bands=()=>page.evaluate(()=>effects.filter(e=>e.type==='banner').length);
 await page.evaluate(()=>{inkfill.load('boss-minhwa');inkfill.start();});await page.clock.runFor(300);
 assert.equal(await bands(),1,'a boss board is announced on entry');
 const point=await page.evaluate(()=>({x:view.ox+view.s*500,y:view.oy+view.s*400}));await page.mouse.move(point.x,point.y);await page.mouse.down();
 assert.equal(await page.evaluate(()=>!!drag),true);assert.equal(await bands(),0,'taking aim ends the announcement');
 await page.keyboard.press('Escape');await page.mouse.up();await page.clock.runFor(200);assert.equal(await bands(),0,'a cancelled aim does not bring it back');
 await page.evaluate(()=>{inkfill.load('boss-minhwa');inkfill.start();});assert.equal(await bands(),1);
 await page.keyboard.press('r');await page.clock.runFor(100);assert.equal(await bands(),0,'a restart does not announce again');
 await page.evaluate(()=>{inkfill.load('boss-minhwa');inkfill.start();});
 assert.equal(await page.evaluate(()=>inkfill.shoot(Math.PI/2,.3)),true);assert.equal(await bands(),0,'a launch ends the announcement');
 await page.evaluate(()=>{inkfill.load('first-wall');inkfill.start();});assert.equal(await bands(),0,'ordinary boards are not announced');
});
test('real shots reveal a single solid color and respect blockers and irregular outlines',async t=>{
 const page=await open(t);
 for(const irregular of [false,true]){
  const r=await page.evaluate(irregular=>{
   inkfill.load({id:'plain-mask',outline:irregular?[[0,0],[640,0],[640,192],[960,192],[960,640],[0,640]]:[[0,0],[960,0],[960,640],[0,640]],blockers:[[[128,192],[352,192],[352,384],[128,384]]],enemies:[{kind:'basic',x:850,y:300,speed:0,dir:0}]});inkfill.start();inkfill.shoot(-Math.PI/2,1);inkfill.settle();
   const cv=document.createElement('canvas');cv.width=960;cv.height=640;const c=cv.getContext('2d');c.clip(playablePath(world.stage),'evenodd');T().drawTerritory(c,world);
   const pixels=c.getImageData(0,0,960,640).data,colors=new Set();let outside=0,visible=0;const state=inkfill.state();
   for(let y=2;y<640;y+=8)for(let x=2;x<960;x+=8){const k=(y*960+x)*4,cell=state.grid[Math.floor(y/4)*240+Math.floor(x/4)];if(cell===0&&pixels[k+3]>0)outside++;if(pixels[k+3]===255){colors.add([pixels[k],pixels[k+1],pixels[k+2]].join(','));visible++;}}
   return {colors:[...colors],outside,visible,ink:state.inkCount,images:Object.keys(ART).length};
  },irregular);
  assert.equal(r.outside,0);assert.ok(r.visible>0&&r.ink>0);assert.deepEqual(r.colors,['221,231,220']);assert.equal(r.images,0,'no decorative image decoding');
 }
});
test('all nine MONO INK silhouettes render with clear margins and frozen cues without changing simulation',async t=>{
 const page=await open(t);
 const result=await page.evaluate(()=>{
  const before=JSON.stringify(inkfill.state()),frames=[];
  for(const kind of ['basic','charger','shooter','eraser','nest','jumper','chaser','splitter','mine']) {
   const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;const c=canvas.getContext('2d');
   const enemy={kind,x:32,y:32,r:kind==='nest'?18:15,vx:1,vy:0,id:1,count:2};
   T().drawEnemy(c,enemy,0);
   const pixels=c.getImageData(0,0,64,64).data;let visible=0,edge=0,signature=2166136261;
   for(let y=0;y<64;y++)for(let x=0;x<64;x++){
    const k=(y*64+x)*4;if(pixels[k+3]>16)visible++;
    if((x<3||y<3||x>60||y>60)&&pixels[k+3])edge++;
    for(let channel=0;channel<4;channel++)signature=Math.imul(signature^pixels[k+channel],16777619);
   }
   c.clearRect(0,0,64,64);T().drawEnemy(c,{...enemy,frozen:true},0);
   const frozen=c.getImageData(0,0,64,64).data;let statusDifference=0;
   for(let k=0;k<frozen.length;k++)if(frozen[k]!==pixels[k])statusDifference++;
   frames.push({kind,visible,edge,signature,statusDifference});
  }
  return {frames,unchanged:before===JSON.stringify(inkfill.state()),decorativeImages:Object.keys(ART).length};
 });
 assert.equal(result.unchanged,true);assert.equal(result.decorativeImages,0);
 assert.equal(new Set(result.frames.map(f=>f.signature)).size,9,'each role has distinct rendered artwork');
 for(const frame of result.frames){assert.ok(frame.visible>180,frame.kind+' has visible art');assert.equal(frame.edge,0,frame.kind+' is not clipped');assert.ok(frame.statusDifference>80,frame.kind+' keeps its frozen overlay');}
 const aim=await page.evaluate(()=>{
  const cv=document.createElement('canvas');cv.width=cv.height=64;const c=cv.getContext('2d');
  // A shooter moving right must still point its muzzle down the committed firing ray.
  T().drawEnemy(c,{kind:'shooter',x:32,y:32,r:15,vx:1,vy:0,intent:{angle:Math.PI/2}},0);
  return {muzzle:[...c.getImageData(32,47,1,1).data],back:[...c.getImageData(32,18,1,1).data]};
 });
 assert.deepEqual(aim.muzzle,[244,242,236,255],'muzzle opening follows the committed shot');
 assert.deepEqual(aim.back,[32,35,34,255],'body remains opposite the muzzle');
});
test('terrain marks, wall spikes and boss pips render distinctly without touching the world',async t=>{
 const page=await open(t);
 const r=await page.evaluate(()=>{
  inkfill.load({id:'terrain-art',zones:[{kind:'boost',x0:100,y0:100,x1:244,y1:172,dir:0},{kind:'mud',x0:300,y0:100,x1:476,y1:236},{kind:'haven',x0:520,y0:100,x1:688,y1:236}],spikes:[{a:[960,200],b:[960,440]}],
   enemies:[{kind:'basic',x:480,y:420,dir:0,speed:0,boss:true,hp:3}]});inkfill.start();
  // Software canvases: repeated readbacks must not switch a canvas between two rasterizers mid-comparison.
  const before=JSON.stringify(inkfill.state()),paint=draw=>{const cv=document.createElement('canvas');cv.width=960;cv.height=640;const c=cv.getContext('2d',{willReadFrequently:true});draw(c);return {cv,c};};
  const count=(c,x,y,w,h)=>c.getImageData(x,y,w,h).data.filter((v,i)=>i%4===3&&v>8).length;
  const pixels=c=>{let sum=2166136261;for(const v of c.getImageData(0,0,960,640).data)sum=Math.imul(sum^v,16777619);return sum;};
  const zones=world.zones.map(z=>{const first=paint(c=>drawZone(c,z,0)),later=paint(c=>drawZone(c,z,1.3));
   return {kind:z.kind,inside:count(first.c,z.x0,z.y0,z.x1-z.x0,z.y1-z.y0),outside:count(first.c,0,300,960,340),still:pixels(first.c)===pixels(later.c),image:pixels(first.c)};});
  const teeth=paint(c=>T().drawEdges(c,world.stage));
  const pips=hp=>{const p=paint(c=>T().drawEnemy(c,{...world.enemies[0],hp},0));return {above:count(p.c,420,330,120,42),image:pixels(p.c)};};
  return {zones,spikes:{field:count(teeth.c,940,210,17,220),beside:count(teeth.c,940,460,17,150)},full:pips(3),hurt:pips(1),unchanged:before===JSON.stringify(inkfill.state())};
 });
 assert.equal(r.unchanged,true);
 assert.equal(new Set(r.zones.map(z=>z.image)).size,3,'each kind of ground has its own mark');
 for(const z of r.zones){assert.ok(z.inside>400,z.kind+' is visible');assert.equal(z.outside,0,z.kind+' stays inside its own rectangle');assert.equal(z.still,true,z.kind+' holds still under reduced motion');}
 assert.ok(r.spikes.field>300,'teeth reach into the field');assert.equal(r.spikes.beside,0,'only along the spiked stretch');
 assert.ok(r.full.above>120,'a crown and pips sit above a boss');assert.notEqual(r.full.image,r.hurt.image,'lost pips are drawn differently');
});
