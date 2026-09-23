const {chromium}=require('playwright');
const CASES=[
 ['nomic','NotFoundError','No microphone'],
 ['blocked','NotAllowedError','Mic blocked'],
 ['busy','NotReadableError','Mic busy'],
];
(async()=>{
 const b=await chromium.launch({channel:'chrome'}); let ok=true;
 for (const [mode,err,want] of CASES) {
  const ctx=await b.newContext(); const p=await ctx.newPage();
  await p.route('**/api/audio/voice-live/status', r=>r.fulfill({status:200,contentType:'application/json',body:'{"ready":true,"available":true,"configured":true}'}));
  await p.addInitScript(e=>{navigator.mediaDevices.getUserMedia=()=>Promise.reject(new DOMException('x',e));},err);
  await p.goto('http://127.0.0.1:9211/voice/');
  await p.getByRole('button',{name:'Start talking'}).click();
  await p.waitForFunction(()=>document.body.dataset.state==='err',null,{timeout:10000});
  const r={mode,state:await p.locator('#state').innerText(),caption:await p.locator('#caption').innerText(),detail:await p.locator('#detail').innerText(),button:await p.locator('#go').innerText(),enabled:await p.locator('#go').isEnabled()};
  const pass=r.state===want && r.enabled && /Try again/.test(r.button) && !/Error|Session refused|from:/.test(r.detail);
  ok=ok&&pass; console.log(pass?'PASS':'FAIL', JSON.stringify(r));
  await p.screenshot({path:`/tmp/voice-${mode}.png`}); await ctx.close();
 }
 // signed-out: session POST 401 after mic granted
 const ctx=await b.newContext(); const p=await ctx.newPage();
 await p.route('**/api/audio/voice-live/status', r=>r.fulfill({status:200,contentType:'application/json',body:'{"ready":true,"available":true,"configured":true}'}));
 await p.route('**/api/audio/voice-live/session', r=>r.fulfill({status:401,body:'{"detail":"Unauthorized"}'}));
 await p.addInitScript(()=>{navigator.mediaDevices.getUserMedia=async()=>{const c=new AudioContext();const d=c.createMediaStreamDestination();c.createOscillator().connect(d);return d.stream;};});
 await p.goto('http://127.0.0.1:9211/voice/'); await p.getByRole('button',{name:'Start talking'}).click();
 await p.waitForFunction(()=>document.body.dataset.state==='err',null,{timeout:10000});
 const s={state:await p.locator('#state').innerText(),caption:await p.locator('#caption').innerText(),login:await p.locator('#login').isVisible()};
 const sp=s.state==='Not signed in'&&s.login; ok=ok&&sp; console.log(sp?'PASS':'FAIL','signedout',JSON.stringify(s));
 await p.screenshot({path:'/tmp/voice-signedout.png'});
 await b.close(); console.log(ok?'GRACEFUL PROOF PASS':'GRACEFUL PROOF FAIL'); process.exit(ok?0:1);
})();
