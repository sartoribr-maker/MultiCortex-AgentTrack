# Autenticação do monitoramento pelo CRM

O monitor aceita o mesmo e-mail e senha da Plataforma CRM. O servidor do monitor
consulta `https://crm.multicortex.com.br/api/v1/auth/login` por HTTPS. Não copia
senhas ou hashes do CRM nem compartilha seu banco ou segredo de assinatura.

A configuração de produção usa:

```text
DEVCORE_AUTH_MODE=crm
DEVCORE_CRM_API_URL=https://crm.multicortex.com.br/api/v1
DEVCORE_CRM_ADMIN_ROLE_IDS=fc9d02d1-2697-45ba-9ba9-c272f584cc51
```

O identificador foi conferido em consulta somente de leitura aos perfis do CRM:
corresponde ao perfil **Administrador**, portal INTERNAL. Gestor Comercial,
Visualizador, Vendedor, Parceiro, Integração SITE, SDR e SDR Admin não recebem
acesso por essa regra. A permissão se baseia no ID do perfil, não em comparação
parcial de nomes nem numa lista de e-mails.

Após o login e nas requisições protegidas (no máximo uma vez por minuto por sessão,
ver "Sessão e renovação"), o monitor consulta `/auth/me` e
`/users/<id-do-próprio-usuário>`. A segunda consulta é necessária porque `/auth/me`
não retorna status da conta; o endpoint de usuários exclui cadastros removidos e
retorna uma projeção segura, sem hash de senha. Ambas as respostas devem confirmar
a identidade, perfil permitido e ausência de troca de senha obrigatória; a conta
também precisa estar ACTIVE. O perfil Administrador precisa conservar a permissão
`users.view` exigida pelo CRM para essa consulta. Nenhum outro cadastro é listado.

Se o usuário perder o perfil, for desativado/removido ou precisar trocar senha, o
acesso é negado em até 1 minuto e a sessão é encerrada. Se a API do CRM ficar
indisponível por mais de 5 minutos, a sessão também é encerrada. Não há fallback
para DEVCORE_USERS ou DEVCORE_ADMIN_EMAILS em modo CRM. O modo local permanece
apenas para instalações antigas/testes isolados, não para esta configuração de
produção. Cookies locais antigos não concedem acesso sem validação CRM.

## Sessão e renovação (desde 10/11/2026)

O cookie do monitor (JWT criptografado, Secure, HttpOnly, SameSite=Lax, restrito ao
host devcore) guarda apenas um identificador opaco de sessão. Os tokens do CRM (acesso
de 15 minutos e renovação de uso único) ficam somente na memória do servidor do
monitor: não vão para o navegador, HTML, props, respostas das APIs nem logs.

- Antes de o token de acesso vencer, o servidor o renova em `POST /auth/refresh`,
  apresentando o token de renovação como o cookie `refresh_token` do próprio CRM, e
  guarda o novo par (o CRM gira o token a cada uso). Requisições simultâneas
  compartilham uma única renovação.
- A sessão dura até **12 horas** desde o login. Termina antes se o CRM recusar a
  renovação, se o perfil/conta deixar de ser válido ou ao sair (o token de renovação
  é revogado em `/auth/logout`).
- A validação de perfil e status no CRM é reaproveitada por 60 s
  (`DEVCORE_CRM_REVALIDATE_SECONDS`). Falhas de rede ou 5xx do CRM mantêm por até
  5 minutos um administrador confirmado recentemente
  (`DEVCORE_CRM_OUTAGE_GRACE_SECONDS`); recusas explícitas (401/403/404/422 ou dados
  inválidos) encerram a sessão na hora.
- Reiniciar o contêiner do monitor encerra todas as sessões (é preciso entrar de novo).
- Sessão encerrada: as APIs respondem 401 e o painel volta ao login com
  "Sua sessão expirou". Sem perfil Administrador: 403.

Trocas obrigatórias de senha devem ser concluídas no próprio CRM. Esta integração usa
as mesmas credenciais, mas não é login automático entre subdomínios: os cookies do
CRM e do monitor são separados.

As APIs de inscrição/status/telemetria dos agentes continuam com suas próprias
credenciais e não dependem de sessão CRM. Não houve alteração no agente ou na POD.

## Validação

- Testes unitários: credenciais, perfil exato, status, identidade, expiração,
  troca obrigatória de senha, resposta inválida, URL insegura e indisponibilidade.
- Ensaio de navegador com CRM HTTPS fictício e certificado confiável: Admin entra;
  demais perfis, senha errada e credencial local são negados; rebaixamento e
  desativação bloqueiam sessão existente; segredo ausente de HTML/respostas/logs.
- Cookie local antigo, mesmo com assinatura válida, não permite acesso em modo CRM.
- CRM fora do ar bloqueia a interface, mantendo inscrição do agente independente.

Rodar `npm run test:e2e:crm` com Docker, Chromium/Playwright e imagem
`devcore-monitor:crm-candidate`. Fixtures usam usuários, senhas e volumes de teste;
nenhum usuário do CRM real é criado ou modificado.

## Publicação

Ativada em produção em 06/11/2026 às 19:30 (Brasília). Imagem
`sha256:9af6f405450553a3dd0b565802c04a3864cb7dd91e6a435ed79a70c0e38c450e`.
A configuração local DEVCORE_USERS/DEVCORE_ADMIN_EMAILS foi removida do ambiente
da instância ativa, além do bloqueio por código no modo CRM. Os cadastros do CRM
e o template/POD não foram modificados.

Backup consistente e rollback privado em
`/opt/multicortex/devcore-agenttrack/backups/crm-auth-20261106T223029Z`.
O rollback.sh restaura imagem/configuração anteriores, portanto retorna ao
mecanismo antigo de login local. Reservar para falha de implantação, não usar
como alternativa de acesso quando o CRM estiver indisponível.

195 testes unitários passaram (65 TypeScript e 130 Python), além de tipagem, lint,
ensaio HTTPS de autenticação e regressão completa de POCs em navegador.
A conectividade HTTPS real, a página pública de login e a negativa de acesso
anônimo foram verificadas. O login de uma conta real precisa ser feito pelo
próprio administrador com sua senha habitual do CRM; senhas não foram solicitadas
ou extraídas para teste.
