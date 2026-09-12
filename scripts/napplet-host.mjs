import {createServer} from 'node:http'
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'

// Local preview/test shell only. It never reaches a live mint or Nostr relay.
const prelude = readFileSync(
  fileURLToPath(import.meta.resolve('@napplet/shim/prelude.global')),
  'utf8'
)
const appFlag = process.argv.indexOf('--app')
const onlyApp = appFlag < 0 ? undefined : process.argv[appFlag + 1]
if (appFlag >= 0 && !['wallet', 'notes'].includes(onlyApp)) {
  throw new Error('Use --app wallet or --app notes.')
}
const port = onlyApp === 'notes' ? 4187 : 4186
const appSource = app =>
  readFileSync(
    app === 'wallet' ? 'dist-napplet/index.html' : 'dist-notes/index.html',
    'utf8'
  )
const scriptValue = value => JSON.stringify(value).replaceAll('<', '\\u003c')
const preview =
  app => String.raw`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>LNURLcash ${app === 'notes' ? 'Notes' : 'Wallet'} · local preview</title><style>
body{margin:0;background:#f5f4ed;font-family:system-ui;color:#285440} .shell{display:flex;gap:12px;padding:8px 20px;background:#e5eadb;align-items:center;font-size:12px}button{padding:7px 15px;border:1px solid #c6d0bd;background:#f8faf2;color:#285440;border-radius:6px;cursor:pointer}iframe{display:block;width:100%;height:calc(100vh - 52px);border:0}.hint{margin-left:auto;font-size:10px}
@media(max-width:650px){.shell{gap:6px;padding:6px 8px}.shell strong{font-size:8px}.shell button{font-size:10px;padding:6px 9px}.hint{display:none}iframe{height:calc(100vh - 44px)}}
</style></head><body><div class="shell"><strong>${app === 'notes' ? 'NOTES' : 'WALLET'} PREVIEW</strong>${app === 'wallet' ? '<button id="sample">Receive demo note</button>' : ''}<span class="hint">${app === 'wallet' ? 'Test mint only · no real sats · ' : ''}Data stays in this preview session</span></div><div id="frames"></div><script>
const prelude=${scriptValue(prelude)};
const app=${scriptValue(app)};const source=${scriptValue(appSource(app))};
const frames={}; const stores={[app]:new Map()};
const topics={[app]:new Set()};const pending={[app]:[]};
window.hostCalls=[];window.hostStores=stores;window.hostFrames=frames;window.demoBalance=21000;
const mintNotes=new Map();
const demoSecret='ab'.repeat(32);
const hash=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(text.match(/../g),v=>parseInt(v,16))))).map(v=>v.toString(16).padStart(2,'0')).join('');
const send=(key,msg)=>frames[key]?.contentWindow.postMessage(msg,'*');
function open(){const key=app;
 if(!frames[key]){const frame=document.createElement('iframe');frame.id=key;frame.title=key+' napplet';frame.sandbox='allow-scripts';
 const policy='<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: blob:; connect-src \'none\'; font-src \'none\'">';
 const injected='<script>'+prelude+'\n;NappletShimPrelude.install({domains:'+JSON.stringify(key==='wallet'?['storage','resource','inc']:['storage','inc','intent'])+'});</'+'script>';
 frame.srcdoc=source.replace('<head>','<head>'+policy+injected);frames[key]=frame;document.getElementById('frames').append(frame);}
}
function deliver(key,topic,payload,sender='preview-sender'){
 const msg={type:'inc.event',topic,payload,sender};
 if(topics[key].has(topic))send(key,msg);else pending[key].push(msg);
}
window.deliverNapplet=(topic,payload,sender)=>deliver(app,topic,payload,sender);
window.reloadNapplet=()=>{frames[app].remove();delete frames[app];topics[app].clear();open()};
// Preview-only routing between separate same-origin tabs. Never opens or focuses a page.
const hostId=crypto.randomUUID();const channel=new BroadcastChannel('lnurlcash-preview-notes-v1');
const responses=new Map();
function walletMessage(message){return new Promise(resolve=>{
 const id=crypto.randomUUID();const timeout=setTimeout(()=>{responses.delete(id);resolve(null)},800);
 responses.set(id,value=>{clearTimeout(timeout);responses.delete(id);resolve(value)});
 channel.postMessage({...message,id,source:hostId});
});}
channel.onmessage=event=>{
 const msg=event.data;if(!msg||typeof msg!=='object')return;
 if(msg.replyTo===hostId){responses.get(msg.id)?.(msg);return;}
 if(app!=='wallet')return;
 if(msg.type==='find-wallet')channel.postMessage({id:msg.id,replyTo:msg.source,wallet:hostId});
 if(msg.type==='send-design'&&msg.target===hostId&&msg.convention==='napplet:wallet/design'){
  deliver(app,msg.convention,msg.payload,'lnurlcash-notes');
  channel.postMessage({id:msg.id,replyTo:msg.source,handled:true});
 }
};
async function mockMint(url){
 const u=new URL(url);if(u.origin!=='https://demo.mint.test')throw new Error('Preview only: use demo.mint.test.');
 const q=u.searchParams;
 if(u.pathname==='/pay')return{tag:'payRequest',callback:u.origin+'/pay/cb',withdrawLink:u.origin+'/w',minSendable:1000,maxSendable:100000000,metadata:'[]',commentAllowed:64};
 if(u.pathname==='/pay/cb'){mintNotes.set(q.get('h'),Number(q.get('amount')));return{pr:'lnbc'+(Number(q.get('amount'))/100)+'n1qqqq'};}
 if(u.pathname==='/w'){
  const h=q.get('h')||(q.get('k1')?await hash(q.get('k1')):'');const amount=mintNotes.get(h);
  if(amount===undefined)return{status:'ERROR',reason:'Unknown note.'};
  return{tag:'withdrawRequest',callback:u.origin+'/w/cb',...(q.has('k1')?{k1:q.get('k1')}:{}),minWithdrawable:amount,maxWithdrawable:amount,mintPubkey:'02'+'aa'.repeat(32)};
 }
 if(u.pathname==='/w/cb'){
  const hashes=await Promise.all(q.getAll('k1').map(hash));if(hashes.some(h=>!mintNotes.has(h)))return{status:'ERROR',reason:'Already spent'};
  const total=hashes.reduce((sum,h)=>sum+mintNotes.get(h),0);hashes.forEach(h=>mintNotes.delete(h));
  if(q.has('h'))mintNotes.set(q.get('h'),q.has('amount')?Number(q.get('amount')):total);
  if(q.has('h2'))mintNotes.set(q.get('h2'),total-Number(q.get('amount')));
  return{status:'OK',sig:'ab'.repeat(65),sig2:'ab'.repeat(65)};
 }throw new Error('Unknown demo endpoint');
}
addEventListener('message',async event=>{
 const key=Object.keys(frames).find(key=>frames[key].contentWindow===event.source);if(!key)return;
 const msg=event.data;if(!msg||typeof msg.type!=='string')return;
 window.hostCalls.push({type:msg.type,topic:msg.topic,url:msg.url,...(msg.type==='intent.invoke'?{request:msg.request}:{})});
 const result={type:msg.type+'.result',id:msg.id};
 try{
  if(msg.type==='storage.get')result.value=stores[key].get(msg.key)??null;
  else if(msg.type==='storage.set')stores[key].set(msg.key,msg.value);
  else if(msg.type==='storage.keys')result.keys=[...stores[key].keys()];
  else if(msg.type==='inc.subscribe'){topics[key].add(msg.topic);setTimeout(()=>{for(const value of pending[key].filter(v=>v.topic===msg.topic))send(key,value);pending[key]=pending[key].filter(v=>v.topic!==msg.topic)},10);}
  else if(msg.type==='inc.unsubscribe'){topics[key].delete(msg.topic);return;}
  else if(msg.type==='inc.emit')return;
  else if(msg.type==='resource.bytes'&&app==='wallet'){result.blob=new Blob([JSON.stringify(await mockMint(msg.url))],{type:'application/json'});result.mime='application/json';}
  else if(msg.type==='resource.cancel')return;
  else if(msg.type==='intent.available'&&app==='notes'){
   const peer=msg.archetype==='wallet'?await walletMessage({type:'find-wallet'}):null;
   result.availability={archetype:msg.archetype,available:!!peer,hasDefault:!!peer,candidates:peer?[{dTag:'lnurlcash-wallet',actions:['design'],conventions:['napplet:wallet/design']}]:[]};
  }
  else if(msg.type==='intent.invoke'&&app==='notes'){
   const request=msg.request;
   const peer=request.archetype==='wallet'&&request.convention==='napplet:wallet/design'?await walletMessage({type:'find-wallet'}):null;
   const ack=peer?await walletMessage({type:'send-design',target:peer.wallet,convention:request.convention,payload:request.payload}):null;
   result.result={ok:!!ack?.handled,handled:!!ack?.handled,archetype:'wallet',action:'design',handler:'lnurlcash-wallet',...(!ack?{error:'Open the Wallet preview in a separate tab on this same preview server.'}:{})};
  }
  else return;
 }catch(error){result.error=error.message;if(msg.type==='resource.bytes')result.type='resource.bytes.error';}
 send(key,result);
});
const sample=document.getElementById('sample');
if(sample)sample.onclick=async()=>{mintNotes.set(await hash(demoSecret),window.demoBalance);deliver(app,'napplet:wallet/receive',{note:'https://demo.mint.test/w?k1='+demoSecret+'&amount='+window.demoBalance});};
open();
</script></body></html>`

createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname
  const app = path === '/' ? (onlyApp ?? 'wallet') : path.slice(1)
  if (path === '/raw-wallet' && onlyApp !== 'notes') {
    response
      .writeHead(200, {'Content-Type': 'text/html'})
      .end(appSource('wallet'))
  } else if (
    ['wallet', 'notes'].includes(app) &&
    (!onlyApp || app === onlyApp)
  ) {
    response
      .writeHead(200, {
        'Content-Type': 'text/html',
        'Cache-Control': 'no-store'
      })
      .end(preview(app))
  } else response.writeHead(404).end()
}).listen(port, '127.0.0.1', () =>
  console.info(
    `Local ${onlyApp ?? 'napplet'} preview: http://127.0.0.1:${port}/${onlyApp ?? 'wallet'}`
  )
)
