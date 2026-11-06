# AgentTrack — homologação e passagem para produção

> **Produção substituída em 06/11/2026 às 18:36 (Brasília), com autorização do
> administrador.** O roteiro de virada abaixo foi executado. Consulte
> [production-cutover.md](production-cutover.md) para estado atual e rollback.

## Escopo da entrega

A central permite cadastrar POCs, prever PODs antes da inscrição, vincular agentes,
aprovar, revogar, recuperar credenciais com motivo auditado e encerrar POCs.
O detalhe reutiliza os indicadores, gráficos, detalhamento por origem e parecer do
painel anterior. Há seleção por POD: percentis de máquinas diferentes não são
somados nem calculados pela média. A central informa requisições medidas e cobertura
da fonte; cobertura incompleta é visível.

O agente 2.1.0-rc1 transmite GPU, processo/slots e métricas operacionais somente
após aprovação. Lê uma fonte local existente sem modificar o coletor legado. Para
novos templates sem essa fonte, o kit oferece captura HTTP passiva, habilitada
explicitamente e dependente de tcpdump/CAP_NET_RAW. Não decodifica TLS. Ausência,
atraso ou incompatibilidade da fonte são mostrados como indisponibilidade.
Identificadores de origem são pseudonimizados; não representam necessariamente
pessoas. Prompts, respostas e tokens não fazem parte da telemetria operacional.

## Entrega ao técnico

Enviar `artifacts/devcore-universal-agent-template-v2.zip` e o respectivo `.sha256`.
O ZIP contém README, Dockerfile de exemplo, instalador com manifesto de integridade
e doze arquivos de runtime. Não contém bootstrap, identidades, credenciais,
dependências de GPU ou modelos. O README dentro do pacote é o procedimento de
integração: instalar código durante o build e chamar `template_boot.py` no startup
real, depois de montar o volume e antes de iniciar o comando original.

Configurar URL do Monitor e bootstrap como segredo em runtime. Não copiar estado
para imagens. Manter um diretório exclusivo por POD em volume persistente. A
instalação não muda o entrypoint automaticamente: cada imagem precisa preservar
seu startup, SSH/Jupyter e argumentos. O ID `25ymgt2hq5zout` identifica a POD atual;
não identifica a imagem Docker usada pelo técnico.

Aceite de cada template real: subir duas PODs e verificar identidades distintas,
aguardar aprovação sem coleta, aprovar uma, enviar requisições, conferir contagens
e tempos, desconectar SSH e reiniciar a mesma POD preservando identidade. Conferir
modelo/SSH/Jupyter e revogação. O teste isolado automatizado cobre boot, persistência,
captura, falha do supervisor e recuperação; não substitui esse aceite em uma imagem
real ainda não fornecida. Não reiniciar a POD atual com modelo ativo para simular
esse teste sem uma janela combinada.

## Armazenamento, retenção e recuperação

O servidor usa uma única instância com estado privado em
`/opt/multicortex/devcore-agenttrack/state`. Não iniciar dois processos escritores
nesse diretório. JSONs são gravados atomicamente; dados corrompidos não são
silenciosamente substituídos. Histórico de GPU e resumos diários têm retenção
padrão de 90 dias, configurável de 1 a 400 por
`DEVCORE_METRICS_RETENTION_DAYS`. Expurgo ocorre no acesso/gravação dos históricos;
não é um serviço de limpeza global. Cadastros e auditoria são preservados.
Captura própria mantém logs locais privados por 45 dias; logs do serviço rotacionam
em três cópias de 1 MiB. Logs Docker limitam-se a três arquivos de 10 MiB.

Para backup consistente, parar somente o serviço que escreve no estado. Exemplo,
no diretório da homologação, com um nome de arquivo novo:

```sh
docker compose -p devcore-agenttrack -f docker-compose.agenttrack.yml stop app
python3 agenttrack-state.py backup --root "$PWD" --output "$PWD/backups/backup-NOVO.zip" --quiesced
python3 agenttrack-state.py verify "$PWD/backups/backup-NOVO.zip"
docker compose -p devcore-agenttrack -f docker-compose.agenttrack.yml up -d app
```

O backup contém segredos; manter privado (0600), fora da web e transferir somente
para armazenamento administrativo protegido. O utilitário inclui configurações e
JSONs do estado, registra hashes e recusa links, locks e arquivos excessivos.
Restauração só aceita destino novo:

```sh
python3 agenttrack-state.py restore backups/backup-NOVO.zip --destination /caminho/privado/restauracao-NOVA
```

Não sobrescrever o estado em uso nem restaurar um backup antigo para desfazer uma
implantação comum: isso pode perder aprovações, revogações e dados novos. Validar a
restauração em destino separado e ajustar proprietário/SELinux antes de um uso
operacional. O bind mount da aplicação requer `:Z` neste servidor.

Revogar bloqueia telemetria e interrompe a captura própria, preservando o modelo.
Uma fonte legada independente não é parada. Reativar/recuperar exige POC ativa,
administrador e motivo; invalida a credencial anterior e incrementa uma geração
auditada. O agente solicita uma credencial nova somente ao receber essa autorização.
Erros de rede/401 nunca autorizam rotação por conta própria. Se a identidade ou a
chave de inscrição forem perdidas, tratar como reinstalação controlada; não clonar
estado de outra POD.

## Validação reproduzível

```sh
npm test
npm run typecheck
npm run test:e2e:pocs
npm run test:e2e:template
npm run test:migration-proxy
```

Os testes E2E requerem Docker, Chromium/Playwright e a imagem candidata construída.
`POC_TEST_IMAGE` escolhe a imagem; `POC_TEST_BASE_PATH=` testa a futura raiz. Fixtures
usam volumes, usuários e modelos sintéticos isolados e removem seus próprios
recursos. O cenário de captura mede HTTP sintético, não inferência de GPU: não é
benchmark nem promessa de impacto percentual em carga de produção.

## Virada futura — somente após aprovação

Arquivos preparados: `docker-compose.release.yml`, `scripts/prepare-release-env.py`
e `infra/ec2/nginx-agenttrack-production-compat.conf`. A imagem de raiz deve ser
construída com basePath vazio; não reutilizar uma imagem compilada para /agenttrack.

1. Registrar IDs das imagens atual/candidata, backup do vhost e incluir um backup
   verificado do estado. Preservar serviço legado na porta 3002.
2. Preparar `.env.release` em destino novo com `prepare-release-env.py`: preserva
   usuários/segredo de autenticação originais e bootstrap/admins da homologação.
   Não exibir nem versionar o arquivo.
3. Parar AgentTrack 3103 antes de iniciar o candidato 3004 usando o mesmo estado.
   Nunca executar ambos sobre o mesmo bind mount.
4. Conferir saúde local 3004, login, POCs e permissões. No vhost HTTPS existente,
   alterar somente o upstream raiz de 3002 para 3004 e substituir o include
   AgentTrack pelo snippet de compatibilidade. Manter SSL, outros hosts e /teste/.
5. Executar `nginx -t` antes de reload. O snippet preserva os URLs já instalados
   `/agenttrack/api/devcore/agents/...`, reescrevendo para a API da raiz. Não é
   necessário recadastrar agentes nem distribuir novas credenciais.
6. Conferir login/admin, central, detalhe, telemetria real, negativa anônima e
   permissão comum. Observar logs, atualidade da fonte e erros; registrar aceite.

Rollback: restaurar o vhost/include anterior, validar e recarregar nginx; parar o
candidato 3004 antes de religar AgentTrack 3103 com a imagem atual de homologação e
**o mesmo estado atualizado**. O root volta ao serviço legado 3002. Não restaurar
banco antigo automaticamente. Mudanças futuras de schema exigirão novo ensaio.

O ensaio de proxy usa nginx real em contêiner e verifica POST, cabeçalhos de
inscrição/autorização, reescrita do URL instalado e reversão. A virada real ainda
não foi executada; o ambiente principal permanece preservado.

## Evidência da homologação em 06/11/2026

- 188 testes: 58 TypeScript e 130 Python, todos aprovados. Tipagem e lint aprovados.
- Chromium validou /agenttrack e a futura raiz: central/detalhe, gráficos, origem
  pseudonimizada, permissões, recuperação auditada, encerramento e tela de 390 px.
- Template isolado: boot sem intervenção, pending sem captura, tráfego HTTP real
  pelo parser, reinício com identidade/credencial preservadas, interrupção da captura
  ao morrer o supervisor, revogação e reativação com nova geração de credencial.
  Modelo sintético permaneceu disponível. Não houve inferência nesse ensaio.
- POD `25ymgt2hq5zout`: Python 3.6.15, agente atualizado para 2.1.0-rc1, UUID e
  credencial preservados; descoberta do processo do modelo permaneceu igual.
  Leitura da fonte existente: aproximadamente 3,3 ms por chamada em ensaio curto;
  isso não mede consumo total em carga nem captura passiva em outro template.
- Monitor recebeu métricas reais disponíveis, 317 requisições na amostra conferida,
  retrato live e histórico 0600. Cadastros e hashes de autorização conferidos contra
  o backup sem expor valores; IDs de origem transmitidos pseudonimizados.
- Backup privado pré-atualização:
  `/opt/multicortex/devcore-agenttrack/backups/pre-operational-20261106T211435Z.zip`.
  Integridade e restauração em destino separado conferidas, sem substituir estado.
- Produção original preservada: contêiner `c79c69df55ffd73360ec1a5447e69a957bbc9ece166227323bfd12855ff81508`;
  raiz 307, login 200 e /teste/ 303. Homologação healthy; API anônima negada com 403.
- `/workspace` do POD atual **não aparece como montagem separada** e usa o mesmo
  dispositivo de `/`. Isso não comprova volume persistente na RunPod: o técnico
  precisa confirmar a configuração do armazenamento. Não foi reiniciado o POD ou
  seu modelo para testar durabilidade. O novo template exige volume persistente.

Kit v2 atualizado: SHA256
`94baf447221c31cf712c092f8e299dd812ed865e7d947d9272f8043e0334ab74`.
Nenhum pacote novo foi colocado em URL pública; a entrega é o arquivo local.

Revisão final da homologação (inclui ajustes de cancelamento de atualização e
relógio do retrato ao vivo): imagem
`sha256:ea856b9f1633fb24059b13863361cd77ed5d157a7c5fc88f1ff8b0e551e23fb5`.
Candidato local para futura raiz:
`sha256:cd1416fdc50ce2323e6fd091dfae37a898ae157310f589686d8f22701fcd4c10`.
Ambas as imagens passaram novamente pelo fluxo Chromium completo.
Backup adicional verificado antes dessa revisão:
`/opt/multicortex/devcore-agenttrack/backups/pre-final-ui-20261106T211822Z.zip`.
Rollback da revisão visual: `devcore-agenttrack:before-final-ui`.
Rollback anterior à coleta operacional: `devcore-agenttrack:before-operational`.
O inventário local da entrega está em `artifacts/agenttrack-release.json`.

Template informado pelo administrador: `mdj9hpta93`. A consulta pública não
permitiu inspecionar sua configuração. O ID está registrado; imagem Docker,
startup e montagem persistente ainda precisam ser conferidos no painel RunPod.

Captura fornecida pelo administrador confirma o template `mdj9hpta93`, nome
`multicortex-2.0.6-devcore`, imagem privada `multicortex/multicortex-2.0.6-work`.
A listagem não mostra tag/digest explícito, comando de inicialização ou volume.
Esses campos continuam pendentes de inspeção; não houve alteração no template.

O ZIP de entrega foi renomeado para `artifacts/Agente_Monitoramento.zip`, com
checksum em `artifacts/Agente_Monitoramento.zip.sha256`. O conteúdo e SHA256
são os mesmos do kit v2 acima. O gerador continua produzindo o nome canônico
`devcore-universal-agent-template-v2.zip`.
