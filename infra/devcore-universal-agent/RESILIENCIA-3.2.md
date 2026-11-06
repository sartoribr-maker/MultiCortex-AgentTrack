# Etapa 3.2 — resiliência e recuperação

Implementação local, sem deploy ou acesso ao Monitor Central real.

## Arquitetura e autorização

O supervisor carrega UUID, chave de inscrição e credencial persistidos. O registro
reutiliza sempre UUID/chave; após confirmação válida do registro, cada ciclo
consulta status antes da coleta. Somente `approved` permite coleta detalhada.
JSON inválido, campos ausentes, estados desconhecidos ou falhas HTTP suspendem o
ciclo. `pending` exclui a credencial; `revoked` exclui a credencial e encerra o
supervisor. Falhas de comunicação não removem a credencial.

SIGINT/SIGTERM sinalizam um Event, interrompendo esperas. Há verificações antes
das operações e depois da coleta. Uma operação já iniciada termina sob seu timeout;
não se inicia outra após observar o sinal. Não há fila de telemetria: a recuperação
consulta status e envia uma amostra nova.

## Retentativas e erros

- GET de status e POST de registro: até quatro tentativas, timeout de 10 segundos
  por chamada e esperas interrompíveis de 1, 2 e 4 segundos.
- DNS, conexão recusada, timeout e HTTP 408/429/500/502/503/504 são transitórios.
- Ciclos malsucedidos aguardam 30, 60, 120, 240 e no máximo 300 segundos; um ciclo
  bem-sucedido restaura a espera normal de 30 segundos.
- HTTP 400/401/403/404/409 e demais códigos não transitórios não têm repetição
  interna e impõem espera de pelo menos 300 segundos. O agente continua consultando
  o mesmo endpoint/identidade, permitindo correção administrativa sem novo cadastro.
- JSON inválido e respostas inconsistentes bloqueiam o ciclo com backoff externo.
- Falha local de coleta descarta a amostra e aguarda novo ciclo/status.
- Configuração HTTPS/bootstrap e estado local inválidos na inicialização encerram
  com mensagem sanitizada. Não se tenta reparar identidade ou credenciais inseguras.
- Logs não incluem corpos de erro, exceções, chaves, tokens ou cabeçalhos.

## Semântica real do backend e POSTs

Analisados `src/lib/devcore/agent-registry.ts` e os endpoints `enroll`,
`status/[id]`, `[id]/credential` e `[id]/telemetry`.

Registro é idempotente para UUID/chave iguais. O 409 do registro pode indicar
conflito de identidade OU indisponibilidade do registry (incluindo lock): não é
prova de erro permanente. Repete-se com a identidade original e espera longa.
Status retorna apenas `status`; 401 significa identidade/chave não reconhecida,
sem provar revogação. Não se exclui a credencial por 401.

Credencial é emitida uma única vez; o servidor guarda apenas seu hash. O mesmo 401
pode significar ausência de aprovação, chave incorreta OU credencial já emitida.
Por isso, esse POST não tem retentativas automáticas. Antes da chamada, o agente
persiste `credential-attempted` (0600, fsync do arquivo/diretório). Sem token local,
a presença desse marcador impede nova emissão inclusive após reiniciar. Resposta
perdida, token inválido ou falha ao salvar exigem recuperação administrativa.
Mesmo uma falha anterior ao envio pode deixar o marcador: é uma escolha conservadora.
Com token válido persistido, o marcador não interfere na operação normal.

Telemetria retorna 204 e não oferece deduplicação: não se repete o POST internamente.
Na falha transitória, o próximo ciclo confirma status e envia amostra nova.
401/403 de telemetria bloqueiam novas coletas/envios; o marcador persistente
`telemetry-auth-blocked` mantém o bloqueio após reinicialização. Status continua
sendo consultado para detectar revogação. Não há rotação ou cadastro alternativo.

## Recuperação administrativa e limites

Não existe recuperação automática de token perdido no protocolo atual. Proposta
futura: operação administrativa explícita e auditada para reemissão, ou protocolo
idempotente com recuperação segura da mesma emissão. Nenhum bypass foi implementado.
Após investigação, um administrador deverá coordenar nova aprovação/reset no servidor
e recuperação dos marcadores locais. Reaprovar no backend invalida o hash anterior;
portanto apenas apagar marcadores ou reiniciar não basta. O agente não executa esses
procedimentos automaticamente nem altera credenciais reais.

A aprovação é confirmada antes de cada coleta; uma revogação ocorrida durante a
coleta será rejeitada pelo endpoint de telemetria e detectada no próximo status.
Chamadas HTTP em andamento e comandos de coleta existentes não são cancelados pelo
Event. Não há jitter, suporte a Retry-After, coordenação entre múltiplos supervisores
usando o mesmo diretório, nem buffer de amostras. Usar apenas um supervisor por estado.
Os testes executam no Python disponível; compatibilidade 3.6 foi preservada na
sintaxe/API do código do agente, mas não validada em interpretador Python 3.6 real.

## Validação local

Executado em 2026-11-06, sem requisições a endpoints reais:

```sh
python3 -m compileall -q infra/devcore-universal-agent
python3 -m unittest discover -s infra/devcore-universal-agent/tests
python3 -m unittest discover -s infra/devcore-vm-agent/tests
```

Resultado: 52 testes do Universal Agent (31 anteriores + 21 novos), 39 testes do
agente de VM; todos aprovados. Compilação aprovada. Os novos testes incluem matriz
HTTP com subcasos, retomada de status e telemetria, falhas sucessivas, emissão com
resposta perdida, recuperação de identidade/token em processos independentes,
permissões, logs sanitizados e simulação direta dos handlers SIGINT/SIGTERM.
Os testes integrados simulam transporte e coleta usando mocks; não homologam
TLS, sinais entregues pelo sistema operacional ou o backend Next.js em execução.

## Próxima etapa: homologação 3.3

1. Em ambiente de teste autorizado no RunPod, validar restart com estado persistente.
2. Interromper/restaurar conectividade e confirmar retomada sem nova identidade.
3. Revogar administrativamente e confirmar exclusão da credencial/bloqueio de coleta.
4. Validar sinais reais, timeout de coleta, TLS e logs do serviço.
5. Homologar procedimento administrativo para emissão perdida e autenticação inválida.

A POC Theós e os endpoints do backend não foram modificados nesta etapa.

## Gerenciador de execução na POD

`agent_service.py` usa somente biblioteca padrão e sintaxe Python 3.6. Oferece
`configure`, `start`, `run`, `status` e `stop`. `configure` persiste URL/bootstrap
exportados em `service-config.json` (0600), no diretório de estado (0700), sem
sobrescrever uma configuração existente. Esse arquivo contém um segredo e não deve
ser compartilhado. Identidade e credencial operacional existentes são preservadas.
`start` cria sessão independente do SSH; `run` mantém flock exclusivo, PID e logs
rotativos (`agent.log` + 3 backups de 1 MiB), com permissão 0600. `stop` verifica a
linha de comando do processo antes de sinalizar SIGTERM; a operação em andamento
pode terminar antes da parada. A trava protege instâncias deste gerenciador: parar
primeiro qualquer supervisor iniciado diretamente pelo terminal.

Não instala hook de boot nem relança após revogação/erro fatal. Para boot, integrar
`MULTICORTEX_AGENT_STATE_DIR=/workspace/devcore-agent-state python3
/workspace/devcore-universal-agent/agent_service.py start` ao script existente da
POD, preservando os comandos do llama.cpp. A persistência de `/workspace` depende
do armazenamento configurado na POD e ainda deve ser confirmada.

Validação: 58 testes do agente aprovados (6 novos do serviço com subprocessos
fictícios, sem rede real), incluindo início destacado, duplicação, parada, PID
obsoleto, configuração persistente sem variáveis da sessão original, permissões e
rejeição de symlink. Sintaxe 3.6 e compilação verificadas. Execução real do
complemento na POD ainda pendente. Pacote complementar publicado com autorização explícita em
https://devcore.multicortex.com.br/agenttrack/downloads/devcore-agent-service.zip.
SHA256: f0d4403c4e08467a6a51bfafd8c62c0947ddb6eb2694a2696478bd3724f67045.
Download HTTPS, integridade e conteúdo verificados.
