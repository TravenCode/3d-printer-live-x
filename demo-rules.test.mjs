import {test} from 'node:test';import assert from 'node:assert/strict';import {DemoRules,RULES} from './demo-rules.mjs';
for(const [type,count,size] of [['like',1,'small'],['follow',1,'small'],['comment',1,'small'],['heart',1,'large'],['beer',2,'large'],['lollipop',3,'large']])test(type+'数量与尺寸',()=>{let r=new DemoRules();r.event(type,{name:'测试'},'1');assert.equal(r.queue.length,count);assert.ok(r.queue.every(x=>x.size===size))});
test('事件去重',()=>{let r=new DemoRules();for(let i=0;i<2;i++)r.event('beer',{name:'测试'},'same');assert.equal(r.queue.length,2)});
test('拒绝旧规则',()=>{let r=new DemoRules();assert.throws(()=>r.event('small66',{name:'测试'},'1'))});

test('优先级：礼物 > 关注 > 点赞 > 评论',()=>{
  const r=new DemoRules();
  r.event('comment',{name:'评论者'},'c1');
  r.event('like',{name:'点赞者'},'l1');
  r.event('follow',{name:'关注者'},'f1');
  r.event('beer',{name:'礼物者'},'b1');
  assert.deepEqual(r.queue.map(j=>j.rank),[3,3,2,1,0]);
  assert.deepEqual(r.queue.map(j=>j.name),['礼物者','礼物者','关注者','点赞者','评论者']);
});

test('同级保持先后顺序，评论永远排最后',()=>{
  const r=new DemoRules();
  r.event('comment',{name:'评论A'},'c1');
  r.event('comment',{name:'评论B'},'c2');
  r.event('like',{name:'点赞A'},'l1');
  r.event('like',{name:'点赞B'},'l2');
  assert.deepEqual(r.queue.map(j=>j.name),['点赞A','点赞B','评论A','评论B']);
});

test('语音感谢只覆盖礼物/关注/点赞',()=>{
  for(const t of ['heart','beer','lollipop','other','follow','like'])assert.equal(RULES[t].voice,true,t+' 应播语音');
  assert.equal(RULES.comment.voice,false,'评论不应播语音');
});

test('关注、点赞、评论都打印小头像',()=>{
  for(const t of ['follow','like','comment'])assert.equal(RULES[t].size,'small',t+' 应为小图');
});
