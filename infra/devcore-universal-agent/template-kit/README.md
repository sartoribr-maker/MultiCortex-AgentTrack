# MultiCortex — Universal Agent para templates RunPod

Entrega ao administrador: kit v2, agente `2.1.0-rc1`, Linux/Python 3.6+,
sem dependências Python externas. O kit instala código na imagem e inicia o agente
em runtime, ao subir cada POD. A coleta e telemetria aguardam aprovação no dashboard.

## 1. Instalar durante a construção da imagem

Extraia o ZIP no contexto de build. Acrescente ao Dockerfile do modelo:

```dockerfile
COPY devcore-universal-agent-template-v2/ /tmp/devcore-agent-kit/
RUN python3 /tmp/devcore-agent-kit/install.py \
    --install-dir /opt/multicortex/devcore-universal-agent
ENV MULTICORTEX_MONITOR_URL=https://devcore.multicortex.com.br/agenttrack
```

O instalador valida os hashes do manifesto, copia somente os doze arquivos de
runtime e recusa destino já existente. Não faz rede, cadastro, coleta, emissão de
credencial ou alteração no comando de inicialização. Não cria identidade ou estado,
mesmo que o ambiente de build tenha variáveis de credenciais. Requer Python 3.6+,
CA certificates confiáveis e `/bin/sh` na imagem base. Não altera GPU ou llama.cpp.

Código em `/opt` evita escondê-lo sob o volume montado em `/workspace`.
O processo deve executar como usuário com permissão para gravar no diretório de
estado; alinhe UID/permissões do volume ao usuário do template. O instalador não
instala Python globalmente nem modifica o USER do Dockerfile.

## 2. Integrar ao início que já existe no template

Opção recomendada: no script de startup do administrador, antes do comando que
inicia o modelo, acrescentar:

```sh
python3 /opt/multicortex/devcore-universal-agent/template_boot.py || \
    echo '[multicortex] Agente nao iniciou: verificar runtime e logs' >&2

# Manter aqui os comandos originais de SSH/Jupyter/modelo, sem alterações.
```

O agente inicia destacado; não precisa de terminal, nohup, cron ou systemd. O script
acima deve ser executado a cada boot da POD, depois de montar o volume persistente.
Não basta instalar código no Dockerfile: a chamada no startup é obrigatória.

Alternativa: envolver o comando original com o wrapper fornecido. Exemplo apenas
se o entrypoint original for `/start-original.sh`:

```sh
/opt/multicortex/devcore-universal-agent/entrypoint-agent.sh \
    /start-original.sh argumento1 argumento2
```

O wrapper passa os argumentos sem alteração e usa `exec` para o processo original
receber sinais diretamente. Retira o bootstrap do ambiente transmitido ao comando
original. Se o agente falhar ao iniciar, informa erro e ainda inicia o modelo;
nesse caso não há monitoramento. O administrador deve conferir o status do agente.

Não substitua ENTRYPOINT/CMD às cegas: confirme os valores reais da imagem, preserve
os argumentos e os serviços SSH/Jupyter que ela inicia. Caso configure o wrapper
como ENTRYPOINT no Dockerfile, explicite também o CMD original (o Docker pode
reinicializar o CMD herdado ao trocar ENTRYPOINT). Se o painel RunPod sobrescrever
o startup, a chamada do agente também precisa estar nesse caminho de execução.

## 3. Variáveis ao criar cada POD

| Variável | Configuração |
| --- | --- |
| `MULTICORTEX_MONITOR_URL` | `https://devcore.multicortex.com.br/agenttrack` no teste; usar o Monitor Central correto em produção |
| `MULTICORTEX_BOOTSTRAP_TOKEN` | Segredo de inscrição fornecido pelo administrador, via secret em runtime |
| `RUNPOD_POD_ID` | Fornecido pela RunPod; não fixar manualmente no template |
| `MULTICORTEX_AGENT_STATE_DIR` | Opcional; omitir para usar `/workspace/devcore-agent-state/<RUNPOD_POD_ID>` |

O bootstrap é o token de inscrição do Monitor Central, não é API key RunPod e não
é a senha de login no dashboard. Usar secrets da RunPod em vez de inserir o valor
na imagem ou no template público. O mesmo bootstrap pode servir para inscrição de
várias PODs conforme a política do Monitor; cada uma terá UUID, chave de inscrição
e credencial operacional próprios. Não é um token operacional por cliente embutido
no pacote. Compartilhar o bootstrap concede capacidade de solicitar cadastros;
a aprovação administrativa continua obrigatória. Distribuição/rotação desse
segredo e autorização dos clientes são responsabilidade da operação MultiCortex.

Alternativa a variável com valor: `MULTICORTEX_BOOTSTRAP_TOKEN_FILE` apontando para
arquivo de segredo montado em runtime, legível pelo processo, sem symlink e com
permissão 0600. Usar apenas uma das duas origens. Não habilitar `set -x` no startup.

Na primeira execução, URL/bootstrap são persistidos no diretório de estado em
`service-config.json` (0600), dentro de diretório 0700. No reinício, a configuração
persistida pode ser reutilizada sem reinjetar o segredo. Se variáveis fornecidas
divergirem do estado, o boot do agente é recusado; nenhuma rotação é feita.

## 4. Identidade por POD e persistência

Cada POD recebe um subdiretório próprio, baseado no ID da RunPod. Duas PODs de uma
mesma imagem não herdam identidade nem credencial, mesmo se montarem um volume
compartilhado. Um marcador vincula o diretório à POD e recusa reutilização por
outra POD. Para reiniciar a mesma instalação, manter o volume e ID originais.

Não criar snapshots de estado de um agente já executado para distribuir como
imagem. Não copiar `agent-id`, `enrollment-key`, `operational-token`,
`credential-attempted`, `telemetry-auth-blocked`, `service-config.json`,
`template-owner.json`, PID ou logs para templates ou para outro cliente.

Usar volume disk ou network volume persistente para `/workspace`. Se o mount for
outro, configurar `MULTICORTEX_AGENT_STATE_DIR` com caminho absoluto exclusivo por
POD. Diretório compartilhado entre clientes, permissões amplas e clonagem de estado
não são suportados. Mesmo com ID distinto, administradores/root do mesmo volume
podem ler seus arquivos: isolar volumes/contas por cliente conforme a operação.

Um diretório manual preexistente sem marcador não é adotado automaticamente. Este
kit destina-se a novas PODs/templates; não executar sobre a POD de homologação atual
para migrá-la implicitamente. A instalação atual continua compatível com seu
supervisor e gerenciador já instalados.

## 5. Fluxo esperado

1. POD inicia o script original; ele dispara o agente em segundo plano.
2. Agente gera identidade/chave próprias e registra no Monitor Central.
3. Dashboard mostra `Aguardando aprovação`.
4. Administrador aprova; agente recebe/persiste credencial operacional individual.
5. Coleta de GPU/llama.cpp e envio de telemetria começam.
6. Reinício reutiliza estado; falha transitória reconecta sem novo cadastro.
7. Revogação interrompe coleta/envio e exclui a credencial operacional local.

"Ativo no boot" significa processo pronto para registrar e aguardar aprovação.
Não significa aprovação automática ou coleta antes da autorização.

## 6. Operação e aceite do template

No terminal da nova POD, usando o estado padrão:

```sh
export MULTICORTEX_AGENT_STATE_DIR="/workspace/devcore-agent-state/$RUNPOD_POD_ID"
python3 /opt/multicortex/devcore-universal-agent/agent_service.py status
tail -f "$MULTICORTEX_AGENT_STATE_DIR/agent.log"
```

Para solicitar parada: `python3 /opt/multicortex/devcore-universal-agent/agent_service.py stop`.
Para iniciar novamente: `python3 /opt/multicortex/devcore-universal-agent/template_boot.py`.

Critérios de aceite por imagem/modelo:

- Subir duas PODs novas: IDs distintos, ambas pending e sem coleta antes de aprovar.
- Aprovar uma: telemetria no dashboard e modelo funcionando normalmente.
- Reiniciar a mesma POD: mesmo ID e credencial, sem nova aprovação.
- Desconectar SSH: serviço e telemetria permanecem.
- Confirmar SSH/Jupyter/modelo, argumentos e sinais originais preservados.
- Validar falha de comunicação e revogação em ambiente de teste autorizado.

Logs rotacionam em `agent.log` + três backups de 1 MiB. Não há porta de entrada
adicional para o agente; a comunicação com o Monitor é HTTPS de saída. Para GPU,
`nvidia-smi` precisa estar disponível. A descoberta de llama.cpp vê processos do
mesmo namespace de PID; não inicia, para ou reconfigura servidores/modelos.

Após revogação, o processo aguarda sem coletar. Para reativar, o administrador
usa **Reativar monitoramento** no dashboard e informa o motivo. Essa ação é
auditada, invalida a credencial anterior e autoriza uma nova geração; falhas de
rede ou autenticação nunca fazem essa recuperação automaticamente. Erro fatal
local exige corrigir a configuração e iniciar novamente o serviço.
A próxima execução do startup é feita pelo ciclo de vida da POD, não por watchdog.
O encerramento do container é controlado pelo entrypoint original. Não promete
cancelar comandos de coleta ou requests que já estejam em andamento.

## 7. Evidências e referências

O agente base foi testado em POD real com Python 3.6.15, NVIDIA H200 NVL e llama.cpp,
incluindo inscrição, aprovação, telemetria, reinício e reconexão. A integração deste
kit foi validada localmente com processos/modelo fictícios; cada template real
precisa passar pelo aceite acima antes de distribuição comercial.

Documentação oficial consultada:
- Templates: https://docs.runpod.io/pods/templates/create-custom-template
- Variáveis/ID da POD: https://docs.runpod.io/pods/templates/environment-variables
- Secrets: https://docs.runpod.io/pods/templates/secrets
- Volumes: https://docs.runpod.io/pods/storage/types


## 8. Coleta operacional completa (kit v2)

O agente primeiro procura uma fonte local já existente em
`/srv/www/devcore-metrics/metrics.json` e `/var/lib/devcore-metrics/live.json`.
Ela é lida somente depois da aprovação; o coletor legado não é alterado ou parado.
URL, identidade local, atualidade e quantidade de slots são validados.
É possível configurar caminhos com `MULTICORTEX_OPERATIONAL_METRICS_FILE` e
`MULTICORTEX_OPERATIONAL_LIVE_FILE`, e host declarado com
`MULTICORTEX_OPERATIONAL_HOST`. Não apontar arquivos de outra POD/cliente.

Quando não existir fonte local, incluir tcpdump na imagem e configurar em runtime:

```text
MULTICORTEX_CAPTURE_ENABLED=1
MULTICORTEX_DEVCORE_HOSTS=host-do-gateway-devcore.exemplo
MULTICORTEX_LLAMA_PORT=7080
```

`MULTICORTEX_DEVCORE_HOSTS` deve listar, separados por vírgula, os hosts DevCore
recebidos em X-Forwarded-Host/Host. Outros hosts ficam no grupo "outros". Não
inventar esse valor: o administrador conhece o gateway dos clientes. Se houver
mais de um llama.cpp, selecionar explicitamente a porta monitorada. A imagem deve
ter tcpdump e permissão CAP_NET_RAW para captura HTTP interna; não precisa estar
no caminho do tráfego. Não adicionar um proxy à inferência nem reiniciar o modelo.
Tráfego TLS entre gateway e modelo não é decodificado: nesse caso configurar uma
fonte de métricas de acesso equivalente, em vez de apresentar zeros como coleta.

O processo de captura próprio possui lease de aprovação de 45 s. Falha de status,
autenticação, pending/revoked ou encerramento param somente seu grupo de processos.
Se o supervisor morrer, o guardião encerra a captura ao expirar o lease, incluindo
os filhos tcpdump. A fonte legada independente não é encerrada pelo agente.

São reutilizados como bibliotecas, em cópias byte a byte, os coletores homologados
`request_metrics_core.py` e `http_capture_core.py`; os arquivos originais da POC
Theós não foram modificados. Nenhum envio legado é feito pelo coletor próprio.
Prompts, respostas e cabeçalhos de autenticação não são gravados. Arquivos locais
de requisições ficam no diretório privado de estado, com retenção de 45 dias.
Identificadores de origem são pseudonimizados por HMAC da identidade da POD antes
da transmissão; não equivalem a contas de pessoas e NAT pode agrupar usuários.

O Monitor recebe resumo diário, percentis, gráficos e retratos ao vivo; o servidor
persiste histórico diário com retenção padrão de 90 dias (configurável 1–400).
Limites de captura, fonte inexistente, fonte atrasada ou sem autorização produzem
estado indisponível, nunca números artificiais. A primeira captura leva até um
ciclo para gerar o retrato; confirme status antes de homologar o template.
