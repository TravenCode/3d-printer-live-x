import fs from 'node:fs';import assert from 'node:assert/strict';
const s=fs.readFileSync('index.html','utf8');const code=s.slice(s.indexOf('function replenishDemo(){'),s.indexOf('function next(){'));const q=[];
// LIVE_VIEW: 直播输出窗口(?live=1)不自己补演示数据，任务由主窗口广播。
const f=new Function('autoDemo','paused','busy','queue','demoPeople','randomPerson','renderQueue','updateScreen','LIVE_VIEW',code+'return replenishDemo;');
const person={name:'测试',avatar:'test'};let make=(auto,pause,busy,live=false)=>f(auto,pause,busy,q,[person],()=>person,()=>{},()=>{},live);
make(true,false,false)();assert.equal(q.length,1);make(true,false,false)();assert.equal(q.length,1);q.length=0;for(let i=0;i<100;i++){make(true,false,false)();assert.equal(q.length,1);q.shift()}make(false,false,false)();assert.equal(q.length,0);make(true,true,false)();assert.equal(q.length,0);make(true,false,true)();assert.equal(q.length,0);q.push({priority:true,name:'礼物'});make(true,false,false)();assert.equal(q.length,1);q.length=0;make(true,false,false,true)();assert.equal(q.length,0,'直播输出窗口不补演示数据');
console.log('PASS: continuous 100-job refill, no duplicates, pause/off/busy/priority preserved');
