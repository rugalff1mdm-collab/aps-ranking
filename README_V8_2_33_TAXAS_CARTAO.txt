V8.2.33 — TAXAS DE CARTÃO POR PLATAFORMA

- Adicionadas as plataformas PayUP, Cielo, Mercado Pago, PayPi, Dom Pagamentos e Best4Send.
- 1x e à vista: 0% de desconto, conforme orientação do usuário.
- 2x a 12x: taxa específica de cada plataforma conforme a planilha Taxa Maquininha ATUALIZADA.
- O valor bruto é informado pelo consultor; o sistema calcula automaticamente taxa, desconto e valor líquido.
- O valor líquido é salvo em sales.amount e usado no ranking.
- O bruto permanece em sales.gross_amount e continua sendo usado nas premiações.
- Mercado Pago 12x permanece indisponível porque a planilha não informa taxa para 12x.
- Vendas antigas sem plataforma continuam preservadas; ao corrigir uma venda antiga, a plataforma pode ser informada para recalcular o líquido.
