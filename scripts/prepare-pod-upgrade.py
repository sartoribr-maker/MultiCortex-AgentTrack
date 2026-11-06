#!/usr/bin/env python3
"""Generate a private SSH-PTY script to stage/apply code only to an existing agent."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import textwrap

BODY = r'''
import base64,hashlib,os,sys,zipfile,io,subprocess,compileall,time,json,urllib.request,re,shutil,tempfile
payload=base64.b64decode("""@PAYLOAD@""")
assert hashlib.sha256(payload).hexdigest()==@DIGEST@
root=@ROOT@
state=@STATE@
current=@CURRENT@
expected=@IDENTITY@
os.umask(0o077)
os.makedirs(root,mode=0o700,exist_ok=True)
with zipfile.ZipFile(io.BytesIO(payload)) as package:package.extractall(root)
candidate=os.path.join(root,'candidate')
if not os.path.isdir(candidate):
 subprocess.check_call([sys.executable,os.path.join(root,'devcore-universal-agent-template-v2','install.py'),'--install-dir',candidate])
assert compileall.compile_dir(candidate,quiet=1)
identity=open(os.path.join(state,'agent-id')).read().strip()
assert identity==expected
key=open(os.path.join(state,'enrollment-key')).read().strip()
assert re.match(r'^[a-f0-9]{64}$',key)
request=urllib.request.Request('https://devcore.multicortex.com.br/agenttrack/api/devcore/agents/status/'+identity,headers={'X-Agent-Enrollment-Key':key})
with urllib.request.urlopen(request,timeout=15) as response:
 status=json.load(response);protocol=response.headers.get('X-Devcore-Agent-Protocol')
assert status['status']=='approved'
sys.path.insert(0,candidate)
from operational_collector import collect_operational
started=time.time()
for i in range(20):
 result=collect_operational(approved=True,servers=[{'port':7080,'slots':6}],state_dir=state,salt=key)
 assert result['status']=='available'
print('Python',sys.version.split()[0],'COMPILE_OK; APPROVAL_CONFIRMED; OPERATIONAL_SOURCE_OK')
print('Average source read ms:',round((time.time()-started)*1000/20,2))
print('CANDIDATE='+candidate)
if @APPLY@:
 assert protocol=='2','Atualize o Monitor antes de atualizar o agente'
 assert not os.path.islink(current) and os.path.isdir(current)
 assert os.path.commonpath([current,state]) not in (current,state)
 env=dict(os.environ,MULTICORTEX_AGENT_STATE_DIR=state)
 manifest=json.load(open(os.path.join(root,'devcore-universal-agent-template-v2','MANIFEST.json')))['sha256']
 backup=os.path.join(root,'source-before-upgrade')
 os.mkdir(backup,0o700)
 for name in manifest:
  path=os.path.join(current,name)
  if os.path.isfile(path) and not os.path.islink(path):shutil.copy2(path,os.path.join(backup,name))
 from llama_discovery import discover_servers
 model_before=discover_servers()
 token_path=os.path.join(state,'operational-token')
 before=hashlib.sha256(open(token_path,'rb').read()).hexdigest()
 subprocess.check_call([sys.executable,os.path.join(current,'agent_service.py'),'stop'],env=env)
 for _ in range(50):
  output=subprocess.check_output([sys.executable,os.path.join(current,'agent_service.py'),'status'],env=env).decode()
  if 'Parado' in output:break
  time.sleep(.5)
 else:raise RuntimeError('Agente não encerrou no prazo; código não alterado')
 def replace(source,destination):
  fd,temporary=tempfile.mkstemp(prefix='.upgrade-',dir=current)
  try:
   with os.fdopen(fd,'wb') as handle:
    handle.write(open(source,'rb').read());handle.flush();os.fsync(handle.fileno())
   os.chmod(temporary,0o755 if destination.endswith('.sh') else 0o644)
   os.replace(temporary,destination)
  finally:
   if os.path.exists(temporary):os.unlink(temporary)
 try:
  for name in manifest:replace(os.path.join(candidate,name),os.path.join(current,name))
  subprocess.check_call([sys.executable,os.path.join(current,'agent_service.py'),'start'],env=env)
  assert discover_servers()==model_before
  assert open(os.path.join(state,'agent-id')).read().strip()==expected
  assert hashlib.sha256(open(token_path,'rb').read()).hexdigest()==before
  print('UPGRADE_OK; IDENTITY_AND_CREDENTIAL_PRESERVED; MODEL_UNCHANGED')
 except Exception:
  for name in os.listdir(backup):replace(os.path.join(backup,name),os.path.join(current,name))
  subprocess.call([sys.executable,os.path.join(current,'agent_service.py'),'start'],env=env)
  raise
'''


def make(archive, identity, apply=False):
    import uuid
    uuid.UUID(identity)
    data=archive.read_bytes();digest=hashlib.sha256(data).hexdigest()
    values={'@PAYLOAD@':'\n'.join(textwrap.wrap(base64.b64encode(data).decode(),1800)),
            '@DIGEST@':repr(digest),'@ROOT@':repr('/workspace/.devcore-agent-upgrade-'+digest[:12]),
            '@STATE@':repr('/workspace/devcore-agent-state'),'@CURRENT@':repr('/workspace/devcore-universal-agent'),
            '@IDENTITY@':repr(identity),'@APPLY@':str(bool(apply))}
    text=BODY
    for key,value in values.items():text=text.replace(key,value)
    return "stty -echo\npython3 - <<'DEVCORE_UPGRADE'\n"+text+"\nDEVCORE_UPGRADE\nexit\n"


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--archive',required=True);p.add_argument('--agent-id',required=True);p.add_argument('--output',required=True);p.add_argument('--apply',action='store_true');a=p.parse_args()
    target=Path(a.output)
    import os
    fd=os.open(str(target),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as handle:handle.write(make(Path(a.archive),a.agent_id,a.apply))
    print('Script privado preparado; nenhuma credencial embutida')
