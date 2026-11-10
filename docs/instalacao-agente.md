# Instalação do agente nas PODs

Duas formas, com o mesmo agente (2.2.0, kit v3). Em ambas, a POD aparece no painel
como **Aguardando aprovação**; a coleta começa quando ela é autorizada.

O agente se configura sozinho em POD RunPod: identifica a POD (`RUNPOD_POD_ID`), o
llama.cpp e a porta, e conta as requisições pelo host do proxy RunPod
(`<ID>-<porta>.proxy.runpod.net`, que chega no `X-Forwarded-Host`). Não é preciso
informar host, porta nem ligar a captura.

## 1. POD já criada: um comando no PC

Recebeu o SSH do administrador? Na raiz deste repositório, no PC:

```sh
scripts/instalar-agente-pod.sh ssh 4vtw3ny63c0ucm-64411d48@ssh.runpod.io -i ~/.ssh/id_ed25519
```

(É o SSH recebido, colado depois do nome do script.) Em 1–3 minutos o script:

1. lê o token de inscrição no EC2 (`.env.release`), sem mostrar na tela;
2. instala `python3` e `tcpdump` na POD (zypper, apt, dnf/yum ou apk);
3. envia o pacote pelo próprio SSH (o proxy da RunPod não tem scp), confere hashes e
   instala em `/opt/multicortex/devcore-universal-agent`;
4. grava o token (0600) e `/opt/multicortex/start-agent.sh`, inicia o agente e mostra
   o **Agent ID**.

Depois: painel → POC → **PODs e autorizações** → vincular e **Autorizar monitoramento**.

- Rodar de novo é seguro: atualiza o código se mudou e reinicia, mantendo identidade
  e aprovação (a versão anterior fica em `…/devcore-universal-agent.bak-<data>`).
- **POD reiniciada** (sem systemd, nada sobe sozinho): rode o mesmo comando, ou na
  POD `sh /opt/multicortex/start-agent.sh`.
- **POD recriada** = POD nova: rode o comando e autorize de novo.
- Sem acesso ao EC2: `MULTICORTEX_BOOTSTRAP_FILE=<arquivo 0600 com o token>`.

## 2. Template: o administrador instala uma vez na imagem

Enviar ao administrador da infra:

- `artifacts/devcore-universal-agent-template-v3.zip` e o `.sha256`;
- o token de inscrição, **em separado** e por canal seguro.

O guia do administrador é o `README.md` dentro do ZIP: acrescentar o
`Dockerfile.example` ao Dockerfile do template e criar na RunPod o secret
`multicortex_bootstrap` com a variável
`MULTICORTEX_BOOTSTRAP_TOKEN={{ RUNPOD_SECRET_multicortex_bootstrap }}`. A partir daí
toda POD criada pelo template já sobe com o agente, inclusive após reinícios.

## Manutenção

- Gerar o pacote após mudar o agente: `python3 scripts/package-universal-agent.py`
  (ZIP reprodutível; o `.sha256` é regravado).
- Testes do agente: `python3 -m unittest discover -s infra/devcore-universal-agent/tests`.
- Script executado dentro da POD: `infra/devcore-universal-agent/pod-install/remote-install.sh`.
