# Dashboard detalhado da POC — histórico da primeira revisão

> Este documento registra a primeira publicação visual. Para a implementação
> operacional atual, retenção, kit v2 e passagem para produção, consulte
> [agenttrack-readiness.md](agenttrack-readiness.md). As limitações abaixo são
> históricas daquela revisão, não o estado atual do código.

A central de POCs e o fluxo administrativo foram preservados. Somente o detalhe
foi reorganizado para seguir o dashboard legado apresentado pelo usuário:

1. Empresa/POC, filtro de POD quando houver mais de uma e atualização.
2. Cabeçalho de cliente/POC, situação, período e barra de progresso.
3. Bloco **Agora**: desenvolvedores online, slots em uso e GPU atual.
4. Oito indicadores diários na mesma ordem e estilo da referência.
5. Gráficos horários, concorrência, GPU/VRAM e séries da POC inteira.
6. Parecer técnico, observações e recomendações limitadas aos dados disponíveis.
7. Detalhes das PODs e autorização em seção expansível ao final.

São reaproveitados o componente `Chart`, tipografia, cores, estilos de cards,
formatação de datas e barra de progresso do dashboard existente. O ambiente
principal não recebe esta publicação.

## Cobertura real de métricas

- GPU atual, memória, temperatura, processos, portas e slots configurados: telemetria
  real do agente já instalado; dados antigos não são apresentados como atividade atual.
- GPU e VRAM ao longo do dia: novas amostras persistidas no Monitor a partir desta
  versão; nada é reconstruído artificialmente para períodos anteriores.
- Desenvolvedores, requisições, concorrência, slots em uso, erros, latência e tempo
  até a primeira resposta: ainda não coletados pelo Universal Agent. Cards mostram
  `—` e gráficos exibem estado de espera, sem zeros ou dados fictícios.
- Slots configurados não são tratados como slots ocupados.
- Parecer é parcial, limitado a comunicação, temperatura e memória. Não conclui
  capacidade de atendimento ou necessidade de upgrade sem dados de demanda/resposta.

## Histórico de GPU

Com `DEVCORE_POC_MODE=1`, cada telemetria aceita também atualiza
`$DEVCORE_TELEMETRY_DIR/gpu-history/<agent-id>/<data-São-Paulo>.json`.
Há no máximo 288 buckets por dia/agente, com média de utilização das amostras,
pico de utilização e pico de memória total usada por POD no intervalo. GPU atual
permanece a última amostra, separada dos agregados históricos.

No filtro de todas as PODs, utilização histórica é ponderada pela contagem de
amostras disponíveis de cada POD; VRAM soma os máximos de cada POD no intervalo
(não representa necessariamente um pico simultâneo). Ausência de dados mantém
lacunas. Estatísticas diárias cobrem somente amostras registradas, não períodos
anteriores à atualização. O dia é separado pelo horário de São Paulo.

O arquivo usa modo 0600 e gravação atômica. Falhas/corrupção do histórico são
registradas com mensagem sanitizada e não impedem aceitar a telemetria atual.
O writer não substitui arquivo corrompido. A implantação é de uma instância;
não há coordenação de escrita entre réplicas neste armazenamento local.

Arquivos diários antigos são preservados. Política de retenção/limite de disco
precisa ser definida antes da migração de produção; não há expurgo automático.
A API retorna somente o histórico do dia atual. Séries de requisições da POC
inteira permanecem indisponíveis até a ampliação da coleta e persistência específica.

## Testes

- 27 testes do dashboard legado, 16 de POCs/autorização, 7 de histórico GPU.
- Teste de navegador local verifica as seções da referência, gráficos, cadastro,
  vinculação/autorização, telemetria, edição, encerramento e layout a 390px.
- Todas as fixtures usam POCs, usuários e agentes fictícios em contêiner isolado.
- Build, tipagem e `git diff --check` antes de publicar somente no AgentTrack.

A próxima etapa para igualar também os indicadores operacionais da referência é
ampliar o Universal Agent para coletar requisições/tempos/atividade por servidor,
com fonte, segurança, compatibilidade e aprovação próprias. Esta revisão não
instala captura de rede nem modifica os processos ou modelos da POD.

## Publicação verificada

Revisão publicada somente no AgentTrack, imagem
`sha256:af82899b2e4be841f0c0b338f39f0ad47f010c00f8bc608b9d90e38accefc6ea`.
Os checksums de POCs e agentes ficaram iguais aos anteriores à publicação. O
contêiner principal manteve ID/imagem; `/` 307, `/entrar` 200 e `/teste/` 303.
AgentTrack healthy; acesso anônimo à API de POCs continua negado (403).

Primeira amostra real da revisão confirmada em `2026-11-06T19:13:14.417Z`;
histórico persistido com modo 0600. Não foi necessário reinstalar o agente na POD.
Os 50 testes TypeScript passaram e o fluxo Chromium validou inclusive o seletor
Empresa/POC sem duplicação de basePath, tela móvel e autorização/encerramento.

Rollback guardado em `devcore-agenttrack:before-poc-detail`; backups privados de
cadastros no servidor em `/opt/multicortex/devcore-agenttrack/backup-before-poc-detail`.
