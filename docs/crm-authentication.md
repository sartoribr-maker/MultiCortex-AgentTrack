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

Após o login e em cada requisição protegida, o monitor consulta `/auth/me` e
`/users/<id-do-próprio-usuário>`. A segunda consulta é necessária porque `/auth/me`
não retorna status da conta; o endpoint de usuários exclui cadastros removidos e
retorna uma projeção segura, sem hash de senha. Ambas as respostas devem confirmar
a identidade, perfil permitido e ausência de troca de senha obrigatória; a conta
também precisa estar ACTIVE. O perfil Administrador precisa conservar a permissão
`users.view` exigida pelo CRM para essa consulta. Nenhum outro cadastro é listado.

Se o usuário perder o perfil, for desativado/removido, precisar trocar senha ou a
API estiver indisponível, a próxima requisição protegida é negada. Não há fallback
para DEVCORE_USERS ou DEVCORE_ADMIN_EMAILS em modo CRM. O modo local permanece
apenas para instalações antigas/testes isolados, não para esta configuração de
produção. Cookies locais antigos não concedem acesso sem validação CRM.

O token CRM fica apenas no JWT criptografado do monitor, em cookie Secure,
HttpOnly, SameSite=Lax e restrito ao host devcore. Não é exposto na projeção pública
da sessão, HTML, props ou respostas das APIs do painel. Não adicionar handlers de
sessão que exponham os claims privados. Não armazenar senhas, tokens ou respostas
completas em logs. Requisições HTTPS recusam redirecionamentos e têm timeout.

A sessão do monitor dura até 15 minutos, limitada adicionalmente pela expiração do
token CRM; então é necessário entrar novamente. Tokens de refresh do CRM não são
encaminhados ao navegador nem reutilizados. Trocas obrigatórias de senha devem
ser concluídas no próprio CRM. Esta integração usa as mesmas credenciais, mas não
é login automático entre subdomínios: os cookies do CRM e do monitor são separados.

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
