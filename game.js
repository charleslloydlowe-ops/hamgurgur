const $=s=>document.querySelector(s);
let ws=null, me=null, room="", state=null, keys={}, myRole="";

$("#create").onclick=async()=>{
  const r=await fetch("/api/create"); const d=await r.json();
  if(!d.code){$("#status").textContent=d.error||"Failed";return}
  connect(d.code);
};
$("#join").onclick=()=>connect($("#roomCode").value.trim().toUpperCase());

async function connect(code){
  const name=($("#name").value.trim()||"Player").slice(0,16);
  if(!/^[A-Z2-9]{5}$/.test(code)){ $("#status").textContent="Enter a 5-character room code.";return }
  room=code;
  const proto=location.protocol==="https:"?"wss":"ws";
  ws=new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(room)}&name=${encodeURIComponent(name)}`);
  ws.onopen=()=>{ $("#menu").classList.add("hidden"); $("#lobby").classList.remove("hidden"); $("#code").textContent=room; };
  ws.onmessage=e=>handle(JSON.parse(e.data));
  ws.onclose=()=>{ if(!$("#game").classList.contains("hidden")) alert("Connection lost."); };
}
function send(o){if(ws?.readyState===1)ws.send(JSON.stringify(o))}
function handle(m){
  if(m.error){$("#lobbyStatus").textContent=m.message;return}
  if(m.you){me=m.you;send({type:"hello",id:me});}
  if(m.type==="state"){
    state=m;
    if(m.players?.some(p=>p.id===me && p.role)) myRole=m.players.find(p=>p.id===me).role;
    renderState();
  }
  if(m.type==="move"){const p=state?.players.find(x=>x.id===m.id);if(p){p.x=m.x;p.y=m.y}}
  if(m.type==="kill"){renderState()}
  if(m.type==="task"){renderState()}
  if(m.type==="sabotage"){renderState()}
  if(m.type==="ejected"){$("#meetingModal").classList.add("hidden");renderState()}
  if(m.type==="gameover"){showGameOver(m)}
}
function renderState(){
  if(!state)return;
  if(state.state==="lobby"){
    $("#lobby").classList.remove("hidden");$("#game").classList.add("hidden");
    $("#players").innerHTML=state.players.map(p=>`<div class="player">${esc(p.name)}${p.id===state.hostId?" 👑":""}</div>`).join("");
    $("#start").disabled=state.hostId!==me;
    $("#lobbyStatus").textContent=`${state.players.length}/12 players`;
  }else if(state.state==="playing"||state.state==="meeting"){
    $("#lobby").classList.add("hidden");$("#game").classList.remove("hidden");
    const mep=state.players.find(p=>p.id===me);
    if(mep) myRole=mep.role;
    $("#role").textContent=mep?.alive?(myRole==="impostor"?"🔪 IMPOSTOR":"👨‍🚀 CREWMATE"):"💀 DEAD";
    $("#role").style.color=myRole==="impostor"?"#ff5757":"#7dd3fc";
    $("#killBtn").classList.toggle("hidden",myRole!=="impostor");
    const count=state.players.filter(p=>p.role==="crewmate").reduce((n,p)=>n+(state.tasks?.[p.id]||0),0);
    $("#taskbar").textContent=`Tasks: ${count} / ${Math.max(1,state.players.filter(p=>p.role==="crewmate").length*3)}`;
    if(state.state==="meeting")openVoting();
  }
}
$("#start").onclick=()=>send({type:"start"});
$("#leave").onclick=()=>location.reload();
$("#meetingBtn").onclick=()=>send({type:"meeting"});
$("#useBtn").onclick=()=>{
  const p=state?.players.find(p=>p.id===me); if(!p||!p.alive)return;
  if(myRole==="crewmate")send({type:"task"});
};
$("#reportBtn").onclick=()=>{
  const p=state?.players.find(p=>p.id===me);if(!p||!p.alive)return;
  let best=-1,bd=90;
  state.bodies.forEach((b,i)=>{const d=Math.hypot(b.x-p.x,b.y-p.y);if(d<bd){bd=d;best=i}});
  if(best>=0)send({type:"report",bodyIndex:best});
};
$("#killBtn").onclick=()=>{
  const p=state?.players.find(p=>p.id===me);if(!p||myRole!=="impostor")return;
  let best=null,bd=75;
  state.players.forEach(t=>{if(t.id!==me&&t.alive&&t.role!=="impostor"){const d=Math.hypot(t.x-p.x,t.y-p.y);if(d<bd){bd=d;best=t}}});
  if(best)send({type:"kill",target:best.id});
};
function openVoting(){
  $("#meetingModal").classList.remove("hidden");
  $("#voteList").innerHTML=state.players.filter(p=>p.alive).map(p=>`<button class="vote" onclick="vote('${p.id}')">🧑 ${esc(p.name)} <small>vote</small></button>`).join("");
}
window.vote=id=>send({type:"vote",target:id});
$("#skipVote").onclick=()=>send({type:"vote",target:"skip"});
function showGameOver(m){
  $("#meetingModal").classList.add("hidden");$("#gameOver").classList.remove("hidden");
  $("#winner").textContent=m.winner==="impostors"?"🔪 IMPOSTORS WIN":"🎉 CREWMATES WIN";
  $("#imps").textContent="Impostors: "+m.impostors.join(", ");
}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}

// Keyboard / touch movement
addEventListener("keydown",e=>keys[e.key.toLowerCase()]=true);
addEventListener("keyup",e=>keys[e.key.toLowerCase()]=false);
document.querySelectorAll("[data-key]").forEach(b=>{
  const k=b.dataset.key;
  b.addEventListener("touchstart",e=>{e.preventDefault();keys[k]=true},{passive:false});
  b.addEventListener("touchend",e=>{e.preventDefault();keys[k]=false},{passive:false});
  b.addEventListener("mousedown",()=>keys[k]=true); b.addEventListener("mouseup",()=>keys[k]=false);
});
setInterval(()=>{
  const p=state?.players?.find(p=>p.id===me);
  if(!p||state.state!=="playing"||!p.alive)return;
  let dx=(keys.d||keys.arrowright||keys.right?1:0)-(keys.a||keys.arrowleft||keys.left?1:0);
  let dy=(keys.s||keys.arrowdown||keys.down?1:0)-(keys.w||keys.arrowup||keys.up?1:0);
  if(dx||dy){const len=Math.hypot(dx,dy);p.x=Math.max(30,Math.min(970,p.x+dx/len*7));p.y=Math.max(30,Math.min(570,p.y+dy/len*7));send({type:"move",id:me,x:p.x,y:p.y})}
},50);

// Canvas rendering
const canvas=$("#canvas"),ctx=canvas.getContext("2d");
function resize(){canvas.width=innerWidth*devicePixelRatio;canvas.height=innerHeight*devicePixelRatio;ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0)}
addEventListener("resize",resize);resize();
function draw(){
  requestAnimationFrame(draw);
  if($("#game").classList.contains("hidden")||!state)return;
  const W=innerWidth,H=innerHeight,sx=W/1000,sy=H/600;
  ctx.save();ctx.scale(sx,sy);
  ctx.fillStyle="#0c0f17";ctx.fillRect(0,0,1000,600);
  // spaceship rooms
  ctx.strokeStyle="#343a4b";ctx.lineWidth=5;
  [[50,50,900,180],[50,270,270,280],[330,270,300,280],[650,270,300,280]].forEach(r=>{ctx.strokeRect(...r)});
  ctx.fillStyle="#171c27";ctx.fillRect(70,70,860,140);ctx.fillRect(70,290,230,240);ctx.fillRect(350,290,260,240);ctx.fillRect(670,290,260,240);
  // task stations
  for(const [x,y] of [[120,110],[850,110],[140,410],[470,450],[820,400]]){ctx.fillStyle="#2c3342";ctx.fillRect(x,y,45,35);ctx.fillStyle="#7dd3fc";ctx.fillRect(x+7,y+7,31,21)}
  // bodies
  for(const b of state.bodies||[]){drawCrew(b.x,b.y,b.color,true)}
  // players
  for(const p of state.players||[]){if(p.alive)drawCrew(p.x,p.y,p.color,p.id===me)}
  ctx.restore();
}
function drawCrew(x,y,color,self){
  ctx.save();ctx.translate(x,y);
  ctx.fillStyle=color;ctx.beginPath();ctx.ellipse(0,5,22,28,0,0,Math.PI*2);ctx.fill();
  ctx.fillStyle="#91d8ef";ctx.beginPath();ctx.ellipse(7,-8,13,9,-.2,0,Math.PI*2);ctx.fill();
  ctx.fillStyle="#10131b";ctx.beginPath();ctx.ellipse(10,-8,10,6,-.2,0,Math.PI*2);ctx.fill();
  ctx.fillStyle="#fff";ctx.fillRect(-23,22,18,7);
  if(self){ctx.strokeStyle="#fff";ctx.lineWidth=2;ctx.strokeRect(-28,-32,56,70)}
  ctx.restore();
}
draw();
