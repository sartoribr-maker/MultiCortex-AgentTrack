# MULTICORTEX — DEVCORE MONITOR UNIVERSAL AGENT
## MISSÃO: IMPLEMENTAÇÃO COMPLETA DA ETAPA 3.2 — RESILIÊNCIA, RECONEXÃO E RECUPERAÇÃO AUTOMÁTICA

### 1. PAPEL E AUTONOMIA

Você é um Engenheiro de Software Sênior, Arquiteto de Sistemas Distribuídos e Especialista em Python, Observabilidade, Segurança e Infraestrutura.

Atue como agente executor autônomo dentro do VS Code.

Sua missão é analisar o código existente, implementar integralmente a Etapa 3.2, criar os testes necessários, executá-los, corrigir falhas e entregar o projeto funcional e documentado.

**Não me peça para executar scripts manualmente.** Utilize suas ferramentas de edição, terminal e testes para realizar o trabalho.

Não interrompa a execução entre subetapas para solicitar autorização, desde que esteja operando exclusivamente no repositório local e respeitando as restrições de segurança.

Não declare sucesso sem evidências de testes.

### 2. CONTEXTO DO PROJETO

Empresa: MultiCortex

Produto: DevCore Monitor

Componente: Universal Agent

Diretório principal:

`/home/sartori/Multicortex/Projetos/DevCore_Track`

Diretório do agente:

`infra/devcore-universal-agent/`

Arquivo principal:

`infra/devcore-universal-agent/supervisor.py`

O Universal Agent foi desenvolvido para monitorar automaticamente ambientes computacionais, especialmente Pods com GPUs NVIDIA e servidores de inferência llama.cpp.

Sua arquitetura contempla:

- Descoberta automática de ambiente, Pod e GPU.
- Descoberta de servidores llama.cpp.
- Registro automático no Monitor Central.
- Aprovação administrativa obrigatória.
- Emissão de credencial operacional individual.
- Envio de telemetria.
- Revogação de acesso.
- Persistência segura de identidade e credenciais.
- Compatibilidade com Python 3.6+ utilizando preferencialmente a biblioteca padrão.

O Monitor Central possui uma interface de administração e APIs específicas para os agentes universais.

**IMPORTANTE:** existe uma implementação legada da POC Theós que não pode ser modificada, removida ou comprometida.

### 3. ESTADO ATUAL — FUNCIONALIDADES HOMOLOGADAS

#### Etapa 3.1 — Persistência segura

Concluída e homologada.

Funcionalidades implementadas:

- Persistência local da credencial operacional.
- Gravação atômica.
- Recuperação após reinicialização do processo.
- Permissões `0600` para credenciais.
- Permissões `0700` para diretório de estado.
- Preservação da chave de inscrição.
- Validação de formato e permissões.
- Rejeição de links simbólicos nos caminhos já protegidos.
- Exclusão da credencial operacional nos estados `pending` e `revoked`.

Resultados anteriores:

- 31 testes de regressão aprovados.
- Testes de persistência aprovados.
- Testes entre processos independentes aprovados.
- Testes de segurança aprovados.

Não reimplemente essas funcionalidades desnecessariamente.

#### Etapa 3.2.1 — Retentativas HTTP

Implementada e testada.

A função `api_request()` já possui:

- Timeout HTTP de 10 segundos.
- Até quatro tentativas.
- Backoff de 1, 2 e 4 segundos.
- Retentativas para HTTP 408, 429, 500, 502, 503 e 504.
- Retentativas para falhas temporárias de conexão.
- Sem repetição automática para HTTP 401 e 403.

Resultados anteriores:

- 5 testes de resiliência aprovados.
- 31 testes de regressão aprovados.

**Verifique o código real antes de assumir que esses recursos estão presentes.**

A última subetapa confirmadamente executada foi a 3.2.1. A implementação da 3.2.2 foi planejada, mas sua execução ainda não foi confirmada.

### 4. OBJETIVO DA ETAPA 3.2

Garantir que o Universal Agent continue operando de forma autônoma diante de falhas temporárias, sem perder identidade, credenciais ou estado de aprovação.

Implementar as seguintes subetapas integralmente:

#### 3.2.2 — Reconexão automática

Modificar o supervisor para:

1. Recuperar-se de indisponibilidades temporárias do Monitor Central.
2. Não encerrar definitivamente após esgotar as retentativas HTTP de uma operação.
3. Aguardar um intervalo apropriado antes de tentar novamente.
4. Continuar verificando o estado de aprovação.
5. Retomar o envio de telemetria após restabelecimento da conexão.
6. Preservar a identidade e a credencial operacional durante falhas temporárias.
7. Respeitar sinais SIGTERM e SIGINT, encerrando de forma controlada.
8. Evitar loops agressivos ou consumo excessivo de CPU.
9. Evitar que um erro temporário provoque novo registro como outro agente.
10. Não executar coleta detalhada enquanto o estado de aprovação não tiver sido confirmado.

Tratar adequadamente falhas no registro inicial e na consulta de status, preservando o princípio de falha segura.

#### 3.2.3 — Segurança e tratamento de erros

Implementar uma política clara para:

- Falhas de DNS.
- Conexão recusada.
- Timeout.
- HTTP 408.
- HTTP 429.
- HTTP 500, 502, 503 e 504.
- HTTP 400, 401 e 403.
- HTTP 404 e 409.
- Respostas JSON inválidas.
- Respostas incompletas ou inconsistentes.
- Credenciais operacionais inválidas.
- Revogação administrativa.
- Falhas locais de coleta.

Requisitos obrigatórios:

1. Nunca transformar um erro de autenticação em aprovação automática.
2. Nunca continuar enviando telemetria após revogação confirmada.
3. Não apagar a credencial por simples indisponibilidade de rede.
4. Não solicitar repetidamente novas credenciais quando já existe uma credencial operacional válida.
5. Não tentar contornar erros 401/403 por meio de novo cadastro ou rotação não autorizada.
6. Não registrar tokens, chaves ou cabeçalhos de autenticação nos logs.
7. Nunca executar coleta detalhada quando o agente estiver `pending`, `revoked` ou com estado desconhecido.
8. Se houver dúvida sobre a validade da autorização, suspender a coleta e aguardar uma confirmação válida.
9. Tratar erros permanentes de configuração separadamente das falhas transitórias.
10. Evitar qualquer mecanismo que permita burlar a aprovação administrativa.

**Atenção à semântica dos endpoints:** não assuma que HTTP 409 sempre representa erro permanente ou que HTTP 401 sempre significa revogação. Analise as implementações reais do backend e documente as decisões.

#### 3.2.4 — Testes integrados

Criar testes automatizados para os seguintes cenários:

**Cenário A — Falha temporária de rede**

- Agente aprovado.
- Monitor Central fica indisponível.
- Credencial permanece armazenada.
- Monitor Central volta.
- Telemetria é retomada.

**Cenário B — Falha durante consulta de status**

- A consulta falha.
- Nenhuma coleta detalhada é iniciada sem confirmação válida.
- O agente continua tentando.
- A operação é retomada após recuperação.

**Cenário C — Revogação**

- Agente aprovado.
- Administrador revoga o agente.
- Agente recebe status `revoked`.
- Credencial operacional é excluída.
- Coleta e envio de telemetria são interrompidos.

**Cenário D — Reinicialização**

- Agente possui identidade e credencial persistidas.
- Processo é reiniciado.
- Identidade original é recuperada.
- Credencial original é recuperada.
- Não ocorre nova emissão desnecessária.

**Cenário E — Erros HTTP**

Validar separadamente:

- 401.
- 403.
- 408.
- 429.
- 500.
- 502.
- 503.
- 504.

**Cenário F — Recuperação após falhas sucessivas**

- Simular várias falhas consecutivas.
- Verificar limites de retentativas e intervalos.
- Simular recuperação.
- Confirmar retorno à operação.

**Cenário G — Encerramento controlado**

- Simular SIGTERM/SIGINT de maneira segura.
- Confirmar que o agente não inicia novas operações após solicitação de encerramento.
- Confirmar que não há corrupção de arquivos persistidos.

**Cenário H — Segurança**

- Credenciais não aparecem em logs.
- Estados desconhecidos não autorizam coleta.
- Falhas de autenticação não provocam cadastro alternativo.
- Revogação impede telemetria.
- Credenciais não são removidas por falhas temporárias.

### 5. DIRETRIZES DE ARQUITETURA

Mantenha o projeto simples, modular e compatível com a infraestrutura existente.

Prioridades:

1. Preservar o protocolo atual.
2. Manter compatibilidade com Python 3.6+.
3. Utilizar biblioteca padrão sempre que possível.
4. Evitar dependências externas desnecessárias.
5. Não introduzir loops infinitos sem controle de interrupção.
6. Evitar alterações incompatíveis nas APIs.
7. Preservar a identidade persistente do agente.
8. Preservar a política de aprovação administrativa.
9. Não alterar o comportamento legado da POC Theós.

Considere se a política de retentativas deve ser aplicada de maneira diferente para consultas GET e operações POST.

**Não repita automaticamente operações POST sem avaliar idempotência e consequências de duplicação.**

Especialmente no endpoint de emissão de credencial, considere o risco de a operação ser concluída no servidor, mas a resposta não chegar ao agente. Não tente resolver isso criando outra identidade ou contornando a emissão única.

Se for necessária uma alteração no protocolo para recuperar uma credencial perdida, documente a proposta e não implemente um bypass administrativo.

### 6. ESCOPO PERMITIDO

Você pode:

- Ler e analisar os arquivos do repositório local.
- Editar o supervisor e módulos diretamente relacionados.
- Criar testes automatizados.
- Criar módulos auxiliares quando justificável.
- Executar comandos locais de desenvolvimento.
- Corrigir erros encontrados.
- Atualizar a documentação técnica.
- Criar backups locais.
- Executar verificações de sintaxe e regressão.

Você NÃO pode:

- Modificar servidores de produção.
- Executar deploy.
- Alterar instâncias RunPod.
- Modificar configurações reais de GPU.
- Reiniciar servidores llama.cpp reais.
- Modificar a POC Theós.
- Alterar credenciais reais.
- Expor segredos.
- Excluir arquivos ou diretórios do projeto sem justificativa e autorização.
- Executar comandos destrutivos.
- Fazer `git push`.
- Criar commits sem autorização.
- Alterar arquivos de contexto preexistentes sem necessidade.
- Instalar dependências globalmente sem autorização.

### 7. METODOLOGIA DE EXECUÇÃO

Trabalhe autonomamente em um único ciclo de implementação.

**Fase 1 — Inspeção**

Analise:

- `supervisor.py`
- `discovery.py`
- `fallback_monitor.py`
- Módulos auxiliares.
- Testes existentes.
- APIs do Monitor Central relacionadas a registro, status, credenciais e telemetria.

Identifique o estado real do código.

**Fase 2 — Planejamento interno**

Defina a solução técnica e seus critérios de teste.

Apresente um resumo breve do plano e prossiga sem aguardar confirmação, desde que nenhuma restrição seja violada.

**Fase 3 — Implementação**

Implemente integralmente as subetapas 3.2.2 e 3.2.3.

Preserve a 3.2.1 e a 3.1.

**Fase 4 — Testes**

Execute:

- Compilação Python.
- Testes unitários.
- Testes integrados simulados.
- Testes de regressão.
- Testes de segurança.
- Testes de recuperação após falha.

Use mocks ou serviços locais simulados. Não envie requisições aos endpoints reais.

**Fase 5 — Correção**

Caso algum teste falhe:

1. Investigue a causa.
2. Corrija o problema.
3. Execute novamente os testes afetados.
4. Execute a regressão completa.
5. Repita até alcançar os critérios de aceite ou identificar um impedimento real.

Não esconda falhas.

**Fase 6 — Documentação**

Crie ou atualize a documentação da Etapa 3.2, incluindo:

- Arquitetura de reconexão.
- Política de backoff.
- Tratamento de erros.
- Estados de segurança.
- Fluxo de recuperação.
- Procedimentos de teste.
- Limitações conhecidas.
- Pendências para homologação real no RunPod.

### 8. CRITÉRIOS DE ACEITE

Considere a Etapa 3.2 concluída localmente somente quando:

- Todos os testes anteriores continuarem passando.
- Os novos testes de resiliência passarem.
- A identidade do agente permanecer estável.
- As credenciais persistirem durante falhas temporárias.
- A reconexão ocorrer automaticamente.
- A telemetria for retomada após recuperação.
- A revogação continuar funcionando.
- Nenhum segredo for exposto.
- Não houver alteração no legado Theós.
- O supervisor não encerrar definitivamente por simples indisponibilidade temporária do Monitor Central.
- A documentação estiver atualizada.

Se algum critério não for atendido, informe claramente que a etapa permanece pendente.

### 9. RELATÓRIO FINAL OBRIGATÓRIO

Ao concluir, apresente um relatório executivo e técnico contendo:

**MULTICORTEX — DEVCORE MONITOR UNIVERSAL AGENT**

**ETAPA 3.2 — RESULTADO DA IMPLEMENTAÇÃO**

1. Status geral: PASS, PARTIAL ou FAIL.
2. Subetapas concluídas.
3. Arquivos criados ou modificados.
4. Principais mudanças implementadas.
5. Quantidade de testes executados.
6. Quantidade de testes aprovados e reprovados.
7. Resultado dos testes de segurança.
8. Resultado dos testes de reconexão.
9. Confirmação de preservação da Etapa 3.1.
10. Confirmação de preservação da POC Theós.
11. Limitações e pendências.
12. Próxima etapa recomendada e suas subetapas.

Apresente evidências reais dos comandos executados e dos resultados obtidos.

### 10. INSTRUÇÃO FINAL

Você tem autorização para executar autonomamente todas as atividades de desenvolvimento, edição, teste e documentação necessárias à conclusão local da Etapa 3.2, dentro das restrições definidas.

Não gere uma sequência de scripts para que eu execute manualmente.

Não se limite a explicar como implementar.

**Implemente, teste, corrija, valide e documente.**

Comece agora pela inspeção do repositório e prossiga até entregar o relatório final da Etapa 3.2.