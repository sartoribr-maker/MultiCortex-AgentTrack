# Remoção do DevCore Monitor no repositório do site (`SITE_LLMS`)

Fazer **só depois** da virada verificada (`docs/virada.md`, passo 5: painel novo
"Online" e card "Agora" atualizando) e **enquanto** o `location /api/devcore/ingest/` do
vhost do site apontar para o contêiner novo (ou depois que todos os agentes usarem
`devcore.multicortex.com.br`). Sessão separada, no repositório do site.

## Arquivos e pastas que saem

| O quê | Caminho no site |
|---|---|
| Páginas do painel | `src/app/devcore/` inteira (`page.tsx`, `layout.tsx`, `actions.ts`, `devcore.css`, `entrar/page.tsx`, `entrar/login-form.tsx`) |
| API | `src/app/api/devcore/` inteira (`ingest/[id]/route.ts`, `ingest/[id]/live/route.ts`, `vms/route.ts`, `vms/[id]/metrics/route.ts`, `vms/[id]/live/route.ts`) |
| Backend | `src/lib/devcore/` inteira (`api`, `assessment`, `host`, `http`, `ingest`, `ingest-request`, `live`, `metrics`, `metrics-schema`, `proxy`, `registry`, `session`, `view`) |
| Componentes | `src/components/devcore/` inteira (`brand`, `chart`, `dashboard`, `developers`, `live`, `opinion`) |
| Cadastro de VMs | `config/devcore-vms.json` (e a pasta `config/`, se ficar vazia) |
| Agente da VM/pod | `infra/devcore-vm-agent/` inteira |
| Testes | `tests/devcore-dashboard.test.ts` |
| Fixtures | `tests/fixtures/devcore-metrics.sample.json`, `tests/fixtures/devcore-live.sample.json` |
| Documentação | `docs/devcore-dashboard.md` |

## Trechos que mudam

1. **`src/proxy.ts`**: remover o `import { devcoreProxy } from "./lib/devcore/proxy";` e as
   duas linhas no início de `proxy()`:

   ```ts
   const devcore = devcoreProxy(request);
   if (devcore) return devcore;
   ```

   O resto (next-intl e o `matcher`) fica igual.
2. **`src/app/robots.ts`**: remover o `import { headers } from "next/headers";`, o
   `import { isDevcoreHost } from "@/lib/devcore/host";` e o bloco
   `if (isDevcoreHost(await headers())) { … }`. A função pode deixar de ser `async`.
   Manter `"/devcore"` no `disallow` é inofensivo; pode sair também.
3. **`.env.example`**: remover o comentário "Painel interno DevCore Monitor…" e as linhas
   `DEVCORE_HOST=`, `DEVCORE_VMS_FILE=`, `DEVCORE_METRICS_TOKEN_DEVCORE_DEMO_01=`.

## No servidor (EC2), depois do deploy do site sem o painel

- `/opt/multicortex/site/.env.production`: remover `DEVCORE_HOST`, `DEVCORE_VMS_FILE`
  (se existir) e `DEVCORE_METRICS_TOKEN_DEVCORE_DEMO_01`. O token continua no
  `/opt/multicortex/devcore-monitor/.env.production`. Fazer com cópia de segurança, um
  comando por vez, por exemplo:
  - `sudo cp -p /opt/multicortex/site/.env.production /opt/multicortex/site/.env.production.bak-devcore-$(date +%Y%m%d-%H%M%S)`
  - `sudo sed -i '/^DEVCORE_/d' /opt/multicortex/site/.env.production`
- `/opt/multicortex/site/docker-compose.prod.yml`: se repassar `DEVCORE_*` ao serviço
  `app` explicitamente, remover essas linhas (conferir com `sudo grep -n DEVCORE` no
  arquivo).
- Recriar o contêiner do site (o `deploy.sh` do site já faz isso).

## O que **não** sai do site

- `public/brand/mark.png`: também é o logo do site (`logo-mark.tsx`, JSON-LD).
- `tests/ai-chat-server-only.cjs`: usado pelos outros testes do site.
- `src/app/[locale]/produtos/devcore/` e as imagens `public/brand/products/devcore*`: são
  a página pública do produto DevCore, não o painel.
- Dependências (`zod`, `next-auth`, `bcryptjs`…): continuam usadas pelo site.
- O vhost `site.multicortex.com.br` mantém o `location /api/devcore/ingest/` até os
  agentes migrarem para a URL do painel.

## Conferência

```bash
git grep -nE "lib/devcore|components/devcore|devcoreProxy|isDevcoreHost|DEVCORE_" || echo "sem referências"
npx tsc --noEmit && npm run build
node --require ./tests/ai-chat-server-only.cjs --import tsx --test tests/locale-proxy.test.ts
```
