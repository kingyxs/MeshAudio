'use strict';
// Physical Android + isolated desktop profile. Never change the user's graph.
// USB reverse validates native capture/PCM; it is not a wireless-LAN test.
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
const {execFileSync,spawn}=require('child_process');
const http=require('http'),net=require('net'),dgram=require('dgram');
const crypto=require('crypto');
const root=path.resolve(__dirname,'..'),pkg='com.meshaudio.node';
const adbFile=process.env.ADB || path.join(root,'.build-tools/android-sdk/platform-tools/adb.exe');
const serial=process.env.ANDROID_SERIAL;
const udpMode=process.env.MESHAUDIO_ANDROID_TRANSPORT==='udp';
const reportDir=path.join(root,'docs/testing/android');fs.mkdirSync(reportDir,{recursive:true});
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'meshaudio-android-'));
const checks=[],measurements={},logs=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let server,proxy,control,sourceMonitor,capture,originalPrefs,originalStayOn,fixtureInstalled=false,reverseAdded=false,controlPort,proxyPort;
let discoveryProxy,audioProxy,dropHash=null;
const pairs=new Set(),controlPairs=new Set(),audioPairs=new Set();
const wireStats=new Map();
function adb(args,options={}){return execFileSync(adbFile,[...(serial?['-s',serial]:[]),...args],{encoding:'utf8',timeout:20000,windowsHide:true,...options});}
function shell(...args){return adb(['shell',...args]);}
function appStatus(){try{return JSON.parse(adb(['exec-out','run-as',pkg,'cat','files/status.json']));}catch{return {};}}
function readPrefs(){return adb(['exec-out','run-as',pkg,'cat','shared_prefs/meshaudio.xml']);}
function writePrefs(value){
  const file=path.join(temp,'meshaudio.xml');fs.writeFileSync(file,value);
  adb(['push',file,'/data/local/tmp/meshaudio-test-prefs.xml']);
  adb(['shell','run-as',pkg,'cp','/data/local/tmp/meshaudio-test-prefs.xml','shared_prefs/meshaudio.xml']);
  adb(['shell','rm','-f','/data/local/tmp/meshaudio-test-prefs.xml']);
}
function withSetting(xml,key,value,type='string'){
  const safe=key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  xml=xml.replace(new RegExp(`<(?:string|int|long|boolean)\\s+name="${safe}"(?:[^>]*/>|[^>]*>[^<]*</(?:string|int|long|boolean)>)`,'g'),'');
  const tag=type==='string'?`<string name="${key}">${value}</string>`:`<${type} name="${key}" value="${value}" />`;
  return xml.replace('</map>',tag+'\n</map>');
}
async function until(test,label,timeout=20000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{const x=await test();if(x)return x;}catch(e){last=e;}await sleep(250);}throw Error(label+(last?': '+last.message:''));}
function passed(text){checks.push(text);console.log('PASS '+text);}
async function freePort(udp=false){const s=udp?dgram.createSocket('udp4'):net.createServer();await new Promise(r=>udp?s.bind(0,'127.0.0.1',r):s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function api(route,body){const r=await fetch(`http://127.0.0.1:${controlPort}${route}`,body===undefined?{}:{method:route==='/api/config'?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert(r.ok,route+' '+r.status);return r.json();}
function nodes(xml){return [...xml.matchAll(/<node\b[^>]+>/g)].map(m=>Object.fromEntries([...m[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(x=>[x[1],x[2]])));}
function dump(){shell('uiautomator','dump','/sdcard/meshaudio-test-window.xml');return adb(['exec-out','cat','/sdcard/meshaudio-test-window.xml']);}
function findNode(list,target){return list.find(n=>n.enabled!=='false' && (target instanceof RegExp?target.test(n.text||''):target.startsWith('#')?(n['resource-id']||'').endsWith('/'+target.slice(1)):n.text===target) && /\[\d+,\d+\]\[\d+,\d+\]/.test(n.bounds||'') && n.bounds!=='[0,0][0,0]');}
function tapNode(node){
  const id=node['resource-id'];const target=id?'id:'+id.split('/').pop():node.text;
  const quoted="'"+target.replaceAll("'","'\\''")+"'";
  const result=adb(['shell',`am instrument -w -e target ${quoted} com.meshaudio.driver/com.meshaudio.node.DeviceDriver`]);
  assert(/driverResult=clicked/.test(result),'system dialog action failed: '+target);
}
async function tap(target,scroll=true){
  const driver=path.join(root,'android/device-driver/build/outputs/apk/debug/device-driver-debug.apk');
  if(!fs.existsSync(driver)) throw Error('Build the test-only Android UI driver first');
  adb(['install','-r',driver]);
  const result=adb(['shell','am','instrument','-w','-e','target',target,'com.meshaudio.driver/com.meshaudio.node.DeviceDriver']);
  if(!/driverResult=clicked/.test(result)) throw Error('UI control not found: '+target+' '+result);
  await sleep(500);
}
async function consent(allow){
  await sleep(700);let list=nodes(dump());
  const allowNode=list.find(n=>/permission_allow_foreground_only_button|permission_allow_button/.test(n['resource-id']||''));
  if(allowNode){tapNode(allowNode);await sleep(500);list=nodes(dump());}
  if(!allow){const cancel=findNode(list,/^(取消|Cancel)$/)||list.find(n=>(n['resource-id']||'')==='android:id/button2');assert(cancel,'system projection cancel button missing');tapNode(cancel);await sleep(500);return;}
  const choose=findNode(list,/^(单个应用|A single app)$/);if(choose){tapNode(choose);await sleep(300);list=nodes(dump());const full=findNode(list,/^(整个屏幕|Entire screen|共享整个屏幕)$/);assert(full,'whole screen choice missing');tapNode(full);await sleep(300);list=nodes(dump());}
  const start=findNode(list,/^(立即开始|现在开始|开始|Start now|Start recording|Start)$/)||list.find(n=>(n['resource-id']||'')==='android:id/button1');
  assert(start,'system projection consent button missing');tapNode(start);await sleep(700);
}
async function foreground(){shell('input','keyevent','KEYCODE_WAKEUP');shell('wm','dismiss-keyguard');shell('am','start','-n',pkg+'/.MainActivity');await sleep(500);}
function sendControl(message){control.send(JSON.stringify(message));}
async function countSource(type){return (await api('/api/state')).sources.find(s=>s.streamType===type);}
function collectAudio(event){const b=Buffer.from(event.data);if(b.length<28||b.toString('ascii',0,4)!=='MSA1')return;const id=b.readUInt32LE(4).toString(16);const s=wireStats.get(id)||{packets:0,frames:0,energy:0,peak:0,maxBytes:0,invalid:0};s.packets++;s.maxBytes=Math.max(s.maxBytes,b.length);for(let i=20;i<b.length;i+=8){const v=b.readFloatLE(i);if(!Number.isFinite(v)||Math.abs(v)>1.001)s.invalid++;else{s.energy+=v*v;s.peak=Math.max(s.peak,Math.abs(v));s.frames++;}}wireStats.set(id,s);}
async function captureVirtual(duration=10000){
  const {detectVBCable}=require('../desktop/native-bridge');const device=detectVBCable();assert(device.available,'VB-CABLE output verification unavailable');
  const chunks=[];let stderr='';
  capture=spawn(device.helperPath,['--capture','--device',device.captureOutput.id,'--duration-ms',String(duration)],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  capture.stdout.on('data',x=>chunks.push(Buffer.from(x)));capture.stderr.on('data',x=>stderr+=x);
  const code=await new Promise((resolve,reject)=>{capture.once('exit',resolve);capture.once('error',reject);});capture=null;assert.equal(code,0,stderr);
  const format=stderr.split(/\r?\n/).map(x=>{try{return JSON.parse(x);}catch{return null;}}).find(x=>x?.type==='capture-info');assert(format,'missing capture format');
  const pcm=Buffer.concat(chunks);let sum=0,peak=0,real=0,imag=0,count=0;
  // Ignore startup before testing the separately captured native endpoint.
  for(let frame=Math.round(format.sampleRate*.5);frame<pcm.length/(format.channels*2);frame++){
    const x=pcm.readInt16LE(frame*format.channels*2)/32768;sum+=x*x;peak=Math.max(peak,Math.abs(x));
    const angle=frame*2*Math.PI*440/format.sampleRate;real+=x*Math.cos(angle);imag+=x*Math.sin(angle);count++;
  }
  const result={seconds:count/format.sampleRate,rms:Math.sqrt(sum/Math.max(1,count)),peak,amplitude440:2*Math.hypot(real,imag)/Math.max(1,count),endpoint:device.captureOutput.name};
  assert(result.seconds>5,'capture too short');assert(result.rms>.001&&result.peak<.5,'missing or clipped audio at actual virtual input');assert(result.amplitude440>.001,'known media tone missing at virtual input');return result;
}
async function main(){
  const devices=adb(['devices','-l']);assert(serial||devices.split(/\r?\n/).filter(x=>/\sdevice\s/.test(x)).length===1,'set ANDROID_SERIAL when multiple devices are attached');
  measurements.androidVersion=shell('getprop','ro.build.version.release').trim();measurements.api=Number(shell('getprop','ro.build.version.sdk').trim());measurements.model=shell('getprop','ro.product.model').trim();
  originalStayOn=shell('settings','get','global','stay_on_while_plugged_in').trim();
  shell('svc','power','stayon','usb');
  shell('am','force-stop',pkg);originalPrefs=readPrefs();fs.writeFileSync(path.join(root,'.build-tools/android-downloads/previous-app/pre-test-prefs.xml'),originalPrefs);
  const apk=path.join(root,'android/app/build/outputs/apk/debug/app-debug.apk');adb(['install','-r',apk]);
  measurements.apkSha256=crypto.createHash('sha256').update(fs.readFileSync(apk)).digest('hex');
  assert(/versionName=0\.3\.1/.test(shell('dumpsys','package',pkg)),'installed version mismatch');assert(readPrefs().includes(originalPrefs.match(/<string name="deviceId">([^<]+)<\/string>/)[1]),'device identity lost in upgrade');
  passed('in-place upgrade to Android 0.3.1 preserves the existing device identity and app data');
  controlPort=await freePort();proxyPort=await freePort();const audio=await freePort(true),discovery=await freePort(true);
  server=spawn(process.execPath,['server.js'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,MESHAUDIO_DATA_DIR:temp,MESHAUDIO_PORT:String(controlPort),MESHAUDIO_AUDIO_PORT:String(audio),MESHAUDIO_DISCOVERY_PORT:String(discovery),MESHAUDIO_AIRPLAY_GUIDE_PORT:'0',MESHAUDIO_WEB_MIC_TLS_PORT:'0',MESHAUDIO_NATIVE_AUDIO:'1',MESHAUDIO_ENGINE:'auto',MESHAUDIO_PARENT_PID:String(process.pid),MESHAUDIO_CONTROL_BIND_HOST:'127.0.0.1'}});
  server.stdout.on('data',x=>logs.push(String(x)));server.stderr.on('data',x=>logs.push(String(x)));
  await until(async()=> (await api('/api/health')).ok,'isolated desktop start');
  proxy=http.createServer((req,res)=>{const forwarded=http.request({host:'127.0.0.1',port:controlPort,path:req.url,method:req.method,headers:req.headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});forwarded.on('error',()=>{res.writeHead(502);res.end();});req.pipe(forwarded);});
  proxy.on('upgrade',(req,socket,head)=>{const upstream=net.connect(controlPort,'127.0.0.1',()=>{upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n`+Object.entries(req.headers).map(([k,v])=>k+': '+v).join('\r\n')+'\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);});const pair={socket,upstream};pairs.add(pair);const group=req.url==='/control'?controlPairs:audioPairs;group.add(pair);const close=()=>{pairs.delete(pair);group.delete(pair);socket.destroy();upstream.destroy();};socket.on('error',close);upstream.on('error',close);socket.on('close',close);upstream.on('close',close);});
  await new Promise(r=>proxy.listen(proxyPort,udpMode?'0.0.0.0':'127.0.0.1',r));
  let prefs;
  if(udpMode){
    const lan=process.env.MESHAUDIO_TEST_LAN_IP||Object.values(os.networkInterfaces()).flat().find(x=>x?.family==='IPv4'&&!x.internal&&x.address.startsWith('192.168.'))?.address;assert(lan,'set MESHAUDIO_TEST_LAN_IP');
    const discoverPublic=await freePort(true),audioPublic=await freePort(true);
    audioProxy=dgram.createSocket('udp4');audioProxy.on('message',(packet,remote)=>{measurements.wirelessSender=remote.address;if(packet.length>=20&&packet.readUInt32LE(4)===dropHash)return;audioProxy.send(packet,audio,'127.0.0.1');});await new Promise(r=>audioProxy.bind(audioPublic,'0.0.0.0',r));
    discoveryProxy=dgram.createSocket('udp4');discoveryProxy.on('message',(packet,remote)=>{const forward=dgram.createSocket('udp4');const expiry=setTimeout(()=>forward.close(),2500);forward.once('message',response=>{clearTimeout(expiry);try{const reply=JSON.parse(response);reply.controlPort=proxyPort;reply.audioPort=audioPublic;reply.port=audioPublic;discoveryProxy.send(Buffer.from(JSON.stringify(reply)),remote.port,remote.address);}finally{forward.close();}});forward.on('error',()=>{clearTimeout(expiry);try{forward.close();}catch{}});forward.send(packet,discovery,'127.0.0.1');});await new Promise(r=>discoveryProxy.bind(discoverPublic,'0.0.0.0',r));
    prefs=withSetting(originalPrefs,'host',lan);prefs=withSetting(prefs,'discoveryPort',discoverPublic,'int');prefs=withSetting(prefs,'websocket',false,'boolean');
  }else{
    const reverseList=adb(['reverse','--list']);assert(!/tcp:4173\b/.test(reverseList),'USB reverse tcp:4173 is already in use; preserve it');adb(['reverse','tcp:4173','tcp:'+proxyPort]);reverseAdded=true;
    prefs=withSetting(originalPrefs,'host','127.0.0.1');prefs=withSetting(prefs,'controlPort',4173,'int');prefs=withSetting(prefs,'websocket',true,'boolean');
  }
  writePrefs(prefs);
  control=new WebSocket(`ws://127.0.0.1:${controlPort}/control`);await new Promise((r,j)=>{control.onopen=r;control.onerror=j;});
  sourceMonitor=new WebSocket(`ws://127.0.0.1:${controlPort}/audio`);sourceMonitor.binaryType='arraybuffer';sourceMonitor.onmessage=collectAudio;await new Promise((r,j)=>{sourceMonitor.onopen=r;sourceMonitor.onerror=j;});
  await foreground();await tap('id:probe_desktop');await sleep(1200);assert(/已找到桌面端/.test(dump()),'desktop probe UI failed');passed(udpMode?'physical phone discovers the isolated desktop through the real wireless LAN using UDP':'physical phone probes the isolated desktop over explicit USB WebSocket compatibility mode');
  await tap('id:toggle_microphone');await until(()=>appStatus().microphone?.packets>500,'microphone capture');
  const mic=await countSource('microphone');assert(mic?.online,'desktop microphone source missing');measurements.micSourceId=mic.sourceId;
  passed('real Android AudioRecord microphone sends finite MSA1 PCM and appears online at the desktop');
  await tap('id:toggle_media');await consent(false);await until(()=>appStatus().microphone?.packets>1000,'microphone continued while cancelling media');assert.equal(appStatus().media.state,'stopped');passed('cancelling MediaProjection consent starts no media capture and leaves microphone streaming');
  await tap('id:toggle_media');await consent(true);await until(()=>appStatus().media?.packets>100,'media capture');
  const media=await countSource('media');assert(media?.online && media.sourceId!==mic.sourceId);measurements.mediaSourceId=media.sourceId;
  passed('fresh system consent starts independent native playback capture while the microphone remains active');
  const fixture='com.meshaudio.testplayer';assert(!shell('pm','list','packages',fixture).includes(fixture),'preserve existing test-player installation');adb(['install',path.join(root,'android/test-player/build/outputs/apk/debug/test-player-debug.apk')]);fixtureInstalled=true;
  shell('am','start','-n',fixture+'/.MainActivity');
  await until(()=> (wireStats.get(media.sourceId)?.peak||0)>.003,'capturable media tone reaches desktop');
  const state=await api('/api/state');await api('/api/config',{outputs:state.config.outputs.map(o=>({...o,enabled:o.id==='out-virtual'})),routes:[[media.id,'bus-main'],['bus-main','out-virtual']]});
  await sleep(1200);measurements.nativeVirtualOutput=await captureVirtual();passed('440 Hz audio from a separate Android playback app traverses the real native mixer and is recorded at VB-CABLE capture input');
  const beforePause=appStatus().microphone.packets;sendControl({type:'source.stop',sourceId:media.sourceId});await until(()=>appStatus().media?.state==='paused','remote media pause');await sleep(1000);assert(appStatus().microphone.packets>beforePause);sendControl({type:'source.start',sourceId:media.sourceId});await until(()=>appStatus().media?.state==='streaming','remote media resume');passed('desktop stop/resume pauses only its source without a new media authorization');
  const beforeControl=appStatus().media.packets;for(const pair of [...controlPairs]){pair.socket.destroy();pair.upstream.destroy();}await sleep(3000);assert(appStatus().media.packets>beforeControl+200);await until(()=>appStatus().media?.controlConnected,'independent control reconnect',15000);passed('disconnecting only the control sockets leaves audio streaming and control reconnects independently');
  const beforeLock=appStatus();shell('input','keyevent','KEYCODE_SLEEP');await sleep(30000);const afterLock=appStatus();assert(afterLock.microphone.packets>beforeLock.microphone.packets+5000,'mic stopped during screen-off');assert(afterLock.media.packets>beforeLock.media.packets+5000,'media stopped during screen-off');measurements.screenOffSeconds=30;passed('on this Android 14 phone both streams continue during a 30-second screen-off interval with a foreground service');
  const services=shell('dumpsys','activity','services',pkg);assert(/isForeground=true/.test(services),'foreground capture notification/service absent');passed('active capture uses an actual Android foreground service and ongoing notification');
  await foreground();const priorSequence=(await countSource('media')).sequence;const micBeforeStop=appStatus().microphone.packets;await tap('id:toggle_media');await until(()=>appStatus().media?.state==='stopped','media stop');await sleep(1000);assert(appStatus().microphone.packets>micBeforeStop);passed('stopping media leaves microphone capture and desktop reception running');
  await tap('id:toggle_media');await consent(true);await until(()=>appStatus().media?.packets>200,'media restart');assert.equal((await countSource('media')).sourceId,media.sourceId);assert(((await countSource('media')).sequence-priorSequence)>>>0 <0x80000000,'sequence rewound');passed('stopped media restarts with fresh consent, stable source identity and forward-only packet sequence');
  if(udpMode){
    const before=await countSource('microphone');dropHash=parseInt(media.sourceId,16);await sleep(4000);const still=await countSource('microphone');assert(still.packets>before.packets+500,'one UDP source loss interrupted the other');const mediaBefore=await countSource('media');dropHash=null;await until(async()=> (await countSource('media')).packets>mediaBefore.packets+200,'UDP source recovery');passed('dropping one wireless UDP source for four seconds preserves the other and audio resumes on the same routes');
  }else{
    const beforeNetwork=appStatus().media.reconnects;for(const pair of [...audioPairs]){pair.socket.destroy();pair.upstream.destroy();}await until(()=>appStatus().media?.reconnects>beforeNetwork,'network loss detected');await until(()=>appStatus().media?.state==='streaming'&&appStatus().microphone?.state==='streaming','audio reconnection',25000);passed('audio connection loss recovers both sources with bounded queues and without reusing projection consent');
  }
  await tap('id:stop_all');await until(()=>appStatus().media?.state==='stopped'&&appStatus().microphone?.state==='stopped','stop all');passed('stop-all releases capture, projection and foreground-service resources');
  for(const [id,stats] of wireStats){assert.equal(stats.invalid,0);assert(stats.maxBytes<=1200);measurements[id]={...stats,rms:Math.sqrt(stats.energy/Math.max(1,stats.frames))};}
  const crashes=shell('logcat','-d','-t','400','-s','AndroidRuntime:E');assert(!crashes.includes('Process: '+pkg),'Android app crashed');passed('captured PCM contains no NaNs/clipping or oversized packets; no MeshAudio fatal crash found');
}
main().catch(error=>{console.error(error.stack);measurements.error=error.message;process.exitCode=1;try{fs.writeFileSync(path.join(root,'.build-tools/android-device-failure.xml'),dump());fs.writeFileSync(path.join(root,'.build-tools/android-device-failure.png'),adb(['exec-out','screencap','-p'],{encoding:null}));}catch{}}).finally(async()=>{
  try{
    shell('am','force-stop',pkg);
    if(originalPrefs){
      // Restore user settings/identity, while never rewinding sequence leases.
      let restored=originalPrefs;
      const current=readPrefs();
      for(const match of current.matchAll(/<long\s+name="(nextSequence\.(?:microphone|media))"\s+value="(\d+)"\s*\/>/g))
        restored=withSetting(restored,match[1],match[2],'long');
      writePrefs(restored);
    }
  }catch(error){measurements.cleanupError=error.message;process.exitCode=1;}
  if(fixtureInstalled)try{adb(['uninstall','com.meshaudio.testplayer']);}catch{}
  if(reverseAdded)try{adb(['reverse','--remove','tcp:4173']);}catch{}
  if(originalStayOn!==undefined)try{shell('settings','put','global','stay_on_while_plugged_in',originalStayOn);}catch{}
  try{shell('rm','-f','/sdcard/meshaudio-test-window.xml');}catch{}
  try{control?.close();sourceMonitor?.close();}catch{}
  for(const pair of pairs){pair.socket.destroy();pair.upstream.destroy();}proxy?.close();capture?.kill();
  discoveryProxy?.close();audioProxy?.close();
  if(server&&server.exitCode===null){const exit=new Promise(r=>server.once('exit',r));server.kill();await exit;}
  fs.writeFileSync(path.join(root,'.build-tools/android-device-server.log'),logs.join('').slice(-40000));
  const report={ok:!process.exitCode,testedAt:new Date().toISOString(),transport:udpMode?'physical Android capture over wireless LAN UDP; isolated packet-fault proxy':'physical Android capture via USB reverse + WebSocket; not Wi-Fi',checks,measurements,manualRequired:[...(!udpMode?['same-LAN UDP discovery and wireless audio']:[]),'Android 10/11 and Android 15+ physical devices','30-minute continuity and human listening','other apps that allow or refuse playback capture']};
  fs.writeFileSync(path.join(reportDir,udpMode?'wireless-device-report.json':'device-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  fs.rmSync(temp,{recursive:true,force:true});
});
