const state={sources:[],buses:[],outputs:[],wires:[]};
const $=s=>document.querySelector(s); const canvas=$('#canvas');
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function sourceHtml(n){return `<div class="node ${n.offline?'offline':''}" data-id="${escapeHtml(n.id)}"><div class="node-top"><div class="node-icon ${n.iconClass}">${n.icon}</div><div><div class="node-title">${escapeHtml(n.title)}</div><div class="node-sub">${escapeHtml(n.sub)}</div></div><div class="node-status" style="color:${n.offline?'#aab4ad':'var(--green)'}"><i></i>${escapeHtml(n.status)}</div><button class="mute ${n.muted?'active':''}" data-source-mute="${escapeHtml(n.id)}" title="${n.muted?'恢复来源':'静音来源'}" aria-label="${n.muted?'恢复来源':'静音来源'}">${n.muted?'×':'◼'}</button><button class="mute" data-source-stop="${escapeHtml(n.id)}" title="停止来源" aria-label="停止来源" ${n.stopped?'disabled':''}>■</button></div><div class="node-meta"><span>${n.offline?'—':escapeHtml(n.sampleRate)}</span><input class="source-gain" type="range" min="0" max="200" value="${Math.round((n.gain??1)*100)}" data-source-gain="${escapeHtml(n.id)}" title="来源增益"><div class="meter ${n.offline?'warn':''}"><i style="width:${n.level}%"></i></div><span>${n.offline?'离线':n.level+'%'}</span></div><span class="port"></span></div>`}
function busHtml(n){return `<div class="node bus-node" data-id="${escapeHtml(n.id)}"><span class="port in"></span><div class="node-top"><div class="node-icon">≋</div><div><div class="node-title">${escapeHtml(n.title)}</div><div class="node-sub">混音总线 · ${n.muted?'已静音':'运行中'}</div></div><button class="mute ${n.muted?'active':''}" data-mute="${escapeHtml(n.id)}" title="${n.muted?'恢复通道':'静音通道'}">${n.muted?'×':'◼'}</button></div><div class="bus-controls"><label>增益</label><input class="range" type="range" min="0" max="100" value="${n.gain}" data-gain="${escapeHtml(n.id)}"><span class="gain-value">${n.gain}%</span><div class="meter"><i style="width:${n.muted?0:n.gain}%"></i></div><span class="port"></span></div></div>`}
function outputHtml(n){return `<div class="node output-node ${n.available===false?'offline':''}" data-id="${escapeHtml(n.id)}"><span class="port in"></span><div class="node-top"><div class="node-icon ${n.iconClass}">${n.icon}</div><div><div class="node-title">${escapeHtml(n.title)}</div><div class="node-sub">${escapeHtml(n.sub)}</div></div></div>${n.diagnostic?`<div class="output-diagnostic">${escapeHtml(n.diagnostic)}</div>`:''}</div>`}
function render(){
  $('#sourceNodes').innerHTML=state.sources.length?state.sources.map(sourceHtml).join(''):'<div class="node-sub">未发现音频来源</div>';
  $('#busNodes').innerHTML=state.buses.map(busHtml).join('');
  $('#outputNodes').innerHTML=state.outputs.map(outputHtml).join('');
  $('#sourceCount').textContent=state.sources.filter(source=>!source.offline).length;
  $('#busCount').textContent=state.buses.length;
  $('#routeCount').textContent=state.wires.length;
  $('#sourceLabel').textContent=state.sources.length+' 个来源';
  $('#busLabel').textContent=state.buses.length+' 个通道';
  bind(); requestAnimationFrame(drawWires);
}
function pos(id,port){const el=document.querySelector(`[data-id="${CSS.escape(id)}"]`);const p=el?.querySelector(port==='in'?'.port.in':'.port:not(.in)');if(!p)return null;const a=canvas.getBoundingClientRect(),b=p.getBoundingClientRect();return{x:b.left-a.left+b.width/2,y:b.top-a.top+b.height/2}}
function drawWires(){const svg=$('#wires');svg.innerHTML='';state.wires.forEach(([a,b],i)=>{const from=pos(a,'out'),to=pos(b,'in');if(!from||!to)return;const dx=Math.max(35,(to.x-from.x)*.42);const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',`M ${from.x} ${from.y} C ${from.x+dx} ${from.y}, ${to.x-dx} ${to.y}, ${to.x} ${to.y}`);path.setAttribute('class','wire');path.dataset.index=i;path.addEventListener('click',()=>{state.wires.splice(i,1);persistCanvas();toast('连接已移除');render()});svg.appendChild(path)})}
let pending=null;
function canConnect(from,to){const sourceIds=new Set(state.sources.map(source=>source.id));const busIds=new Set(state.buses.map(bus=>bus.id));const outputs=new Map(state.outputs.map(output=>[output.id,output]));return (sourceIds.has(from)&&busIds.has(to))||(busIds.has(from)&&outputs.get(to)?.enabled===true)}
function sendControl(message){if(controlSocket?.readyState===WebSocket.OPEN)controlSocket.send(JSON.stringify(message));else toast('控制连接暂不可用')}
function bind(){
  document.querySelectorAll('.port:not(.in)').forEach(port=>port.addEventListener('click',event=>{event.stopPropagation();pending=port.closest('.node').dataset.id;toast('请选择下一列的目标节点')}));
  document.querySelectorAll('.port.in').forEach(port=>port.addEventListener('click',event=>{event.stopPropagation();if(!pending)return;const target=port.closest('.node').dataset.id;if(!canConnect(pending,target)){toast('此路由类型或输出状态不允许连接');pending=null;return}if(!state.wires.some(wire=>wire[0]===pending&&wire[1]===target)){state.wires.push([pending,target]);persistCanvas();toast('路由连接已建立')}pending=null;render()}));
  document.querySelectorAll('[data-source-mute]').forEach(button=>button.addEventListener('click',()=>sendControl({type:'source.mute',sourceId:button.dataset.sourceMute,muted:!state.sources.find(source=>source.id===button.dataset.sourceMute)?.muted})));
  document.querySelectorAll('[data-source-stop]').forEach(button=>button.addEventListener('click',()=>sendControl({type:'source.stop',sourceId:button.dataset.sourceStop})));
  document.querySelectorAll('[data-source-gain]').forEach(range=>range.addEventListener('input',()=>sendControl({type:'source.gain',sourceId:range.dataset.sourceGain,gain:Number(range.value)/100})));
  document.querySelectorAll('[data-mute]').forEach(button=>button.addEventListener('click',()=>{const bus=state.buses.find(item=>item.id===button.dataset.mute);bus.muted=!bus.muted;persistCanvas();toast(bus.muted?'通道已静音':'通道已恢复');render()}));
  document.querySelectorAll('[data-gain]').forEach(range=>range.addEventListener('input',()=>{const bus=state.buses.find(item=>item.id===range.dataset.gain);bus.gain=Number(range.value);range.parentElement.querySelector('.gain-value').textContent=range.value+'%';range.parentElement.querySelector('.meter i').style.width=bus.muted?0:range.value+'%';persistCanvas()}));
}
function persistCanvas(){fetch('/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({buses:state.buses.map(bus=>({id:bus.id,name:bus.title,gain:Number(bus.gain)/100,muted:!!bus.muted})),routes:state.wires})}).then(()=>syncSnapshot()).catch(()=>{})}
function toast(message){const element=$('#toast');element.textContent=message;element.classList.add('show');clearTimeout(window._toast);window._toast=setTimeout(()=>element.classList.remove('show'),1800)}
$('#addBusBtn').addEventListener('click',()=>{const id='bus-'+Date.now();state.buses.push({id,title:'新建混音通道',gain:65,muted:false});persistCanvas();toast('已创建输出通道');render()});
$('#scanBtn').addEventListener('click',()=>toast('设备扫描由局域网发现请求触发'));
window.addEventListener('resize',drawWires);

function applySnapshot(snapshot){
  if(!snapshot?.config)return;
  const streams=new Map((snapshot.streams||[]).map(stream=>[String(stream.sourceId).toLowerCase(),stream]));
  const sources=(snapshot.sources||snapshot.config.sources||[]).map(source=>{
    const stream=streams.get(String(source.sourceId||'').toLowerCase());
    const online=source.online===true&&source.stopped!==true;
    const name=source.deviceName||source.name||'网络来源';
    const type=source.streamType||stream?.streamType||'unknown';
    const typeLabel=type==='microphone'?'麦克风流':type==='media'?'媒体流':'音频流';
    const rate=source.sampleRate||snapshot.config.settings?.sampleRate||48000;
    const channels=source.channels||snapshot.config.settings?.channels||2;
    return {id:source.id||`net-${source.sourceId}`,sourceId:source.sourceId,title:name,sub:`${typeLabel} · ${source.streamId||source.sourceId||''}`,icon:type==='microphone'?'♩':'◉',iconClass:'phone',status:source.stopped?'已停止':online?'在线':'离线',sampleRate:`${Math.round(rate/1000)} kHz · ${channels} ch`,level:online?Math.min(100,Math.round((source.rms||0)*240)):0,offline:!online,muted:source.muted===true,stopped:source.stopped===true,gain:Number(source.gain)||1};
  });
  state.sources=sources;
  state.buses=(snapshot.config.buses||[]).map(bus=>({id:bus.id,title:bus.name,gain:Math.round((Number(bus.gain)||0)*100),muted:bus.muted===true}));
  state.outputs=(snapshot.config.outputs||[]).map(output=>({id:output.id,title:output.name,sub:output.kind==='virtual-mic'?(output.enabled?'写入 CABLE Input · 应用读取 CABLE Output':'需要安装外部 VB-CABLE'):output.kind==='system'?'系统播放设备':output.kind||'输出设备',icon:output.kind==='system'?'◖':'♟',iconClass:output.kind==='system'?'speaker':'',available:output.enabled===true,enabled:output.enabled===true,diagnostic:output.enabled?`外部设备：${output.captureDeviceName||'CABLE Output'}`:(output.diagnostic||'请安装并启用 VB-CABLE')}));
  state.wires=(snapshot.config.routes||[]).map(edge=>[...edge]);
  render();
}
async function syncSnapshot(){try{const response=await fetch('/api/state');if(!response.ok)throw new Error('snapshot request failed');applySnapshot(await response.json())}catch(_){}}
let controlSocket=null;
function connectControl(){
  const scheme=location.protocol==='https:'?'wss':'ws';
  controlSocket=new WebSocket(`${scheme}://${location.host}/control`);
  controlSocket.onopen=()=>controlSocket.send(JSON.stringify({type:'state.get'}));
  controlSocket.onmessage=event=>{try{const message=JSON.parse(event.data);if(message.type==='state.snapshot')applySnapshot(message)}catch(_){}};
  controlSocket.onclose=()=>setTimeout(connectControl,1500);
}
connectControl();
syncSnapshot();

// Phase 1 browser playback adapter. Production Windows output uses WASAPI.
const playback={ctx:null,node:null,queue:[],ws:null,started:false};
function routeAllowsSpeakerSource(sourceHash){
  const source=state.sources.find(item=>String(item.sourceId).toLowerCase()===sourceHash.toString(16));
  if(!source||source.offline||source.muted||source.stopped)return false;
  return state.wires.some(([sourceId,busId])=>sourceId===source.id&&state.wires.some(([routedBus,outputId])=>routedBus===busId&&outputId==='out-speaker'));
}
function initPlayback(){
  if(playback.started)return;
  const AudioContext=window.AudioContext||window.webkitAudioContext;
  if(!AudioContext){toast('当前浏览器不支持音频播放');return;}
  playback.ctx=new AudioContext({sampleRate:48000});
  playback.node=playback.ctx.createScriptProcessor(1024,0,2);
  playback.node.onaudioprocess=event=>{const left=event.outputBuffer.getChannelData(0),right=event.outputBuffer.getChannelData(1);for(let i=0;i<left.length;i++){const frame=playback.queue.length>=2?playback.queue.splice(0,2):[0,0];left[i]=frame[0];right[i]=frame[1]}};
  playback.node.connect(playback.ctx.destination);playback.started=true;
  toast('系统播放预览已启用');
}
function connectAudio(){
  const scheme=location.protocol==='https:'?'wss':'ws';
  playback.ws=new WebSocket(`${scheme}://${location.host}/audio`);playback.ws.binaryType='arraybuffer';
  playback.ws.onopen=()=>toast('音频接收已连接');playback.ws.onerror=()=>toast('音频接收连接失败');playback.ws.onclose=()=>setTimeout(connectAudio,1500);
  playback.ws.onmessage=event=>{if(!playback.started)return;const bytes=new Uint8Array(event.data);if(bytes.length<20||String.fromCharCode(...bytes.slice(0,4))!=='MSA1')return;const view=new DataView(event.data),sourceHash=view.getUint32(4,true);if(!routeAllowsSpeakerSource(sourceHash))return;const payload=new Float32Array(event.data.slice(20));const max=48000*2/2;for(let i=0;i<payload.length&&playback.queue.length<max*2;i++)playback.queue.push(payload[i])};
}
document.addEventListener('pointerdown',initPlayback,{once:true});
connectAudio();
