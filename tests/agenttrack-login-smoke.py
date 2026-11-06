import subprocess,urllib.request,urllib.error,re,html,http.cookies
name='devcore-agenttrack-smoke'
hash_value=subprocess.check_output(['node','-e',"console.log(require('bcryptjs').hashSync('smoke-password', 4))"],text=True).strip()
subprocess.run(['docker','rm','-f',name],check=True,stdout=subprocess.DEVNULL)
subprocess.run(['docker','run','-d','--name',name,'-p','127.0.0.1:3113:3000',
 '-e','NEXT_PUBLIC_BASE_PATH=/agenttrack','-e','HEALTH_PATH=/agenttrack/robots.txt',
 '-e','AUTH_SECRET=local-smoke-test-only-not-a-real-secret',
 '-e','AUTH_URL=https://devcore.multicortex.com.br/agenttrack/api/auth',
 '-e','DEVCORE_USERS=smoke@example.invalid:'+hash_value,
 'devcore-agenttrack:current'],check=True,stdout=subprocess.DEVNULL)
import time
base='http://127.0.0.1:3113'
for _ in range(30):
 try:
  page=urllib.request.urlopen(base+'/agenttrack/entrar').read().decode();break
 except (urllib.error.URLError, ConnectionError): time.sleep(.2)
else: raise RuntimeError('server unavailable')
hidden=[]
for tag in re.findall(r'<input[^>]+>',page):
 if 'type="hidden"' in tag:
  key=re.search(r'name="([^"]+)"',tag)
  value=re.search(r'value="([^"]*)"',tag)
  if key: hidden.append((html.unescape(key.group(1)),html.unescape(value.group(1)) if value else ''))
assert hidden
boundary='----DevcoreSmokeBoundary'
fields=hidden+[('email','smoke@example.invalid'),('password','smoke-password')]
body=''.join('--'+boundary+'\r\nContent-Disposition: form-data; name="'+key+'"\r\n\r\n'+value+'\r\n' for key,value in fields)+'--'+boundary+'--\r\n'
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args): return None
opener=urllib.request.build_opener(NoRedirect)
request=urllib.request.Request(base+'/agenttrack/entrar',data=body.encode(),headers={
 'Content-Type':'multipart/form-data; boundary='+boundary,
 'Host':'devcore.multicortex.com.br','X-Forwarded-Proto':'https',
 'X-Forwarded-Host':'devcore.multicortex.com.br','Origin':'https://devcore.multicortex.com.br'})
try: response=opener.open(request)
except urllib.error.HTTPError as e: response=e
print('Login POST:',response.code,'Location:',response.headers.get('Location'))
assert response.code==303
assert response.headers['Location'] == 'https://devcore.multicortex.com.br/agenttrack/'
cookies=http.cookies.SimpleCookie()
for value in response.headers.get_all('Set-Cookie',[]): cookies.load(value)
session=cookies.get('__Secure-agenttrack.session-token')
assert session and session['path']=='/agenttrack' and session['secure']
print('Session cookie: isolated name/path; Secure; HttpOnly')
request=urllib.request.Request(base+'/agenttrack/',headers={'Cookie':'__Secure-agenttrack.session-token='+session.value})
with opener.open(request) as response:
 print('Authenticated dashboard:',response.code)
 assert response.code==200
 dashboard=response.read().decode()
 assert 'Agentes Universais' in dashboard

action=re.search(r'name="(\$ACTION_ID_[^"]+)"',dashboard).group(1)
body='--'+boundary+'\r\nContent-Disposition: form-data; name="'+action+'"\r\n\r\n\r\n--'+boundary+'--\r\n'
request=urllib.request.Request(base+'/agenttrack/',data=body.encode(),headers={
 'Content-Type':'multipart/form-data; boundary='+boundary,
 'Cookie':'__Secure-agenttrack.session-token='+session.value,
 'Host':'devcore.multicortex.com.br','X-Forwarded-Proto':'https',
 'X-Forwarded-Host':'devcore.multicortex.com.br','Origin':'https://devcore.multicortex.com.br'})
try: response=opener.open(request)
except urllib.error.HTTPError as e: response=e
print('Logout POST:',response.code,'Location:',response.headers.get('Location'))
assert response.code==303 and response.headers['Location']=='https://devcore.multicortex.com.br/agenttrack/entrar'
