# DevCore Monitor

Painel interno da MultiCortex para acompanhar as VMs de POC do DevCore, em
`https://devcore.multicortex.com.br`. Recebe as métricas que o agente de cada VM/pod envia
(push) e mostra uso, tempos, GPU, slots, desenvolvedores e um parecer técnico. Uso só da
equipe, com login, sem indexação.

Documentação completa (arquitetura, indicadores, agente, cadastro de VMs, variáveis,
login, deploy): [`docs/devcore-dashboard.md`](docs/devcore-dashboard.md).

## Rodar localmente

Requisitos: Node 22+ e Python 3.6+ (testes do agente).

```bash
npm install
cp .env.example .env.local
# preencha AUTH_SECRET (openssl rand -base64 32), um token de teste em
# DEVCORE_METRICS_TOKEN_DEVCORE_DEMO_01 e um usuário:
npm run hash-password -- voce@multicortex.com.br "Seu Nome"   # cole a saída em DEVCORE_USERS
npm run dev
```

Envie um `metrics.json` de teste e entre em `http://localhost:3000/entrar`:

```bash
curl -X POST -H "Authorization: Bearer <token de teste>" \
  --data-binary @tests/fixtures/devcore-metrics.sample.json \
  http://localhost:3000/api/devcore/ingest/devcore-demo-01      # 204
```

(O fixture é de 13/10/2026; o painel o mostra como "Atrasado". Para ver "Online", troque o
`generated_at` pela hora atual.)

## Testar

```bash
npm run typecheck     # next typegen + tsc
npx eslint .
npm test              # testes do painel (node:test) + do agente (unittest)
npm run build
```

## Deploy

Contêiner `devcore-monitor-app-1` no EC2 (`127.0.0.1:3002`, `/opt/multicortex/devcore-monitor/`),
atrás do nginx. Com a árvore Git limpa:

```bash
./deploy.sh
```

Valida, constrói a imagem localmente, envia por `docker save | ssh`, recria o contêiner,
faz health check e volta à imagem anterior se falhar. Uma única instância: as métricas
ficam na memória do processo.

- Virada do site para este projeto: [`docs/virada.md`](docs/virada.md)
- O que remover depois no site: [`docs/remocao-no-site.md`](docs/remocao-no-site.md)
