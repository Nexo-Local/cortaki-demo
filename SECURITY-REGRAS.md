# CortaKi — regras endurecidas (v10)

## O que agora é autoridade
- Banco/backend: preço, duração, disponibilidade, status, pagamento, comissão, saldo, saque, código Protege e permissões.
- Frontend: somente interface, intenção do usuário e cache não sensível.
- `localStorage`: tema/preferências locais. Não é fonte financeira nem de segurança.

## Máquinas de estado
### Atendimento
`REQUESTED → CONFIRMED → ON_THE_WAY → CHECKED_IN → IN_SERVICE → COMPLETED`
Estados laterais: `CANCELLED`, `NO_SHOW`, `DISPUTED`.

### Pagamento
`PENDING → AUTHORIZED → PAID → HELD/REFUNDED/CHARGEBACK/FAILED`.

### Saque
`REQUESTED → UNDER_REVIEW → APPROVED → PROCESSING → PAID`.
Falhas: `FAILED`, `REVERSED`, `CANCELLED`.

## CortaKi Protege
1. Código é criado no servidor com CSPRNG.
2. Apenas o hash é persistido.
3. Máximo de 5 tentativas.
4. Bloqueio de 15 minutos após 5 falhas.
5. Check-in do cliente e barbeiro são registrados no servidor.
6. Código válido + presença válida permitem `IN_SERVICE`.
7. Só `IN_SERVICE` pode virar `COMPLETED`.
8. Liquidação financeira acontece uma vez, por idempotência.

## Agenda
- Preço e duração são recalculados pelo servidor.
- Serviço precisa estar ativo e disponível para o barbeiro escolhido.
- Duração total = soma dos serviços.
- Conflito é bloqueado no banco com range exclusion.
- Agendamento futuro não depende de `online_now`.
- `online_now` é somente para CortaKi Flash.

## Dinheiro
- Centavos inteiros.
- Ledger imutável.
- Correção financeira = reversão, nunca edição retroativa.
- Taxa da plataforma é congelada no atendimento.
- Comissão é congelada no atendimento.
- Saldo disponível desconta saques `REQUESTED`, `UNDER_REVIEW`, `APPROVED`, `PROCESSING` e `PAID`.
- Barbeiro autônomo pode ter payout próprio.
- Barbearia tem payout próprio.
- Nenhuma chave Pix/conta bancária é aceita como prova de pagamento.

## O que continua pendente por falta dos seus fornecedores
- Provedor de autenticação/identidade: estrutura pronta, integração não ativada.
- Provedor de pagamento/PIX: estrutura pronta, integração real não ativada.
- Conta bancária/conta de recebimento da empresa: não configurada; saques reais ficam bloqueados.
- Provedor de KYC facial/documental: tabela e fluxo preparados, fornecedor ainda não configurado.

## Regra de produção
O servidor local usa `x-dev-user-id` apenas para testes. Em `NODE_ENV=production`, sem autenticação real, a API responde `AUTH_REQUIRED`. Nunca publicar o modo demo.
