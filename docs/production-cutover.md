# Substituição do painel DevCore — 06/11/2026

> Autenticação atualizada posteriormente para CRM, exclusiva ao perfil
> Administrador. A configuração de autenticação descrita na virada original
> abaixo é histórica. Veja [crm-authentication.md](crm-authentication.md).

Virada concluída às 18:36, horário de Brasília, após aceite da homologação e
instrução explícita do administrador para substituir o painel.

URL principal: https://devcore.multicortex.com.br/

Imagem ativa: `sha256:cd1416fdc50ce2323e6fd091dfae37a898ae157310f589686d8f22701fcd4c10`.
Compose: projeto `devcore-release`, arquivo
`/opt/multicortex/devcore-agenttrack/docker-compose.release.yml`.
Contêiner `devcore-release-app-1`, upstream privado `127.0.0.1:3004`.
Configuração privada `.env.release` preserva usuários e segredo de autenticação
originais, além do bootstrap e administradores da homologação. Não versionar esse
arquivo nem colocar backups no diretório público.

## Dados e compatibilidade

- Estado existente preservado em `/opt/multicortex/devcore-agenttrack/state`.
- POCs, identidades, autorizações e hashes das credenciais comparados com o backup:
  iguais após a troca. Não houve recadastro, reset ou nova aprovação.
- Telemetria autenticada real recebida após a troca em `2026-11-06T21:36:04.061Z`,
  fonte disponível e identificadores de origem pseudonimizados.
- Apenas o novo contêiner escreve no estado. AgentTrack 3103 está parado.
- O agente mantém `/agenttrack/api/devcore/agents/...`; nginx reescreve para a API
  da raiz preservando método e cabeçalhos. Acesso de navegador a /agenttrack/
  redireciona para a raiz. Atualizar favoritos de detalhes de POC para /pocs/ID.
- Nginx validado antes do reload. Login 200, raiz 307 para login anônimo,
  robots 200, API anônima de POCs 403 e /teste/ 303.
- O serviço legado 3002 foi mantido para rollback; o processo/modelo do POD e o
  template RunPod não foram alterados nesta migração.

## Backup e rollback

Diretório privado:
`/opt/multicortex/devcore-agenttrack/backups/production-cutover-20261106T213600Z`.

Contém vhost anterior, include anterior, backup consistente `state.zip` e
`rollback.sh`. Integridade do backup aprovada antes da virada.

Para voltar ao painel anterior e ao AgentTrack, executar no EC2 como administrador:

```sh
sudo bash /opt/multicortex/devcore-agenttrack/backups/production-cutover-20261106T213600Z/rollback.sh
```

O script restaura a configuração anterior de nginx, valida/recarrega, para o novo
escritor 3004 e inicia AgentTrack 3103 com **o estado atualizado**. Não restaura um
backup antigo nem perde novas aprovações. O root retorna ao legado 3002.

Uma tentativa inicial foi revertida automaticamente porque uma checagem consultou
`/api/auth/providers`, endpoint que esta aplicação não expõe. O login usa Server
Actions. A checagem foi corrigida para as rotas existentes; não foi necessário
alterar a aplicação. Essa tentativa também comprovou a reversão real do roteamento
e a retomada da homologação, além do ensaio isolado previamente aprovado.

## Próximas atualizações

Usar build com basePath vazio e o projeto `devcore-release`. O `deploy.sh` legado
aponta para o serviço antigo na porta 3002: não é o mecanismo de atualização deste
painel novo. Antes de cada alteração, registrar imagem atual, parar o único escritor
para backup consistente e verificar saúde/telemetria após a publicação. Nunca
iniciar AgentTrack e release ao mesmo tempo sobre o mesmo estado.

A integração do ZIP pelo técnico nos templates é uma atividade separada e não
condiciona o funcionamento deste dashboard com o agente já instalado.
