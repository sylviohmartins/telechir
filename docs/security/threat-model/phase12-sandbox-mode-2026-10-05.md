# Phase 12 Threat Model Delta — Sandbox Mode

**Data:** 2026-10-05

**Base:** threat model baseline + Phase 9 policy/approvals/audit + Phase 11 submission readiness.

**Escopo:** execução local opcional em Docker para `run_command` e `start_process`.

## Invariante central

> Sandbox reduz blast radius; não cria autoridade.

A cadeia continua exigindo:

1. caller autenticado;
2. ownership do device;
3. cloud governance;
4. permission/risk corretos;
5. approval quando necessário;
6. policy local final;
7. somente então seleção de `guarded_host` ou `sandbox`.

Se sandbox não estiver disponível, `execution_mode=sandbox` falha. Não existe downgrade automático para host.

## Trust boundaries novas

### Docker CLI configurado

O agent confia no binary Docker configurado localmente como componente do host.

Controles:

- path absoluto;
- arquivo existente;
- configuração explícita;
- `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_TLS_VERIFY` e `DOCKER_CERT_PATH` removidos;
- CLI usa `--context default`;
- Docker não é instalado/modificado pelo Telechir.

Risco residual: um binary/local daemon já comprometido invalida a contenção.

### Container image

A image é configuração local e precisa de referência imutável:

- `sha256:<digest>`; ou
- `repo@sha256:<digest>`.

Tags mutáveis são rejeitadas. `--pull never` impede fetch automático.

Risco residual: conteúdo malicioso continua possível mesmo com digest imutável. Digest fornece identidade/reprodutibilidade, não confiabilidade.

### Workspace bind

O único bind mount intencional é o `cwd` autorizado.

Antes de chegar ao Docker:

- caminho é resolvido/canonicalizado;
- deve estar dentro de root autorizado;
- sensitive paths são rejeitados.

No builder:

- source precisa ser absoluto e diretório existente;
- vírgula, aspas e control chars são rejeitados;
- target fixo é `/workspace`;
- `bind-propagation=rprivate`;
- `bind-recursive=disabled`.

Risco residual: o workspace é gravável e seus arquivos podem ser alterados/apagados pelo comando aprovado.

## STRIDE / abuse cases

### Fake sandbox / fallback para host

Ataque: solicitar `sandbox`, mas por erro executar no host.

Controles:

- enum explícito;
- runtime ausente -> `UNSUPPORTED_CAPABILITY`;
- cloud exige capability `sandbox.docker`;
- agent exige config sandbox antes do preflight/exec;
- spawn path de sandbox só constrói Docker `Command`;
- não há fallback para shell do host.

### Mode swap após approval

Ataque: obter approval para comando no sandbox e trocar para guarded host.

Controle:

- `execution_mode` vive nos argumentos normalizados;
- argument digest inclui todos os argumentos;
- approval é digest/command/session bound;
- teste explícito comprova deny após troca de modo.

### Permission widening

Ataque: usar sandbox para obter NETWORK, SECRET_USE, elevation ou Git write.

Controle:

- `SHELL_SAFE` permanece obrigatório;
- local shell policy rejeita SHELL_FULL, NETWORK, SECRET_USE, ELEVATION, ADMIN, GIT_WRITE e GIT_REMOTE_WRITE;
- sandbox não altera requested_permissions.

Observação: um comando aprovado pode conter ferramentas de rede, mas `--network none` impede conectividade externa normal. Isso não equivale a conceder PermissionDomain::NETWORK.

### Host shell injection na linha Docker

Ataque: command/string altera flags Docker no host.

Controle:

- `std::process::Command` recebe program/args separadamente;
- command do usuário é um único argumento depois da image e de `/bin/sh -lc`;
- nenhuma construção `docker ... <user command>` via host shell.

A sintaxe shell só é interpretada **dentro do container**.

### Docker socket / daemon exposure

Ataque: mount de `/var/run/docker.sock` ou equivalente.

Controle:

- command builder tem mount único e fixo do workspace;
- testes garantem ausência de `docker.sock`;
- nenhum device mount ou arbitrary volume flag é aceito.

### Privileged/capabilities

Ataque: container privilegiado ou capabilities de kernel adicionais.

Controles:

- `--cap-drop ALL`;
- `--security-opt no-new-privileges=true`;
- ausência de `--privileged`;
- ausência de `--cap-add`;
- rootfs `--read-only`.

### Host network

Ataque: container alcança rede/metadata service.

Controle:

- `--network none`;
- proxies zerados;
- nenhum host networking.

Residual:
- loopback do próprio namespace existe;
- vulnerability do runtime/kernel está fora da garantia;
- future explicit network sandbox não faz parte da Phase 12.

### Mutable/missing image

Ataque: tag muda ou image ausente dispara download.

Controles:

- digest obrigatório;
- `--pull never`;
- image ausente -> Docker falha;
- nenhum fallback.

### Resource exhaustion

Ataque: fork bomb/memory exhaustion/file descriptors.

Controles:

- bounded `--pids-limit`;
- bounded memory;
- bounded CPU;
- bounded tmpfs;
- bounded shm;
- nofile ulimit;
- core dump disabled;
- existing Telechir output rings/timeouts/concurrency limits permanecem.

Residual:
- workspace disk consumption não tem quota;
- daemon/kernel overhead continua compartilhado.

### Sensitive environment

Ataque: herdar token/proxy/credential do agent.

Controles:

- container só recebe env explicitamente configurado pelo builder;
- HOME/TMPDIR artificiais;
- proxy vars vazias;
- `env_refs` continuam fail-closed porque secret broker ainda não existe;
- nenhum credential é injetado automaticamente.

### Mount/path escape

Ataque: symlink/cwd fora de root, sintaxe `--mount` malformada ou submount escape.

Controles:

- canonicalização em FilesystemPolicy;
- root ownership local;
- sensitive path deny;
- source validation;
- comma/quote/control rejection;
- `bind-recursive=disabled`.

### Container escape

Ataque: exploit do container runtime/kernel.

Mitigações atuais:

- read-only rootfs;
- cap-drop ALL;
- no-new-privileges;
- no network;
- no devices/socket;
- resource limits.

Residual importante:

- Docker não é VM boundary;
- daemon rootful pode ampliar impacto de vulnerabilidade;
- rootless/userns/seccomp/AppArmor/SELinux dedicados são hardening futuro/configuração externa.

### Orphan container

Ataque/falha: agent/host crash deixa container vivo.

Controles:

- `--rm`;
- timeout/cancel cleanup nominal;
- container tem prefixo/label Telechir.

Residual:

- crash abrupto pode impedir cleanup;
- Phase 12 não possui startup reconciler/orphan sweeper.

### Cleanup failure

Ataque/falha: comando termina/cancela mas container permanece e API reporta sucesso.

Controles:

- timeout/force cancel exigem `rm -f`;
- graceful cancel usa `stop --time 1`;
- como todos os containers são `--rm`, stop bem-sucedido conclui lifecycle;
- stop falho tenta force-remove;
- falha de cleanup retorna erro e não sucesso.

### Malicious image

Ataque: image pinned contém payload hostil.

Controle parcial:

- containment profile acima.

Residual:

- image trust/signing/SBOM não está implementado;
- operador deve escolher image confiável;
- future Telechir sandbox image própria deve ser minimal/pinned/signed.

## Capability advertising

`sandbox.docker` só deve compor a lista anunciada quando config sandbox é válida.

O control plane não assume sandbox a partir de OS/agent version; exige capability explícita.

## Dados e auditabilidade

`execution_mode` aparece em resultados de process lifecycle para que:

- usuário saiba onde rodou;
- testes/audit possam distinguir host/sandbox;
- não exista falsa impressão de isolamento.

O nome interno do container não é exposto no output público.

## Prova de segurança executada

Além de testes fake-Docker, foi executada prova com Docker 28.1.1 local:

- image local por SHA;
- no pull;
- network none;
- rootfs write bloqueada;
- workspace read/write;
- sem eth0;
- auto-remove confirmado.

Isso não é pentest de container escape; é evidência de que o perfil declarativo funciona no daemon disponível.

## Gates que continuam fora do escopo

- rootless Docker obrigatório;
- userns-remap obrigatório;
- seccomp custom;
- AppArmor/SELinux profile dedicado;
- microVM;
- storage quota;
- image signing/provenance enforcement;
- startup orphan reconciler;
- network-enabled sandbox;
- secret broker.

## Conclusão

A Phase 12 adiciona isolamento útil sem alterar o princípio de autoridade local.

O sandbox deve ser descrito como **defense-in-depth**, não como execução de código arbitrário totalmente segura.
