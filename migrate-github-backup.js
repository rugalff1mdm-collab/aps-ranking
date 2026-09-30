const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { DatabaseSync } = require('node:sqlite');
const { Pool } = require('pg');

const SOURCE_URL = 'https://raw.githubusercontent.com/rugalff1mdm-collab/aps-ranking/main/aps.db';
const SOURCE_SHA = '959fb5b25f6303641db3d7385d05c6887ecef316';
const TEMP_DB = path.join(os.tmpdir(), 'aps-ranking-legacy.db');

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
      const done = await c.query('SELECT 1 FROM legacy_imports WHERE source=$1 LIMIT 1', [SOURCE_URL]);

      console.log('Baixando backup legado do GitHub...');
      // Mesmo que uma importação anterior tenha sido marcada como concluída,
      // conferimos novamente o backup. Isso permite recuperar vendas que tenham
      // ficado de fora de uma primeira execução sem duplicá-las.

      await download(SOURCE_URL, TEMP_DB);
      db = await openSqlite(TEMP_DB);
      const tables = await sqliteTables(db);
      console.log('Tabelas encontradas no backup:', [...tables].join(', '));

      await c.query('BEGIN');
      const maps = {users:new Map(), sources:new Map()};

      const users = await importUsers(db, c, maps);
      const sources = await importLeadSources(db, c, maps);

      // Vendas e leads são importados/atualizados sem apagar o que já existe.
      const sales = await importRows(db, c, 'sales', maps, {consultant_id:true, lead_source_id:true});
      const leads = await importRows(db, c, 'leads', maps, {consultant_id:true, lead_source_id:true});

      // Regras e configurações do backup substituem apenas as regras/configurações
      // atuais, mantendo o banco operacional e os dados de vendas intactos.
      let prizeRules = 0, prizeLosses = 0, prizeAdjustments = 0, supervisor = 0;
      if (tables.has('prize_rules')) prizeRules = await replaceSimpleTable(db, c, 'prize_rules');
      if (tables.has('supervisor_prize_settings')) supervisor = await replaceSimpleTable(db, c, 'supervisor_prize_settings');
      if (tables.has('prize_losses')) prizeLosses = await importRows(db, c, 'prize_losses', maps, {consultant_id:true, rule_id:true});
      if (tables.has('prize_adjustments')) prizeAdjustments = await importRows(db, c, 'prize_adjustments', maps, {consultant_id:true});

      if (done.rows.length) {
        await c.query(
          'UPDATE legacy_imports SET source_sha=$2, imported_at=CURRENT_TIMESTAMP, details=$3 WHERE source=$1',
          [SOURCE_URL,SOURCE_SHA,JSON.stringify({users,sources,sales,leads,prizeRules,prizeLosses,prizeAdjustments,supervisor,mode:'repair'})]
        );
      } else {
        await c.query(
          'INSERT INTO legacy_imports(source,source_sha,details) VALUES($1,$2,$3)',
          [SOURCE_URL,SOURCE_SHA,JSON.stringify({users,sources,sales,leads,prizeRules,prizeLosses,prizeAdjustments,supervisor})]
        );
      }
      await c.query('COMMIT');

      const summary = {users,sources,sales,leads,prizeRules,prizeLosses,prizeAdjustments,supervisor};
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
    try { fs.unlinkSync(TEMP_DB); } catch (_) {}
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
