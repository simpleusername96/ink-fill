'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {loadEngine,hash,noiseCases,verifyStage}=require('../tools/campaign.cjs');
const certificate=require('./campaign-certificate.json');
const by=(e,id)=>e.CAMPAIGN.find(r=>r.id===id);
const swap=(e,id,change)=>e.CAMPAIGN.map(r=>r.id===id?{...r,...change}:r);
const PRIMARY=['blade','bomb'],WORLD_PAR=[3,4,5,6,6,6,6],BOSS_PAR=[5,5,6,6,6,6,6];

test('campaign recipes preserve pinned identity and reject invalid curricula',()=>{
  const e=loadEngine(),original=e.CAMPAIGN.map(e.generateStage),source=by(e,'guarded-blast'),at=e.CAMPAIGN.indexOf(source);
  const extra={...source,id:'extra-application',difficulty:(source.difficulty+e.CAMPAIGN[at+1].difficulty)/2};
  const inserted=[...e.CAMPAIGN.slice(0,at+1),extra,...e.CAMPAIGN.slice(at+1)];
  e.validateCampaign(inserted);e.validateStage(e.generateStage(extra));
  assert.deepEqual(inserted.filter(r=>r.id!==extra.id).map(e.generateStage),original);
  e.MECHANICS.futureTool={type:'tool',requires:['bomb'],label:'Future'};
  assert.deepEqual(e.CAMPAIGN.map(e.generateStage),original);
  assert.throws(()=>e.validateCampaign([by(e,'first-line'),by(e,'first-shot')]),/prerequisite/);
  assert.throws(()=>e.validateCampaign([by(e,'first-line'),by(e,'first-line')]),/Invalid campaign/);
  assert.throws(()=>e.validateCampaign([{...by(e,'first-line'),enemies:['unknown']}]),/Unknown mechanic/);
  assert.throws(()=>e.validateCampaign([{...by(e,'first-line'),difficulty:NaN}]),/Invalid campaign/);
  assert.throws(()=>e.validateCampaign(swap(e,'guarded-blast',{core:['barrier','charger'],review:['protect','basic','blade']})),/core\/review budget/i);
  assert.throws(()=>e.validateCampaign([{...by(e,'first-line'),wallCount:3}]),/Invalid campaign/,'no board carries more than two walls');
  assert.throws(()=>e.validateCampaign([{...by(e,'first-line'),enemies:Array(5).fill('basic')}]),/Roster limit/,'initial enemy density is bounded');
  assert.throws(()=>e.validateCampaign(swap(e,'first-nest',{enemies:['nest','nest','basic']})),/Roster limit/,'campaign boards have one spawn source');
  assert.throws(()=>e.validateCampaign(swap(e,'lasting-frost',{review:['blackhole'],tools:['freeze','blackhole'],enemies:['basic']})),/Core\/review|Unintroduced/);
  assert.throws(()=>e.validateCampaign(swap(e,'lasting-frost',{review:['basic'],tools:['freeze']})),/Primary orb share/,'support-only introductions are rejected');
  assert.throws(()=>e.validateCampaign(swap(e,'lasting-frost',{tools:['freeze','freeze','blade']})),/Primary orb share/,'the share counts copies rather than distinct kinds');
  const emptyLater=e.CAMPAIGN.map(r=>r.id==='first-wall'?{...r,review:['basic','blade','freeze'],tools:['blade','freeze']}:r.id==='first-charge'?{...r,review:['basic','barrier'],enemies:['basic','charger'],tools:[]}:r);
  assert.throws(()=>e.validateCampaign(emptyLater),/Primary orb share/,'empty tool rosters cannot bypass the minimum after a primary orb is learned');
  // Bosses, terrain and board shapes are admitted through the same explicit recipe fields.
  assert.throws(()=>e.validateCampaign(swap(e,'boss-garden',{boss:undefined})),/Invalid campaign/,'a boss stage names its boss');
  assert.throws(()=>e.validateCampaign(swap(e,'first-wall',{boss:{hp:3}})),/Invalid campaign/,'only a boss stage carries one');
  assert.throws(()=>e.validateCampaign(swap(e,'boss-ink',{enemies:['eraser'],review:['eraser','bomb','blade','barrier']})),/Roster limit/,'only kinds with a giant form can lead a boss stage');
  assert.throws(()=>e.validateCampaign(swap(e,'first-boost',{zones:['lava']})),/Unknown mechanic/);
  assert.throws(()=>e.validateCampaign(swap(e,'first-mud',{shape:'circle'})),/Invalid campaign/,'board shapes come from the fixed orthogonal set');
  assert.throws(()=>e.validateCampaign(swap(e,'first-wall',{zones:['boost'],review:['basic','blade','boost']})),/Core\/review|Unintroduced/,'terrain waits for its own lesson');
  assert.throws(()=>e.validateCampaign(swap(e,'field-run',{phase:'challenge',core:[],review:['boost','mud','eraser','nest','bomb']})),/Challenge budget/,'mixed challenges belong to the final world');
});

test('campaign progression limits each roster and actually reuses earlier elements in every later world',()=>{
  const e=loadEngine(),seen=new Set(),introductions=[];
  assert.equal(e.STAGES.length,52);
  assert.deepEqual(e.CHAPTERS.map((_,i)=>e.STAGES.filter(s=>s.chapter===i).length),[6,6,7,7,6,7,13]);
  assert.deepEqual(Object.keys(e.MECHANICS).filter(k=>e.MECHANICS[k].role==='primary'),PRIMARY);
  for(const [i,s]of e.STAGES.entries()){
    e.validateStage(s);const g=s.generation,r=e.CAMPAIGN[i],boss=s.enemies.filter(a=>a.boss);
    if(g.introduce){assert.ok(!seen.has(g.introduce));seen.add(g.introduce);introductions.push([i+1,g.introduce]);}
    const actual=[...new Set([...s.enemies.map(a=>a.kind),...s.orbs.map(o=>o.kind),...s.zones.map(z=>z.kind),...(s.spikes.length?['spikes']:[]),...(s.blockers.length?['barrier']:[]),...(boss.length?['boss']:[])])];
    assert.ok(actual.every(k=>seen.has(k)),s.id+' only uses learned kinds');
    assert.deepEqual(new Set(actual),new Set([...g.core,...g.review]));
    assert.ok(actual.length<=5);
    assert.ok(s.enemies.length<=4&&new Set(s.enemies.map(a=>a.kind)).size<=3);
    assert.ok(s.enemies.filter(a=>a.kind==='nest').length<=1);
    assert.ok(new Set(s.orbs.map(o=>o.kind)).size<=2);
    assert.ok(s.zones.length+s.spikes.length<=2,s.id+' carries at most two pieces of terrain');
    const primary=s.orbs.filter(o=>PRIMARY.includes(o.kind)).length;
    if(i>0)assert.ok(primary>=1,s.id+' always includes a primary orb after the first lesson');
    if(s.orbs.length)assert.ok(primary*2>=s.orbs.length,s.id+' reserves at least half of authored orbs for enemy removal');
    if(g.phase==='boss'){
      // One boss leads the board, alone or with hazards it can be lured into; the supply can always finish it.
      assert.equal(boss.length,1);assert.equal(s.enemies[0],boss[0]);assert.ok(boss[0].hp>=3&&boss[0].hp<=4);
      assert.ok(s.enemies.slice(1).every(a=>a.kind==='mine'),s.id+' has no free-roaming escort');
      assert.ok(primary+s.enemies.filter(a=>a.kind==='mine').length>=boss[0].hp,s.id+' supplies a hit for every pip');
      assert.equal(s.target,94,'only a defeated or tightly trapped boss leaves this much of the board');
      assert.equal(s.par,BOSS_PAR[s.chapter]);
    }else{
      assert.equal(boss.length,0);assert.ok(s.target>=58&&s.target<=78);
      if(i>0)assert.equal(s.par,s.id==='separate-paths'?4:WORLD_PAR[s.chapter]);else assert.equal(s.par,1);
      if(s.chapter>=3)assert.ok(s.orbs.length>=2&&s.orbs.length<=3,s.id+' supplies late-game tools');
    }
    if(g.phase==='challenge')assert.equal(s.orbs.length,3,s.id+' supplies challenge reserves');
    if(g.phase==='application'){assert.deepEqual(g.core,e.CHAPTERS[s.chapter].core);assert.equal(g.review.length,e.CHAPTERS[s.chapter].reviewCount);}
    if(g.phase==='intro'){assert.equal(g.core.length,1);assert.ok(g.review.length<=3);}
    if(g.phase==='challenge'){assert.equal(g.introduce,null);assert.equal(actual.length,5);}
    assert.equal(s.target,r.target);assert.equal(s.par,r.par);
    assert.equal(s.lives??3,s.id==='first-heart'?2:3,'only the heart lesson starts with a heart to win back');
    assert.throws(()=>e.validateStage({...s,enemies:[...s.enemies,{...s.enemies[0]}]}),/overlap|Roster/);
  }
  assert.deepEqual(introductions,[[1,'basic'],[2,'blade'],[3,'freeze'],[6,'boss'],[7,'barrier'],[8,'charger'],[9,'protect'],[13,'shooter'],[14,'bomb'],[15,'blackhole'],
    [20,'jumper'],[21,'eraser'],[22,'nest'],[27,'boost'],[28,'mud'],[29,'haven'],[30,'spikes'],[33,'chaser'],[34,'heart'],[35,'splitter'],[36,'mine'],[37,'ink']]);
  const before=new Set();
  for(let c=0;c<7;c++){
    const stages=e.STAGES.filter(s=>s.chapter===c),used=new Set(stages.flatMap(s=>s.generation.uses));
    for(const k of before)assert.ok(used.has(k),'world '+(c+1)+' reuses '+k);
    used.forEach(k=>before.add(k));
    // Once walls are learned, no later board falls back to an empty rectangle.
    if(c)assert.ok(stages.every(s=>s.blockers.length>0||s.generation.shape!=='rect'));
    assert.equal(stages.at(-1).generation.phase,'boss','every world ends with its boss');
    assert.equal(stages.filter(s=>s.generation.phase==='boss').length,1);
  }
  assert.equal(before.size,22);
  assert.deepEqual(e.STAGES.filter(s=>s.generation.phase==='boss').map(s=>s.enemies[0].kind),['basic','charger','shooter','nest','charger','splitter','chaser']);
  assert.ok(by(e,'stored-guard').tools.filter(k=>k==='protect').length===2);
  assert.ok(by(e,'guarded-frost').tools.filter(k=>k==='protect').length===2);
  assert.ok(e.STAGES.slice(10).some(s=>!s.enemies.some(a=>a.kind==='basic')),'basic is selected rather than an uncounted mandatory slot');
});

test('campaign boards vary walls, outline and terrain while preserving gaps and legal paths',()=>{
  const e=loadEngine(),areas=[],occlusion=[],early=e.STAGES.filter(s=>s.chapter===1&&s.generation.phase!=='boss');
  const inside=(x,y,p)=>{let c=false;for(let i=0,j=p.length-1;i<p.length;j=i++){const [ax,ay]=p[i],[bx,by]=p[j];if((ay>y)!==(by>y)&&x<(bx-ax)*(y-ay)/(by-ay)+ax)c=!c;}return c;};
  for(const s of e.STAGES){
    const m=s.generation.geometry;assert.deepEqual(m,e.geometryMetrics(s.blockers,s.outline));
    assert.equal(m.count,s.generation.wallCount);assert.ok(m.count<=2);assert.ok(m.areaFraction<.08);assert.ok(m.minimumGap>=64);
    const boxes=s.blockers.map(p=>{
      assert.ok([4,6].includes(p.length));
      assert.ok(Math.max(...p.map(v=>v[0]))-Math.min(...p.map(v=>v[0]))<=176&&Math.max(...p.map(v=>v[1]))-Math.min(...p.map(v=>v[1]))<=176,s.id+' wall size is bounded');
      p.forEach((a,i)=>{const b=p[(i+1)%p.length];assert.ok(a[0]===b[0]||a[1]===b[1]);a.forEach(v=>assert.equal(v%4,0));});
      return {x0:Math.min(...p.map(v=>v[0])),x1:Math.max(...p.map(v=>v[0])),y0:Math.min(...p.map(v=>v[1])),y1:Math.max(...p.map(v=>v[1]))};
    });
    for(let i=0;i<boxes.length;i++)for(const b of boxes.slice(i+1)){
      const a=boxes[i],gap=Math.hypot(Math.max(a.x0-b.x1,b.x0-a.x1,0),Math.max(a.y0-b.y1,b.y0-a.y1,0));assert.ok(gap>=72,s.id+' usable gap');
    }
    // Outlines stay orthogonal and on the grid, and keep most of the board playable.
    s.outline.forEach((a,i)=>{const b=s.outline[(i+1)%s.outline.length];assert.ok(a[0]===b[0]||a[1]===b[1],s.id+' outline is orthogonal');a.forEach(v=>assert.equal(v%4,0));});
    const w=e.makeWorld(s);assert.ok(w.playable>=38400*.8,s.id+' keeps at least four fifths of the board');
    if(s.chapter<4&&s.generation.phase!=='boss')assert.equal(s.generation.shape,'rect','the first four worlds keep their rectangles');
    // Terrain lies inside the board, clear of walls and of the ball; spikes sit on a real wall.
    for(const z of s.zones){
      for(const [x,y]of [[z.x0,z.y0],[z.x1,z.y0],[z.x1,z.y1],[z.x0,z.y1],[(z.x0+z.x1)/2,(z.y0+z.y1)/2]]){assert.ok(inside(x,y,s.outline),s.id+' terrain inside the outline');assert.ok(!s.blockers.some(p=>inside(x,y,p)));}
      assert.ok(!(s.ball.x>z.x0&&s.ball.x<z.x1&&s.ball.y>z.y0&&s.ball.y<z.y1),s.id+' the ball never starts on terrain');
      if(z.kind==='haven')for(const a of s.enemies)assert.ok(a.x<z.x0-a.r||a.x>z.x1+a.r||a.y<z.y0-a.r||a.y>z.y1+a.r,s.id+' no enemy starts inside a protected zone');
    }
    for(const k of s.spikes){
      assert.ok(k.a[0]===k.b[0]||k.a[1]===k.b[1]);
      assert.ok(w.segs.some(g=>[k.a,k.b].every(([x,y])=>{const dx=g.b[0]-g.a[0],dy=g.b[1]-g.a[1],t=((x-g.a[0])*dx+(y-g.a[1])*dy)/(dx*dx+dy*dy);return t>=0&&t<=1&&Math.hypot(g.a[0]+dx*t-x,g.a[1]+dy*t-y)<.01;})),s.id+' spikes lie on a wall');
      assert.ok(Math.hypot(s.ball.x-(k.a[0]+k.b[0])/2,s.ball.y-(k.a[1]+k.b[1])/2)>=160,s.id+' the ball starts clear of spikes');
    }
    if(s.generation.phase==='challenge'&&s.blockers.length){areas.push(m.areaFraction);occlusion.push(m.blockedSightlines);}
    e.validateStage(s);
  }
  assert.ok(e.STAGES.some(s=>s.blockers.some(p=>p.length===6)));
  assert.ok(new Set(e.STAGES.filter(s=>s.blockers.length).map(s=>hash(s.blockers))).size>20);
  assert.ok(new Set(e.STAGES.map(s=>s.generation.shape)).size>=6,'new worlds use every board shape');
  assert.deepEqual([...new Set(e.STAGES.flatMap(s=>[...s.zones.map(z=>z.kind),...(s.spikes.length?['spikes']:[])]))].sort(),['boost','haven','mud','spikes']);
  const mean=a=>a.reduce((n,x)=>n+x,0)/a.length;
  assert.ok(mean(areas)>mean(early.map(s=>s.generation.geometry.areaFraction)));
  assert.ok(mean(occlusion)>mean(early.map(s=>s.generation.geometry.blockedSightlines)));
  const r=by(e,'first-wall');assert.notDeepEqual(e.generateStage({...r,seed:r.seed+1}).blockers,e.generateStage(r).blockers);
  const t=by(e,'first-mud');assert.notDeepEqual(e.generateStage({...t,seed:t.seed+1}).zones,e.generateStage(t).zones);
});

test('campaign movement increases in real simulation and retains stationary and frozen roles',()=>{
  const e=loadEngine(),means=[],spans=[];
  // Ordinary ground movers carry the world's speed band; still roles, chasers and bosses follow their own rules.
  const ordinary=a=>!a.boss&&!['nest','charger','jumper','mine','chaser'].includes(a.kind);
  for(let chapter=0;chapter<7;chapter++){
    const distances=[],ranges=[];
    for(const stage of e.STAGES.filter(s=>s.chapter===chapter)){
      const w=e.makeWorld({...stage,target:99,orbs:[],zones:[],spikes:[]});w.quiet=true;
      const moved=new Map(w.enemies.filter(ordinary).map(a=>[a.id,0]));e.shoot(w,stage.ball.x<480?0:Math.PI,.8);
      for(let frame=0;frame<72&&w.moving;frame++){
        const previous=new Map(w.enemies.map(a=>[a.id,{x:a.x,y:a.y}]));
        e.step(w);
        for(const a of w.enemies)if(moved.has(a.id)){const p=previous.get(a.id);moved.set(a.id,moved.get(a.id)+Math.hypot(a.x-p.x,a.y-p.y));}
      }
      distances.push(...moved.values());
      for(const a of stage.enemies){
        if(a.kind==='nest'||a.kind==='mine')assert.equal(a.speed,0);
        if(a.patrol)ranges.push(Math.max(...a.patrol.flatMap(p=>a.patrol.map(q=>Math.hypot(q.x-p.x,q.y-p.y)))));
      }
    }
    means.push(distances.reduce((a,b)=>a+b,0)/distances.length);spans.push(ranges.length?ranges.reduce((a,b)=>a+b,0)/ranges.length:0);
  }
  for(let i=1;i<means.length;i++)assert.ok(means[i]>means[i-1],'observed world movement rises: '+JSON.stringify(means));
  assert.ok(spans[6]>spans[1],'late realized patrol spans exceed early ones');
  const base={...e.STAGES[0],target:99,ball:{x:8,y:632},orbs:[],enemies:[{kind:'basic',x:720,y:200,dir:90,speed:100,patrol:[{x:720,y:150},{x:720,y:250}]}]};
  const w=e.makeWorld(base),clone=e.cloneWorld(w);w.quiet=true;e.shoot(w,0,.6);e.shoot(clone,0,.6);
  for(let i=0;i<180;i++){e.step(w);e.step(clone);}
  assert.ok(w.shotEvents.some(ev=>ev.type==='turn'));assert.deepEqual(w.enemies,clone.enemies);
  const f=e.makeWorld({...base,ball:{x:480,y:632},orbs:[{kind:'freeze',x:480,y:528}],enemies:[{kind:'basic',x:480,y:380,dir:90,speed:40,patrol:[{x:480,y:360},{x:480,y:430}]}]});f.quiet=true;
  e.shoot(f,-Math.PI/2,.8);while(f.moving)e.step(f);assert.equal(f.enemies[0].frozen,true);
  const before=structuredClone(f.enemies[0]);e.shoot(f,Math.PI,.6);for(let i=0;i<180;i++)e.step(f);
  assert.deepEqual({x:f.enemies[0].x,y:f.enemies[0].y,index:f.enemies[0].patrolIndex},{x:before.x,y:before.y,index:before.patrolIndex});
  assert.throws(()=>e.makeWorld({...base,enemies:[{...base.enemies[0],patrol:[{x:-1,y:150},{x:720,y:250}]}]}),/Invalid patrol/);
  assert.throws(()=>e.makeWorld({...base,enemies:[{...base.enemies[0],chargeSpeed:1000}]}),/Invalid charge/);
});

test('campaign progression derives sequential and world unlocks from valid clears only',()=>{
  const e=loadEngine(),ids=e.STAGES.map(s=>s.id),records={};
  assert.deepEqual(e.campaignProgress(records),{cleared:0,unlockedThrough:0,complete:false});
  records[ids[5]]=3;assert.equal(e.campaignProgress(records).unlockedThrough,0,'a later stored record cannot jump a gap');
  for(const value of [NaN,Infinity,'3',-1,4,1.5]){records[ids[0]]=value;assert.equal(e.campaignProgress(records).cleared,0);}
  for(let i=0;i<5;i++)records[ids[i]]=1;
  assert.equal(e.campaignProgress(records).unlockedThrough,6,'one-star clears suffice, including a saved contiguous sixth clear');
  delete records[ids[5]];assert.equal(e.campaignProgress(records).unlockedThrough,5);
  // A board inserted later reopens everything behind it as soon as it is cleared: older records are kept, never bypassed.
  const veteran=Object.fromEntries(ids.filter(id=>!id.startsWith('boss-')&&e.STAGES.find(s=>s.id===id).chapter<4).map(id=>[id,3]));
  assert.equal(e.campaignProgress(veteran).unlockedThrough,ids.indexOf('boss-garden'));
  veteran['boss-garden']=1;assert.equal(e.campaignProgress(veteran).unlockedThrough,ids.indexOf('boss-minhwa'));
  ids.forEach(id=>records[id]=1);assert.deepEqual(e.campaignProgress(records),{cleared:52,unlockedThrough:51,complete:true});
});

test('campaign witnesses bind current layouts and star thresholds accept efficient alternatives',()=>{
  const e=loadEngine();assert.equal(certificate.schema,2);assert.equal(certificate.fingerprint,e.fingerprint);
  assert.equal(loadEngine(e.html.replace(/\n/g,'\r\n')).fingerprint,e.fingerprint);
  assert.deepEqual(Object.keys(certificate.stages).sort(),e.CAMPAIGN.map(r=>r.id).sort());
  const first=e.CAMPAIGN[0],proof=certificate.stages[first.id];
  assert.throws(()=>verifyStage(e,{...first,seed:first.seed+1},proof),/Stale layout/);
  assert.throws(()=>verifyStage(e,first,{...proof,routes:[]}),/One witness/);
  const bad={...proof.routes[0],caseActions:{'corner-1-1':[{x:0,y:0,power:.5}]}};
  assert.throws(()=>verifyStage(e,first,{...proof,routes:[bad]}),/Invalid continuation/);
  assert.notEqual(loadEngine(e.html.replace('// ─── Contours','const changedSimulationForTest=true;\n// ─── Contours')).fingerprint,e.fingerprint);
  for(const r of e.CAMPAIGN){
    const s=e.generateStage(r),p=certificate.stages[r.id];assert.equal(p.stageHash,hash(s));assert.equal(p.par,s.par);assert.equal(p.routes.length,1);
    const witness=p.routes[0],expected=noiseCases(s.generation.profile,s.par);
    assert.equal(expected.length,3);assert.equal(new Set(expected.map(c=>JSON.stringify(c.errors))).size,3);
    assert.equal(witness.suiteHash,hash(expected));assert.deepEqual(witness.results.map(r=>r.case),expected.map(c=>c.id));
    assert.ok(witness.results.every(r=>r.win&&r.stars===3&&r.shots<=s.par));
    for(const [shots,stars]of [[1,3],[s.par,3],[s.par+1,2],[s.par+2,2],[s.par+3,1]])assert.equal(e.starsFor({stage:s,shots}),stars);
  }
});
