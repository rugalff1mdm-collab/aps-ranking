require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');
const path = require('path');

const SQLITE_PATH = process.env.SQLITE_PATH || path.join(__dirname, 'aps.db');
if (!process.env.DATABASE_URL) {
  console.error('Defina DATABASE_URL antes de executar a migração.');
  process.exit(1);
}

const sqlite = new sqlite3.Database(SQLITE_PATH);
const all = (sql, params=[]) => new Promise((resolve,reject)=>sqlite.all(sql, params, (err, rows)=>err?reject(err):resolve(rows)));
const pool = new Pool({connectionString:process.env.DATABASE_URL, ssl:{rejectUnauthorized:false}, max:2});

async function main(){
  const users = await all('SELECT id,name,email,password_hash,role,active,goal,photo_data,created_at FROM users ORDER BY id');
  const sources = await all('SELECT id,name,active,created_at FROM lead_sources ORDER BY id');
  const sales = await all('SELECT id,consultant_id,client_name,amount,sale_date,state,lead_source_id,created_at FROM sales ORDER BY id');
  const leads = await all('SELECT id,lead_date,consultant_id,quantity,lead_source_id,state,created_at FROM leads ORDER BY id');

  console.log(`Encontrados: ${users.length} usuários, ${sources.length} origens, ${sales.length} vendas, ${leads.length} registros de leads.`);

  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('TRUNCATE TABLE leads, sales, lead_sources, users RESTART IDENTITY CASCADE');

    for (const r of users) await c.query(`INSERT INTO users (id,name,email,password_hash,role,active,goal,photo_data,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [r.id,r.name,r.email,r.password_hash,r.role,r.active,r.goal,r.photo_data,r.created_at]);
    for (const r of sources) await c.query(`INSERT INTO lead_sources (id,name,active,created_at) VALUES ($1,$2,$3,$4)`, [r.id,r.name,r.active,r.created_at]);
    for (const r of sales) await c.query(`INSERT INTO sales (id,consultant_id,client_name,amount,sale_date,state,lead_source_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [r.id,r.consultant_id,r.client_name,r.amount,r.sale_date,r.state,r.lead_source_id,r.created_at]);
    for (const r of leads) await c.query(`INSERT INTO leads (id,lead_date,consultant_id,quantity,lead_source_id,state,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [r.id,r.lead_date,r.consultant_id,r.quantity,r.lead_source_id,r.state,r.created_at]);

    await c.query(`SELECT setval(pg_get_serial_sequence('users','id'), COALESCE((SELECT MAX(id) FROM users),1), true)`);
    await c.query(`SELECT setval(pg_get_serial_sequence('lead_sources','id'), COALESCE((SELECT MAX(id) FROM lead_sources),1), true)`);
    await c.query(`SELECT setval(pg_get_serial_sequence('sales','id'), COALESCE((SELECT MAX(id) FROM sales),1), true)`);
    await c.query(`SELECT setval(pg_get_serial_sequence('leads','id'), COALESCE((SELECT MAX(id) FROM leads),1), true)`);

    await c.query('COMMIT');
    console.log('Migração concluída com sucesso.');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
    await pool.end();
    sqlite.close();
  }
}

main().catch(e=>{console.error('Falha na migração:',e.message);pool.end().catch(()=>{});sqlite.close();process.exit(1)});
