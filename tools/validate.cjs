'use strict';
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
for(const args of [
  ['tools/build-locales.cjs','--check'],
  ['tools/campaign.cjs','--verify'],
  ['--test','--test-concurrency=1','tests/gameplay.cjs','tests/map-art.cjs','tests/localization.cjs'],
]){
  const result=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit'});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status||1);
}
console.log('PASS public source validation');
