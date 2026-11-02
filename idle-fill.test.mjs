import fs from 'node:fs';import assert from 'node:assert/strict';
const s=fs.readFileSync('index.html','utf8');
assert.ok(s.includes("if(type==='comment'||type==='like'||type==='gift'||type==='follow'||type==='join')lastLiveMsgAt=Date.now()"),'真实观众消息(评论/点赞/礼物/关注/进场)应重置30秒计时');
assert.ok(s.includes('socket.onopen=()=>{lastLiveMsgAt=Date.now();'),'连接数据桥应重置30秒计时');
assert.ok(/setInterval\(idleTestFill,1000\)/.test(s),'应每秒检查一次空闲填充');
const code=s.slice(s.indexOf('function idleTestFill(){'),s.indexOf('function next(){'));
const person={name:'测试观众',avatar:'test'};const q=[];const calls=[];
let now=1000000;const realNow=Date.now;Date.now=()=>now;
try{
 // liveMode / liveEverConnected 决定是否允许演示补位：真直播时一律不补。
 const make=(pause,people,queueArr,live=false,everLive=false)=>new Function('paused','demoPeople','queue','lastLiveMsgAt','liveEvent','randomPerson','liveMode','liveEverConnected',code+'return idleTestFill;')(pause,people,queueArr,1000000,(type,user,amount,label,sourceTag,markLive)=>calls.push({type,user,amount,sourceTag,markLive}),()=>person,live,everLive);
 const fill=make(false,[person],q);
 fill();assert.equal(calls.length,0,'30秒内不补');
 now+=29999;fill();assert.equal(calls.length,0,'差1毫秒满30秒也不补');
 now+=1;fill();assert.equal(calls.length,1,'满30秒补一张');
 assert.equal(calls[0].type,'like');assert.equal(calls[0].sourceTag,'30秒无互动·测试头像');assert.equal(calls[0].markLive,false);assert.equal(calls[0].user.name,'测试观众');
 fill();assert.equal(calls.length,1,'补完立刻重置计时');
 now+=29999;fill();assert.equal(calls.length,1,'重置后29.9秒不补');
 now+=1;fill();assert.equal(calls.length,2,'再等满30秒继续补');
 now+=30000;make(false,[person],[{name:'a'},{name:'b'}])();assert.equal(calls.length,2,'队列已有2张时不再补');
 now+=30000;make(true,[person],q)();assert.equal(calls.length,2,'暂停打印时不补');
 now+=30000;make(false,[],q)();assert.equal(calls.length,2,'测试头像池为空时不补');
 now+=30000;make(false,[person],q,true,false)();assert.equal(calls.length,2,'已连数据桥(liveMode)时不补');
 now+=30000;make(false,[person],q,false,true)();assert.equal(calls.length,2,'曾经连过数据桥(liveEverConnected)时不补');
 console.log('PASS: 30秒无消息自动补测试头像；补后计时重置；暂停/队列满2/空头像池/直播中均不补');
}finally{Date.now=realNow}
