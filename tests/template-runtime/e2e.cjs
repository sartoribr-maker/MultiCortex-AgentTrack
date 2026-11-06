// End-to-end template boot + approved passive capture; fictitious HTTP model only.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { execFileSync } = require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),bcrypt=require('bcryptjs');
const tag='devcore-template-e2e-'+process.pid, network=tag+'-net', data=tag+'-server', state=tag+'-state';
const app=tag+'-app',proxy=tag+'-proxy',agent=tag+'-agent';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'devcore-template-e2e-'));
const image=process.env.POC_TEST_IMAGE || 'devcore-agenttrack:operational-candidate',origin='https://devcore.multicortex.com.br',base='http://127.0.0.1:3115';
const prefix=process.env.POC_TEST_BASE_PATH ?? '/agenttrack';
const bootstrap=crypto.randomBytes(32).toString('hex');
const docker=args=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let browser,context,cookie='';
async function until(description, fn, timeout=95000) {const start=Date.now();while(Date.now()-start<timeout){const result=await fn();if(result)return result;await delay(1000)}throw new Error('Timeout: '+description);}
async function api(method,route,body){return fetch(base+prefix+'/api/devcore/'+route,{method,headers:{'Content-Type':'application/json',host:'devcore.multicortex.com.br',origin,cookie},body:method==='GET'?undefined:JSON.stringify(body||{})});}
const stateRoot='/workspace/devcore-agent-state/template-e2e-first';
function probe(code){return docker(['exec',agent,'python3','-c',code]).trim();}
function ownedRunning(){return Number(probe("import glob\nn=0\nfor p in glob.glob('/proc/[0-9]*/cmdline'):\n try:\n  n+=any(x.endswith(b'/http_capture_core.py') for x in open(p,'rb').read().split(b'\\0'))\n except OSError: pass\nprint(n)"));}
(async()=>{try{
 fs.writeFileSync(path.join(root,'server.env'),[
  'NEXT_PUBLIC_BASE_PATH='+prefix,'HEALTH_PATH='+prefix+'/robots.txt','AUTH_SECRET='+crypto.randomBytes(32).toString('hex'),
  'AUTH_URL='+origin+prefix+'/api/auth','DEVCORE_USERS=smoke@example.invalid:'+bcrypt.hashSync('smoke-password',4),
  'DEVCORE_ADMIN_EMAILS=smoke@example.invalid','DEVCORE_BOOTSTRAP_TOKEN='+bootstrap,'DEVCORE_POC_MODE=1',
  'DEVCORE_AGENTS_FILE=/state/agents.json','DEVCORE_POCS_FILE=/state/pocs.json','DEVCORE_TELEMETRY_DIR=/state/telemetry'].join('\n'),{mode:0o600});
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(root,'key.pem'),'-out',path.join(root,'cert.pem'),'-days','1','-subj','/CN=monitor','-addext','subjectAltName=DNS:monitor'],{stdio:'ignore'});
 let proxyCode="const https=require('https'),http=require('http'),fs=require('fs');https.createServer({key:fs.readFileSync('/certs/key.pem'),cert:fs.readFileSync('/certs/cert.pem')},(req,res)=>{const p=http.request({host:'app',port:3000,path:req.url,method:req.method,headers:{...req.headers,host:'devcore.multicortex.com.br','x-forwarded-proto':'https'}},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res)});p.on('error',()=>{res.writeHead(502);res.end()});req.pipe(p)}).listen(8443,'0.0.0.0');";
 if(!prefix)proxyCode=proxyCode.replace('path:req.url','path:(req.url.startsWith("/agenttrack/api/devcore/agents/")?req.url.slice(11):req.url)');
 docker(['network','create',network]);docker(['volume','create',data]);docker(['volume','create',state]);
 docker(['run','--rm','--user','0','--entrypoint','chown','-v',data+':/state',image,'1001:1001','/state']);
 docker(['run','-d','--name',app,'--network',network,'--network-alias','app','-p','127.0.0.1:3115:3000','-v',data+':/state','--env-file',path.join(root,'server.env'),image]);
 docker(['run','-d','--name',proxy,'--network',network,'--network-alias','monitor','--user','0','--entrypoint','node','-v',root+':/certs:ro',image,'-e',proxyCode]);
 await until('app ready',async()=>{try{return(await fetch(base+prefix+'/entrar')).ok}catch{return false}},30000);
 docker(['run','-d','--name',agent,'--network',network,'--cap-add','NET_RAW','-p','127.0.0.1:3116:7080','-v',state+':/workspace','-v',root+':/certs:ro',
  '-e','RUNPOD_POD_ID=template-e2e-first','-e','MULTICORTEX_MONITOR_URL=https://monitor:8443/agenttrack','-e','MULTICORTEX_BOOTSTRAP_TOKEN='+bootstrap,'-e','SSL_CERT_FILE=/certs/cert.pem','devcore-agent-template:test']);
 await until('model starts',async()=>{try{return(await fetch('http://127.0.0.1:3116/health')).ok}catch{return false}},20000);
 browser=await chromium.launch({headless:true});context=await browser.newContext();
 await context.route(origin+'/**',async route=>{const r=route.request(),url=new URL(r.url());const response=await route.fetch({url:base+url.pathname+url.search,headers:{...r.headers(),host:'devcore.multicortex.com.br','x-forwarded-host':'devcore.multicortex.com.br','x-forwarded-proto':'https'}});await route.fulfill({response});});
 const page=await context.newPage();await page.goto(origin+prefix+'/entrar');await page.getByLabel('E-mail',{exact:true}).fill('smoke@example.invalid');await page.getByLabel('Senha',{exact:true}).fill('smoke-password');await page.getByRole('button',{name:'Entrar',exact:true}).click();await page.getByRole('heading',{name:'Central de POCs',exact:true}).waitFor();
 cookie=(await context.cookies(origin+prefix+'/')).map(c=>c.name+'='+c.value).join('; ');
 const enrolled=await until('agent enrollment',async()=>{const d=await(await api('GET','pocs')).json();return d.unassignedAgents.find(a=>a.podId==='template-e2e-first')},25000);
 assert.equal(enrolled.status,'pending');assert.equal(ownedRunning(),0);console.log('Boot: original model healthy; agent enrolled pending; no capture before approval');
 const today=new Date(Date.now()-3*3600000).toISOString().slice(0,10);
 const poc=(await(await api('POST','pocs',{name:'Template E2E',client:'Fictitious client',responsible:'Test',startDate:today,endDate:today,notes:''})).json()).poc;
 assert.equal((await api('POST','pocs/'+poc.id+'/pods',{name:'HTTP stub',podId:enrolled.podId,agentId:enrolled.id})).status,200);
 const baselineStart=Date.now();
 await Promise.all(Array.from({length:12},()=>fetch('http://127.0.0.1:3116/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','X-Forwarded-For':'198.51.100.99','X-Forwarded-Host':'test.devcore.invalid'},body:'{}'}).then(r=>r.text())));
 const baselineMs=Date.now()-baselineStart;assert.equal(ownedRunning(),0);
 console.log('Synthetic workload without capture: 12 concurrent requests in '+baselineMs+' ms');
 assert.equal((await api('POST','agents/'+enrolled.id+'/approve')).status,200);
 await until('approval activates capture',async()=>ownedRunning()===1,50000);
 const start=Date.now();
 await Promise.all(Array.from({length:12},(_,i)=>fetch('http://127.0.0.1:3116/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','X-Forwarded-For':i%2?'192.0.2.10':'192.0.2.11','X-Forwarded-Host':'test.devcore.invalid','Authorization':'Bearer fixture-api-should-not-persist'},body:JSON.stringify({messages:[{content:'fixture-prompt-should-not-persist'}]})}).then(r=>{assert.equal(r.status,200);return r.text()})));
 const capturedMs=Date.now()-start;assert.ok(capturedMs<Math.max(1000,baselineMs*4));
 console.log('Synthetic workload with capture: 12 requests in '+capturedMs+' ms; no model inference');
 const report=await until('operational metrics reach dashboard',async()=>{const d=await(await api('GET','pocs')).json();const pod=d.pocs.find(p=>p.id===poc.id).pods[0];return pod.operational?.metrics?.today?.requests>=12?pod:null},95000);
 assert.equal(report.operational.metrics.today.requests,12);
 assert.equal(report.operational.fresh,true);assert.equal(report.operational.metrics.today.developers,2);assert.ok(report.operational.metrics.today.latency_s.p50>0);assert.ok(report.operational.metrics.today.inflight.peak.total>1);
 assert.equal(JSON.stringify(report.operational).includes('192.0.2.10'),false);
 assert.equal(probe("import glob;print(any(b'fixture-prompt-should-not-persist' in open(p,'rb').read() or b'fixture-api-should-not-persist' in open(p,'rb').read() for p in glob.glob('"+stateRoot+"/operational/logs/*')))"),'False');
 console.log('Capture: real packet parser, counts, developers, latency, concurrency, privacy and telemetry validated');
 const tokenHash=probe("import hashlib;print(hashlib.sha256(open('"+stateRoot+"/operational-token','rb').read()).hexdigest())");
 docker(['restart',agent]);
 await until('model after restart',async()=>{try{return(await fetch('http://127.0.0.1:3116/health')).ok}catch{return false}},20000);
 await until('same agent resumes',async()=>{const d=await(await api('GET','pocs')).json();return d.pocs.find(p=>p.id===poc.id).pods[0].agent?.id===enrolled.id&&ownedRunning()===1},50000);
 assert.equal(probe("import hashlib;print(hashlib.sha256(open('"+stateRoot+"/operational-token','rb').read()).hexdigest())"),tokenHash);
 console.log('Restart: model and agent auto-start, original identity and credential preserved');
 const servicePid=probe("print(open('"+stateRoot+"/service.pid').read())");docker(['exec',agent,'kill','-KILL',servicePid]);
 await until('capture stops after supervisor crash',async()=>ownedRunning()===0,10000);
 assert.equal((await fetch('http://127.0.0.1:3116/health')).status,200);
 console.log('Safety: supervisor crash terminates owned capture; model remains healthy');
 docker(['exec',agent,'python3','/opt/multicortex/devcore-universal-agent/template_boot.py']);
 await until('capture after recovery',async()=>ownedRunning()===1,50000);
 assert.equal((await api('POST','agents/'+enrolled.id+'/revoke')).status,200);
 await until('revocation stops capture and removes token',async()=>ownedRunning()===0&&probe("import os;print(os.path.exists('"+stateRoot+"/operational-token'))")==='False',50000);
 assert.equal((await fetch('http://127.0.0.1:3116/health')).status,200);
 console.log('Revocation: capture stopped, operational credential deleted, original model unaffected');
 assert.equal((await api('POST','agents/'+enrolled.id+'/reset-credential',{reason:'Reativação administrativa explícita no teste de integração'})).status,200);
 await until('administrative reapproval recovers credential',async()=>ownedRunning()===1&&probe("import os;print(os.path.exists('"+stateRoot+"/operational-token'))")==='True',55000);
 assert.notEqual(probe("import hashlib;print(hashlib.sha256(open('"+stateRoot+"/operational-token','rb').read()).hexdigest())"),tokenHash);
 assert.equal(probe("print(open('"+stateRoot+"/credential-generation').read())"),'1');
 console.log('Administrative recovery: audited reapproval, new generation, same identity, one new credential');
} catch(error){console.error('Template E2E failure:',error.message.split('\n')[0]);try{console.log(docker(['logs','--tail','15',agent]))}catch{}process.exitCode=1;
} finally{if(context)await context.unrouteAll({behavior:'ignoreErrors'});if(browser)await browser.close();for(const c of [agent,proxy,app])try{docker(['rm','-f',c])}catch{}for(const v of [state,data])try{docker(['volume','rm',v])}catch{}try{docker(['network','rm',network])}catch{}fs.rmSync(root,{recursive:true,force:true});}})();
