const fs=require('fs');
const t0=Date.now();
const commands=new Map();
for (const f of fs.readdirSync('./commands').filter(x=>x.endsWith('.js'))) {
  try { const m=require('./commands/'+f); for(const c of m.commands) commands.set(c.name.toLowerCase(), c); } catch(e){ console.log('FAIL',f,e.message); }
}
console.log('1) command load:', Date.now()-t0, 'ms  ('+commands.size+' cmds)');

// time a normal command dispatch (menu)
const m={command:'menu',arg:'',args:[],text:'.menu',chat:'1@s.whatsapp.net',sender:'1@s.whatsapp.net',isOwner:true,isGroup:false,reply:async()=>{},send:async()=>{}};
const sock={sendMessage:async()=>({key:{id:'x'}}),readMessages:async()=>{},sendPresenceUpdate:async()=>{}};
(async()=>{
  const t1=Date.now();
  await commands.get('menu').handler(m,sock);
  console.log('2) menu dispatch:', Date.now()-t1, 'ms');

  // time the fuzzy scan (worst case — unknown command)
  const lev=(a,b)=>{const d=Array.from({length:a.length+1},(_,i)=>[i,...Array(b.length).fill(0)]);for(let j=0;j<=b.length;j++)d[0][j]=j;for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++)d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(a[i-1]===b[j-1]?0:1));return d[a.length][b.length];};
  const t2=Date.now();
  const q='xyzzy';
  [...commands.keys()].map(n=>{let s=lev(q,n);if(n.includes(q)||q.includes(n))s=Math.min(s,Math.abs(n.length-q.length));return[n,s];}).sort((a,b)=>a[1]-b[1]);
  console.log('3) fuzzy scan (unknown cmd):', Date.now()-t2, 'ms  <-- YE MASLA HY');

  // time settings getToggle
  const settingsMod=require('./commands/settings.js');
  const t3=Date.now();
  for(let i=0;i<1000;i++) settingsMod.getToggle('autoread');
  console.log('4) 1000x getToggle:', Date.now()-t3, 'ms');
  process.exit(0);
})();
