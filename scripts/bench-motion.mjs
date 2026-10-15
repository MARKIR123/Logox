// Run after build: node scripts/bench-motion.mjs
// Synthetic visible Actor rows; excludes terminal rendering and private history.
import {performance} from 'node:perf_hooks';
import {RuntimeStore} from '../dist/src/runtime/store.js';
import {buildStageRows} from '../dist/src/tui/stage.js';
import {decorateRow} from '../dist/src/tui/row-presentation.js';
import {encodeRow} from '../dist/src/tui/terminal-plane.js';
const store = new RuntimeStore();
store.activities.create({sessionId:'bench', ownerId:'techne', activityId:'actor',kind:'actor',title:'动效测量', status:'running',stage:'执行',detail:''});
store.message('bench','techne','assistant',Array.from({length:120},(_,i)=>'line '+i+' abcdefghijklmnopqrstuvwxyz 中文🙂 '.repeat(5)).join(String.fromCharCode(10)),{activityId:'actor'});
const source = buildStageRows(store.getSnapshot(),'bench','logox',119,{actor:true},null);
function measure(height,motion) {
 const rows=source.slice(0,height), samples=[], decorations=[]; let previous=[],bytes=0,changed=0;
 for(let tick=0;tick<220;tick++){
  const began=performance.now();
  const presented=rows.map(row=>decorateRow(row,100000+tick*80,motion));
  const decorated=performance.now();
  const lines=presented.map((row,i)=>encodeRow(row,i,null,120));
  const ended=performance.now();
  if(tick>=20){samples.push(ended-began);decorations.push(decorated-began);for(let i=0;i<lines.length;i++)if(lines[i]!==previous[i]){bytes+=Buffer.byteLength(lines[i]);changed++;}}
  previous=lines;
 }
 samples.sort((a,b)=>a-b);
 const average=samples.reduce((a,b)=>a+b,0)/samples.length;
 return {rows:height,motion,decorateMs:+(decorations.reduce((a,b)=>a+b,0)/decorations.length).toFixed(3),frameMs:+average.toFixed(3),p95Ms:+samples[Math.floor(samples.length*.95)].toFixed(3),singleCorePercentAt12_5fps:+(average*12.5/10).toFixed(2),changedRowsPerTick:+(changed/200).toFixed(1),ansiBytesPerSecond:Math.round(bytes/200*12.5)};
}
console.log(JSON.stringify({note:'合成120列 Actor；计时包含颜色装饰和 ANSI 编码，不包含终端绘制',results:[measure(30,true),measure(30,false),measure(60,true),measure(60,false)]},null,2));
