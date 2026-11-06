# AgentTrack — ambiente isolado de homologação

URL: https://devcore.multicortex.com.br/agenttrack/

A aplicação existente em `/` continua no projeto Docker `devcore-monitor`, porta
3002. O ambiente de testes usa projeto `devcore-agenttrack`, imagem
`devcore-agenttrack:current`, porta privada 3103 e diretório
`/opt/multicortex/devcore-agenttrack`.

## Isolamento

- Build próprio com `NEXT_PUBLIC_BASE_PATH=/agenttrack`.
- APIs e assets ficam sob `/agenttrack/`; o agente usa como URL base
  `https://devcore.multicortex.com.br/agenttrack` (sem barra final).
- Cookies `__Secure-agenttrack.*`, Secure/HttpOnly, path `/agenttrack`.
- Segredo de sessão e bootstrap novos, diferentes da publicação principal.
- Lista de usuários reutilizada da configuração atual, sem modificar sua origem.
- Administradores definidos separadamente em `DEVCORE_ADMIN_EMAILS`.
- Registry de agentes e telemetria no volume `./state`; catálogo legado vazio
  (`state/vms.json`) para não confundir testes com a POC Theós.
- Não expor `.env.agenttrack` nem copiar credenciais para documentação ou Git.

## Arquivos

`docker-compose.agenttrack.yml`, `infra/ec2/nginx-agenttrack-location.conf`,
`src/lib/base-path.ts`. O prefixo é opcional: builds sem a variável mantêm a raiz.
O Dockerfile aceita `--build-arg NEXT_PUBLIC_BASE_PATH=/agenttrack`.
O health check usa `HEALTH_PATH=/agenttrack/robots.txt`.

O Nginx mantém o prefixo no proxy para 3103. A regra é incluída no vhost HTTPS
existente; `location /` e o include de `/teste/` são preservados. Há backup do
vhost antes da alteração, teste `nginx -t` e reload sem reiniciar os contêineres
existentes.

## Validação

Tipos e testes do site; build Docker; HTTP de login, imagem otimizada, JS/CSS,
robots e negação de acesso administrativo anônimo. Login completo com usuário
fictício em contêiner local valida redirecionamento, cookie isolado e painel
protegido. Em produção comparar `/`, `/entrar`, `/teste/` e identidade/imagem do
contêiner existente antes/depois. Não usar cadastro ou credenciais de agentes reais
nos testes de publicação.

O bootstrap fica somente em `.env.agenttrack` no servidor. Sua transferência para
a POD deve ocorrer por canal seguro. Aprovação/revogação exigem conta cadastrada
e e-mail explicitamente incluído em `DEVCORE_ADMIN_EMAILS`.

## Publicação verificada em 2026-11-06

- `/agenttrack/`: 307 para `/agenttrack/entrar`; login: 200.
- 11 assets públicos de login: 200; robots: 200; API administrativa anônima: 403.
- Login/logout completos no contêiner local fictício: 303 para os caminhos
  prefixados; painel autenticado: 200; cookie isolado confirmado.
- Nova instância: `devcore-agenttrack-app-1`, healthy.
- Instância anterior: mesmo ID e imagem antes/depois; `/` 307, `/entrar` 200,
  `/teste/` 303, todos preservados.
- Nginx: única linha acrescentada ao vhost inclui o snippet novo. Backup:
  `/etc/nginx/vhosts.d/devcore.conf.bak-agenttrack-20261106-152819`.
- `DEVCORE_ADMIN_EMAILS=tiago.sartori@multicortex.ai`, conforme autorização explícita do usuário. Aplicação confirmada no contêiner isolado.
- Bootstrap próprio criado no servidor, não exibido nem incluído no repositório.

Para desativar somente o acesso público do teste, remover apenas o include
`/etc/nginx/devcore-agenttrack/agenttrack-location.conf` do vhost, validar com
`nginx -t` e recarregar. Parar somente o projeto Compose `devcore-agenttrack`, se
necessário. Preservar o volume de estado e a publicação principal.

## Correção de redirecionamento com JavaScript

O navegador com Server Actions acrescenta `basePath` aos destinos relativos à
raiz. Prefixar manualmente esses destinos duplicava `/agenttrack` no login e
logout. `authRedirect()` agora gera URL absoluta usando somente `AUTH_URL`
configurada no servidor quando há prefixo; a publicação na raiz mantém os destinos
originais. A correção foi reproduzida e validada com Chromium headless, além do
POST HTML sem JavaScript.

Regressão local (Docker e Playwright já disponíveis, sem usuários reais):

```sh
python3 tests/agenttrack-login-smoke.py
node tests/agenttrack-browser.cjs
```

O primeiro comando cria/recria apenas `devcore-agenttrack-smoke` na porta 3113,
com usuário fictício, e testa POST sem JavaScript. O segundo testa o formulário
com JavaScript, painel autenticado e saída, redirecionando requisições do domínio
público para esse contêiner local. Se Playwright não estiver nas dependências,
`PLAYWRIGHT_MODULE_PATH` pode indicar uma instalação existente. Ao terminar,
remover somente o contêiner de fixture: `docker rm -f devcore-agenttrack-smoke`.

## Distribuição autorizada do agente

Download público autorizado explicitamente pelo usuário:
https://devcore.multicortex.com.br/agenttrack/downloads/devcore-universal-agent.zip

Contém somente supervisor.py, discovery.py, fallback_monitor.py, gpu_discovery.py
 e llama_discovery.py, sem segredos ou dados persistidos. SHA256 desta versão:
`e38f66addfd4bcd36c20babf54dd17247a264e31130c072a921ed2ec02e57e2b`.
O Nginx serve somente esse URL exato de `/var/lib/devcore-agenttrack-downloads/`,
sem listagem de diretório. Download e integridade validados por HTTPS.

## SELinux no servidor de homologação

HTTP 409 de enrollment foi diagnosticado por AVC `container_t` tentando escrever
no diretório `state` rotulado `usr_t`. Corrigido o bind mount para
`./state:/var/lib/devcore-agenttrack:Z`, atribuindo rótulo privado ao volume exclusivo
do AgentTrack. SELinux permanece ativo. Escrita testada com arquivo temporário
próprio e remoção após teste; contêiner principal preservado.

## Homologação real: reinício e reconexão — 2026-11-06

O usuário confirmou reinício do supervisor na POD Python 3.6.15: mesma identidade
`aa6fd47c-2d3d-4972-8e02-f6645bb0ea85`, retomada imediata de telemetria sem aprovação.

Teste controlado de reconexão: regra temporária HTTP 503 durante 45 segundos somente
no endpoint de status dessa identidade. Os logins da publicação principal e do
AgentTrack responderam 200 durante a falha. O mtime do arquivo de telemetria
permaneceu 1793987290 no início e no fim da indisponibilidade; após restauração,
chegou nova amostra em `2026-11-06T17:49:20.436Z` (14:49:20 em São Paulo).
A identidade permaneceu única/aprovada, com emissão de credencial anterior à falha.
A regra temporária foi removida e o contêiner principal preservado.

O teste comprova retomada automática após falha de status e ausência de novos envios
nesse intervalo. Não observa diretamente os processos de coleta dentro da POD;
a garantia de bloqueio de coleta também é coberta pelos testes locais.
Pendências: execução contínua/inicialização automática na POD e revogação real
com procedimento administrativo de recuperação previamente definido.

## Evolução para central de POCs

A experiência nova do `/agenttrack/` está documentada em `docs/agenttrack-pocs.md`.
O Compose ativa `DEVCORE_POC_MODE=1` e define `DEVCORE_POCS_FILE` no mesmo volume
privado. A publicação principal mantém o comportamento anterior. Criar a primeira
POC e vincular a POD real pela aba **PODs e autorizações**; sua aprovação e
credencial anteriores foram preservadas.
