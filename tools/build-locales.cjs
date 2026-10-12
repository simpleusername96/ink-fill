'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),codes=['ko','en','zh-Hans','ja'];
const dictionaries=Object.fromEntries(codes.map(code=>[code,JSON.parse(fs.readFileSync(path.join(root,'locales',code+'.json'),'utf8'))]));
const keys=Object.keys(dictionaries.ko).sort();
const placeholders=value=>[...value.matchAll(/\{([a-zA-Z][\w]*)\}/g)].map(m=>m[1]).sort();
for(const code of codes){
 assert.deepEqual(Object.keys(dictionaries[code]).sort(),keys,code+' message keys');
 for(const key of keys){const value=dictionaries[code][key];assert.equal(typeof value,'string',code+':'+key);assert.ok(value.trim(),code+':'+key+' empty');assert.deepEqual(placeholders(value),placeholders(dictionaries.ko[key]),code+':'+key+' placeholders');}
}
const file=path.join(root,'index.html'),html=fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n');
const block='// BEGIN LOCALIZED MESSAGES\nconst MESSAGES = '+JSON.stringify(dictionaries).replace(/</g,'\\u003c')+';\n// END LOCALIZED MESSAGES';
assert.match(html,/\/\/ BEGIN LOCALIZED MESSAGES[\s\S]*?\/\/ END LOCALIZED MESSAGES/);
if(process.argv.includes('--check'))assert.ok(html.includes(block),'embedded dictionaries are stale');
else fs.writeFileSync(file,html.replace(/\/\/ BEGIN LOCALIZED MESSAGES[\s\S]*?\/\/ END LOCALIZED MESSAGES/,()=>block));
console.log('PASS: '+codes.length+' locales × '+keys.length+' message keys, complete matching placeholders'+(process.argv.includes('--check')?', embedded parity':''));
