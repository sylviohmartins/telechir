# Conta e Dataset de Review

A conta de review deve ser dedicada à OpenAI e conter somente dados sintéticos.

## Identidade

O username/password são cadastrados **somente no portal de review**. Não versionar credential, token, cookie, recovery code ou MFA seed.

Requisitos:

- login disponível pela internet pública;
- sem VPN/rede corporativa;
- sem SMS/email code/magic link dependente de uma pessoa;
- sem MFA inacessível ao reviewer;
- permissões suficientes apenas para os casos declarados.

## Device

Criar um device sintético:

```text
Display name: Review Device
Authorized root: /workspace/review
```

Não usar workstation pessoal ou ambiente produtivo.

## Arquivos

`/workspace/review/hello.txt`:

```text
hello from telechir review
```

Criar `/workspace/review/sample-repo` como repositório Git local com pelo menos:

- um commit baseline;
- uma modificação unstaged previsível;
- um arquivo untracked sintético;
- nenhum remote com credential.

## Write case

Garantir que o reviewer possa solicitar:

```text
/workspace/review/phase11-review.txt
```

O arquivo pode ser removido/resetado entre execuções por um procedimento administrativo fora do plugin. O fluxo normal deve continuar exigindo a governança/approval prevista pelo Telechir.

## Process case

O caso positivo usa apenas:

```text
echo telechir-review
```

Não habilitar shell irrestrito para facilitar review.

## Negative cases

A conta/dataset não deve contornar:

- ausência de tool de delete;
- hard deny de executáveis/network authority;
- elevation/admin.

O comportamento esperado é refusal/limitation segura, não uma simulação de sucesso.
