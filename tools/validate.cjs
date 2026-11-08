'use strict';
const {spawnSync,execFileSync}=require('node:child_process'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const browser=(pattern)=>['--test','--test-concurrency=1','--test-name-pattern='+pattern,'tests/gameplay.cjs'];
const groups={
 rules:[browser('^(enclosure|wet trails|tears|physical orbs|territory|orb effects|enemy actions|terrain|bosses|boss completion|prediction:)')],
 campaign:[['--test','tests/campaign.cjs']],
 input:[browser('^(campaign public drag|aiming:|public input:|touch aim:)')],
 save:[browser('^(campaign records|local out-of-order|result records|persistence:|result sharing:)')],
 presentation:[['--test','tests/map-art.cjs'],browser('^(campaign stages start|all stages open|every theme|plain display|home |focus indication|tutorial motion|a real teaching toast|startup keeps)')],
 localization:[['tools/build-locales.cjs','--check'],['--test','tests/localization.cjs']],
};
function indexOwners(base){
 if(!base)throw Error('index.html needs --scope <changed behavior> or a valid --base; filename alone is ambiguous');
 const before=execFileSync('git',['show',base+':index.html'],{cwd:root,encoding:'utf8'}).replace(/\r\n/g,'\n');
 const after=execFileSync('git',['show','HEAD:index.html'],{cwd:root,encoding:'utf8'}).replace(/\r\n/g,'\n');
 const core=html=>{const a=html.indexOf('// ─── Constants'),b=html.indexOf('// ─── Contours',a);if(a<0||b<a)throw Error('Engine boundaries changed; select explicit scopes');return html.slice(a,b);};
 const owners=new Set();
 if(core(before)!==core(after)){owners.add('rules');owners.add('campaign');}
 const style=html=>html.match(/<style[^>]*>[\s\S]*?<\/style>/)?.[0]||'';
 if(style(before)!==style(after))owners.add('presentation');
 const outside=html=>html.replace(style(html),'').replace(core(html),'');
 if(outside(before)!==outside(after)){owners.add('input');owners.add('save');owners.add('presentation');}
 return [...owners];
}
function gameplayCasePatterns(base){
 if(!base)throw Error('gameplay.cjs needs --scope or a valid --base to identify changed cases');
 const source=ref=>execFileSync('git',['show',ref+':tests/gameplay.cjs'],{cwd:root,encoding:'utf8'}).replace(/\r\n/g,'\n');
 const clean=code=>code.replace(/^\s*\/\/[^\n]*$/gm,'').replace(/^require\('\.\/campaign\.cjs'\);\s*$/gm,'').trim();
 const sections=code=>{
  // Only literal named Node-test registrations are selectable. Other registration
  // forms need an explicit scope instead of silently becoming a complete run.
  const calls=[...code.matchAll(/^(?:test|for[^\n]*?\btest)\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gm)];
  if(!calls.length)throw Error('Unknown gameplay registration shape; select explicit --scope');
  return {preamble:clean(code.slice(0,calls[0].index)),cases:new Map(calls.map((call,i)=>[require('node:vm').runInNewContext(call[1],Object.create(null),{timeout:20}),clean(code.slice(call.index,calls[i+1]?.index))]))};
 };
 const before=sections(source(base)),after=sections(source('HEAD'));
 const shared=before.preamble!==after.preamble;
 const names=[...after.cases].filter(([name,body])=>shared||before.cases.get(name)!==body).map(([name])=>name);
 return names.map(name=>'^'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
}
function select(changed,{base,casePatterns=[]}={}){
 const selected=new Set();
 for(const file of changed){
  if(file==='index.html')for(const name of indexOwners(base))selected.add(name);
  else if(/^locales\/|tools\/build-locales/.test(file))selected.add('localization');
  else if(/^tests\/gameplay\.cjs$/.test(file))casePatterns.push(...gameplayCasePatterns(base));
  else if(/^tests\/(map-art|localization)\.cjs$/.test(file))selected.add(file.includes('map-art')?'presentation':'localization');
  else if(/^tools\/(campaign|design|agents|conditions)\.cjs$|^tests\/(campaign|campaign-certificate)/.test(file))selected.add('campaign');
  else if(/^assets\//.test(file))selected.add('presentation');

 }
 return [...selected];
}
module.exports={groups,select};
if(require.main===module){try{
 const args=process.argv.slice(2),scopes=[],changed=[];let all=false,list=false,base=process.env.INK_FILL_CI_BASE;
 for(let i=0;i<args.length;i++){
  const arg=args[i];if(arg==='--all'||arg==='--release'){all=true;continue;}if(arg==='--list'){list=true;continue;}
  if(!['--scope','--changed','--base'].includes(arg)||!args[i+1]||args[i+1].startsWith('--'))throw Error('Unknown or incomplete argument '+arg);
  const value=args[++i];if(arg==='--scope')scopes.push(value);else if(arg==='--changed')changed.push(value.replaceAll('\\','/'));else base=value;
 }
 if(base&&!all&&!scopes.length&&!changed.length){if(!/^[0-9a-f]{40}$/.test(base)||/^0+$/.test(base))throw Error('A nonzero full CI base SHA is required');changed.push(...execFileSync('git',['diff','--name-only',base,'HEAD'],{cwd:root,encoding:'utf8'}).trim().split(/\r?\n/).filter(Boolean));}
 if(!all&&!scopes.length&&!changed.length&&!base)throw Error('Select a scope or changed paths; no default full run');
 const casePatterns=[];
 const selected=all?Object.keys(groups):scopes.length?scopes:select(changed,{base,casePatterns});
 for(const name of selected)if(!groups[name])throw Error('Unknown scope '+name);
 let commands=[...new Map(selected.flatMap(name=>groups[name]).map(command=>[JSON.stringify(command),command])).values()];
 if(casePatterns.length)commands.push(browser(casePatterns.join('|')));
 const gameplay=commands.filter(command=>command.at(-1)==='tests/gameplay.cjs');
 if(gameplay.length>1){
  const pattern=gameplay.map(command=>command.find(arg=>arg.startsWith('--test-name-pattern=')).slice('--test-name-pattern='.length)).join('|');
  commands=commands.filter(command=>command.at(-1)!=='tests/gameplay.cjs');
  commands.push(browser(pattern));
 }
 if(list){console.log(JSON.stringify(commands,null,2));process.exit(0);}
 for(const args of commands){const result=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit'});if(result.error)throw result.error;if(result.status!==0)process.exit(result.status||1);}
 console.log('PASS selected validation: '+selected.join(', '));
}catch(error){console.error(error.message+'\nScopes: '+Object.keys(groups).join(', ')+'; --list previews; --all/--release is explicit full execution');process.exitCode=1;}}
