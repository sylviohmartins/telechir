# Phase 12 — Revalidação Docker Sandbox

**Data:** 2026-10-05
**Escopo:** isolamento local opcional para `run_command` e `start_process`
**Status:** perfil mínimo revalidado e prova local executada; Docker continua boundary externo confiado

## Decisão

A primeira implementação de sandbox do Telechir usa Docker CLI local de forma explícita e opt-in.

Ela não transforma Docker em autoridade de policy. O fluxo permanece:

```text
OAuth/ownership
  -> cloud governance
  -> approval quando necessário
  -> agent local / policy final
  -> guarded_host OU Docker sandbox
```

O sandbox é uma camada adicional de contenção. Se não estiver configurado ou se Docker falhar, o Telechir **não** executa o comando no host como fallback.

## Revalidação oficial

A documentação oficial Docker consultada em 2026-10-05 sustenta as decisões centrais:

- bind mounts devem preferir `--mount`; diferente de `-v`, source inexistente falha em vez de ser criado silenciosamente;
- `bind-recursive=disabled` evita incluir submounts do source no bind;
- o network driver `none` isola o container de redes externas, preservando apenas loopback;
- rootless mode e user namespace remapping podem reduzir o impacto de comprometimento do daemon/container, mas são configuração do runtime/host e não devem ser ativados silenciosamente pelo Telechir.

Fontes:

- https://docs.docker.com/engine/storage/bind-mounts/
- https://docs.docker.com/engine/network/drivers/none/
- https://docs.docker.com/engine/security/rootless/
- https://docs.docker.com/engine/security/userns-remap/
- https://docs.docker.com/reference/cli/docker/container/run/

## Perfil Phase 12

O command builder produz argumentos diretamente para o Docker binary configurado; não usa shell do host para montar a linha Docker.

Perfil:

```text
docker --context default run
  --rm
  --name telechir-sbx-<uuid>
  --label com.telechir.sandbox=true
  --pull never
  --network none
  --read-only
  --cap-drop ALL
  --security-opt no-new-privileges=true
  --pids-limit <bounded>
  --memory <bounded>
  --cpus <bounded>
  --ulimit nofile=1024:1024
  --ulimit core=0
  --tmpfs /tmp:rw,nosuid,nodev,size=<bounded>
  --shm-size 64m
  --mount type=bind,source=<canonical-authorized-cwd>,target=/workspace,bind-propagation=rprivate,bind-recursive=disabled
  --workdir /workspace
  --env HOME=/tmp
  --env TMPDIR=/tmp
  --env HTTP_PROXY=
  --env HTTPS_PROXY=
  --env ALL_PROXY=
  --env NO_PROXY=
  --init
  <immutable-local-image>
  /bin/sh -lc <command>
```

Não são adicionados:

- `--privileged`;
- `--cap-add`;
- Docker socket;
- host network;
- host PID/IPC;
- devices;
- secrets;
- env do host;
- image pull automático.

## Image policy

A configuração aceita somente:

```text
sha256:<64hex>
repo@sha256:<64hex>
```

Tags mutáveis, inclusive `:latest`, falham na validação.

`--pull never` garante que uma image ausente não seja baixada automaticamente. Nesse cenário a execução falha; não há fallback para `guarded_host`.

O Telechir não instala Docker nem seleciona image automaticamente.

## Workspace

O `cwd` passa primeiro pelo `FilesystemPolicy.resolve_existing`, que:

- canonicaliza o caminho;
- exige que permaneça em root autorizado;
- rejeita sensitive paths.

Somente esse diretório canonicalizado é enviado ao Docker como source de `--mount`.

O builder também rejeita source não absoluto/inexistente e caracteres incompatíveis com a sintaxe segura adotada para `--mount` (vírgula, aspas e control chars).

O workspace é intencionalmente gravável. Portanto sandbox não significa filesystem descartável: um comando aprovado ainda pode modificar/apagar conteúdo dentro do workspace autorizado.

## Política e approvals

`guarded_host` mantém o classificador existente.

No modo `sandbox`:

- `SHELL_SAFE` continua obrigatório;
- NETWORK/SECRET_USE/ELEVATION/ADMIN/GIT_WRITE/GIT_REMOTE_WRITE não podem ser adicionados;
- comandos já permitidos no host seguem permitidos;
- comandos/sintaxe que seriam hard-denied no host tornam-se `APPROVAL_REQUIRED`, não ALLOW;
- approval é vinculado ao digest dos argumentos, que inclui `execution_mode`;
- mudar `sandbox` para `guarded_host` invalida o binding e falha fechado.

A ausência de `sandbox.docker` no device é bloqueada no control plane antes do dispatch.

## Lifecycle

Short command:

- Docker CLI é o processo filho gerenciado;
- timeout tenta `docker rm -f <name>` e encerra o processo CLI;
- cleanup não confirmado não é reportado como sucesso.

Managed process:

- `start_process` mantém o Docker CLI/stdio como processo gerenciado;
- read/write continuam no handle Telechir;
- list/read/cancel expõem `execution_mode`, mas não o nome interno do container;
- force cancel usa `docker rm -f`;
- cancel gracioso usa `docker stop --time 1`; como todos os containers são criados com `--rm`, stop bem-sucedido significa lifecycle removido;
- se stop falhar, o agent tenta `rm -f`; se também falhar, retorna erro.

## Prova local — Docker real

Ambiente:

```text
Docker client: 28.1.1
Docker server: 28.1.1
Host: PREDATORH300
Image local utilizada:
sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4
```

A prova usou a image Node 24 Bookworm já presente localmente, sem pull.

Foram verificados:

- workspace bind montado e legível;
- escrita dentro do workspace autorizada;
- tentativa de escrita em `/root` falhou sob rootfs read-only;
- loopback presente;
- `eth0` ausente com `--network none`;
- processo terminou com exit 0;
- arquivo esperado apareceu no workspace;
- nenhum container com o nome de prova permaneceu após `--rm`.

Resultado:

```text
RUN_EXIT=0
OUTPUT=sandbox-ok
REMAINING_CONTAINER=
```

Essa prova valida o perfil Docker contra o daemon local. Os testes Rust com fake Docker validam a montagem programática dos argumentos e lifecycle do Telechir.

## Hardening opcional fora da Phase 12

Recomendável para ambientes mais hostis:

- Docker rootless mode;
- userns-remap;
- daemon dedicado;
- sandbox image mínima própria e assinada;
- seccomp/AppArmor/SELinux profile dedicado;
- quotas de storage por workspace;
- reconciler de containers órfãos após crash;
- runtime alternativo de isolamento mais forte, se threat model futuro exigir.

Esses itens não são ligados automaticamente nesta fase porque são propriedades do host/runtime e podem quebrar workloads existentes.

## Riscos residuais

- Docker daemon rootful continua uma boundary privilegiada do host;
- uma vulnerabilidade de container/runtime pode permitir escape;
- image pinned pode ser maliciosa;
- workspace bind gravável permite efeitos destrutivos no workspace autorizado;
- storage consumido no bind não tem quota Phase 12;
- crash abrupto do agent/host pode deixar container órfão;
- `network none` não é uma promessa contra kernel/runtime compromise;
- `/bin/sh -lc` permite sintaxe shell dentro do container quando o comando foi autorizado/aprovado;
- esta fase não implementa VM/microVM isolation.

## Conclusão

O perfil é adequado como **sandbox local opcional de contenção para o MVP**, desde que a documentação não o apresente como boundary absoluta contra código hostil.

A autoridade final continua sendo policy + approval no agent; sandbox reduz blast radius, não substitui autorização.
