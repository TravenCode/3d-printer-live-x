// 打印优先级（数字越大越靠前）：礼物 3 > 关注 2 > 点赞 1 > 评论 0。
// 四类都会打印小头像；礼物按原有规则可能出多张/大图。
// voice=true 的类别在触发时会播一句语音感谢。
export const RULES={
  heart:{count:1,size:'large',priority:true,rank:3,voice:true,label:'爱心'},
  beer:{count:2,size:'large',priority:true,rank:3,voice:true,label:'啤酒'},
  lollipop:{count:3,size:'large',priority:true,rank:3,voice:true,label:'棒棒糖'},
  other:{count:1,size:'large',priority:true,rank:3,voice:true,label:'礼物'},
  follow:{count:1,size:'small',rank:2,voice:true,label:'关注'},
  like:{count:1,size:'small',rank:1,voice:true,label:'点赞'},
  comment:{count:1,size:'small',rank:0,voice:false,label:'评论'}
};
export class DemoRules{
 constructor(){this.queue=[];this.likes=new Map();this.seen=new Set();this.follows=new Set()}
 event(type,user,id,amount=1){
  if(!RULES[type])throw Error('未知规则');
  if(!user?.name)throw Error('缺少用户');
  if(!Number.isInteger(amount)||amount<1||amount>100)throw Error('演示单次数量应为1到100');
  if(id&&this.seen.has(id))return {added:0,duplicate:true};
  if(id)this.seen.add(id);
  const rule=RULES[type],count=rule.count*amount,rank=rule.rank??0;
  const jobs=Array.from({length:count},(_,i)=>({...user,size:rule.size,priority:!!rule.priority,rank,voice:!!rule.voice,source:rule.label,copy:i+1,total:count}));
  // 按 rank 稳定插入：排在同级之前、所有低优先级之后。
  let index=this.queue.length;
  if(rank>0){
    const at=this.queue.findIndex(j=>(j.rank??0)<rank);
    if(at>=0)index=at;
  }else{
    // 评论优先级最低，永远排在队尾。
    index=this.queue.length;
  }
  this.queue.splice(index,0,...jobs);
  return {added:count,size:rule.size,rank}
 }
}
