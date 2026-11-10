# MultiCortex DevCore Monitor — instalação do agente no template RunPod

Kit v3 · agente 2.2.0 · Linux com Python 3.6+ · sem dependências Python externas.

Depois destes passos, **toda POD criada a partir do template já sobe com o agente
rodando**. O agente se cadastra sozinho no Monitor e começa a enviar métricas assim
que a MultiCortex autoriza a POD no painel. Não é preciso SSH, terminal ou nenhum
comando dentro da POD.

## O que você recebe

- `devcore-universal-agent-template-v3.zip` (e o `.sha256` para conferir o arquivo).
- Um **token de inscrição** (64 caracteres), enviado em separado por canal seguro.
  Ele não é senha de painel nem chave da RunPod; serve apenas para a POD pedir
  cadastro. Cada POD ainda precisa ser aprovada pela MultiCortex.

## Passo 1 — Imagem do template (Dockerfile)

1. Extraia o ZIP na mesma pasta do Dockerfile do template. Deve aparecer a pasta
   `devcore-universal-agent-template-v3/`.
2. Copie para o **final** do Dockerfile o conteúdo de `Dockerfile.example`. Ele:
   - instala `python3` e `tcpdump` (bloco openSUSE ou Debian/Ubuntu);
   - instala o agente em `/opt/multicortex/devcore-universal-agent`;
   - define o endereço do Monitor;
   - inicia o agente antes do comando original do template.
3. Confira o ENTRYPOINT original da imagem base e ajuste a última linha se não for
   `/entrypoint.sh`:

   ```sh
   docker inspect <imagem-base> --format '{{json .Config.Entrypoint}} {{json .Config.Cmd}}'
   ```

   Se a imagem base tiver `CMD`, repita esse `CMD` no Dockerfile (trocar ENTRYPOINT
   apaga o CMD herdado). O modelo, SSH e Jupyter continuam iniciando como antes; se o
   agente falhar, o modelo sobe do mesmo jeito.
4. Gere e publique a imagem como de costume.

Alternativa ao ENTRYPOINT: se o template já tem um script de inicialização próprio,
basta acrescentar esta linha **antes** do comando que inicia o modelo, em vez do item 3:

```sh
python3 /opt/multicortex/devcore-universal-agent/template_boot.py || echo '[multicortex] agente não iniciou' >&2
```

## Passo 2 — Template na RunPod

1. Em **Secrets**, crie o secret `multicortex_bootstrap` com o token de inscrição.
2. No template, em **Environment Variables**, acrescente:

   | Variável | Valor |
   | --- | --- |
   | `MULTICORTEX_BOOTSTRAP_TOKEN` | `{{ RUNPOD_SECRET_multicortex_bootstrap }}` |

3. Mantenha a porta HTTP do modelo exposta como hoje (ex.: `7080`).

Nada mais é necessário. O agente descobre sozinho:

- o ID da POD (`RUNPOD_POD_ID`, fornecido pela RunPod);
- o servidor llama.cpp e a porta em uso;
- o endereço do proxy da RunPod usado pelo DevCore
  (`<ID-da-POD>-<porta>.proxy.runpod.net`), para contar as requisições.

## Passo 3 — Conferir numa POD nova

Suba uma POD com o template e avise a MultiCortex. Para conferir pelo terminal da POD
(opcional):

```sh
cat /root/devcore-agent-state/$RUNPOD_POD_ID/agent.log 2>/dev/null || cat /workspace/devcore-agent-state/$RUNPOD_POD_ID/agent.log
```

Esperado: `Estado: pending` até a aprovação no painel; depois, `Telemetria enviada`
a cada 30 segundos.

## Ajustes opcionais (variáveis do template)

| Variável | Quando usar |
| --- | --- |
| `MULTICORTEX_LLAMA_PORT` | Mais de um llama.cpp na POD: porta a monitorar. |
| `MULTICORTEX_DEVCORE_HOSTS` | Hosts DevCore diferentes do proxy RunPod (separados por vírgula). |
| `MULTICORTEX_CAPTURE_ENABLED=0` | Desligar a contagem de requisições (mantém GPU e llama.cpp). |
| `MULTICORTEX_AGENT_STATE_DIR` | Caminho absoluto exclusivo da POD para o estado do agente. |

## Segurança e funcionamento

- O token fica só no secret da RunPod; nunca na imagem, no Dockerfile ou no Git.
  O agente grava sua configuração em diretório 0700, arquivos 0600, e não repassa o
  token ao processo do modelo.
- Cada POD gera identidade e credencial próprias. Não copie
  `devcore-agent-state/` de uma POD para outra nem para dentro de imagens.
- Sem aprovação no painel não há coleta nem envio de métricas. Revogar no painel
  interrompe a coleta.
- A contagem de requisições lê apenas **cabeçalhos HTTP** do tráfego da porta do
  modelo (via tcpdump, que precisa de `CAP_NET_RAW`, padrão para root na RunPod).
  Prompts e respostas não são lidos nem gravados.
- O agente só faz conexões HTTPS de saída para o Monitor; não abre portas.
- Estado em `/workspace/devcore-agent-state/<ID>` quando `/workspace` existe (volume
  persistente: reinício mantém a mesma identidade e aprovação); caso contrário em
  `/root/devcore-agent-state/<ID>`. POD recriada = POD nova, que precisa de nova
  aprovação.
- Logs: `agent.log` no diretório de estado, rotacionado (3 × 1 MiB).
