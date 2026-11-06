// Local Docker fixture at port 3113; fictitious smoke user only.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try {
 const context=await browser.newContext();
 await context.route('https://devcore.multicortex.com.br/**',async route=>{
  const request=route.request();
  const url=new URL(request.url());
  const response=await route.fetch({url:'http://127.0.0.1:3113'+url.pathname+url.search,
   headers:{...request.headers(),host:'devcore.multicortex.com.br','x-forwarded-host':'devcore.multicortex.com.br','x-forwarded-proto':'https'}});
  await route.fulfill({response});
 });
 const page=await context.newPage();
 await page.goto('https://devcore.multicortex.com.br/agenttrack/entrar');
 await page.getByLabel('E-mail',{exact:true}).fill('smoke@example.invalid');
 await page.getByLabel('Senha',{exact:true}).fill('smoke-password');
 await page.getByRole('button',{name:'Entrar',exact:true}).click();
 await page.waitForTimeout(2500);
 console.log('URL after JS login:',page.url());
 if(!/^\/agenttrack\/?$/.test(new URL(page.url()).pathname)) throw new Error('Login destination incorrect');
 await page.getByRole('heading',{name:'Agentes Universais'}).waitFor();
 console.log('Authenticated panel: PASS');
 await page.getByRole('button',{name:'Sair',exact:true}).click();
 await page.waitForURL('**/agenttrack/entrar');
 console.log('Logout URL:',page.url());
 } finally {await browser.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
