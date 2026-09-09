# APS SOLUÇÕES — Ranking de Vendas

Atualização do projeto existente, preservando a stack original (Node.js + Express + SQLite + frontend HTML/CSS/JS) e mantendo usuários, consultores e vendas existentes.

## Principais melhorias

- Identidade visual corporativa para **APS SOLUÇÕES / RANKING DE VENDAS**.
- Layout responsivo para computador, tablet, celular e tela grande/TV.
- Ranking por faturamento, com quantidade de vendas como segundo critério.
- Pódio de 1º, 2º e 3º lugar com fotos dos consultores.
- Painel de administrador com faturamento, vendas, meta, percentual da meta, leads e conversão.
- Painel de consultor com meta, vendido, falta para a meta, percentual, vendas e conversão próprios.
- Cadastro de venda com cliente, valor, data, estado e origem do lead.
- Origens armazenadas em tabela no SQLite; inicialmente **Daniel, Tom e Remalho**.
- Administrador pode criar, ativar e desativar origens.
- Gestão de leads com data, consultor, quantidade, origem e estado.
- Conversão real: **vendas ÷ leads × 100**.
- Análises por origem, estado e consultor.
- Filtros por mês, consultor, estado e origem.
- Administrador pode excluir vendas; consultor não pode excluir nenhuma venda.
- Autorização de permissões validada no backend/API, não apenas na interface.
- Atualização automática a cada 10 segundos.
- Migração automática e compatível do banco existente.
- Backup automático antes de alterações de schema necessárias.

## Arquivos alterados

- `server.js` — API, autenticação, permissões, migrações SQLite, vendas, leads, origens e analytics.
- `public/index.html` — interface completa, dashboard, filtros, gestão e tela grande.
- `README.md` — documentação atualizada.

## Banco de dados e segurança

O sistema continua usando o mesmo arquivo SQLite definido por `DB_PATH` (por padrão `aps.db`). **Não substitua nem apague o arquivo `aps.db` existente.**

Quando o sistema detectar que o banco existente precisa das novas estruturas, ele cria automaticamente um backup em:

```text
backups/aps-AAAA-MM-DDTHH-MM-SS-sssZ.db
```

As estruturas adicionadas são:

- `lead_sources`
- `leads`
- `sales.state`
- `sales.lead_source_id`

As novas colunas de `sales` são compatíveis com vendas antigas: registros anteriores continuam existindo, mas não ganham estado/origem artificialmente. Por isso, vendas antigas podem aparecer como **“Origem antiga”** e sem estado na análise detalhada.

## Instalação / atualização

Na pasta do projeto:

```bash
npm install
npm start
```

Depois abra:

```text
http://localhost:3000
```

### Se você já possui um banco em produção

1. Faça também um backup manual do `aps.db` antes da atualização.
2. Substitua os arquivos do projeto pelos arquivos desta versão, sem apagar o `aps.db`.
3. Mantenha o mesmo `DB_PATH` no `.env` caso ele esteja configurado.
4. Execute `npm install` para garantir as dependências.
5. Execute `npm start`.
6. Na primeira inicialização, a aplicação fará as migrações necessárias automaticamente.
7. Confira a pasta `backups/` caso uma migração de schema tenha sido necessária.

## Variáveis de ambiente

Copie `.env.example` para `.env` e ajuste, se necessário:

```env
PORT=3000
JWT_SECRET=troque-por-um-segredo-forte
DB_PATH=./aps.db
ADMIN_EMAIL=admin@aps.local
ADMIN_PASSWORD=123456
```

Em produção, altere `JWT_SECRET` e a senha administrativa.

## Login inicial

Se ainda não existir nenhum usuário administrador, o sistema cria:

- E-mail: `admin@aps.local`
- Senha: `123456`

Se já existir um administrador no banco, os dados dele são preservados.

## Como testar

### Administrador

1. Faça login como administrador.
2. Cadastre um consultor com foto e meta.
3. Cadastre uma origem adicional em **Equipe e configurações**.
4. Em **Gestão de leads**, registre uma quantidade de leads para consultor/origem/estado.
5. Cadastre uma venda usando a mesma combinação.
6. Confira a conversão: vendas ÷ leads × 100.
7. Use os filtros de mês, consultor, estado e origem.
8. Exclua uma venda e confirme que faturamento, vendas, ranking e conversão são recalculados sem apagar o registro de leads.
9. Edite a meta do consultor e confira o percentual atualizado.
10. Abra **Ranking grande** e verifique o pódio.

### Consultor

1. Faça login com uma conta de consultor.
2. Confirme que o painel mostra apenas sua meta e seu desempenho.
3. Cadastre uma venda.
4. Confirme que a API aceita o lançamento somente para o próprio usuário.
5. Tente acessar uma rota administrativa: ela deve retornar **403 — Acesso restrito**.
6. Tente excluir uma venda pela API: a operação deve retornar **403**.

## Atualização automática

O frontend atualiza os dados a cada 10 segundos sem exigir recarga manual da página.

## Observação sobre conversão

Conversão verdadeira depende de **leads registrados**. Vendas antigas continuam preservadas, mas sem origem/estado/leads associados não devem ser usadas para inventar uma conversão detalhada.

## Hospedagem em nuvem (Supabase + Render)
Esta versão usa PostgreSQL via `DATABASE_URL`. O script `migrate-sqlite-to-postgres.js` migra o banco SQLite existente para o PostgreSQL do Supabase.
