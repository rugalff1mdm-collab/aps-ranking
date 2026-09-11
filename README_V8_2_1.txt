APS SOLUÇÕES - Ranking V8.2.1

Correção desta atualização:
- Corrigido o erro de parâmetros do Analytics (bySource/byState) que causava "bind message supplies 4 parameters, but prepared statement requires 6".
- Corrigida a ordem de criação da tabela prize_rules para instalações novas do banco.
- Mantidas as funcionalidades de premiações mensais e cálculo sobre as vendas existentes.
- Nenhuma rotina de exclusão ou reset de dados foi adicionada.

Deploy:
1. Substitua os arquivos do projeto no GitHub pelos desta pasta.
2. NÃO envie .env com senhas. Use as variáveis do Render.
3. Faça commit e aguarde o Auto-Deploy.
