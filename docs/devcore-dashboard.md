# Painel DevCore Monitor (`devcore.multicortex.com.br`)

Painel interno para acompanhar as VMs de POC do DevCore. Uso exclusivo da equipe
MultiCortex (usuários cadastrados em `DEVCORE_USERS`), sem indexação e sem links
públicos.

É um projeto próprio (este repositório), separado do site: app Next.js único, sem banco,
no contêiner `devcore-monitor-app-1` do EC2. Até 11/2026 ele morava dentro do site
(`SITE_LLMS`); a remoção do código lá está em `docs/remocao-no-site.md`.

## Arquitetura (sem mudar DNS, Apache ou llama.cpp)

O tráfego real do DevCore **não passa pelo nginx da VM**. Os desenvolvedores chegam a
`devcore01.multicortex.com.br`, que aponta para o gateway Apache `35.168.36.211`, e o
Apache repassa direto ao llama.cpp da VM, em `0.0.0.0:7080`. Como o DNS, as portas do
Apache e o llama.cpp não podem mudar, as medições são feitas de forma **passiva** e
enviadas pela VM ao painel (**push**, só conexão de saída).

```
Desenvolvedor ──HTTPS──► Apache 35.168.36.211 ──HTTP──► VM :7080 llama.cpp
                                                          │  (cópia dos pacotes, tcpdump)
                                    devcore_http_capture.py ─► /var/log/devcore-poc/requests-AAAAMMDD.log
                     samples.csv (GPU) ─┐                  │
                                        └─ devcore_metrics_agent.py (timer 1 min) ─► metrics.json
                                                          │ POST HTTPS + Bearer (saída)
      EC2 nginx: site.multicortex.com.br/api/devcore/ingest/<vm>  ◄──┘
                 │ (location /api/devcore/ingest/ → 127.0.0.1:3002)
                 ▼
      devcore-monitor-app-1 :3002 ◄── devcore.multicortex.com.br (painel, login) ◄── navegador
```

- **Captura passiva** (`devcore_http_capture.py`):
  - O `tcpdump` entrega uma **cópia** dos pacotes da porta 7080; o processo **não fica no
    caminho do tráfego**. Se ele parar, o DevCore não é afetado; só o painel fica sem dados.
  - **Lê só os cabeçalhos HTTP.** Os corpos (prompts, código e respostas) passam pela
    memória, são pulados byte a byte e **nunca são gravados nem logados**.
  - O IP do desenvolvedor vem do `X-Forwarded-For` e o host do `X-Forwarded-Host`, que o
    Apache já envia. Requisições de outros hosts pelo mesmo gateway contam como "outros".
- **Retrato ao vivo (captura 1.3+):** a cada 10 s a captura grava
  `/var/lib/devcore-metrics/live.json` e o envia a `…/api/devcore/ingest/<vm>/live`, com o
  mesmo token. Só contagens: desenvolvedores on-line, requisições em andamento e GPU agora.
  Alimenta o card **Agora** do painel, que se atualiza sozinho a cada 10 s.
- **Push:** o agente envia o `metrics.json` ao painel a cada minuto, com o mesmo token. Não
  precisa de DNS novo, de porta aberta na VM nem de regra no firewall.
- **Modo pull (alternativo):** se um dia a VM ficar acessível ao painel, o cadastro aceita
  `"source": "pull"` com `metricsUrl`. O endpoint nginx `/poc/metrics.json` protegido por
  token continua instalado para isso.

## Componentes

| Parte | Local |
|---|---|
| Agente, captura, units, instalador | `infra/devcore-vm-agent/` (Python 3.6, só stdlib) |
| Cadastro de VMs (sem segredos) | `config/devcore-vms.json` (ou `DEVCORE_VMS_FILE`) |
| Recebimento do push | `src/app/api/devcore/ingest/[id]/route.ts`, `src/lib/devcore/ingest.ts` |
| Backend do painel | `src/lib/devcore/*`, `src/app/api/devcore/vms/**` |
| Frontend | `src/app/page.tsx`, `src/app/entrar/*`, `src/app/layout.tsx`, `src/components/devcore/*` |
| Login | `src/lib/auth.ts` (Auth.js), `src/lib/devcore/users.ts`, `src/lib/devcore/session.ts`, `scripts/hash-password.ts` |
| Sem indexação | `next.config.ts` (`X-Robots-Tag` em todas as rotas), `src/app/robots.ts`, meta robots do layout |
| Deploy | `Dockerfile`, `docker-compose.prod.yml`, `deploy.sh`, `infra/ec2/` (trechos do nginx) |
| Testes | `infra/devcore-vm-agent/tests/`, `tests/devcore-dashboard.test.ts` |

## Regras dos indicadores (horário de Brasília, UTC−3)

- **Requisições**: `POST /v1/chat/completions` do host DevCore (`devcore_hosts`).
- **Taxa de erro**: (4xx + 5xx) ÷ requisições, **sem** contar `499`. O 499 é o cliente
  cancelando o streaming, comum em IDEs, e aparece à parte como "canceladas". Na captura,
  uma conexão fechada pelo gateway no meio da resposta vira 499; a fechada pela VM, 502.
- **Tempo de resposta**: do primeiro byte da requisição até o fim da resposta (`rt`).
- **Espera até o modelo responder**: até o **primeiro byte do corpo da resposta**, ou seja,
  o primeiro token no streaming (`uht`). Mediana e p95, só de respostas 2xx.
- **Desenvolvedores ativos**: IPs distintos (do `X-Forwarded-For`) com ao menos uma
  chamada `/v1/*` 2xx no dia. Localhost (testes na VM) fica de fora. O JSON contém **só
  a contagem** no histórico de dias (`daily[]`, `state.json`).
- **Lista por desenvolvedor** (agente 1.3+, clique no card "Desenvolvedores ativos hoje"):
  `today.developer_list` traz, para cada um desses IPs, as inferências de hoje
  (`POST /v1/chat/completions`, com sucesso, 4xx, 5xx e canceladas), primeira e última
  chamada, tempo ativo e as medianas de resposta e de espera. O **tempo ativo** é a união
  dos intervalos das requisições (`ts − rt` até `ts`), juntando chamadas com até 5 min de
  intervalo. "Ativo agora" = chamada nos 5 min anteriores à geração do arquivo. Vários
  desenvolvedores atrás do mesmo NAT aparecem como um IP. O IP é dado pessoal (LGPD): a
  lista só aparece no painel com login da equipe; `developer_details = false` no
  `agent.conf` volta a enviar só a contagem.
- **Card "Agora"** (retrato ao vivo, captura 1.3+):
  - **Desenvolvedores on-line**: IPs distintos do host DevCore com requisição `/v1/*` em
    andamento **ou** chamada 2xx nos últimos `online_window_s` (padrão 5 min). "Em
    andamento" é a parte desses IPs com requisição aberta neste instante. Vários
    desenvolvedores atrás do mesmo NAT contam como um.
  - **Slots em uso**: `POST` enviados e ainda não respondidos por completo (DevCore +
    outros), contra os `slots` da VM. O que passa disso está na fila do llama.cpp.
    Requisições abertas há mais de 30 min (fim perdido) são ignoradas.
  - **GPU agora**: `nvidia-smi` no momento do retrato (utilização e VRAM).
  - O retrato vale por 30 s (três envios). Depois disso o card mostra "Parado" com os
    últimos números. Ao reiniciar, a captura recupera dos logs a atividade dos últimos
    5 min.
- **Requisições simultâneas** (o que ocupa os slots do llama.cpp): calculadas segundo a
  segundo pelo log, cada `POST` ocupando um slot de `ts − rt` até `ts`. O pico e o "tempo
  com ≥ 8 requisições" usam o total (DevCore + outros) e também só o DevCore. As
  conexões TCP do `samples.csv` aparecem como detalhe.
- **GPU**: média e máximo de `gpu_util`; VRAM máxima. O total vem do `nvidia-smi`.
- **Log do servidor do modelo** (agente 1.2+): o agente lê o journal da unit
  `server_unit` (padrão `multicortex-server`) desde 00:00 e envia em `today.server`
  só números: requisições recusadas por contexto acima do limite do slot (o motivo
  real dos 400), contexto por slot, contexto usado (p50/p95), erros do servidor,
  tokens/s de geração (p50/p10) e de processamento do prompt. Nenhum texto de prompt.
- **Parecer técnico** (card no fim do painel): regras em `src/lib/devcore/assessment.ts`
  sobre os indicadores de hoje. Cada problema traz a evidência em números, e os ajustes
  de configuração e upgrades de infraestrutura aparecem sem repetição, com os problemas
  que cada um resolve. Limites: contexto recusado ≥ 5% das requisições = atenção;
  espera p95 ≥ 10 s observar, ≥ 30 s atenção; geração < 20 tokens/s observar,
  < 10 atenção; slots esgotados > 0% observar, ≥ 10% atenção; VRAM ≥ 90% observar,
  ≥ 97% atenção; 5xx ≥ 1% atenção. Sem o bloco `today.server` (agente < 1.2), o
  parecer avisa que é parcial.
- **Histórico da POC**: os dias fechados ficam em `/var/lib/devcore-metrics/state.json`
  (até 45 dias). Os logs da captura são diários e mantidos por 60 dias. Dias sem registro
  aparecem em branco.

> O `samples.csv` chama de `conn_site` as conexões vindas de `35.168.36.211`. Na prática,
> isso inclui o próprio DevCore, porque todo o tráfego entra por esse gateway. Por isso o
> painel usa as requisições simultâneas da captura.

## 1. Instalar ou atualizar o agente na VM

Pré-requisitos: `python3` (3.6+), `tcpdump` (`sudo zypper in tcpdump`), `nginx` e `curl`.

```bash
# no seu PC
scp -r ~/Multicortex/Projetos/DevCore_Track/infra/devcore-vm-agent opensuse@201.23.87.153:/tmp/
# na VM (um comando por vez quando houver sudo)
cd /tmp/devcore-vm-agent
sudo bash ./install.sh --push-url https://site.multicortex.com.br/api/devcore/ingest/devcore-demo-01 --allow-ip 52.207.145.100
```

A URL `https://site.multicortex.com.br/api/devcore/ingest/<id>` continua valendo: o nginx
do EC2 repassa esse caminho ao contêiner do painel. A URL direta
`https://devcore.multicortex.com.br/api/devcore/ingest/<id>` também funciona; ao reinstalar
um agente, prefira ela (veja `docs/virada.md`, passo opcional).

O instalador é idempotente. Rodar de novo atualiza o código e **mantém o token**. Ele:

1. Instala o agente e a captura em `/usr/local/lib/devcore-metrics/`. A configuração fica em
   `/etc/devcore-metrics/agent.conf`, que é criada uma vez e migrada da versão 1.0.
2. Grava `push.conf` (URL) e `push.token` (permissão **600**) em `/etc/devcore-metrics/`.
3. Gera o primeiro `metrics.json` e já tenta o envio. "push: HTTP 401/404" significa que
   o painel ainda não tem o token ou o deploy; o timer tenta de novo a cada minuto.
4. Configura o endpoint nginx `/poc/metrics.json` (modo pull). Ele vai no vhost HTTPS
   (`listen … 443`), é verificado com `nginx -t` e restaurado se falhar.
5. Ativa `devcore-metrics.timer` (1 min) e `devcore-capture.service` (`Restart=always`,
   CPU ≤ 30%, memória ≤ 300 MB). A captura também envia o retrato ao vivo a cada 10 s;
   falhas de envio aparecem no journal só quando mudam (`journalctl -u devcore-capture`).

Se o token for gerado agora, ele aparece **uma única vez**. Esse token vai para a
variável `DEVCORE_METRICS_TOKEN_<ID>` do painel. Para recuperá-lo na VM:
`sudo cat /etc/devcore-metrics/push.token`. Para trocar: `--rotate-token`.

Nada no llama.cpp, no Apache ou nas rotas `/v1` é alterado.

Verificações na VM:

```bash
systemctl --no-pager list-timers devcore-metrics.timer
systemctl --no-pager status devcore-capture.service | head -5
sudo tail -3 /var/log/devcore-poc/requests-$(date -u +%Y%m%d).log
sudo journalctl -u devcore-metrics.service -n 5 --no-pager      # "push: ..." só aparece em erro
sudo cat /var/lib/devcore-metrics/live.json                      # retrato ao vivo (atualiza a cada 10 s)
```

### Servidor em contêiner (RunPod)

Desde 20/10/2026 a `devcore-demo-01` roda num pod RunPod (RTX PRO 6000, 96 GB,
`--parallel 6`). O caminho agora é Apache `35.168.36.211` → Cloudflare/proxy RunPod
(`<pod>-7080.proxy.runpod.net`) → llama.cpp `:7080` do pod, com conexões vindas de
`100.64.x.x`. O pod não tem systemd, nginx, `tar` nem `scp`; por isso:

- `install-pod.sh` instala `python3`/`tcpdump` (zypper), grava o `agent.conf` sem nginx
  e sem journal (`server_unit` vazio: o parecer técnico fica parcial) e com
  `write_samples = true`, porque não existe o `samples.csv` da POC. A captura (1.4+)
  grava a GPU e as requisições em andamento em `samples.csv-AAAAMMDD` a cada 10 s.
- `devcore-supervisor.sh` substitui o systemd: reinicia a captura se ela parar e roda o
  agente a cada minuto. Log: `/var/log/devcore-poc/supervisor.log`.
- Os slots vêm do `--parallel` do llama.cpp em execução (ou `--slots N`).
- O proxy da RunPod troca o `X-Forwarded-Host` pelo host do pod; o instalador inclui
  `<pod>-7080.proxy.runpod.net` em `devcore_hosts` (o IP do `X-Forwarded-For` continua certo).
- O disco do contêiner é zerado quando o pod é recriado: rode o `install-pod.sh` de novo
  (o histórico em `state.json` se perde, a menos que seja copiado antes).

Envio dos arquivos (o proxy SSH da RunPod só aceita terminal interativo):

```bash
# no seu PC: empacota, envia em base64 e extrai com Python (o pod não tem tar)
cd ~/Multicortex/Projetos/DevCore_Track/infra && tar czf /tmp/agent.tgz --exclude=tests devcore-vm-agent
{ echo "base64 -d > /root/agent.tgz <<'B64'"; base64 -w 76 /tmp/agent.tgz; echo B64
  echo "rm -rf /root/devcore-vm-agent; python3 -I -c \"import tarfile; tarfile.open('/root/agent.tgz').extractall('/root')\""
  echo exit; } | ssh -tt <pod>@ssh.runpod.io -i ~/.ssh/id_ed25519
# no pod
bash /root/devcore-vm-agent/install-pod.sh --push-url https://site.multicortex.com.br/api/devcore/ingest/devcore-demo-01
```

Verificações no pod: `tail /var/log/devcore-poc/supervisor.log`,
`tail -3 /var/log/devcore-poc/requests-$(date -u +%Y%m%d).log` e
`cat /var/lib/devcore-metrics/live.json`. Parar: `install-pod.sh --stop`.

### Remoção

```bash
sudo bash ./uninstall.sh            # remove timer, captura, location, token e código (mantém dados)
sudo bash ./uninstall.sh --purge    # também apaga metrics.json, histórico, configuração e requests-*.log
```

O `samples.csv` do monitoramento original da POC nunca é apagado.

## 2. Cadastrar uma nova VM

1. Instale o agente na VM nova (passo 1), com `--push-url …/api/devcore/ingest/<id>`.
2. Acrescente a VM em `config/devcore-vms.json`:

   ```json
   {
     "id": "acme-01",
     "company": "Acme",
     "pocName": "POC Acme",
     "vmName": "devcore-acme-01",
     "pocStart": "2026-11-03",
     "pocEnd": "2026-12-02",
     "slots": 8,
     "source": "push",
     "tokenEnv": "DEVCORE_METRICS_TOKEN_ACME_01"
   }
   ```

   `id`: minúsculas, números e hífen; precisa ser igual ao final da `--push-url`.
   `tokenEnv` é o **nome** da variável, nunca o token.
3. Defina `DEVCORE_METRICS_TOKEN_ACME_01=<token da VM>` em
   `/opt/multicortex/devcore-monitor/.env.production` e faça o deploy (`./deploy.sh`).
   Para cadastrar sem rebuild, use `DEVCORE_VMS_FILE`.

## 3. Variáveis de ambiente (servidor do painel)

| Variável | Exemplo | Uso |
|---|---|---|
| `AUTH_SECRET` | (segredo, `openssl rand -base64 32`) | Assina o cookie de sessão. Próprio do painel, diferente do site |
| `AUTH_URL` | `https://devcore.multicortex.com.br` | URL pública do painel (Auth.js, com `trustHost`) |
| `DEVCORE_USERS` | `ana@multicortex.com.br:<hash>:Ana` | Usuários da equipe, separados por vírgula (seção 4) |
| `DEVCORE_METRICS_TOKEN_<ID>` | (segredo) | Um por VM. Valida o push (e o pull, se usado) |
| `DEVCORE_VMS_FILE` | `/app/config/devcore-vms.json` | Opcional: cadastro externo |

Ficam em `/opt/multicortex/devcore-monitor/.env.production` no EC2 (permissão 600),
lido pelo `docker-compose.prod.yml`. Em desenvolvimento, use `.env.local` (modelo em
`.env.example`). O `DEVCORE_HOST` do site não existe mais: o painel é o app inteiro e
responde em qualquer host que o nginx encaminhar.

- **Segurança:** os tokens nunca vão ao navegador nem aos logs. O endpoint de ingestão
  responde 401 igual para VM inexistente e token errado, compara o token em tempo
  constante, limita o corpo a 2 MB e valida o schema.
- **Memória:** os dados recebidos ficam na memória do app. Rode **uma única instância**.
  Depois de um deploy, o painel mostra "aguardando envio" por até 1 min (o card "Agora"
  volta em até 10 s).

## 4. Acesso e login

- Login próprio, sem banco: Auth.js (Credentials, sessão JWT) contra a lista
  `DEVCORE_USERS`. Cada entrada é `email:hash[:Nome]`; o hash é bcrypt (custo 12) em
  base64, para não ter `$` no arquivo de ambiente (um hash bcrypt puro `$2b$…` também é
  aceito).
- Para incluir alguém, gere a entrada no seu PC (a senha é pedida sem eco e nunca é
  impressa; mínimo de 12 caracteres):

  ```bash
  npm run hash-password -- pessoa@multicortex.com.br "Nome da Pessoa"
  ```

  Acrescente a linha impressa a `DEVCORE_USERS` (separada por vírgula) no
  `.env.production` do servidor e recrie o contêiner (`./deploy.sh`, ou
  `sudo docker compose -p devcore-monitor -f docker-compose.prod.yml up -d --force-recreate app`
  em `/opt/multicortex/devcore-monitor`).
- Para remover alguém, apague a entrada e recrie o contêiner. Uma sessão aberta desse
  e-mail passa a ver "Sua conta não tem perfil de equipe MultiCortex." (acesso negado).
- Página de login em `/entrar`; anônimo é levado para lá; "Sair" volta para `/entrar`.
  O cookie de sessão (`__Secure-authjs.session-token`, `HttpOnly`) é só do host
  `devcore.multicortex.com.br`.
- Proteções contra indexação: `X-Robots-Tag: noindex, nofollow, noarchive` em todas as
  respostas (`next.config.ts`), meta robots no layout e `robots.txt` com `Disallow: /`.

## 5. Infraestrutura e deploy

Nada muda no DNS de `devcore01`, nas portas do Apache `35.168.36.211` nem no llama.cpp.

1. **DNS:** `devcore.multicortex.com.br` A → `52.207.145.100` (EC2), já existente.
2. **Contêiner:** `devcore-monitor-app-1` (projeto compose `devcore-monitor`), em
   `127.0.0.1:3002`, a partir de `/opt/multicortex/devcore-monitor/` (`docker-compose.prod.yml`
   e `.env.production`). Imagem `devcore-monitor:current`, usuário não root, `restart:
   unless-stopped`. O `config/devcore-vms.json` vai na imagem.
3. **nginx do EC2:**
   - vhost `devcore.multicortex.com.br` (`/etc/nginx/vhosts.d/devcore.conf`) com
     `proxy_pass http://127.0.0.1:3002;` (modelo em `infra/ec2/nginx-devcore-vhost.conf`);
   - no vhost de `site.multicortex.com.br` (`/etc/nginx/vhosts.d/multicortex.conf`), o
     `location /api/devcore/ingest/` que repassa a ingestão ao painel
     (`infra/ec2/nginx-site-ingest-location.conf`). Assim os agentes já instalados
     continuam com a mesma URL.
4. **Deploy:** na raiz deste projeto, com a árvore Git limpa, `./deploy.sh`. Ele valida
   (tipos, lint, testes, build), confere o servidor sem mostrar segredos, constrói a
   imagem localmente, envia por `docker save | ssh`, guarda a imagem em uso como
   `devcore-monitor:rollback`, recria o contêiner e faz o health check em
   `127.0.0.1:3002`; se falhar, volta para a imagem anterior. Depois, abra
   `https://devcore.multicortex.com.br/` e confira "Online" em até 1 min.
5. **Rollback manual** (no EC2, em `/opt/multicortex/devcore-monitor`):
   `sudo docker tag devcore-monitor:rollback devcore-monitor:current` e
   `sudo docker compose -p devcore-monitor -f docker-compose.prod.yml up -d --force-recreate app`.

A virada do site para este projeto (sem perder métricas) está em `docs/virada.md`.

## 6. Testes

```bash
npm run typecheck                                                     # next typegen + tsc
npx eslint .
python3 -m unittest discover -s infra/devcore-vm-agent/tests -v       # agente + captura (pcap sintético)
docker run --rm -v "$PWD/infra/devcore-vm-agent:/a:ro" python:3.6-slim python -m unittest discover -s /a/tests
node --require ./tests/server-only-stub.cjs --import tsx --test tests/devcore-dashboard.test.ts
npm test                                                              # os dois conjuntos acima
```

A captura também foi validada num contêiner openSUSE Leap 15.6 com o tcpdump real:
streaming, keep-alive, cancelamento (499), separação de hosts e nenhum trecho de prompt
no log. `tests/fixtures/devcore-metrics.sample.json` é gerado pelo próprio agente e
serve de contrato entre o agente e o schema do painel.

Teste manual local: `npm run dev`, `.env.local` com um token de teste e um usuário
gerado pelo `hash-password`, e um envio com
`curl -X POST -H "Authorization: Bearer <token>" --data-binary @metrics.json http://localhost:3000/api/devcore/ingest/devcore-demo-01`
(resposta 204).

## Schema do `metrics.json` (versão 1)

Os campos principais são `schema`, `agent_version`, `generated_at` (UTC), `slots`,
`sources`, `today.*` (inclui `inflight` e `other_requests` desde o agente 1.1),
`hourly_24h[24]`, `timeline_today.points[]` (5 min, com `inflight_*_max`) e `daily[]`.
A definição completa está em `src/lib/devcore/metrics-schema.ts`. Os campos novos são
opcionais (inclusive `today.server`, do agente 1.2), então o agente 1.0 continua aceito. O status fica "Atrasado" com
`generated_at` acima de 5 min e "Indisponível" sem envio há mais de 15 min.
