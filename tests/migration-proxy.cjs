// Validate future Nginx cutover/rollback routing without touching public servers.
const {execFileSync}=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'devcore-migration-proxy-')),name='devcore-migration-proxy-'+process.pid,nginx=name+'-nginx';
const docker=a=>execFileSync('docker',a,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{try{
 const code="const http=require('http');for(const [port,version] of [[3002,'legacy'],[3004,'candidate'],[3103,'agenttrack']])http.createServer((q,s)=>{q.resume();q.on('end',()=>{s.setHeader('Content-Type','application/json');s.end(JSON.stringify({version,url:q.url,method:q.method,authorization:!!q.headers.authorization,enrollment:!!q.headers['x-agent-enrollment-key']}))})}).listen(port,'0.0.0.0');";
 fs.copyFileSync(path.join(process.cwd(),'infra/ec2/nginx-agenttrack-production-compat.conf'),path.join(root,'compat.conf'));
 function config(candidate){return `events {}\nhttp { server { listen 8080; server_name devcore.multicortex.com.br; ${candidate?'include /test/compat.conf;':'location /agenttrack/ { proxy_pass http://127.0.0.1:3103; }'} location / { proxy_pass http://127.0.0.1:${candidate?3004:3002}; } } }\n`;}
 fs.writeFileSync(path.join(root,'nginx.conf'),config(true));fs.chmodSync(root,0o755);
 docker(['run','-d','--name',name,'-p','127.0.0.1:3117:8080','--entrypoint','node','node:22-alpine','-e',code]);
 docker(['run','-d','--name',nginx,'--network','container:'+name,'-v',root+':/test:ro','nginx:alpine','nginx','-c','/test/nginx.conf','-g','daemon off;']);
 for(let i=0;i<40;i++){try{if((await fetch('http://127.0.0.1:3117/')).ok)break}catch{}await sleep(200)}
 docker(['exec',nginx,'nginx','-t','-c','/test/nginx.conf']);
 const response=await fetch('http://127.0.0.1:3117/agenttrack/api/devcore/agents/test/telemetry',{method:'POST',headers:{Authorization:'Bearer fixture-only','X-Agent-Enrollment-Key':'fixture-only'},body:'{}'});
 const data=await response.json();assert.equal(data.version,'candidate');assert.equal(data.url,'/api/devcore/agents/test/telemetry');assert.equal(data.method,'POST');assert.equal(data.authorization,true);assert.equal(data.enrollment,true);
 const browserRedirect=await fetch('http://127.0.0.1:3117/agenttrack/',{redirect:'manual'});assert.equal(browserRedirect.status,302);
 console.log('Cutover proxy: agent URL rewrite, POST and auth headers preserved; UI redirect validated');
 fs.writeFileSync(path.join(root,'nginx.conf'),config(false));docker(['exec',nginx,'nginx','-t','-c','/test/nginx.conf']);docker(['exec',nginx,'nginx','-s','reload','-c','/test/nginx.conf']);await sleep(500);
 const oldRoot=await(await fetch('http://127.0.0.1:3117/')).json();assert.equal(oldRoot.version,'legacy');
 const oldAgent=await(await fetch('http://127.0.0.1:3117/agenttrack/api/devcore/agents/test/status')).json();assert.equal(oldAgent.version,'agenttrack');assert.equal(oldAgent.url,'/agenttrack/api/devcore/agents/test/status');
 console.log('Rollback proxy: legacy root and AgentTrack restored without changing agent URLs');
}finally{for(const c of [nginx,name])try{docker(['rm','-f',c])}catch{}fs.rmSync(root,{recursive:true,force:true})}})().catch(e=>{console.error(e.message.split('\n')[0]);process.exitCode=1});
