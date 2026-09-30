const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { DatabaseSync } = require('node:sqlite');
const { Pool } = require('pg');

const SOURCES = [
  // O backup anterior é importado primeiro para recuperar todo o histórico.
  { url:'https://raw.githubusercontent.com/rugalff1mdm-collab/aps-ranking/main/aps-backup-antes-migracao.db', sha:'faee5e40d08c1a89dd5bb4d8c4e9dc5081a2ab45', label:'backup-antes-migracao' },
  // O aps.db atual é importado por último para prevalecer nos registros que
  // existem nos dois arquivos.
  { url:'https://raw.githubusercontent.com/rugalff1mdm-collab/aps-ranking/main/aps.db', sha:'959fb5b25f6303641db3d7385d05c6887ecef316', label:'aps.db' }
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        fs.unlink(dest, () => download(response.headers.location, dest).then(resolve, reject));
        return;
      }
      if (response.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        reject(new Error('GitHub respondeu HTTP ' + response.statusCode));
        return;
      }
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', err => {
      file.close();
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

function sqliteAll(db, sql, params=[]) {
  return db.prepare(sql).all(...params);
}
function sqliteGet(db, sql, params=[]) {
  return db.prepare(sql).get(...params);
}
function openSqlite(file) {
  return new DatabaseSync(file);
}
function closeSqlite(db) {
  try { db.close(); } catch (_) {}
}
function qi(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }

async function pgColumns(client, table) {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
    [table]
  );
  return r.rows.map(x => x.column_name);
}
async function sqliteTables(sqlite) {
  const rows = await sqliteAll(sqlite, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  return new Set(rows.map(x => x.name));
}
function commonColumns(rows, pgCols) {
  if (!rows.length) return [];
  const keys = Object.keys(rows[0]);
  return keys.filter(k => pgCols.includes(k));
}
async function tableExists(sqlite, name) {
  const r = await sqliteGet(sqlite, "SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]);
  return !!r;
}
async function resetSequence(client, table) {
  try {
    await client.query(
      `SELECT setval(pg_get_serial_sequence($1,'id'), COALESCE((SELECT MAX(id) FROM ${qi(table)}),1), true)`,
      [table]
    );
  } catch (_) {}
}

async function importUsers(sqlite, client, maps) {
  if (!(await tableExists(sqlite, 'users'))) return 0;
  const rows = await sqliteAll(sqlite, 'SELECT * FROM users ORDER BY id');
  const cols = await pgColumns(client, 'users');
  let count = 0;
  for (const r of rows) {
    const email = String(r.email || '').trim().toLowerCase();
    const rawRole = String(r.role || '').trim().toLowerCase();
    const normalizedRole = ['admin','administrator','administrador'].includes(rawRole) ? 'admin'
      : ['ranking_admin','ranking-admin','ranking admin'].includes(rawRole) ? 'ranking_admin'
      : 'consultant';
    const normalizedActive = r.active == null ? 1 : (Number(r.active) ? 1 : 0);
    r.role = normalizedRole;
    r.active = normalizedActive;
    let existing = email ? (await client.query('SELECT id,role FROM users WHERE lower(email)=lower($1) LIMIT 1', [email])).rows[0] : null;

    if (existing && ['admin','ranking_admin'].includes(String(r.role || '').toLowerCase())) {
      maps.users.set(Number(r.id), Number(existing.id));
      continue;
    }

    const insertCols = commonColumns([r], cols).filter(c => c !== 'id');
    if (!existing) {
      const idFree = Number.isInteger(Number(r.id)) && Number(r.id) > 0 &&
        !(await client.query('SELECT 1 FROM users WHERE id=$1', [Number(r.id)])).rows[0];
      if (idFree && cols.includes('id')) insertCols.unshift('id');
    }

    if (existing) {
      const setCols = insertCols.filter(c => c !== 'id');
      if (setCols.length) {
        const vals = setCols.map(c => c === 'email' ? email : r[c]);
        await client.query(
          `UPDATE users SET ${setCols.map((c,i)=>qi(c)+'=$'+(i+1)).join(', ')} WHERE id=$${setCols.length+1}`,
          [...vals, Number(existing.id)]
        );
      }
      maps.users.set(Number(r.id), Number(existing.id));
    } else {
      const vals = insertCols.map(c => c === 'email' ? email : r[c]);
      const placeholders = vals.map((_,i)=>'$'+(i+1)).join(',');
      const ins = await client.query(
        `INSERT INTO users (${insertCols.map(qi).join(',')}) VALUES (${placeholders}) RETURNING id`,
        vals
      );
      maps.users.set(Number(r.id), Number(ins.rows[0].id));
    }
    count++;
  }
  await resetSequence(client, 'users');
  return count;
}

async function importLeadSources(sqlite, client, maps) {
  if (!(await tableExists(sqlite, 'lead_sources'))) return 0;
  const rows = await sqliteAll(sqlite, 'SELECT * FROM lead_sources ORDER BY id');
  const cols = await pgColumns(client, 'lead_sources');
  let count = 0;
  for (const r of rows) {
    const name = String(r.name || '').trim();
    if (!name) continue;
    const existing = (await client.query('SELECT id FROM lead_sources WHERE lower(name)=lower($1) LIMIT 1', [name])).rows[0];
    if (existing) {
      maps.sources.set(Number(r.id), Number(existing.id));
      await client.query('UPDATE lead_sources SET active=$1 WHERE id=$2', [r.active == null ? 1 : r.active, existing.id]);
      continue;
    }
    const insertCols = commonColumns([r], cols).filter(c => c !== 'id');
    const idFree = Number.isInteger(Number(r.id)) && Number(r.id) > 0 &&
      !(await client.query('SELECT 1 FROM lead_sources WHERE id=$1', [Number(r.id)])).rows[0];
    if (idFree && cols.includes('id')) insertCols.unshift('id');
    const vals = insertCols.map(c => c === 'name' ? name : r[c]);
    const ins = await client.query(
      `INSERT INTO lead_sources (${insertCols.map(qi).join(',')}) VALUES (${vals.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING id`,
      vals
    );
    maps.sources.set(Number(r.id), Number(ins.rows[0].id));
    count++;
  }
  await resetSequence(client, 'lead_sources');
  return count;
}

function saleKey(r) {
  const norm = v => String(v ?? '').trim().toLowerCase();
  const num = v => {
    const n = Number(v);
    return Number.isFinite(n) ? n.toFixed(2) : '0.00';
  };
  return [
    Number(r.consultant_id || 0),
    norm(r.client_name),
    norm(r.sale_date),
    num(r.gross_amount ?? r.amount),
    norm(r.payment_type),
    Number(r.installments || 0),
    num(r.payment_amount_2),
    norm(r.payment_type_2),
    Number(r.installments_2 || 0),
    norm(r.payment_date_2),
    num(r.payment_amount_3),
    norm(r.payment_type_3),
    Number(r.installments_3 || 0),
    norm(r.payment_date_3)
  ].join('|');
}

async function importSales(sqlite, client, maps) {
  if (!(await tableExists(sqlite, 'sales'))) return 0;
  const rows = await sqliteAll(sqlite, 'SELECT * FROM sales ORDER BY id');
  const cols = await pgColumns(client, 'sales');

  // IMPORTANTE: IDs das duas bases SQLite não são globais.
  // Não podemos fazer upsert pelo id, pois a venda #1 do backup pode ser
  // diferente da venda #1 do aps.db. O objetivo é preservar TODAS as vendas.
  const existingRows = (await client.query(
    `SELECT id,consultant_id,client_name,sale_date,gross_amount,amount,payment_type,installments,
            payment_amount_2,payment_type_2,installments_2,payment_date_2,
            payment_amount_3,payment_type_3,installments_3,payment_date_3
       FROM sales`
  )).rows;
  const keys = new Set(existingRows.map(saleKey));

  let count = 0;
  for (const raw of rows) {
    const r = {...raw};
    if (r.consultant_id != null) r.consultant_id = maps.users.get(Number(r.consultant_id)) || null;
    if (r.lead_source_id != null) r.lead_source_id = maps.sources.get(Number(r.lead_source_id)) || null;
    if (!r.consultant_id) {
      console.log('Venda ignorada: consultor não mapeado, id SQLite=', r.id);
      continue;
    }

    const key = saleKey(r);
    if (keys.has(key)) continue;

    const insertCols = commonColumns([r], cols).filter(c => c !== 'id');
    if (!insertCols.length) continue;
    const vals = insertCols.map(col => r[col]);
    await client.query(
      `INSERT INTO sales (${insertCols.map(qi).join(',')})
       VALUES (${vals.map((_,i)=>'$'+(i+1)).join(',')})`,
      vals
    );
    keys.add(key);
    count++;
  }
  await resetSequence(client, 'sales');
  return count;
}

async function importRows(sqlite, client, table, maps, foreignMap) {
  if (!(await tableExists(sqlite, table))) return 0;
  const rows = await sqliteAll(sqlite, 'SELECT * FROM ' + qi(table) + ' ORDER BY id');
  const cols = await pgColumns(client, table);
  let count = 0;
  for (const raw of rows) {
    const r = {...raw};
    if (foreignMap?.consultant_id != null && r.consultant_id != null) {
      r.consultant_id = maps.users.get(Number(r.consultant_id)) || null;
    }
    if (foreignMap?.lead_source_id && r.lead_source_id != null) {
      r.lead_source_id = maps.sources.get(Number(r.lead_source_id)) || null;
    }
    if (foreignMap?.rule_id && r.rule_id != null) {
      r.rule_id = Number(r.rule_id);
    }

    const insertCols = commonColumns([r], cols);
    if (!insertCols.length) continue;
    const oldId = Number(r.id || 0);
    const exists = oldId > 0 ? (await client.query(`SELECT 1 FROM ${qi(table)} WHERE id=$1`, [oldId])).rows[0] : null;
    const vals = insertCols.map(c => r[c]);

    if (exists) {
      const setCols = insertCols.filter(c => c !== 'id');
      if (setCols.length) {
        const updVals = setCols.map(c => r[c]);
        await client.query(
          `UPDATE ${qi(table)} SET ${setCols.map((c,i)=>qi(c)+'=$'+(i+1)).join(', ')} WHERE id=$${setCols.length+1}`,
          [...updVals, oldId]
        );
      }
    } else {
      await client.query(
        `INSERT INTO ${qi(table)} (${insertCols.map(qi).join(',')}) VALUES (${vals.map((_,i)=>'$'+(i+1)).join(',')})`,
        vals
      );
    }
    count++;
  }
  await resetSequence(client, table);
  return count;
}
async function replaceSimpleTable(sqlite, client, table, keyColumns=[]) {
  if (!(await tableExists(sqlite, table))) return 0;
  const rows = await sqliteAll(sqlite, 'SELECT * FROM ' + qi(table) + ' ORDER BY id');
  if (!rows.length) return 0;
  await client.query('DELETE FROM ' + qi(table));
  const cols = await pgColumns(client, table);
  let count = 0;
  for (const r of rows) {
    const insertCols = commonColumns([r], cols);
    const vals = insertCols.map(c => r[c]);
    await client.query(
      `INSERT INTO ${qi(table)} (${insertCols.map(qi).join(',')}) VALUES (${vals.map((_,i)=>'$'+(i+1)).join(',')})`,
      vals
    );
    count++;
  }
  await resetSequence(client, table);
  return count;
}

async function run() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL não configurada');
  if (process.env.AUTO_IMPORT_LEGACY === '0') {
    console.log('Migração do backup antigo desativada por AUTO_IMPORT_LEGACY=0');
    return {skipped:true};
  }

  const pool = new Pool({connectionString:process.env.DATABASE_URL, ssl:{rejectUnauthorized:false}, max:2});
  const sqlite = null;
  let db = null;
  try {
    const c = await pool.connect();
    try {
      await c.query(`CREATE TABLE IF NOT EXISTS legacy_imports (
        id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        source TEXT NOT NULL UNIQUE,
        source_sha TEXT,
        imported_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        details TEXT
      )`);
      const totals = {users:0,sources:0,sales:0,leads:0,prizeRules:0,prizeLosses:0,prizeAdjustments:0,supervisor:0};

      await c.query('BEGIN');
      try {
        // Os dois backups são idempotentes: registros existentes são atualizados
        // pelo mesmo ID e os registros ausentes são inseridos. O backup antigo
        // entra primeiro e o aps.db atual prevalece em caso de sobreposição.
        for (const source of SOURCES) {
          const tempDb = path.join(os.tmpdir(), 'aps-ranking-legacy-' + source.label + '.db');
          let sourceDb = null;
          try {
            console.log('Baixando backup legado:', source.label);
            await download(source.url, tempDb);
            sourceDb = openSqlite(tempDb);
            const tables = await sqliteTables(sourceDb);
            console.log('Tabelas encontradas em', source.label + ':', [...tables].join(', '));
            const counts = {};
            for (const t of ['users','sales','leads','lead_sources','prize_rules','prize_losses','prize_adjustments','supervisor_prize_settings']) {
              if (tables.has(t)) counts[t] = Number(sqliteGet(sourceDb, `SELECT COUNT(*) AS count FROM ${qi(t)}`).count || 0);
            }
            console.log('Contagens no arquivo', source.label + ':', counts);

            const maps = {users:new Map(), sources:new Map()};
            const users = await importUsers(sourceDb, c, maps);
            const sources = await importLeadSources(sourceDb, c, maps);
            const sales = await importSales(sourceDb, c, maps);
            const leads = await importRows(sourceDb, c, 'leads', maps, {consultant_id:true, lead_source_id:true});

            let prizeRules = 0, prizeLosses = 0, prizeAdjustments = 0, supervisor = 0;
            if (tables.has('prize_rules')) prizeRules = await replaceSimpleTable(sourceDb, c, 'prize_rules');
            if (tables.has('supervisor_prize_settings')) supervisor = await replaceSimpleTable(sourceDb, c, 'supervisor_prize_settings');
            if (tables.has('prize_losses')) prizeLosses = await importRows(sourceDb, c, 'prize_losses', maps, {consultant_id:true, rule_id:true});
            if (tables.has('prize_adjustments')) prizeAdjustments = await importRows(sourceDb, c, 'prize_adjustments', maps, {consultant_id:true});

            totals.users += users;
            totals.sources += sources;
            totals.sales += sales;
            totals.leads += leads;
            totals.prizeRules += prizeRules;
            totals.prizeLosses += prizeLosses;
            totals.prizeAdjustments += prizeAdjustments;
            totals.supervisor += supervisor;
            const pgCounts = {};
            for (const t of ['users','sales','leads']) {
              pgCounts[t] = Number((await c.query(`SELECT COUNT(*)::int AS count FROM ${qi(t)}`)).rows[0].count || 0);
            }
            console.log('Contagens no PostgreSQL após', source.label + ':', pgCounts);

            await c.query(
              `INSERT INTO legacy_imports(source,source_sha,details)
               VALUES($1,$2,$3)
               ON CONFLICT(source) DO UPDATE SET
                 source_sha=EXCLUDED.source_sha,
                 imported_at=CURRENT_TIMESTAMP,
                 details=EXCLUDED.details`,
              [source.url, source.sha, JSON.stringify({users,sources,sales,leads,prizeRules,prizeLosses,prizeAdjustments,supervisor,mode:'merge-all'})]
            );
          } finally {
            if (sourceDb) closeSqlite(sourceDb);
            try { fs.unlinkSync(tempDb); } catch (_) {}
          }
        }

        await c.query('COMMIT');
      } catch (e) {
        try { await c.query('ROLLBACK'); } catch (_) {}
        throw e;
      }

      const summary = totals;
      console.log('MIGRAÇÃO DO BACKUP CONCLUÍDA:', summary);
      return summary;
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally {
      c.release();
    }
  } finally {
    if (db) await closeSqlite(db);
    await pool.end();
  }
}

if (require.main === module) {
  run().then(() => process.exit(0)).catch(err => {
    console.error('Falha na migração do backup:', err);
    process.exit(1);
  });
}

module.exports = { run };
