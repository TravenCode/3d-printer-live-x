import {test} from 'node:test';import assert from 'node:assert/strict';
import {parseChatLine,mapGift,parseLike,diffNew,allocateLikes,normKey,pbDecode,extractUser,isJunkName,stripTimeSuffix} from './douyin-bridge.mjs';

test('昵称后面的发布时间要被剥离',()=>{
  assert.equal(stripTimeSuffix('yjg3250昨天 21'),'yjg3250');
  assert.equal(stripTimeSuffix('小明'),'小明');
  assert.equal(stripTimeSuffix('冰雨格格今天 08'),'冰雨格格');
  assert.equal(stripTimeSuffix('路人甲3分钟前'),'路人甲');
  assert.deepEqual(parseChatLine('yjg3250昨天 21：15哥 如何获取打印软件？'),{kind:'comment',name:'yjg3250',text:'哥 如何获取打印软件？'});
  assert.deepEqual(parseChatLine('1072778353584052昨天 21：15哥 如何获取打印软件？'),{kind:'comment',name:'1072778353584052',text:'哥 如何获取打印软件？'});
  assert.equal(parseChatLine('小明昨天 21：666').name,'小明');
});

test('评论解析',()=>{assert.deepEqual(parseChatLine('天观星系：打印了'),{kind:'comment',name:'天观星系',text:'打印了'});assert.deepEqual(parseChatLine('马达研究者：666'),{kind:'comment',name:'马达研究者',text:'666'})});
test('礼物解析(空格形态)',()=>{const r=parseChatLine('蛋小黑 送出 大啤酒 x2');assert.equal(r.kind,'gift');assert.equal(r.name,'蛋小黑');assert.equal(r.gift,'大啤酒');assert.equal(r.count,2)});
test('礼物解析(冒号形态与默认数量)',()=>{const a=parseChatLine('蛋小黑：送出 棒棒糖 x3');assert.equal(a.kind,'gift');assert.equal(a.gift,'棒棒糖');assert.equal(a.count,3);const b=parseChatLine('蛋小黑 送出了 爱心');assert.equal(b.kind,'gift');assert.equal(b.gift,'爱心');assert.equal(b.count,1)});
test('礼物映射四类',()=>{assert.equal(mapGift('大啤酒'),'beer');assert.equal(mapGift('小心心'),'heart');assert.equal(mapGift('红心'),'heart');assert.equal(mapGift('棒棒糖'),'lollipop');assert.equal(mapGift('嘉年华'),'other')});
test('进场与系统消息',()=>{assert.deepEqual(parseChatLine('小小水晶球 来了'),{kind:'join',name:'小小水晶球'});assert.equal(parseChatLine('欢迎来到直播间！抖音严禁未成年人直播或礼物消费。').kind,'system');assert.equal(parseChatLine(''),null);assert.equal(parseChatLine(null),null)});
test('点赞计数解析',()=>{assert.equal(parseLike('100本场点赞'),100);assert.equal(parseLike('8 本场点赞'),8);assert.equal(parseLike('70.1万本场点赞'),701000);assert.equal(parseLike('71.1万本场点赞'),711000);assert.equal(parseLike('人气榜100+'),null)});
test('增量弹幕去重与顶端裁剪',()=>{const seen=new Set();assert.equal(diffNew(['天观星系：11111','马达研究者：打印'],seen).length,2);assert.equal(diffNew(['天观星系：11111','马达研究者：打印'],seen).length,0);assert.deepEqual(diffNew(['天观星系：11111','马达研究者：打印','蛋小黑：为啥没我?'],seen),['蛋小黑：为啥没我?']);assert.equal(diffNew(['马达研究者：打印','蛋小黑：为啥没我?'],seen).length,0)});
test('同文连发不去重',()=>{const seen=new Set();assert.equal(diffNew(['天观星系：999','天观星系：999'],seen).length,2);assert.equal(diffNew(['天观星系：999','天观星系：999'],seen).length,0)});
test('未知行不产生事件',()=>{assert.equal(parseChatLine('小时榜100+'),null);assert.equal(parseChatLine('原画可试看25s'),null)});
test('昵称归一化匹配头像',()=>{assert.equal(normKey('小 明 🌸'),'小明');assert.equal(normKey('  花火 '),'花火');assert.equal(normKey('😭👍豆豆'),'豆豆')});
test('protobuf解码：从协议消息提取昵称和头像',()=>{
  const fld=(n,payload)=>{const out=[(n<<3)|2];let l=payload.length;do{let b=l&0x7f;l>>>=7;if(l)b|=0x80;out.push(b)}while(l);return Buffer.concat([Buffer.from(out),payload])};
  const avatar='https://p3.douyinpic.com/aweme-avatar/testABC~tplv-obj.image';
  const user=Buffer.concat([fld(3,Buffer.from('小明','utf8')),fld(6,Buffer.from(avatar,'utf8'))]);
  const chat=Buffer.concat([fld(4,Buffer.from('666','utf8')),fld(7,user)]);
  const u=extractUser(chat);assert.equal(u.name,'小明');assert.equal(u.avatar,avatar);
  const nested=Buffer.concat([fld(1,Buffer.from([0x08,0x01])),fld(2,user)]);
  const u2=extractUser(nested);assert.equal(u2.name,'小明');
});
test('关注消息解析',()=>{assert.deepEqual(parseChatLine('小团 关注了主播'),{kind:'follow',name:'小团'});assert.deepEqual(parseChatLine('小团：关注了主播'),{kind:'follow',name:'小团'})});
test('垃圾名过滤',()=>{assert.equal(isJunkName('送出了'),true);assert.equal(isJunkName('远山观势前天分享[视频]'),true);assert.equal(isJunkName('小时榜'),true);assert.equal(isJunkName('冰雨格格'),false);assert.equal(parseChatLine('送出了 大啤酒 x1'),null);assert.equal(parseChatLine('远山观势前天分享[视频]：好看'),null)});
test('点赞轮换：交错进行，同一人每轮最多3次，绝不匿名',()=>{const roster=[['甲','a'],['乙','b'],['丙','c']];const st={idx:0,used:new Map()};const e1=allocateLikes(10,roster,st);assert.deepEqual(e1.map(e=>e.name+e.count),['甲1','乙1','丙1','甲1','乙1','丙1','甲1','乙1','丙1','甲1']);assert.ok(e1.every(e=>e.avatar));for(let i=0;i<e1.length-3;i++)assert.notEqual(e1[i].name,e1[i+1].name,'连续同一人');const e2=allocateLikes(3,roster,st);assert.deepEqual(e2.map(e=>e.name+e.count),['乙1','丙1','甲1']);const e3=allocateLikes(2,roster,st);assert.deepEqual(e3.map(e=>e.name+e.count),['乙1','丙1']);assert.deepEqual(allocateLikes(5,[],{idx:0,used:new Map()}),[])});
test('无真头像观众每轮只排1次，有头像者优先',()=>{const roster=[['甲','av'],['乙','']];const st={idx:0,used:new Map()};const e=allocateLikes(4,roster,st);assert.deepEqual(e.map(x=>x.name+x.count),['甲1','乙1','甲2']);const roster2=[['乙',''],['甲','av'],['丙','c']].sort((x,y)=>(Number(!!y[1])-Number(!!x[1])));const st2={idx:0,used:new Map()};const e2=allocateLikes(2,roster2,st2);assert.equal(e2[0].name,'甲','有头像者排前')});

test('悬停头像脚本可以编译，头像缓存供后续事件复用', async()=>{
  const {readFileSync}=await import('node:fs');
  const source=readFileSync(new URL('./douyin-bridge.mjs',import.meta.url),'utf8');
  const section=source.slice(source.indexOf('async function resolveHoverBatch'),source.indexOf('async function run(hub)'));
  const expressions=[...section.matchAll(/expression: `([\s\S]*?)`,/g)];
  assert.equal(expressions.length,2);
  for(const [,template] of expressions){
    const expression=new Function('name','return `'+template+'`;')('测试');
    assert.doesNotThrow(()=>new Function(expression));
  }
  assert.ok(source.includes('feedAvatar(n, a)'));
  assert.ok(source.includes('normMap.get(key) || normAvatars[key]'));
});

test('任意普通评论均触发，无关键词限制，包括数字表情和重复内容',()=>{
 for(const text of ['你好','123','😀','随便说点什么','打印'])assert.deepEqual(parseChatLine('小明：'+text),{kind:'comment',name:'小明',text});
 const seen=new Set();assert.equal(diffNew(['小明：😀','小明：😀'],seen).length,2);
});

test('嵌套Image.url_list与昵称同属User时可获取头像',()=>{
 const fld=(n,p)=>{const bytes=[n*8+2];let size=p.length;do{let b=size&127;size>>>=7;if(size)b|=128;bytes.push(b)}while(size);return Buffer.concat([Buffer.from(bytes),p])};
 const avatar='https://p3.douyinpic.com/aweme-avatar/test.jpeg?signature='+ 'a'.repeat(400);
 const user=Buffer.concat([fld(3,Buffer.from('炫 丽')),fld(9,fld(1,Buffer.from(avatar)))]);
 assert.deepEqual(extractUser(fld(2,user)),{name:'炫 丽',avatar});
});

test('悬停可定位单独昵称、冒号昵称，并给出多个点击位置',async()=>{
 const {readFileSync}=await import('node:fs');
 const src=readFileSync(new URL('./douyin-bridge.mjs',import.meta.url),'utf8');
 const section=src.slice(src.indexOf('async function resolveHoverBatch'));
 const template=section.match(/expression: `([\s\S]*?)`,/)[1];
 const expression=new Function('name','return `'+template+'`;')('小明');
 for(const text of ['小明','小明：','小明:','小明：你好']){
   const el={textContent:text,children:[],getBoundingClientRect:()=>({left:100,top:100,bottom:120,width:60,height:20})};
   const doc={querySelectorAll:()=>[el],elementFromPoint:()=>el};
   const result=new Function('document','window','innerWidth','innerHeight','return '+expression)(doc,{__chatRoot:{isConnected:true,querySelectorAll:()=>[el]}},800,600);
   const pts=JSON.parse(result);
   assert.ok(Array.isArray(pts)&&pts.length>=2,'昵称上应给出多个候选点击位置');
   assert.deepEqual({x:pts[0].x,y:pts[0].y},{x:130,y:110},'首选位置保持原靠左偏移');
   assert.ok(pts.every(p=>p.y===110&&p.x>=100&&p.x<160&&p.label));
   assert.equal(new Set(pts.map(p=>p.x+','+p.y)).size,pts.length,'点击位置不重复');
 }
});

test('头像补取多轮换位置点击，等待头像读取，失败后点评论区',async()=>{
 const {resolveHoverBatch,_injectCdpForTest}=await import('./douyin-bridge.mjs');
 async function drive(name,reads,points){
  const calls=[];let readerReads=0;const logs=[];const origLog=console.log,origWarn=console.warn;
  console.log=(...a)=>logs.push(a.join(' '));console.warn=(...a)=>logs.push(a.join(' '));
  try{
   _injectCdpForTest({ rpc: async(method,params)=>{
    if(method!=='Runtime.evaluate'){calls.push({type:params.type,x:params.x,y:params.y});return {result:{value:1}}}
    const ex=params.expression;
    if(ex.includes('.find(e => { const r=e.getBoundingClientRect()'))return {result:{value:false}};
    if(ex.includes('contenteditable'))return {result:{value:{x:5,y:5}}};
    if(ex.includes('__chatRoot'))return {result:{value:JSON.stringify(points)}};
    const v=reads[Math.min(readerReads,reads.length-1)];readerReads++;
    return {result:{value:JSON.stringify(v)}};
   }});
   await resolveHoverBatch([name]);
  }finally{console.log=origLog;console.warn=origWarn;_injectCdpForTest(null)}
  return {calls,readerReads,logs};
 }
 const pts=[{x:130,y:110,label:'左'},{x:112,y:110,label:'靠左'},{x:146,y:110,label:'右'}];
 const a=await drive('测试甲',[{card:false,avatar:''},{card:false,avatar:''},{card:false,avatar:''},{card:true,avatar:''},{card:true,avatar:'https://p3.douyinpic.com/aweme-avatar/ming.jpeg'}],pts);
 assert.deepEqual(a.calls.filter(c=>c.type==='mouseReleased').map(c=>c.x),[130,5,112],'第1轮点靠左，失败后点评论区，第2轮换位置');
 assert.equal(a.readerReads,5,'第1轮快速判3次，第2轮等头像加载2次');
 assert.ok(a.logs.some(l=>l.includes('点击资料卡获取到头像：测试甲')&&l.includes('第2次点击·靠左')));
 const b=await drive('测试乙',[{card:false,avatar:''}],pts);
 assert.deepEqual(b.calls.filter(c=>c.type==='mouseReleased').map(c=>c.x),[130,5,112,5,146,5],'3轮点击轮流换位置，每轮后点一次评论区');
 assert.equal(b.readerReads,9,'每轮快速判3次');
 assert.ok(b.logs.some(l=>l.includes('第1次点击（左）资料卡未出现 测试乙')));
 assert.ok(b.logs.some(l=>l.includes('第3次点击（右）资料卡未出现 测试乙')));
});

test('界面提示不能当作观众昵称',()=>{
 for(const name of ['充钻石客户端壁纸通知消息投稿','互相关注','粉丝团','账号已在其他地方进入直播间'])assert.equal(isJunkName(name),true);
 assert.equal(isJunkName('雅俗'),false);
});

test('资料卡补取发送完整单击事件',async()=>{
 const {clickNickname}=await import('./douyin-bridge.mjs');const calls=[];
 await clickNickname(async(method,params)=>calls.push({method,...params}),120,240);
 assert.deepEqual(calls.map(c=>c.type),['mouseMoved','mousePressed','mouseReleased']);
 assert.ok(calls.every(c=>c.x===120&&c.y===240));assert.equal(calls[1].button,'left');assert.equal(calls[2].clickCount,1);
});
