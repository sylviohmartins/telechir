# G1-C — Host de leitura explícita, política local e auditoria limitada

**Data:** 2026-10-14 (America/Sao_Paulo)  
**Status:** em validação de CI final; não é a conclusão do gate G1-C.  
**Issue:** [#82](https://github.com/sylviohmartins/telechir/issues/82)  
**PR:** [#90](https://github.com/sylviohmartins/telechir/pull/90)

## Entrega

A CLI mantém `serve <https-origin>` com executor `DenyAllHostExecutor` por padrão. O novo comando **opt-in separado** `serve-readonly <https-origin> <absolute-root>` seleciona explicitamente uma única raiz de filesystem válida, existente e canonicalizada, e habilita um executor **somente de leitura** para `fs.list`, `fs.stat`, `fs.read`, `fs.search`, `git.status` e `git.diff` (seis operações).

As outras **17 de 23** operações são negadas antes de chamar o executor, incluindo alterações de filesystem, shell, processos, browser, screen e input. A permissão solicitada deve ser exatamente `FS_READ`; `workspace_id`, `approval_id`, `idempotency_key` e níveis `HIGH/CRITICAL` são recusados neste modo conservador. Não existe aprovação remota capaz de elevar o limite read-only.

O wrapper utiliza o `LocalCommandExecutor` existente, com `FilesystemPolicy` para roots/junctions/symlinks, `LocalPolicyEngine` para autorização e validações de Git sem hooks externos. A chamada autorizada só pode ser executada **uma vez**, por comparação com o comando preparado. `execute()` direto continua fail-closed. O identificador do comando é hash SHA-256, e uma janela limitada de 1.024 IDs detecta replay inclusive através de reconnects na mesma instância de executor.

Uma fila local de no máximo 256 eventos registra operação, decisão, instante UTC e digest do command_id, sem armazenar argumentos ou caminhos em texto puro. **Esta fila é volátil e não constitui auditoria durável**; ela precisa de sink confiável/integração de evidências no próximo incremento. A execução foreground continua voluntária e `ctrl+c` encerra a sessão; nenhum serviço, autostart ou credencial é criado automaticamente.

## Critérios técnicos e negativos

- [ ] CI Windows compilação, Rustfmt, Clippy, testes e bootstrap seguro no último commit do PR.
- [ ] Teste real de `fs.list` em diretório temporário autorizado.
- [ ] Recusa de comandos de escrita e de todas as operações privilegiadas.
- [ ] Leitura negada fora do root; canonicalização e políticas da camada filesystem permanecem em vigor.
- [ ] Rejeitar `approval_id`, `workspace_id`, permissão `FS_WRITE` e risco `HIGH`.
- [ ] Rejeitar replay e qualquer chamada a `execute_authorized` sem autorização válida/pendente.
- [ ] Testar limite de 256 eventos e ausência de raw arguments/path/IDs no `Debug` da auditoria.
- [ ] PowerShell preflight: missing-root/relative-root/HTTP externo sem acessar keyring ou rede.
- [ ] CI do control plane e cliente OAuth/Keycloak sem regressões no último SHA.

## Limites para encerramento

**G1-C não será encerrado por este incremento.** Faltam auditoria durável, verificação da integração de política/approvals no contexto da sessão realtime, testes de negativa e de execução read-only end-to-end no fluxo completo do Agent. O G1-D continuará responsável pelo aceite integrado em loopback, sem usar tokens simulados na fronteira real do produto.

**Sem alteração nas configurações do Avast:** build/teste Rust exclusivamente na CI Windows hospedada, não no computador pessoal.
