// Isolated HTTPS CRM contract fixture; never uses production users/passwords.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const {execFileSync}=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'devcore-crm-auth-')),name='devcore-crm-auth-'+process.pid,app=name+'-app',crm=name+'-crm',volume=name+'-state',network=name+'-net';
const image=process.env.POC_TEST_IMAGE||'devcore-monitor:crm-candidate',origin='https://devcore.multicortex.com.br',base='http://127.0.0.1:3118';
const authSecret=crypto.randomBytes(32).toString('hex');
const role=crypto.randomUUID(),viewerRole=crypto.randomUUID(),id=crypto.randomUUID(),viewerId=crypto.randomUUID(),bootstrap=crypto.randomBytes(32).toString('hex');
const docker=a=>execFileSync('docker',a,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let browser,context;
const fixture=`const https=require('https'),fs=require('fs');const adminId=${JSON.stringify(id)},viewerId=${JSON.stringify(viewerId)},adminRole=${JSON.stringify(role)},viewerRole=${JSON.stringify(viewerRole)};
const refreshTokens=new Set(),crypto=require('crypto');const issue=(s,u)=>{const r=crypto.randomBytes(48).toString('hex');refreshTokens.add(r);s.setHeader('Set-Cookie','refresh_token='+r+'; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Lax');return 'eyJhbGciOiJIUzI1NiJ9.'+Buffer.from(JSON.stringify({sub:u.id,exp:Math.floor(Date.now()/1000)+60})).toString('base64url')+'.fixture_signature'};
https.createServer({key:fs.readFileSync('/fixture/key.pem'),cert:fs.readFileSync('/fixture/cert.pem')},async(q,s)=>{s.setHeader('Content-Type','application/json');let body='';for await(const chunk of q)body+=chunk;const mode=JSON.parse(fs.readFileSync('/fixture/mode.json'));let user={id:adminId,email:'admin@example.invalid',name:'CRM Admin fixture',role:{id:mode.demoted?viewerRole:adminRole,name:mode.demoted?'Vendedor':'Administrador'},mustChangePassword:!!mode.change};const payload=q.headers.authorization?.split('.')[1];if(payload){const tokenUser=JSON.parse(Buffer.from(payload,'base64url'));if(tokenUser.sub===viewerId)user={...user,id:viewerId,email:'viewer@example.invalid',role:{id:viewerRole,name:'Visualizador'}};}
if(q.url==='/api/v1/auth/login'){const input=JSON.parse(body);if(input.password!=='fixture-crm-password'||!['admin@example.invalid','viewer@example.invalid'].includes(input.email)){s.writeHead(401);return s.end('{}')}if(input.email==='viewer@example.invalid')user={...user,id:viewerId,email:input.email,role:{id:viewerRole,name:'Visualizador'}};const token=mode.expired?'eyJhbGciOiJIUzI1NiJ9.'+Buffer.from(JSON.stringify({sub:user.id,exp:Math.floor(Date.now()/1000)-1})).toString('base64url')+'.fixture_signature':issue(s,user);return s.end(JSON.stringify({accessToken:token,user,passwordChangeRequired:!!mode.change}))}
if(q.url==='/api/v1/auth/refresh'||q.url==='/api/v1/auth/logout'){const old=/refresh_token=([a-f0-9]+)/.exec(q.headers.cookie||'')?.[1];if(!old||!refreshTokens.delete(old)||q.url.endsWith('logout')){s.writeHead(old&&q.url.endsWith('logout')?200:401);return s.end('{}')}return s.end(JSON.stringify({accessToken:issue(s,user),user}))}
if(!payload){s.writeHead(401);return s.end('{}')}if(q.url==='/api/v1/auth/me')return s.end(JSON.stringify(user));if(q.url==='/api/v1/users/'+user.id)return s.end(JSON.stringify({...user,status:mode.inactive?'INACTIVE':'ACTIVE'}));s.writeHead(404);s.end('{}');}).listen(8443,'0.0.0.0');`;
(async()=>{try{
 fs.chmodSync(root,0o755);fs.writeFileSync(path.join(root,'server.cjs'),fixture);fs.writeFileSync(path.join(root,'mode.json'),'{}');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(root,'key.pem'),'-out',path.join(root,'cert.pem'),'-days','1','-subj','/CN=crm-fixture','-addext','subjectAltName=DNS:crm-fixture'],{stdio:'ignore'});
 docker(['network','create',network]);docker(['volume','create',volume]);docker(['run','--rm','--entrypoint','chown','--user','0','-v',volume+':/state',image,'1001:1001','/state']);
 docker(['run','-d','--name',crm,'--network',network,'--network-alias','crm-fixture','-v',root+':/fixture:ro','node:22-alpine','node','/fixture/server.cjs']);
 docker(['run','-d','--name',app,'--network',network,'-p','127.0.0.1:3118:3000','-v',volume+':/state','-v',root+':/fixture:ro',
 '-e','NODE_EXTRA_CA_CERTS=/fixture/cert.pem','-e','AUTH_SECRET='+authSecret,'-e','AUTH_URL='+origin,'-e','DEVCORE_AUTH_MODE=crm','-e','DEVCORE_CRM_API_URL=https://crm-fixture:8443/api/v1','-e','DEVCORE_CRM_ADMIN_ROLE_IDS='+role,'-e','DEVCORE_CRM_REVALIDATE_SECONDS=0','-e','DEVCORE_CRM_OUTAGE_GRACE_SECONDS=0',
 '-e','DEVCORE_USERS=legacy@example.invalid:'+require('bcryptjs').hashSync('fixture-legacy-password',4),'-e','DEVCORE_ADMIN_EMAILS=legacy@example.invalid',
 '-e','DEVCORE_POC_MODE=1','-e','DEVCORE_POCS_FILE=/state/pocs.json','-e','DEVCORE_AGENTS_FILE=/state/agents.json','-e','DEVCORE_TELEMETRY_DIR=/state/telemetry','-e','DEVCORE_BOOTSTRAP_TOKEN='+bootstrap,image]);
 for(let i=0;i<50;i++){try{if((await fetch(base+'/entrar')).ok)break}catch{}await sleep(200)}
 browser=await chromium.launch({headless:true});context=await browser.newContext();await context.route(origin+'/**',async route=>{const request=route.request(),url=new URL(request.url());const response=await route.fetch({url:base+url.pathname+url.search,headers:{...request.headers(),host:'devcore.multicortex.com.br','x-forwarded-host':'devcore.multicortex.com.br','x-forwarded-proto':'https'}});await route.fulfill({response});});const page=await context.newPage();page.setDefaultTimeout(15000);
 async function login(email,password){await page.goto(origin+'/entrar');await page.getByLabel('E-mail',{exact:true}).fill(email);await page.getByLabel('Senha',{exact:true}).fill(password);await page.getByRole('button',{name:'Entrar',exact:true}).click()}
 for(const [email,password] of [['legacy@example.invalid','fixture-legacy-password'],['viewer@example.invalid','fixture-crm-password'],['admin@example.invalid','wrong-password']]){await login(email,password);await page.getByRole('alert').filter({hasText:'Acesso não autorizado'}).waitFor();assert.ok(page.url().endsWith('/entrar'))}
 console.log('CRM login: non-Admin, wrong password and local-credential fallback denied');
 await login('admin@example.invalid','fixture-crm-password');await page.getByRole('heading',{name:'Central de POCs',exact:true}).waitFor();
 let cookie=(await context.cookies(origin)).map(c=>c.name+'='+c.value).join('; ');
 async function relogin(){await login('admin@example.invalid','fixture-crm-password');await page.getByRole('heading',{name:'Central de POCs',exact:true}).waitFor();cookie=(await context.cookies(origin)).map(c=>c.name+'='+c.value).join('; ')}
 const session=(await context.cookies(origin)).find(c=>c.name==='__Secure-authjs.session-token');assert.ok(session?.httpOnly&&session.secure);assert.equal(session.domain,'devcore.multicortex.com.br');
 async function api(route,options={}){return fetch(base+route,{...options,headers:{host:'devcore.multicortex.com.br','x-forwarded-proto':'https',cookie,origin,...options.headers}})}
 let r=await api('/api/devcore/pocs');assert.equal(r.status,200);assert.equal((await r.text()).includes('fixture_signature'),false);assert.equal((await page.content()).includes('fixture_signature'),false);assert.equal((await api('/api/auth/session')).status,404);
 console.log('CRM Admin: dashboard/API allowed; encrypted HttpOnly cookie; bearer absent from HTML/API');
 for(let i=0;i<4;i++){assert.equal((await api('/api/devcore/pocs')).status,200)}
 assert.equal(cookie.includes('refresh_token'),false);
 console.log('CRM renewal: expiring access token renewed server-side with rotating refresh token; session continues');
 const {encode}=await import('next-auth/jwt');const legacy=await encode({token:{sub:id,email:'admin@example.invalid',name:'Legacy fixture'},secret:authSecret,salt:'__Secure-authjs.session-token',maxAge:900});assert.equal((await api('/api/devcore/pocs',{headers:{cookie:'__Secure-authjs.session-token='+legacy}})).status,401);console.log('Legacy session: valid local cookie cannot grant CRM access');
 for(const mode of [{demoted:true},{inactive:true},{change:true}]){fs.writeFileSync(path.join(root,'mode.json'),JSON.stringify(mode));const denied=(await api('/api/devcore/pocs')).status;assert.ok(denied===403||denied===401,String(denied));assert.equal((await api('/api/devcore/pocs')).status,401);fs.writeFileSync(path.join(root,'mode.json'),'{}');await relogin()}
 assert.equal((await api('/api/devcore/pocs')).status,200);
 console.log('Current CRM profile: demotion, deactivation and mandatory password change deny an existing session');
 docker(['stop',crm]);assert.equal((await api('/api/devcore/pocs')).status,401);
 await page.waitForURL(/\/entrar$/,{timeout:25000});await page.getByText('Sua sessão expirou. Entre novamente.').waitFor();
 console.log('Expired session: dashboard returns to login with "Sua sessão expirou"');
 const agentId=crypto.randomUUID(),key=crypto.randomBytes(32).toString('hex');
 r=await api('/api/devcore/agents/enroll',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+bootstrap},body:JSON.stringify({identity:{agent_id:agentId,enrollment_key:key,platform:'runpod',pod_id:'fixture-pod',hostname:'fixture',agent_version:'fixture'}})});assert.equal(r.status,200);
 console.log('CRM outage: browser access denied; independent agent enrollment remains operational');
 const logs=docker(['logs',app]);assert.equal(logs.includes('fixture-crm-password'),false);assert.equal(logs.includes('fixture_signature'),false);
}finally{if(context)await context.unrouteAll({behavior:'ignoreErrors'});if(browser)await browser.close();for(const c of [app,crm])try{docker(['rm','-f',c])}catch{}try{docker(['volume','rm',volume])}catch{}try{docker(['network','rm',network])}catch{}fs.rmSync(root,{recursive:true,force:true})}})().catch(e=>{console.error('CRM E2E:',e.message.split('\n')[0]);process.exitCode=1});
