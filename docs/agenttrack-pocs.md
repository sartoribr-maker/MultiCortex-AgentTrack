# AgentTrack — POCs e PODs

## Escopo

Central de POCs, cadastro/edição de cliente, nome, responsável, período e observações;
PODs previstas por ID RunPod ou agentes já registrados; vinculação explícita,
autorização de monitoramento e painel específico por POC. A publicação principal
continua com o dashboard legado. A nova experiência é habilitada somente quando
`DEVCORE_POC_MODE=1`; o Compose de AgentTrack define essa variável.

## Operação

1. Na central, usar **Nova POC** para cadastrar cliente e período.
2. Abrir a POC e usar **Cadastrar POD**. É possível informar um ID RunPod antes de
   instalar o agente ou escolher um dos agentes já registrados.
3. Para POD previamente cadastrada, depois do registro usar **Vincular agente
   encontrado** no seu cartão. O ID reportado pelo agente deve corresponder à POD.
4. Usar **Autorizar monitoramento** dentro da POC. Vincular não aprova sozinho.
5. A central mostra POCs ativas, PODs online, utilização média das GPUs e memória.
   Um clique abre GPU, memória, temperatura, processos, portas e slots de cada POD.
6. **Editar POC** altera metadados sem alterar aprovação ou credenciais.
7. **Encerrar POC** exige confirmação explícita e encerra o monitoramento de todas
   as PODs vinculadas. É definitivo nesta versão; os dados da última amostra ficam
   preservados para consulta. A data prevista não encerra automaticamente a POC.

Agentes sem vínculo aparecem em **PODs e autorizações**. Aprovações anteriores à
introdução das POCs são preservadas: esses agentes continuam com a autorização já
concedida e devem ser vinculados manualmente, sem nova emissão de credencial.
Novas aprovações exigem POC ativa no backend. Aprovar novamente um agente já
aprovado é idempotente e não invalida sua credencial. Agentes revogados não são
reativados pela tela: o protocolo de emissão única exige recuperação administrativa.
Não há transferência automática de POD entre POCs nem exclusão de vínculos nesta
versão; não cadastrar POD prevista na POC errada.

## Persistência e segurança

`DEVCORE_POCS_FILE=/var/lib/devcore-agenttrack/pocs.json`, no volume de estado já
existente e com rótulo SELinux privado (`:Z`). Metadados e vínculos ficam no mesmo
arquivo, gravado atomicamente com modo 0600, fsync e trava exclusiva. Lock existente
não é apagado automaticamente. Erros/corrupção não são tratados como cadastro vazio.
UUIDs independentes identificam POCs e PODs; agente e ID RunPod não podem aparecer
em dois vínculos. Os hashes/credenciais do registry dos agentes nunca são devolvidos
pela nova API.

Todas as APIs de POC exigem usuário administrativo já autorizado; mutações validam
origem quando enviada pelo navegador. O acesso atual é de administração MultiCortex,
não há ainda portal por cliente. Dados são consultados com no-store.

O encerramento é persistido antes de revogar o registry. Status, emissão e validação
do token também consultam o estado da POC: mesmo que uma gravação de revogação
falhe, uma POC encerrada não mantém acesso operacional. O agente vê status revoked
na próxima consulta e exclui sua credencial. Requisições/coletas já em andamento
seguem as limitações já documentadas do agente; não há cancelamento remoto instantâneo.

## Métricas

Online = agente aprovado, POC ativa e recebimento no servidor há menos de 90 s.
Agregados de GPU e slots usam somente PODs online. Valores ausentes aparecem como
indisponíveis; amostras antigas ficam marcadas como históricas no detalhe. Atenção
indica POD aprovada sem comunicação recente, GPU com temperatura >=85 °C ou memória
>=95%. Utilização é média simples das GPUs reportadas. Memória é exibida em GiB a
partir de MiB. Slots significam configuração, não requisições ativas.

Atualização automática a cada 10 s; datas/horários de apresentação em São Paulo.
O servidor guarda a última amostra e, desde a revisão do dashboard detalhado,
histórico diário de GPU/VRAM em intervalos de cinco minutos. Gráficos de latência,
tokens por segundo, alertas enviados e métricas de requisições continuam dependendo
da ampliação da coleta. Consulte `docs/agenttrack-dashboard-poc.md`.

## Validação local

```sh
npm run typecheck
npm run test:site
node --require ./tests/server-only-stub.cjs --import tsx tests/poc-management.test.ts
python3 -m unittest discover -s infra/devcore-universal-agent/tests
python3 -m unittest discover -s infra/devcore-vm-agent/tests
docker build --build-arg NEXT_PUBLIC_BASE_PATH=/agenttrack -t devcore-agenttrack:poc-candidate .
PLAYWRIGHT_MODULE_PATH=/caminho/playwright node tests/poc-browser.cjs
```

O teste de navegador cria usuário, agentes e POCs fictícios em volume/contêiner
locais próprios, verifica cadastro, navegação, aprovação, telemetria, edição,
isolamento, encerramento e layout móvel. Remove somente sua fixture ao concluir.
Nenhuma POC ou credencial real é criada ou revogada por esses testes.

## Publicação de homologação

Publicar somente imagem/projeto `devcore-agenttrack` em 3103 com
`docker-compose.agenttrack.yml`, preservando `devcore-monitor` em 3002 e o Nginx
existente. Guardar imagem anterior para rollback. O volume de estado existente não
é substituído. A POD real aprovada aparecerá aguardando vínculo à POC escolhida
pelo administrador; não inventar cliente ou vínculo automaticamente.

A substituição da publicação principal será uma etapa posterior, após aceite:
backup de todos os registries/telemetria, plano de migração de dados/sessões,
revisão de autorização por cliente, testes de regressão, janela e rollback. Não
executar o deploy.sh principal para esta homologação.

## Resultado da entrega local/publicada

- Tipagem e build Docker aprovados.
- 27 testes do dashboard anterior + 16 testes de POCs + 70 do agente universal +
  39 do agente de VM: 152 aprovados, nenhum reprovado.
- Aceite de navegador completo aprovado com Chromium: entrada, central, cadastro,
  navegação, vinculação, aprovação, telemetria, edição, POD prevista, rejeição de
  ID incompatível, isolamento, encerramento e layout a 390px.
- Publicado somente em AgentTrack; imagem validada:
  `sha256:76e3a065e9308331513f44ec83ffff027ecff535a459ef8d197506d3ca9a92dc`.
- Contêiner principal manteve ID e imagem; `/` 307, `/entrar` 200 e `/teste/` 303.
- Registry real dos agentes manteve o checksum anterior à atualização; agente da
  POD de homologação permanece approved, com telemetria recente após a publicação.
- Nenhuma POC, vinculação, aprovação ou revogação fictícia foi criada no servidor.
- Rollback guardado em imagem `devcore-agenttrack:before-pocs` e Compose
  `/opt/multicortex/devcore-agenttrack/docker-compose.agenttrack.yml.before-pocs`.
- Backup privado do registry em
  `/opt/multicortex/devcore-agenttrack/backup-before-pocs/agents.json`.

A homologação funcional pelo administrador (cadastro da POC e vinculação da POD real)
é o próximo passo. O ambiente de produção principal não foi substituído.
