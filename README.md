# CortaKi v10 — Security Foundation + Local Database

Esta versão substitui a lógica financeira/antifraude crítica do protótipo por uma API server-side com SQLite local e entrega o schema canônico para Supabase/PostgreSQL.

## O que foi corrigido

- Preço e duração são calculados no servidor.
- Serviço precisa estar realmente disponível para o barbeiro escolhido.
- Duração dos serviços entra no conflito de agenda.
- Banco impede dupla reserva concorrente do mesmo barbeiro.
- Idempotência para criação de agendamento e saque.
- UUID em vez de `Date.now()` para entidades críticas.
- CortaKi Protege usa CSPRNG + hash do código no backend.
- Cinco tentativas de código e bloqueio temporário.
- Check-in de cliente e barbeiro no servidor.
- `IN_SERVICE` só depois de código/presença válidos.
- `COMPLETED` só a partir de `IN_SERVICE`.
- Liquidação financeira ocorre uma única vez.
- Ledger financeiro é append-only no desenho de produção.
- Saldo disponível desconta saques pendentes/processando/pagos.
- Barbeiro autônomo e barbearia possuem beneficiários separados.
- Comissão é aplicada antes da distribuição e deve existir para atendimentos de barbearia.
- Chat crítico usa autorização por appointment na API.
- Auditoria registra operações sensíveis.
- RLS e funções de autorização estão no migration SQL.
- Payout/conta bancária não é fingido como integração real.
- Autenticação/KYC/pagamento real não são ativados sem os fornecedores que você informou que ainda não possui.

## Rodar

Requer Node.js 22+.

```bash
npm start
```

Abra:

- `http://127.0.0.1:4173/`
- `http://127.0.0.1:4173/dev-console.html`

## Testes

```bash
npm run test:security
```

O conjunto atual testa 15 regras críticas, incluindo conflito de agenda, idempotência, código inválido/válido, liquidação, ledger e tentativa de double-spend no saque.

## Identidade de teste

Como você ainda não possui um provedor de autenticação, o servidor local aceita `X-Dev-User-Id`. Isso existe **somente em desenvolvimento**.

Identidades:

- `customer-1`
- `barber-1`
- `barber-2`
- `barber-3`
- `shop-admin-1`
- `admin-1`

Em `NODE_ENV=production`, sem autenticação real, a API exige autenticação e não aceita esse mecanismo.

## Supabase

Use `supabase/migrations/001_cortaki_hardened.sql` como schema canônico para um projeto novo. Ele usa Supabase Auth, RLS, `btree_gist` e exclusão de sobreposição de agenda.

Não coloque `service_role` no frontend.

## Integrações que ficam aguardando seus fornecedores

### Autenticação
Estrutura pronta para Supabase Auth. Não foi criada uma empresa/provedor externo fictício.

### Pagamento
Existe `payments`, eventos de estado e adapter local. O pagamento real só deve ser considerado `PAID` após webhook autenticado do PSP.

### Banco / payout
Existe `payout_accounts` e `payouts`. Não existe conta bancária real cadastrada. Portanto o saque local é apenas simulação operacional.

### KYC
Existe `identity_verifications`. Nenhum documento ou selfie é enviado para fornecedor enquanto o provider não estiver configurado.

## Regra de ouro
O frontend nunca é a autoridade para dinheiro, permissão, status, disponibilidade, código de segurança ou propriedade de recurso.
