// Integration fixture: isolated Docker volume, fictitious agents/users, no production writes.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const name = 'devcore-poc-browser-' + process.pid;
const volume = name + '-data';
const image = process.env.POC_TEST_IMAGE || 'devcore-agenttrack:poc-candidate';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devcore-poc-browser-'));
const base = 'http://127.0.0.1:3114';
const origin = 'https://devcore.multicortex.com.br';
const prefix = process.env.POC_TEST_BASE_PATH ?? '/agenttrack';
const bootstrap = crypto.randomBytes(32).toString('hex');
const env = [
 'NEXT_PUBLIC_BASE_PATH=' + prefix, 'HEALTH_PATH=' + prefix + '/robots.txt',
 'AUTH_SECRET=' + crypto.randomBytes(32).toString('hex'),
 'AUTH_URL=' + origin + prefix + '/api/auth',
 'DEVCORE_USERS=smoke@example.invalid:' + bcrypt.hashSync('smoke-password', 4),
 'DEVCORE_ADMIN_EMAILS=smoke@example.invalid', 'DEVCORE_BOOTSTRAP_TOKEN=' + bootstrap,
 'DEVCORE_POC_MODE=1', 'DEVCORE_AGENTS_FILE=/state/agents.json',
 'DEVCORE_TELEMETRY_DIR=/state/telemetry', 'DEVCORE_POCS_FILE=/state/pocs.json',
].join('\n');
const envPath = path.join(root, 'fixture.env');
fs.writeFileSync(envPath, env, { mode: 0o600 });
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, context, page;
(async () => {
 try {
  docker(['volume', 'create', volume]);
  docker(['run', '--rm', '--user', '0', '--entrypoint', 'chown', '-v', volume + ':/state', image, '1001:1001', '/state']);
  docker(['run', '-d', '--name', name, '-p', '127.0.0.1:3114:3000', '-v', volume + ':/state', '--env-file', envPath, image]);
  for (let i = 0; i < 50; i++) { try { if ((await fetch(base + prefix + '/entrar')).ok) break; } catch {} await delay(200); }
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  await context.route(origin + '/**', async route => {
   const request = route.request(), url = new URL(request.url());
   const response = await route.fetch({ url: base + url.pathname + url.search,
    headers: { ...request.headers(), host: 'devcore.multicortex.com.br', 'x-forwarded-host': 'devcore.multicortex.com.br', 'x-forwarded-proto': 'https' } });
   await route.fulfill({ response });
  });
  let cookie = '';
  async function api(method, route, body, extra = {}) {
   return fetch(base + prefix + '/api/devcore/' + route, { method, headers: {
    'Content-Type': 'application/json', host: 'devcore.multicortex.com.br',
    'x-forwarded-proto': 'https', origin, cookie, ...extra,
   }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  }
  assert.equal((await api('GET', 'pocs')).status, 403);
  const id = crypto.randomUUID(), key = crypto.randomBytes(32).toString('hex');
  assert.equal((await api('POST', 'agents/enroll', { identity: { agent_id: id, enrollment_key: key, platform: 'runpod', pod_id: 'test-pod-one', hostname: 'test-host', agent_version: 'test' } }, { Authorization: 'Bearer ' + bootstrap })).status, 200);
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(15000);
  page.on("pageerror", e => console.log("Browser error:", e.message.split("\n")[0]));
  page.on('dialog', dialog => dialog.accept(dialog.type() === 'prompt' ? 'Reativação administrativa explícita em teste de navegador' : undefined));
  await page.goto(origin + prefix + '/entrar');
  await page.getByLabel('E-mail', { exact: true }).fill('smoke@example.invalid');
  await page.getByLabel('Senha', { exact: true }).fill('smoke-password');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await page.getByRole('heading', { name: 'Central de POCs', exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, prefix + '/');
  cookie = (await context.cookies(origin + prefix + '/')).map(c => c.name + '=' + c.value).join('; ');
  assert.equal((await api('POST', 'pocs', {}, { origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await api('POST', 'agents/' + id + '/approve')).status, 409);
  assert.equal((await api('POST', 'agents/' + id + '/approve', {}, { origin: 'https://evil.invalid' })).status, 403);
  console.log('Authorization: anonymous/cross-origin/unlinked approval denied');
  await page.getByRole('button', { name: '+ Nova POC', exact: true }).click();
  await page.getByLabel('Nome da POC', { exact: true }).fill('Atendimento de teste');
  await page.getByLabel('Cliente', { exact: true }).fill('Cliente fictício');
  await page.getByLabel('Responsável', { exact: true }).fill('Equipe de teste');
  await page.getByLabel('Início', { exact: true }).fill('2026-11-01');
  await page.getByLabel('Encerramento previsto', { exact: true }).fill('2026-12-01');
  await page.getByRole('button', { name: 'Criar POC', exact: true }).click();
  await page.getByRole('link').filter({ hasText: 'Atendimento de teste' }).click();
  await page.waitForURL('**' + prefix + '/pocs/**');
  await page.getByRole('heading', { name: 'Atendimento de teste', exact: true }).waitFor();
  let data = await (await api('GET', 'pocs')).json();
  const poc = data.pocs[0];
  assert.ok(new URL(page.url()).pathname.startsWith(prefix + '/pocs/'));
  await page.getByRole('button', { name: '+ Cadastrar POD', exact: true }).click();
  await page.getByLabel('Agente registrado', { exact: true }).selectOption(id);
  await page.getByLabel('Nome da POD', { exact: true }).fill('Inferência principal');
  await page.getByRole('button', { name: 'Salvar POD', exact: true }).click();
  await page.locator('details').filter({ hasText: 'PODs da POC · detalhes e autorização' }).evaluate(node => { node.open = true; });
  await page.getByRole('heading', { name: 'Inferência principal', exact: true }).waitFor();
  let status = await (await api('GET', 'agents/status/' + id, undefined, { 'X-Agent-Enrollment-Key': key })).json();
  assert.equal(status.status, 'pending');
  await page.getByRole('button', { name: 'Autorizar monitoramento', exact: true }).click();
  for (let i = 0; i < 30; i++) {
   status = await (await api('GET', 'agents/status/' + id, undefined, { 'X-Agent-Enrollment-Key': key })).json();
   if (status.status === 'approved') break;
   await delay(100);
  }
  assert.equal(status.status, 'approved');
  const credential = await (await api('POST', 'agents/' + id + '/credential', {}, { 'X-Agent-Enrollment-Key': key })).json();
  const legacyFixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/devcore-metrics.sample.json'), 'utf8'));
  const today = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
  const delta = Date.parse(today + 'T12:00:00Z') - Date.parse(legacyFixture.today.date + 'T12:00:00Z');
  const shifted = JSON.parse(JSON.stringify(legacyFixture), (key, value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) ? new Date(Date.parse(value) + delta).toISOString() : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(Date.parse(value + 'T12:00:00Z') + delta).toISOString().slice(0,10) : value);
  shifted.generated_at = new Date().toISOString();
  shifted.today.developer_list = (shifted.today.developer_list || []).map((d, i) => ({ ...d, ip: 'dev-' + String(i).padStart(20, '0') }));
  const liveFixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/devcore-live.sample.json'), 'utf8'));
  liveFixture.generated_at = new Date().toISOString();
  const operational = { version: 1, status: 'available', source: 'existing', reason: null, developer_identity: 'pseudonymous', metrics: shifted, live: liveFixture };
  const sample = { agent_id: id, timestamp: new Date().toISOString(), agent_version: 'test', metrics: { operational, gpu: { devices: [{ index: 0, name: 'NVIDIA H200 TEST', utilization_percent: 75, memory_used_mib: 4096, memory_total_mib: 8192, temperature_c: 42 }] }, llama: [{ pid: 123, executable: 'llama-server-test', port: 7080, slots: 6 }] } };
  assert.equal((await api('POST', 'agents/' + id + '/telemetry', sample, { Authorization: 'Bearer ' + credential.token })).status, 204);
  await page.getByRole('button', { name: 'Atualizar', exact: true }).click();
  await page.getByRole('heading', { name: 'NVIDIA H200 TEST', exact: true }).waitFor();
  await page.getByText('llama-server-test', { exact: true }).waitFor();
  await page.getByRole('region', { name: 'Monitoramento operacional da POD' }).count();
  assert.equal((await (await api('GET', 'pocs')).json()).pocs[0].pods[0].operational.metrics.today.requests, shifted.today.requests);
  assert.equal(await page.getByText('Aguardando coleta de requisições e tempos de resposta.', { exact: true }).count(), 0);
  await page.getByRole('button', { name: /Desenvolvedores ativos hoje/ }).click();
  await page.getByRole('columnheader', { name: 'Identificador de origem' }).waitFor();
  await page.getByRole('button', { name: 'Fechar', exact: true }).click();
  console.log('UI: complete request counts, live usage, latency, errors, charts and developer breakdown validated');
  const secondInput = { name: 'Outra operação', client: 'Outro cliente', responsible: 'Equipe', startDate: '2026-11-01', endDate: '2026-12-01', notes: '' };
  const second = await (await api('POST', 'pocs', secondInput)).json();
  assert.equal((await api('POST', 'pocs/' + second.poc.id + '/pods', { name: 'Duplicate', podId: 'test-pod-one', agentId: id })).status, 409);
  const planned = await (await api('POST', 'pocs/' + second.poc.id + '/pods', { name: 'POD planejada', podId: 'planned-pod', agentId: null })).json();
  const plannedId = crypto.randomUUID(), plannedKey = crypto.randomBytes(32).toString('hex');
  assert.equal((await api('POST', 'agents/enroll', { identity: { agent_id: plannedId, enrollment_key: plannedKey, platform: 'runpod', pod_id: 'planned-pod', hostname: 'planned-host', agent_version: 'test' } }, { Authorization: 'Bearer ' + bootstrap })).status, 200);
  assert.equal((await api('PATCH', 'pocs/' + second.poc.id + '/pods/' + planned.pod.id, { agentId: id })).status, 409);
  assert.equal((await api('PATCH', 'pocs/' + second.poc.id + '/pods/' + planned.pod.id, { agentId: plannedId })).status, 200);
  assert.equal((await (await api('GET', 'agents/status/' + plannedId, undefined, { 'X-Agent-Enrollment-Key': plannedKey })).json()).status, 'pending');
  console.log('Planned POD: register before agent, bind later, mismatched ID rejected, approval remains pending');
  await page.getByRole('button', { name: 'Editar POC', exact: true }).click();
  await page.getByLabel('Nome da POC', { exact: true }).fill('Atendimento atualizado');
  await page.getByRole('button', { name: 'Salvar alterações', exact: true }).click();
  await page.getByRole('heading', { name: 'Atendimento atualizado', exact: true }).waitFor();
  assert.equal((await api('POST', 'agents/' + id + '/telemetry', sample, { Authorization: 'Bearer ' + credential.token })).status, 204);
  assert.equal((await (await api('GET', 'pocs')).json()).pocs.find(p => p.id === poc.id).pods[0].gpuHistory.length, 1);
  for (const heading of ['Agora', 'Parecer técnico', 'Uso da GPU hoje', 'VRAM hoje', 'Requisições por hora', 'Tempo de resposta por hora', 'POC inteira: requisições por dia']) {
   await page.getByRole('heading', { name: heading, exact: true }).waitFor();
  }
  await page.locator('details').filter({ hasText: 'PODs da POC · detalhes e autorização' }).evaluate(node => { node.open = false; });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: '/tmp/devcore-poc-detail-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: '/tmp/devcore-poc-detail-desktop.png', fullPage: true });
  await page.getByRole('link', { name: '← Central de POCs', exact: true }).click();
  await page.waitForURL('**' + prefix + '/');
  await page.getByRole('link').filter({ hasText: 'Atendimento atualizado' }).waitFor();
  await page.screenshot({ path: '/tmp/devcore-poc-central.png', fullPage: true });
  await page.getByRole('link').filter({ hasText: 'Atendimento atualizado' }).click();
  await page.waitForURL('**' + prefix + '/pocs/**');
  await page.getByLabel('Empresa / POC', { exact: true }).selectOption(second.poc.id);
  await page.waitForURL('**' + prefix + '/pocs/' + second.poc.id);
  await page.getByRole('heading', { name: 'Outra operação', exact: true }).waitFor();
  await page.getByLabel('Empresa / POC', { exact: true }).selectOption(poc.id);
  await page.waitForURL('**' + prefix + '/pocs/' + poc.id);
  console.log('Reference layout: Agora, indicators, charts, opinion and POC selector validated');
  await page.locator('details').filter({ hasText: 'PODs da POC · detalhes e autorização' }).evaluate(node => { node.open = true; });
  await page.getByRole('button', { name: 'Revogar', exact: true }).click();
  await page.getByRole('button', { name: 'Reativar monitoramento', exact: true }).click();
  let generationStatus;
  for (let attempt=0; attempt<30; attempt++) {
    generationStatus = await (await api('GET', 'agents/status/' + id, undefined, { 'X-Agent-Enrollment-Key': key })).json();
    if (generationStatus.credential_generation === 1) break;
    await delay(100);
  }
  assert.equal(generationStatus.credential_generation, 1);
  assert.equal((await api('POST', 'agents/' + id + '/telemetry', sample, { Authorization: 'Bearer ' + credential.token })).status, 401);
  const replacement = await (await api('POST', 'agents/' + id + '/credential', {}, { 'X-Agent-Enrollment-Key': key })).json();
  credential.token = replacement.token;
  assert.equal((await api('POST', 'agents/' + id + '/telemetry', sample, { Authorization: 'Bearer ' + credential.token })).status, 204);
  console.log('Administrative recovery UI: explicit reason, reapproval generation and old-token rejection validated');
  await page.getByRole('button', { name: 'Encerrar POC', exact: true }).click();
  await page.getByText(/Encerrada em/).waitFor();
  assert.equal((await api('POST', 'agents/' + id + '/telemetry', sample, { Authorization: 'Bearer ' + credential.token })).status, 401);
  status = await (await api('GET', 'agents/status/' + id, undefined, { 'X-Agent-Enrollment-Key': key })).json();
  assert.equal(status.status, 'revoked');
  await page.getByRole('link', { name: '← Central de POCs', exact: true }).click();
  await page.getByRole('heading', { name: 'Central de POCs', exact: true }).waitFor();
  await page.getByRole('link').filter({ hasText: 'Outra operação' }).click();
  await page.getByRole('heading', { name: 'Outra operação', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'NVIDIA H200 TEST' }).count(), 0);
  console.log('Isolation: duplicate links denied, edit preserves credential, closure revokes, other POC isolated');
  console.log('Responsive UI at 390px: PASS');
 } catch (error) {
  if (page) {
   console.log('Failure URL:', page.url());
   console.log('Viewport:', await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, overflow: [...document.querySelectorAll('main *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1).slice(0, 6).map(e => e.tagName + '.' + e.className) })));
   await page.screenshot({ path: '/tmp/devcore-poc-test-failure.png', fullPage: true });
   console.log('Visible dialogs:', await page.locator('dialog').innerText().catch(() => 'none'));
  }
  throw error;
 } finally {
  if (context) await context.unrouteAll({ behavior: 'ignoreErrors' });
  if (browser) await browser.close();
  try { docker(['rm', '-f', name]); } catch {}
  try { docker(['volume', 'rm', volume]); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
 }
})().catch(error => { console.error(error.message.split('\n')[0]); process.exitCode = 1; });
