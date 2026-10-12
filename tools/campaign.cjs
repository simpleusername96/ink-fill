'use strict';

// Offline witnesses use the executable engine; no search runs in the game.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..'),HTML=path.join(ROOT,'index.html'),CERTIFICATE=path.join(ROOT,'tests/campaign-certificate.json');
const TUNING=/\/\/ BEGIN CAMPAIGN TUNING\nconst CAMPAIGN_TUNING = [\s\S]*?;\n\/\/ END CAMPAIGN TUNING/;
const hash=value=>crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
function loadEngine(html=fs.readFileSync(HTML,'utf8')) {
  html=html.replace(/\r\n/g,'\n');
  const start=html.indexOf('// ─── Constants'),end=html.indexOf('// ─── Contours');
  if(start<0||end<start||!TUNING.test(html))throw Error('Missing executable simulation boundaries');
  const core=html.slice(start,end),stars=html.match(/^function starsFor\(w\).*$/m)?.[0];
  if(!stars)throw Error('Missing executable star rule');
  const engine=new Function(core+'\n'+stars+'\nreturn {CAMPAIGN,CAMPAIGN_TUNING,CHAPTERS,MECHANICS,CONTENT_LIMITS,STAGES,generateStage,validateStage,validateCampaign,campaignProfile,recipeMechanics,geometryMetrics,recordStars,campaignProgress,makeWorld,cloneWorld,shoot,step,starsFor};')();
  return {...engine,html,fingerprint:hash(core.replace(TUNING,'// accepted variants excluded')+stars)};
}
function startWorld(engine,stage){const w=engine.makeWorld(stage);w.quiet=true;return w;}
function execute(engine,base,action,error=[0,0]) {
  const w=engine.cloneWorld(base);if(w.result)return w;
  const angle=Math.atan2(action.y-w.ball.y,action.x-w.ball.x)+error[0]*Math.PI/180;
  if(!engine.shoot(w,angle,Math.max(.03,Math.min(1,action.power+error[1]))))throw Error('Rejected witness shot');
  let frames=0;while(w.moving&&frames++<1500)engine.step(w);
  if(w.moving)throw Error('Simulation exceeded shot ceiling');return w;
}
function noiseCases(profile,length) {
  return [0,-1,1].map(sign=>({id:sign===0?'nominal':'corner-'+sign+'-'+sign,
    errors:Array.from({length},()=>[sign*profile.angle,sign*profile.power])}));
}
function replayRoute(engine,stage,actions,testCase={id:'nominal',errors:[]}) {
  let w=startWorld(engine,stage);const events=[];
  for(let k=0;k<actions.length&&!w.result;k++){w=execute(engine,w,actions[k],testCase.errors[k]);events.push(...w.shotEvents);}
  return {w,events,result:{case:testCase.id,win:w.result==='win',shots:w.shots,lives:w.lives,stars:w.result==='win'?engine.starsFor(w):0,coverage:w.inkCount/w.playable*100}};
}
function inspectRoute(engine,stage,actions,caseActions={}) {
  const cases=noiseCases(stage.generation.profile,stage.par),runs=cases.map(c=>replayRoute(engine,stage,caseActions[c.id]||actions,c));
  return {cases,runs,failed:runs.filter(r=>!r.result.win||r.result.stars!==3)};
}
function candidates(w) {
  const out=[{x:w.ball.x,y:0,power:.95},{x:w.ball.x,y:640,power:.95},{x:0,y:w.ball.y,power:.95},{x:960,y:w.ball.y,power:.95}];
  // Visible open-space midpoints keep the search aware of the actual board.
  for(const [axis,limit]of [['x',960],['y',640]]) {
    const edges=[0,...w.enemies.map(e=>e[axis]),limit].sort((a,b)=>a-b);
    const gaps=edges.slice(1).map((end,i)=>({width:end-edges[i],mid:(end+edges[i])/2})).filter(g=>g.width>=100).sort((a,b)=>b.width-a.width).slice(0,2);
    for(const g of gaps)for(const edge of axis==='x'?[0,640]:[0,960])out.push({x:axis==='x'?g.mid:edge,y:axis==='x'?edge:g.mid,power:.95});
  }
  for(const x of [80,240,480,720,880])for(const y of [0,640])out.push({x,y,power:.95});
  for(const x of [0,960])for(const y of [80,240,400,560])out.push({x,y,power:.95});
  for(const o of w.orbs)for(const power of [.7,.95])out.push({x:o.x,y:o.y,power});
  // A stored blade makes every body a target; a boost pad is a landmark like a tool.
  if(w.blade>0)for(const e of w.enemies)for(const power of [.7,.95])out.push({x:e.x,y:e.y,power});
  for(const z of w.zones)if(z.kind==='boost')out.push({x:(z.x0+z.x1)/2,y:(z.y0+z.y1)/2,power:.85});
  // Internal walls are visible closing/reflection targets too; keep two long faces per wall.
  for(const wall of w.stage.blockers){
    const faces=wall.map((a,i)=>{const b=wall[(i+1)%wall.length];return {x:(a[0]+b[0])/2,y:(a[1]+b[1])/2,length:Math.hypot(b[0]-a[0],b[1]-a[1])};});
    for(const f of faces.sort((a,b)=>b.length-a.length).slice(0,2))out.push({x:f.x,y:f.y,power:.85});
  }
  return out.filter(a=>Math.hypot(a.x-w.ball.x,a.y-w.ball.y)>64);
}
const value=w=>w.result==='win'?200:w.result==='lose'?-1000:w.inkCount/w.playable*100+w.wetCount/w.playable*25-w.enemies.reduce((n,e)=>n+(e.boss?50*e.hp:25),0)+w.lives*25+w.enemies.reduce((n,e)=>n+(e.frozen?18:0),0);
function solve(engine,stage,{testCase={id:'nominal',errors:[]},prefix=[]}={}) {
  const initial=replayRoute(engine,stage,prefix,testCase).w;
  if(initial.result==='win')return {actions:prefix,evaluations:0};
  if(initial.result==='lose')return {actions:null,evaluations:0};
  let beam=[{actions:prefix,world:initial}],evaluations=0;
  for(let depth=prefix.length;depth<stage.par;depth++) {
    const next=[],wins=[];
    for(const branch of beam)for(const action of candidates(branch.world)) {
      const w=execute(engine,branch.world,action,testCase.errors[depth]);evaluations++;
      if(w.result==='lose')continue;
      const item={actions:[...branch.actions,action],world:w,score:value(w)};
      if(w.result==='win')wins.push(item);else next.push(item);
    }
    if(wins.length){wins.sort((a,b)=>(b.world.lives-a.world.lives)||(b.world.inkCount/b.world.playable-a.world.inkCount/a.world.playable));return {actions:wins[0].actions,evaluations};}
    next.sort((a,b)=>b.score-a.score);beam=[];const seen=new Set();
    for(const item of next) {
      const w=item.world,key=[Math.round(w.ball.x/40),Math.round(w.ball.y/40),Math.floor(w.inkCount/w.playable*40),w.enemies.length,w.lives,w.enemies.filter(e=>e.boss).reduce((n,e)=>n+e.hp,0),w.blade,w.orbs.length].join(',');
      if(seen.has(key))continue;seen.add(key);beam.push(item);if(beam.length===4)break;
    }
    if(!beam.length)break;
  }
  return {actions:null,evaluations,best:beam[0]?beam[0].world.inkCount/beam[0].world.playable*100:0};
}
function certificateFor(engine,recipe,actions,caseActions={},repair=false) {
  const stage=engine.generateStage(recipe);engine.validateStage(stage);
  if(!actions.length||actions.length>stage.par)return null;
  caseActions=Object.fromEntries(Object.entries(caseActions).filter(([id])=>noiseCases(stage.generation.profile,stage.par).some(c=>c.id===id)));let audit=inspectRoute(engine,stage,actions,caseActions);
  if(repair)for(const run of audit.failed) {
    const c=audit.cases.find(c=>c.id===run.result.case);
    if(c.id==='nominal')return null;
    const correction=solve(engine,stage,{testCase:c,prefix:actions.slice(0,1)});
    if(!correction.actions)return null;caseActions[c.id]=correction.actions;
  }
  if(audit.failed.length)audit=inspectRoute(engine,stage,actions,caseActions);
  if(audit.failed.length)return null;
  return {id:recipe.id,variant:recipe.variant,par:stage.par,stageHash:hash(stage),routes:[{actions,caseActions,suiteHash:hash(audit.cases),results:audit.runs.map(r=>r.result)}]};
}
function verifyStage(engine,recipe,proof) {
  if(!proof||proof.id!==recipe.id)throw Error('Missing witness: '+recipe.id);
  const stage=engine.generateStage(recipe);engine.validateStage(stage);
  if(proof.stageHash!==hash(stage)||proof.par!==stage.par)throw Error('Stale layout witness: '+recipe.id);
  if(!Array.isArray(proof.routes)||proof.routes.length!==1)throw Error('One witness required: '+recipe.id);
  const route=proof.routes[0];
  if(!route.actions.length||route.actions.length>stage.par||route.actions.some(a=>![a.x,a.y,a.power].every(Number.isFinite)||a.power<=0||a.power>1))throw Error('Invalid witness actions: '+recipe.id);
  for(const [id,actions]of Object.entries(route.caseActions||{})) {
    if(!noiseCases(stage.generation.profile,stage.par).some(c=>c.id===id&&id!=='nominal')||actions.length>stage.par||!actions.length||JSON.stringify(actions[0])!==JSON.stringify(route.actions[0]))throw Error('Invalid continuation: '+recipe.id);
    if(actions.some(a=>![a.x,a.y,a.power].every(Number.isFinite)||a.power<=0||a.power>1))throw Error('Invalid continuation actions: '+recipe.id);
  }
  const audit=inspectRoute(engine,stage,route.actions,route.caseActions);
  if(route.suiteHash!==hash(audit.cases))throw Error('Changed error sample: '+recipe.id);
  if(audit.failed.length)throw Error('Failed witness '+recipe.id+': '+JSON.stringify(audit.failed.map(r=>r.result)));
  if(JSON.stringify(route.results)!==JSON.stringify(audit.runs.map(r=>r.result)))throw Error('Witness replay changed: '+recipe.id);
  return audit.cases.length;
}
function buildRecipe(engine,recipe,stored) {
  const retained=stored?.routes?.[0]?.actions;
  if(retained&&stored.variant===recipe.variant) {const proof=certificateFor(engine,recipe,retained,stored.routes[0].caseActions,true);if(proof)return {proof,evaluations:0};}
  const failures=[];
  for(const variant of [recipe.variant,...[0,1,2].filter(v=>v!==recipe.variant)]) {
    const candidate={...recipe,variant};
    try {
      const stage=engine.generateStage(candidate);engine.validateStage(stage);
      const result=solve(engine,stage);
      if(result.actions){const proof=certificateFor(engine,candidate,result.actions,{},true);if(proof)return {proof,evaluations:result.evaluations};}
      // A useful setup can be pruned by immediate coverage; keep one trial per tool.
      for(const orb of stage.orbs) {
        const prefix=[{x:orb.x,y:orb.y,power:.7}],setup=solve(engine,stage,{prefix});
        if(setup.actions){const proof=certificateFor(engine,candidate,setup.actions,{},true);if(proof)return {proof,evaluations:result.evaluations+setup.evaluations};}
      }
      failures.push({variant,evaluations:result.evaluations,best:result.best});
    }catch(e){failures.push({variant,error:e.message});}
  }
  return {failures};
}
// Replace completed checkpoints without repeatedly truncating a file watched by Windows tools.
function writeCheckpoint(file,content) {
  const temporary=file+'.'+crypto.randomUUID()+'.tmp';
  try {
    fs.writeFileSync(temporary,content,{flag:'wx'});
    for(let attempt=0;;attempt++) {
      try {fs.renameSync(temporary,file);break;}
      catch(error) {
        if(process.platform!=='win32'||!['EPERM','EBUSY','EACCES'].includes(error.code)||attempt>=10)throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);
      }
    }
  }
  finally {if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}
function main() {
  const args=process.argv.slice(2),number=(flag,fallback)=>{const i=args.indexOf(flag);return i<0?fallback:Number(args[i+1]);};
  const engine=loadEngine(),from=number('--from',0),count=number('--count',engine.CAMPAIGN.length-from);
  if(!Number.isInteger(from)||from<0||!Number.isInteger(count)||count<1||from+count>engine.CAMPAIGN.length)throw Error('Invalid campaign subset');
  const selected=engine.CAMPAIGN.slice(from,from+count),old=fs.existsSync(CERTIFICATE)?JSON.parse(fs.readFileSync(CERTIFICATE,'utf8')):null;
  if(args.includes('--verify')) {
    if(old?.schema!==2||old.fingerprint!==engine.fingerprint)throw Error('Stale engine witness; regenerate explicitly');
    if(Object.keys(old.stages).sort().join()!==engine.CAMPAIGN.map(r=>r.id).sort().join())throw Error('Incomplete campaign evidence');
    let cases=0;for(const r of selected){cases+=verifyStage(engine,r,old.stages[r.id]);console.log('PASS '+r.id);}
    console.log(JSON.stringify({stages:selected.length,witnesses:selected.length,cases}));return;
  }
  if(!args.includes('--generate'))throw Error('Use --generate or --verify, optionally --from N --count N');
  const saved={schema:2,fingerprint:engine.fingerprint,stages:old?.schema===2&&old.fingerprint===engine.fingerprint?{...old.stages}:{}};
  const tuning={...engine.CAMPAIGN_TUNING},failed=[];
  const save=()=>{
  const current=fs.readFileSync(HTML,'utf8').replace(/\r\n/g,'\n');
  if(loadEngine(current).fingerprint!==engine.fingerprint)throw Error('Executable changed during generation');
  const block='// BEGIN CAMPAIGN TUNING\nconst CAMPAIGN_TUNING = '+JSON.stringify(tuning,null,2)+';\n// END CAMPAIGN TUNING';
  const updated=current.replace(TUNING,block);
  if(updated!==current)writeCheckpoint(HTML,updated);
  writeCheckpoint(CERTIFICATE,JSON.stringify(saved,null,2)+'\n');
  };
  for(const r of selected) {
    const result=buildRecipe(engine,r,old?.stages[r.id]);
    if(!result.proof){failed.push({id:r.id,...result});console.error('FAIL '+JSON.stringify(failed.at(-1)));continue;}
    tuning[r.id]={variant:result.proof.variant};saved.stages[r.id]=result.proof;save();
    console.log(JSON.stringify({id:r.id,variant:result.proof.variant,par:r.par,shots:result.proof.routes[0].actions.length,evaluations:result.evaluations}));
  }
  if(failed.length)throw Error('No witness within bounded search: '+failed.map(f=>f.id).join(', '));
}
if(require.main===module)try{main();}catch(e){console.error(e.stack);process.exitCode=1;}
module.exports={loadEngine,hash,noiseCases,replayRoute,inspectRoute,verifyStage,solve};
