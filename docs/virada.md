# Virada do site para o DevCore Monitor independente

Objetivo: o painel e a ingestão passam do contêiner do site (`multicortex-site-app-1`,
`:3001`) para `devcore-monitor-app-1` (`:3002`), **sem mexer no pod/VM** e sem parar o
recebimento de métricas. Nada muda no DNS de `devcore01`, no Apache `35.168.36.211` nem
no llama.cpp.

Por que não se perde nada: o agente reenvia o `metrics.json` completo (hoje, 24 h, dia a
dia da POC) a cada minuto e o retrato ao vivo a cada 10 s, sempre para a mesma URL. O
histórico vive na VM (`state.json`). O contêiner novo começa vazio e se completa no
primeiro envio; o do site simplesmente para de receber.

Convenções: no EC2 (`ssh ec2-user@52.207.145.100`) o `sudo` não pede senha. Cole **um
comando com `sudo` por vez**. Nenhum passo imprime token ou senha.

## 0. Antes de começar

- Mostrar os vhosts atuais (para conferir onde entra a regra da ingestão):
  - `sudo cat /etc/nginx/vhosts.d/devcore.conf`
  - `sudo cat /etc/nginx/vhosts.d/multicortex.conf`
- Gerar no seu PC, na raiz deste projeto, uma entrada por pessoa da equipe:
  `npm run hash-password -- pessoa@multicortex.com.br "Nome"`

## 1. Diretório e `.env.production` do painel (EC2)

```bash
sudo install -d -m 755 -o ec2-user -g ec2-user /opt/multicortex/devcore-monitor
sudo install -m 600 /dev/null /opt/multicortex/devcore-monitor/.env.production
echo 'AUTH_URL=https://devcore.multicortex.com.br' | sudo tee -a /opt/multicortex/devcore-monitor/.env.production >/dev/null
echo "AUTH_SECRET=$(openssl rand -base64 32)" | sudo tee -a /opt/multicortex/devcore-monitor/.env.production >/dev/null
# o MESMO token da VM que o site usa hoje, copiado de arquivo para arquivo (não aparece na tela)
sudo grep '^DEVCORE_METRICS_TOKEN_DEVCORE_DEMO_01=' /opt/multicortex/site/.env.production | sudo tee -a /opt/multicortex/devcore-monitor/.env.production >/dev/null
# as entradas geradas no passo 0, separadas por vírgula
echo 'DEVCORE_USERS=<entrada1>,<entrada2>' | sudo tee -a /opt/multicortex/devcore-monitor/.env.production >/dev/null
# conferência: só os nomes das variáveis
sudo grep -oE '^[A-Z0-9_]+=' /opt/multicortex/devcore-monitor/.env.production
```

A conferência deve listar `AUTH_URL=`, `AUTH_SECRET=`,
`DEVCORE_METRICS_TOKEN_DEVCORE_DEMO_01=` e `DEVCORE_USERS=`, uma vez cada.

## 2. Deploy do contêiner novo (seu PC)

```bash
cd ~/Multicortex/Projetos/DevCore_Track
./deploy.sh
```

O `sudo docker build` local pede a sua senha. Ao fim, `devcore-monitor-app-1` responde em
`127.0.0.1:3002`, mas ainda não recebe tráfego: o site continua igual.

## 3. Virada da ingestão (EC2, vhost do site)

Só depois do passo 2 (contêiner novo respondendo); antes disso a regra daria 502 e o
envio daquele minuto se perderia.

A regra fica num arquivo próprio, incluído no bloco 443 de `site.multicortex.com.br`
(o `server_name` aparece também no bloco 80 do fim do arquivo; o `sed` abaixo altera só
a primeira ocorrência, que é a do 443).

```bash
# no seu PC, na raiz do projeto
scp infra/ec2/nginx-site-ingest-location.conf ec2-user@52.207.145.100:/tmp/
```

No EC2, um comando por vez:

```bash
sudo install -D -m 644 /tmp/nginx-site-ingest-location.conf /etc/nginx/devcore-monitor/ingest-location.conf
sudo cp -p /etc/nginx/vhosts.d/multicortex.conf /etc/nginx/vhosts.d/multicortex.conf.bak-devcore-$(date +%Y%m%d-%H%M%S)
sudo sed -i '0,/server_name site\.multicortex\.com\.br;/s//&\n    include \/etc\/nginx\/devcore-monitor\/ingest-location.conf;/' /etc/nginx/vhosts.d/multicortex.conf
sudo grep -n ingest-location /etc/nginx/vhosts.d/multicortex.conf
sudo nginx -t
sudo systemctl reload nginx
```

O `grep` deve mostrar **uma** linha (logo abaixo do primeiro `server_name`). Se o
`nginx -t` falhar, não recarregue: restaure a cópia (seção "Voltar atrás").

Conferência: sem token, o caminho já responde pelo contêiner novo com 401 e o cabeçalho
`noarchive` (o site respondia sem ele):
`curl -s -D - -o /dev/null -X POST https://site.multicortex.com.br/api/devcore/ingest/devcore-demo-01 | grep -iE '^HTTP|x-robots'`

Em até 1 min o pod faz o próximo envio, que já cai no contêiner novo.

## 4. Virada do painel (EC2, vhost do DevCore)

O `devcore.conf` também inclui `/etc/nginx/devcore-loadtest/teste-location.conf`
(`/teste/` → `127.0.0.1:8095`, ferramenta de teste de carga). Ele não usa a porta 3001
e não muda: só o `proxy_pass` do `location /` é trocado.

1. Troca do `proxy_pass` com cópia de segurança automática (`devcore.conf.bak-…`):
   `sudo sed -i.bak-$(date +%Y%m%d-%H%M%S) 's#proxy_pass http://127.0.0.1:3001;#proxy_pass http://127.0.0.1:3002;#' /etc/nginx/vhosts.d/devcore.conf`
2. `sudo grep -n proxy_pass /etc/nginx/vhosts.d/devcore.conf` (deve mostrar `:3002`)
3. `sudo nginx -t`
4. `sudo systemctl reload nginx`

## 5. Verificação

- `curl -sI https://devcore.multicortex.com.br/entrar | grep -i x-robots` →
  `noindex, nofollow, noarchive`.
- Abrir `https://devcore.multicortex.com.br/`, entrar com um usuário de `DEVCORE_USERS`
  (as sessões antigas do site não valem mais) e conferir, **em até 1 minuto**, o status
  **"Online"** e o card **"Agora"** atualizando a cada 10 s.
- Só depois disso a remoção do código no site pode ser feita (`docs/remocao-no-site.md`).

## Voltar atrás

Restaurar as cópias e recarregar (um comando por vez). O arquivo
`/etc/nginx/devcore-monitor/ingest-location.conf` pode ficar: sem o `include`, não tem efeito.

```bash
sudo cp -p /etc/nginx/vhosts.d/devcore.conf.bak-<data> /etc/nginx/vhosts.d/devcore.conf
sudo cp -p /etc/nginx/vhosts.d/multicortex.conf.bak-devcore-<data> /etc/nginx/vhosts.d/multicortex.conf
sudo nginx -t
sudo systemctl reload nginx
```

O site continua com o código do painel até a remoção, então volta a receber e a mostrar
os dados no envio seguinte.

## Opcional, depois: URL direta no agente

Reinstalar o agente do pod apontando direto para o painel (procedimento de envio em
`docs/devcore-dashboard.md`, "Servidor em contêiner"):

```bash
bash /root/devcore-vm-agent/install-pod.sh --push-url https://devcore.multicortex.com.br/api/devcore/ingest/devcore-demo-01
```

Antes, para manter o limite de 2 MB do contrato nesse host (o padrão do nginx é 1 MB),
acrescente `client_max_body_size 3m;` ao `location /` de `devcore.conf` (cópia,
edição, `nginx -t`, reload).

Quando todos os agentes usarem essa URL, remova o `location /api/devcore/ingest/` do
vhost do site (mesmo roteiro: cópia, edição, `nginx -t`, reload).
