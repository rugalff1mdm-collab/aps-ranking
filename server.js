require('dotenv').config();
const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'TROQUE-ESTE-SEGREDO-EM-PRODUCAO';

// Taxas da planilha "Taxa Maquininha ATUALIZADA".
// Regra do sistema: à vista e 1x = 0%; 2x a 12x usam a taxa da plataforma.
const CARD_RATES = {"PayUP": [0, 0.0724, 0.0822, 0.0919, 0.1014, 0.1113, 0.136, 0.1455, 0.155, 0.1646, 0.1742, 0.1839], "Cielo": [0, 0.0564, 0.064, 0.0716, 0.0792, 0.0869, 0.0986, 0.1064, 0.1142, 0.1221, 0.1301, 0.1381], "Mercado Pago": [0, 0.047, 0.0555, 0.064, 0.0725, 0.081, 0.0875, 0.096, 0.1045, 0.113, 0.1215, null], "PayPi": [0, 0.0543, 0.065, 0.0758, 0.0865, 0.0973, 0.1081, 0.1188, 0.1296, 0.1403, 0.1511, 0.1619], "Dom Pagamentos": [0, 0.0572, 0.0676, 0.0781, 0.0885, 0.0989, 0.1171, 0.1274, 0.1378, 0.1481, 0.1584, 0.168], "Best4Send": [0, 0.0579, 0.0684, 0.0788, 0.0893, 0.0998, 0.1161, 0.1265, 0.1369, 0.1473, 0.1577, 0.1681]};
function cardRate(platform, installments){
  if(!platform || !Number.isInteger(Number(installments))) return null;
  const n=Number(installments);
  if(n===1) return 0;
  if(n<1 || n>12) return null;
  const arr=CARD_RATES[String(platform)];
  if(!arr) return null;
  return arr[n-1]===null || arr[n-1]===undefined ? null : Number(arr[n-1]);
}
function calculateCardValues(gross, platform, installments){
  const g=Number(gross);
  if(!Number.isFinite(g) || g<=0) return null;
  const n=Number(installments||1);
  if(!platform || n===1) return {rate:0, fee:0, net:Number(g.toFixed(2))};
  const rate=cardRate(platform,n);
  if(rate===null) return null;
  const fee=Number((g*rate).toFixed(2));
  return {rate, fee, net:Number((g-fee).toFixed(2))};
}
function normalizePaymentType(value){
  const v=String(value||'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  if(v==='avista'||v==='a vista'||v==='pix'||v.includes('avista')||v.includes('pix'))return 'avista';
  if(v==='parcelado'||v.includes('parcelado')||v.includes('cartao'))return 'parcelado';
  return '';
}
function calculatePaymentPart(amount, type, platform, installments){
  const v=Number(amount||0);
  if(!Number.isFinite(v) || v<0) return null;
  const t=String(type||'').toLowerCase();
  if(v===0) return {type:null,amount:0,installments:null,platform:null,rate:0,fee:0,net:0};
  if(t==='avista') return {type:'avista',amount:Number(v.toFixed(2)),installments:null,platform:null,rate:0,fee:0,net:Number(v.toFixed(2))};
  if(t==='parcelado') {
    const n=Number(installments);
    const calc=calculateCardValues(v,platform,n);
    if(!calc) return null;
    return {type:'parcelado',amount:Number(v.toFixed(2)),installments:n,platform:String(platform||''),rate:calc.rate,fee:calc.fee,net:calc.net};
  }
  return null;
}
function effectivePrizePayment(s){
  const parceladas=[];
  for(let i=1;i<=3;i++){
    const suf=i===1?'':'_'+i;
    const t=String(s[`payment_type${suf}`]||'').toLowerCase();
    const n=Number(s[`installments${suf}`]||0);
    if(t==='parcelado'&&n>0)parceladas.push(n);
  }
  if(parceladas.length)return {payment_type:'parcelado',installments:Math.max(...parceladas)};
  return {payment_type:'avista',installments:null};
}


if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL não configurada.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

function pgSql(sql, params=[]) {
  let i = 0;
  return sql
    .replace(/INSERT\s+OR\s+IGNORE/gi, 'INSERT')
    .replace(/\?/g, () => `$${++i}`)
    .replace(/INSERT INTO ([^;]+?)(\s*;)?$/is, (m, body, semi) => m)
    .replace(/role=\"(admin|consultant)\"/g, "role='$1'");
}

const dbGet = async (sql, params=[]) => {
  const result = await pool.query(pgSql(sql, params), params);
  return result.rows[0];
};
const dbAll = async (sql, params=[]) => {
  const result = await pool.query(pgSql(sql, params), params);
  return result.rows;
};
const dbRun = async (sql, params=[]) => {
  const isInsert = /^\s*INSERT\b/i.test(sql);
  const finalSql = isInsert && !/\bRETURNING\b/i.test(sql) ? `${pgSql(sql, params)} RETURNING id` : pgSql(sql, params);
  const result = await pool.query(finalSql, params);
  return { lastID: result.rows[0]?.id, rowCount: result.rowCount, rows: result.rows };
};

app.use(express.json({limit:'4mb'}));
app.use((req,res,next)=>{if(req.path==='/'||req.path.endsWith('.html')||req.path.startsWith('/api/'))res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');next()});
app.get('/',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html'),{headers:{'Cache-Control':'no-store, no-cache, must-revalidate, proxy-revalidate','Pragma':'no-cache','Expires':'0'}}));
app.use(express.static(path.join(__dirname,'public'),{setHeaders:(res,filePath)=>{if(filePath.endsWith('.html')){res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');res.setHeader('Pragma','no-cache');res.setHeader('Expires','0')}}}));

async function init(){
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'consultant',
    active INTEGER NOT NULL DEFAULT 1,
    goal REAL NOT NULL DEFAULT 0,
    photo_data TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sales (
    id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    consultant_id INTEGER NOT NULL REFERENCES users(id),
    client_name TEXT NOT NULL,
    client_age INTEGER,
    birth_date TEXT,
    amount REAL NOT NULL,
    gross_amount REAL,
    sale_date TEXT NOT NULL,
    state TEXT,
    lead_source_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS lead_sources (
    id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS leads (
    id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    lead_date TEXT NOT NULL,
    consultant_id INTEGER NOT NULL REFERENCES users(id),
    quantity INTEGER NOT NULL,
    lead_source_id INTEGER NOT NULL REFERENCES lead_sources(id),
    state TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS team TEXT NOT NULL DEFAULT 'A'`);
  await pool.query(`UPDATE users SET team='A' WHERE team IS NULL OR team=''`);
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS client_age INTEGER`);
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS birth_date TEXT`);
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS gross_amount REAL`);
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_type TEXT`);
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS installments INTEGER`);
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS card_platform TEXT`);
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS card_fee_rate REAL`);
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS card_fee_amount REAL`);
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_amount_2 REAL`);
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_type_2 TEXT`);
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS installments_2 INTEGER`);
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS card_platform_2 TEXT`);
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS card_fee_rate_2 REAL`);
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS card_fee_amount_2 REAL`);
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_date_1 TEXT`);
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_amount_3 REAL`);
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_type_3 TEXT`);
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS installments_3 INTEGER`);
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS card_platform_3 TEXT`);
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS card_fee_rate_3 REAL`);
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS card_fee_amount_3 REAL`);
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_date_2 TEXT`);
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_date_3 TEXT`);
  await pool.query(`UPDATE sales SET payment_date_1=sale_date WHERE payment_date_1 IS NULL OR payment_date_1=''`);
  await pool.query(`CREATE TABLE IF NOT EXISTS prize_rules (
    id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    frequency TEXT NOT NULL DEFAULT 'sale',
    payment_type TEXT,
    min_amount REAL NOT NULL DEFAULT 0,
    max_installments INTEGER,
    min_installments INTEGER,
    min_days INTEGER,
    prize_amount REAL NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`ALTER TABLE prize_rules ADD COLUMN IF NOT EXISTS min_installments INTEGER`);
  await pool.query(`CREATE TABLE IF NOT EXISTS prize_losses (
    id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    consultant_id INTEGER NOT NULL REFERENCES users(id),
    rule_id INTEGER,
    period_month TEXT NOT NULL,
    loss_date TEXT NOT NULL,
    reason TEXT NOT NULL,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS supervisor_prize_settings (
    id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    value REAL NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const prizeCount=(await pool.query('SELECT COUNT(*)::int count FROM prize_rules')).rows[0].count;
  if(!prizeCount){
    const rules=[
      ['Parcelamento até 6x — R$ 1.900','sale','parcelado',1900,6,20,'Venda parcelada em até 6x'],
      ['Parcelamento até 6x — R$ 2.400','sale','parcelado',2400,6,30,'Venda parcelada em até 6x'],
      ['Parcelamento até 6x — R$ 2.700','sale','parcelado',2700,6,40,'Venda parcelada em até 6x'],
      ['Parcelamento 7x — R$ 3.400','sale','parcelado',3400,7,70,'Venda parcelada em 7x'],
      ['Parcelamento 7x — R$ 4.000','sale','parcelado',4000,7,90,'Venda parcelada em 7x'],
      ['Parcelamento 8x — R$ 5.000','sale','parcelado',5000,8,120,'Venda parcelada em 8x'],
      ['Parcelamento 8x — R$ 6.000','sale','parcelado',6000,8,150,'Venda parcelada em 8x'],
      ['Parcelamento 8x — R$ 7.000','sale','parcelado',7000,8,200,'Venda parcelada em 8x'],
      ['À vista — R$ 1.900','sale','avista',1900,null,50,'Venda à vista'],
      ['À vista — R$ 2.500','sale','avista',2500,null,70,'Venda à vista'],
      ['À vista — R$ 4.000','sale','avista',4000,null,150,'Venda à vista'],
      ['Acumulado diário — R$ 3.800','daily','',3800,null,50,'Faturamento acumulado do consultor no dia'],
      ['Acumulado diário — R$ 5.500','daily','',5500,null,70,'Faturamento acumulado do consultor no dia'],
      ['Acumulado diário — R$ 7.800','daily','',7800,null,120,'Faturamento acumulado do consultor no dia'],
      ['Acumulado semanal — R$ 12.000','weekly','',12000,null,150,'Faturamento acumulado do consultor na semana'],
      ['Dinâmica — R$ 1.500','dynamic','',1500,null,0,'Valor da premiação fica configurável pelo ADMIN'],
      ['Vendeu todos os dias (seg-sex)','all_days','',0,null,70,'Venda em todos os dias úteis da semana'],
      ['Meta diária — 1º lugar','daily_rank','',7500,null,50,'1º lugar entre quem bateu a meta diária'],
      ['Meta diária — 2º lugar','daily_rank','',7500,null,30,'2º lugar entre quem bateu a meta diária']
    ];
    for(const r of rules) await pool.query(`INSERT INTO prize_rules(name,category,frequency,payment_type,min_amount,max_installments,min_installments,prize_amount,active,description) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9)`,[r[0],r[1],r[1]==='sale'?'sale':r[1],r[2]||null,r[3],r[4],r[1]==='sale'?(r[4]===6?2:r[4]):null,r[5],r[6]]);
  }
  const supDefaults=[['daily_goal',5715],['daily_prize',50],['weekly_goal',28600],['weekly_prize',100]];
  for(const [n,v] of supDefaults) await pool.query(`INSERT INTO supervisor_prize_settings(name,value,active) VALUES($1,$2,1) ON CONFLICT(name) DO NOTHING`,[n,v]);
  // Corrige a inversão antiga das metas do supervisor, sem mexer em valores que o ADMIN já tenha personalizado.
  await pool.query(`UPDATE supervisor_prize_settings SET value=5715 WHERE name='daily_goal' AND value=28600`);
  await pool.query(`UPDATE supervisor_prize_settings SET value=28600 WHERE name='weekly_goal' AND value=5715`);
  // Padroniza os nomes das premiações de meta diária para não aparecerem como acumulado diário.
  await pool.query(`UPDATE prize_rules SET name='Meta diária — 1º lugar', description='Meta da equipe de R$ 7.500 no dia; 1º lugar em faturamento bruto' WHERE category='daily_rank' AND prize_amount=50`);
  await pool.query(`UPDATE prize_rules SET name='Meta diária — 2º lugar', description='Meta da equipe de R$ 7.500 no dia; 2º lugar em faturamento bruto' WHERE category='daily_rank' AND prize_amount=30`);


  for(const name of ['Daniel','Tom','Remalho']){
    await pool.query('INSERT INTO lead_sources (name,active) VALUES ($1,1) ON CONFLICT (name) DO NOTHING',[name]);
  }
  const email=(process.env.ADMIN_EMAIL || 'admin@aps.local').trim().toLowerCase();
  const password=process.env.ADMIN_PASSWORD || '123456';
  const existing=(await pool.query("SELECT * FROM users WHERE role='admin' ORDER BY id LIMIT 1")).rows[0];
  if(!existing){
    const hash=await bcrypt.hash(password,10);
    await pool.query('INSERT INTO users (name,email,password_hash,role,goal,active) VALUES ($1,$2,$3,$4,$5,1)',['Administrador',email,hash,'admin',0]);
    console.log(`Admin inicial criado: ${email}`);
  } else if(process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD){
    // Se o Render tiver ADMIN_EMAIL/ADMIN_PASSWORD configurados, sincroniza o admin existente.
    // Isso corrige bancos antigos onde a senha/e-mail foram criados antes das variáveis atuais.
    const hash=await bcrypt.hash(password,10);
    await pool.query('UPDATE users SET email=$1,password_hash=$2,active=1 WHERE id=$3',[email,hash,existing.id]);
    console.log(`Admin sincronizado pelas variáveis do Render: ${email}`);
  }
}

function auth(req,res,next){
  const header=req.headers.authorization||'';
  const token=header.startsWith('Bearer ')?header.slice(7):null;
  if(!token) return res.status(401).json({error:'Não autenticado'});
  try{req.user=jwt.verify(token,JWT_SECRET);next()}
  catch(e){return res.status(401).json({error:'Sessão inválida'})}
}
function adminOnly(req,res,next){
  if(req.user.role!=='admin') return res.status(403).json({error:'Acesso restrito'});
  next();
}
function rankingAdminOrAdmin(req,res,next){
  if(!['admin','ranking_admin'].includes(req.user.role)) return res.status(403).json({error:'Acesso restrito'});
  next();
}
function validMonth(value){return /^\d{4}-\d{2}$/.test(value||'')?value:new Date().toISOString().slice(0,7)}
function validDate(value){return /^\d{4}-\d{2}-\d{2}$/.test(value||'')}
function calculateAge(birthDate,referenceDate){
  if(!validDate(birthDate)||!validDate(referenceDate)) return null;
  const b=new Date(birthDate+'T00:00:00Z'), r=new Date(referenceDate+'T00:00:00Z');
  if(Number.isNaN(b.getTime())||Number.isNaN(r.getTime())||b>r) return null;
  let age=r.getUTCFullYear()-b.getUTCFullYear();
  const beforeBirthday=r.getUTCMonth()<b.getUTCMonth() || (r.getUTCMonth()===b.getUTCMonth() && r.getUTCDate()<b.getUTCDate());
  if(beforeBirthday) age--;
  return age;
}
function normalizeState(value){return String(value||'').trim().toUpperCase()}
const STATES=['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];
function monthBounds(month){return {start:`${month}-01`,next:`${monthNext(month)}-01`}}
function monthNext(month){const [y,m]=month.split('-').map(Number);const d=new Date(Date.UTC(y,m,1));return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`}
function dateFilterParts({month,consultantId,state,sourceId,dateFrom,dateTo},alias=''){
  const p=[]; const v=[]; const a=alias?alias+'.':'';
  if(dateFrom){p.push(`${a}date >= ?`);v.push(dateFrom)}
  else if(month){const b=monthBounds(month);p.push(`${a}date >= ? AND ${a}date < ?`);v.push(b.start,b.next)}
  if(dateTo){p.push(`${a}date <= ?`);v.push(dateTo)}
  if(consultantId){p.push(`${a}consultant_id = ?`);v.push(Number(consultantId))}
  if(state){p.push(`${a}state = ?`);v.push(normalizeState(state))}
  if(sourceId){p.push(`${a}lead_source_id = ?`);v.push(Number(sourceId))}
  return {where:p.length?' AND '+p.join(' AND '):'',params:v};
}

app.post('/api/login',async(req,res)=>{
  try{
    const email=String(req.body?.email||'').trim().toLowerCase();
    const password=String(req.body?.password||'');
    const user=await dbGet('SELECT * FROM users WHERE email=? AND active=1',[email]);
    if(!user || !(await bcrypt.compare(password,user.password_hash))) return res.status(401).json({error:'E-mail ou senha inválidos'});
    const token=jwt.sign({id:user.id,name:user.name,email:user.email,role:user.role},JWT_SECRET,{expiresIn:'7d'});
    res.json({token,user:{id:user.id,name:user.name,email:user.email,role:user.role,goal:user.goal,photo_data:user.photo_data||null}});
  }catch(e){console.error(e);res.status(500).json({error:'Erro interno'})}
});

app.get('/api/me',auth,async(req,res)=>{
  const u=await dbGet('SELECT id,name,email,role,goal,photo_data,team FROM users WHERE id=?',[req.user.id]);
  if(!u) return res.status(404).json({error:'Usuário não encontrado'});
  res.json(u);
});
app.patch('/api/me',auth,async(req,res)=>{
  try{
    const u=await dbGet('SELECT * FROM users WHERE id=?',[req.user.id]);
    if(!u) return res.status(404).json({error:'Usuário não encontrado'});
    const email=String(req.body?.email??u.email).trim().toLowerCase();
    const newPassword=String(req.body?.new_password||'');
    if(!email) return res.status(400).json({error:'Informe o e-mail'});
    if(newPassword && newPassword.length<6) return res.status(400).json({error:'A nova senha deve ter pelo menos 6 caracteres'});
    if(newPassword){const hash=await bcrypt.hash(newPassword,10);await dbRun('UPDATE users SET email=?,password_hash=? WHERE id=?',[email,hash,u.id]);}
    else await dbRun('UPDATE users SET email=? WHERE id=?',[email,u.id]);
    res.json({ok:true});
  }catch(e){if(String(e.message||'').includes('UNIQUE')) return res.status(400).json({error:'Este e-mail já está em uso'});console.error(e);res.status(500).json({error:'Não foi possível atualizar a conta'});}
});

app.get('/api/ranking',auth,async(req,res)=>{
  const month=validMonth(req.query.month);
  const team=String(req.query.team||'').trim().toUpperCase();
  if(team && !['A','B'].includes(team)) return res.status(400).json({error:'Equipe inválida'});
  if(team && req.user.role!=='admin') return res.status(403).json({error:'Acesso restrito'});
  const {where:rawWhere,params}=dateFilterParts({month},'s');
  const where=rawWhere.replace(/s\.date/g,'s.sale_date');
  const teamWhere=team?` AND u.team=?`:''; const finalParams=team?[...params,team]:params;
  const rows=await dbAll(`SELECT u.id,u.name,u.goal,u.photo_data,u.team,COALESCE(SUM(s.amount),0) revenue,COUNT(s.id) sales_count
    FROM users u LEFT JOIN sales s ON s.consultant_id=u.id ${where?where.replace(' AND s.',' AND s.'):''}
    WHERE u.role='consultant' AND u.active=1${teamWhere} GROUP BY u.id ORDER BY revenue DESC,sales_count DESC,u.name ASC`,finalParams);
  res.json(rows.map(r=>({...r,revenue:Number(r.revenue||0),sales_count:Number(r.sales_count||0),avg_ticket:r.sales_count?Number(r.revenue)/Number(r.sales_count):0,goal_pct:r.goal?Number(r.revenue)/Number(r.goal)*100:0})));
});

app.get('/api/team-rankings',auth,async(req,res)=>{
  if(req.user.role!=='admin') return res.status(403).json({error:'Acesso restrito'});
  const start=validDate(req.query.from)?String(req.query.from):(process.env.TEAM_RANK_START_DATE||'2026-09-21');
  const teams={};
  for(const team of ['A','B']){
    // Equipe A mantém o histórico normal; Equipe B começa no ranking separado a partir da data configurada.
    const dateFilter = team==='B' ? ' AND s.sale_date>=?' : '';
    const params = team==='B' ? [start,team] : [team];
    const rows=await dbAll(`SELECT u.id,u.name,u.goal,u.photo_data,u.team,
      COALESCE(SUM(s.amount),0) revenue,COUNT(s.id) sales_count
      FROM users u
      LEFT JOIN sales s ON s.consultant_id=u.id${dateFilter}
      WHERE u.role='consultant' AND u.active=1 AND u.team=?
      GROUP BY u.id ORDER BY revenue DESC,sales_count DESC,u.name ASC`,params);
    const decorated=rows.map(r=>({...r,revenue:Number(r.revenue||0),sales_count:Number(r.sales_count||0),avg_ticket:r.sales_count?Number(r.revenue)/Number(r.sales_count):0,goal_pct:r.goal?Number(r.revenue)/Number(r.goal)*100:0}));
    teams[team]={team,rows:decorated,total_revenue:decorated.reduce((a,r)=>a+r.revenue,0),total_sales:decorated.reduce((a,r)=>a+r.sales_count,0)};
  }
  res.json({start,teams});
});

app.get('/api/sales',auth,async(req,res)=>{
  const month=validMonth(req.query.month); const p=[month]; let extra='';
  if(!['admin','ranking_admin'].includes(req.user.role)){extra=' AND s.consultant_id=?';p.push(req.user.id)}
  const rows=await dbAll(`SELECT s.id,s.client_name,s.client_age,s.birth_date,s.amount,s.gross_amount,s.sale_date,s.state,s.lead_source_id,s.payment_type,s.installments,s.card_platform,s.card_fee_rate,s.card_fee_amount,s.payment_date_1,s.payment_amount_2,s.payment_type_2,s.installments_2,s.card_platform_2,s.card_fee_rate_2,s.card_fee_amount_2,s.payment_date_2,s.payment_amount_3,s.payment_type_3,s.installments_3,s.card_platform_3,s.card_fee_rate_3,s.card_fee_amount_3,s.payment_date_3,ls.name lead_source_name,u.name consultant_name,u.id consultant_id
    FROM sales s JOIN users u ON u.id=s.consultant_id LEFT JOIN lead_sources ls ON ls.id=s.lead_source_id
    WHERE substr(s.sale_date,1,7)=?${extra} ORDER BY s.sale_date DESC,s.id DESC`,p);
  res.json(rows.map(r=>({...r,amount:Number(r.amount),gross_amount:r.gross_amount===null||r.gross_amount===undefined?null:Number(r.gross_amount)})));
});

app.post('/api/sales',auth,async(req,res)=>{
  try{
    const {client_name,birth_date}=req.body||{};
    const paymentDate1=String(req.body?.payment_date_1||req.body?.payment_date||req.body?.sale_date||'');
    const saleDate=paymentDate1, birthDate=String(birth_date||''), state=normalizeState(req.body?.state), sourceId=Number(req.body?.lead_source_id||0);
    const age=calculateAge(birthDate,saleDate), parts=[];
    for(let i=1;i<=3;i++){
      const suf=i===1?'':'_'+i, amount=Number(req.body?.[`payment_amount${suf}`] ?? (i===1?(req.body?.payment_amount_1??req.body?.gross_amount??0):0));
      const type=normalizePaymentType(req.body?.[`payment_type${suf}`] ?? (i===1?req.body?.payment_type:null));
      const installments=req.body?.[`installments${suf}`]===undefined||req.body?.[`installments${suf}`]===''?null:Number(req.body[`installments${suf}`]);
      const platform=String(req.body?.[`card_platform${suf}`]||'').trim()||null;
      const date=String(req.body?.[`payment_date${suf}`]||(i===1?saleDate:''));
      const calc=amount>0?calculatePaymentPart(amount,type,platform,installments||1):{rate:0,fee:0,net:0};
      parts.push({amount,type,installments,platform,date,calc});
    }
    const missing=[]; if(!String(client_name||'').trim())missing.push('Cliente'); if(!validDate(birthDate))missing.push('Data de nascimento'); if(!validDate(saleDate))missing.push('Data do pagamento 01'); if(!state||!STATES.includes(state))missing.push('Estado'); if(!sourceId)missing.push('Origem do lead');
    const active=parts.filter(p=>p.amount>0);
    if(!active.length)missing.push('Valor do pagamento 01');
    for(let i=0;i<3;i++){const p=parts[i];if(p.amount<=0)continue;if(!validDate(p.date))missing.push(`Data do pagamento ${String(i+1).padStart(2,'0')}`);if(!['avista','parcelado'].includes(p.type))missing.push(`Forma do pagamento ${String(i+1).padStart(2,'0')}`);if(p.type==='parcelado'){if(!p.platform)missing.push(`Plataforma do pagamento ${String(i+1).padStart(2,'0')}`);if(!Number.isInteger(p.installments)||p.installments<1||p.installments>12)missing.push(`Parcelas do pagamento ${String(i+1).padStart(2,'0')}`);}}
    if(missing.length)return res.status(400).json({error:'Falta preencher: '+missing.join(', '),missing});
    if(active.length<parts.filter(p=>p.amount>=0).length && false){}
    if(req.user.role==='ranking_admin')return res.status(403).json({error:'Este acesso é somente para ranking e premiações'});
    const consultantId=req.user.role==='admin'?Number(req.body.consultant_id||0):req.user.id; if(!consultantId)return res.status(400).json({error:'Informe o consultor'});
    const c=await dbGet('SELECT id FROM users WHERE id=? AND role="consultant" AND active=1',[consultantId]); const source=await dbGet('SELECT id FROM lead_sources WHERE id=? AND active=1',[sourceId]);
    if(!c)return res.status(400).json({error:'Consultor inválido ou inativo'}); if(!source)return res.status(400).json({error:'Origem de lead inválida ou inativa'});
    const gross=Number(parts.reduce((a,p)=>a+p.amount,0).toFixed(2)), value=Number(parts.reduce((a,p)=>a+(p.calc?.net||0),0).toFixed(2));
    const p1=parts[0],p2=parts[1],p3=parts[2];
    const result=await dbRun(`INSERT INTO sales (consultant_id,client_name,client_age,birth_date,amount,gross_amount,sale_date,state,lead_source_id,payment_type,installments,card_platform,card_fee_rate,card_fee_amount,payment_date_1,payment_amount_2,payment_type_2,installments_2,card_platform_2,card_fee_rate_2,card_fee_amount_2,payment_date_2,payment_amount_3,payment_type_3,installments_3,card_platform_3,card_fee_rate_3,card_fee_amount_3,payment_date_3) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[consultantId,String(client_name).trim(),age,birthDate,value,gross,saleDate,state,sourceId,p1.type,p1.installments,p1.platform,p1.calc?.rate??0,p1.calc?.fee??0,p1.date,p2.amount||0,p2.amount?p2.type:null,p2.amount?p2.installments:null,p2.amount?p2.platform:null,p2.calc?.rate??0,p2.calc?.fee??0,p2.amount?p2.date:null,p3.amount||0,p3.amount?p3.type:null,p3.amount?p3.installments:null,p3.amount?p3.platform:null,p3.calc?.rate??0,p3.calc?.fee??0,p3.amount?p3.date:null]);
    const created=await dbGet('SELECT * FROM sales WHERE id=?',[result.lastID]);res.json({ok:true,id:result.lastID,sale:created});
  }catch(e){console.error(e);res.status(500).json({error:'Não foi possível registrar a venda'})}
});

app.delete('/api/sales/:id',auth,adminOnly,async(req,res)=>{
  const sale=await dbGet('SELECT id FROM sales WHERE id=?',[req.params.id]);
  if(!sale) return res.status(404).json({error:'Venda não encontrada'});
  await dbRun('DELETE FROM sales WHERE id=?',[req.params.id]);
  res.json({ok:true});
});
app.patch('/api/sales/:id',auth,async(req,res)=>{
  try{
    const s=await dbGet('SELECT * FROM sales WHERE id=?',[req.params.id]);if(!s)return res.status(404).json({error:'Venda não encontrada'});
    if(req.user.role==='ranking_admin')return res.status(403).json({error:'Este acesso não pode editar vendas'});
    if(req.user.role==='consultant'&&Number(s.consultant_id)!==Number(req.user.id))return res.status(403).json({error:'Você só pode editar suas próprias vendas'});
    const client=String(req.body?.client_name??s.client_name).trim(),birthDate=String(req.body?.birth_date??s.birth_date??''),paymentDate1=String(req.body?.payment_date_1??req.body?.sale_date??s.payment_date_1??s.sale_date),date=paymentDate1,state=normalizeState(req.body?.state??s.state),sourceId=Number((req.body?.lead_source_id??s.lead_source_id)||0),age=calculateAge(birthDate,date),parts=[];
    for(let i=1;i<=3;i++){
      const suf=i===1?'':'_'+i, oldAmt=i===1?Number(s.gross_amount||0)-Number(s.payment_amount_2||0)-Number(s.payment_amount_3||0):Number(s[`payment_amount${suf}`]||0);
      const amount=Number(req.body?.[`payment_amount${suf}`] ?? (i===1?oldAmt:0));
      const type=normalizePaymentType(req.body?.[`payment_type${suf}`]??s[`payment_type${suf}`]??'');
      const installments=req.body?.[`installments${suf}`]===undefined||req.body?.[`installments${suf}`]===''?(s[`installments${suf}`]??null):Number(req.body[`installments${suf}`]);
      const platform=String(req.body?.[`card_platform${suf}`]??s[`card_platform${suf}`]??'').trim()||null, pdate=String(req.body?.[`payment_date${suf}`]??s[`payment_date${suf}`]??(i===1?date:''));
      const calc=amount>0?calculatePaymentPart(amount,type,platform,installments||1):{rate:0,fee:0,net:0}; parts.push({amount,type,installments,platform,date:pdate,calc});
    }
    const active=parts.filter(p=>p.amount>0),missing=[]; if(!client)missing.push('Cliente'); if(!validDate(birthDate)||!Number.isInteger(age)||age<18||age>120)missing.push('Data de nascimento'); if(!validDate(date))missing.push('Data do pagamento 01'); if(!state||!STATES.includes(state))missing.push('Estado'); if(!sourceId)missing.push('Origem do lead'); if(!active.length)missing.push('Valor do pagamento 01'); for(let i=0;i<3;i++){const p=parts[i];if(p.amount<=0)continue;if(!validDate(p.date))missing.push(`Data do pagamento ${String(i+1).padStart(2,'0')}`);if(!['avista','parcelado'].includes(p.type))missing.push(`Forma do pagamento ${String(i+1).padStart(2,'0')}`);if(p.type==='parcelado'){if(!p.platform)missing.push(`Plataforma do pagamento ${String(i+1).padStart(2,'0')}`);if(!Number.isInteger(p.installments)||p.installments<1||p.installments>12)missing.push(`Parcelas do pagamento ${String(i+1).padStart(2,'0')}`);}} if(missing.length)return res.status(400).json({error:'Falta preencher: '+missing.join(', '),missing});
    const consultantId=req.user.role==='admin'?Number(req.body?.consultant_id??s.consultant_id):Number(s.consultant_id),gross=Number(parts.reduce((a,p)=>a+p.amount,0).toFixed(2)),amount=Number(parts.reduce((a,p)=>a+(p.calc?.net||0),0).toFixed(2)),p1=parts[0],p2=parts[1],p3=parts[2];
    const updateResult=await dbRun(`UPDATE sales SET consultant_id=?,client_name=?,client_age=?,birth_date=?,amount=?,gross_amount=?,sale_date=?,state=?,lead_source_id=?,payment_type=?,installments=?,card_platform=?,card_fee_rate=?,card_fee_amount=?,payment_date_1=?,payment_amount_2=?,payment_type_2=?,installments_2=?,card_platform_2=?,card_fee_rate_2=?,card_fee_amount_2=?,payment_date_2=?,payment_amount_3=?,payment_type_3=?,installments_3=?,card_platform_3=?,card_fee_rate_3=?,card_fee_amount_3=?,payment_date_3=? WHERE id=?`,[consultantId,client,age,birthDate,amount,gross,date,state,sourceId,p1.type,p1.installments,p1.platform,p1.calc?.rate??0,p1.calc?.fee??0,p1.date,p2.amount||0,p2.amount?p2.type:null,p2.amount?p2.installments:null,p2.amount?p2.platform:null,p2.calc?.rate??0,p2.calc?.fee??0,p2.amount?p2.date:null,p3.amount||0,p3.amount?p3.type:null,p3.amount?p3.installments:null,p3.amount?p3.platform:null,p3.calc?.rate??0,p3.calc?.fee??0,p3.amount?p3.date:null,s.id]);
    if(!updateResult.rowCount) return res.status(404).json({error:'A venda foi encontrada, mas não foi atualizada no banco.'});
    const updated=await dbGet('SELECT * FROM sales WHERE id=?',[s.id]);
    res.json({ok:true,message:'Venda corrigida e salva no banco!',sale:updated});
  }catch(e){console.error(e);res.status(500).json({error:'Não foi possível atualizar a venda'})}
});

app.get('/api/ranking-admins',auth,async(req,res)=>{
  if(!['admin','ranking_admin'].includes(req.user.role)) return res.status(403).json({error:'Acesso restrito'});
  const rows=await dbAll("SELECT id,name,email,active,created_at FROM users WHERE role='ranking_admin' ORDER BY active DESC,name ASC");
  res.json(rows);
});

app.get('/api/users',auth,adminOnly,async(req,res)=>{
  const rows=await dbAll(`SELECT id,name,email,role,active,goal,photo_data,team,created_at FROM users ORDER BY role DESC,team ASC,name ASC`);res.json(rows);
});
app.post('/api/users',auth,adminOnly,async(req,res)=>{
  try{
    const {name,email,password,goal,photo_data}=req.body||{}; const requestedRole=String(req.body?.role||'consultant'); const team=String(req.body?.team||'A').trim().toUpperCase();
    if(!name||!email||!password) return res.status(400).json({error:'Nome, e-mail e senha são obrigatórios'});
    if(String(password).length<6) return res.status(400).json({error:'A senha deve ter pelo menos 6 caracteres'});
    const goalValue=Number(goal||0);if(!Number.isFinite(goalValue)||goalValue<0) return res.status(400).json({error:'Meta inválida'});
    if(!['consultant','ranking_admin'].includes(requestedRole)) return res.status(400).json({error:'Tipo de acesso inválido'});
    if(!['A','B'].includes(team)) return res.status(400).json({error:'Equipe inválida'});
    const hash=await bcrypt.hash(String(password),10);const result=await dbRun('INSERT INTO users (name,email,password_hash,role,goal,photo_data,team) VALUES (?,?,?,?,?,?,?)',[String(name).trim(),String(email).trim().toLowerCase(),hash,requestedRole,requestedRole==='consultant'?goalValue:0,photo_data||null,team]);res.json({id:result.lastID});
  }catch(e){res.status(400).json({error:'E-mail já cadastrado ou dados inválidos'})}
});
app.patch('/api/users/:id',auth,adminOnly,async(req,res)=>{
  try{
    const u=await dbGet('SELECT * FROM users WHERE id=?',[req.params.id]);if(!u) return res.status(404).json({error:'Usuário não encontrado'});
    const name=String(req.body?.name??u.name).trim(),goal=Number(req.body?.goal??u.goal),active=req.body?.active===undefined?u.active:(req.body.active?1:0),photo=req.body?.photo_data===undefined?u.photo_data:req.body.photo_data,email=req.body?.email===undefined?u.email:String(req.body.email).trim().toLowerCase(),team=String(req.body?.team??u.team??'A').trim().toUpperCase();
    if(!name||!email||!Number.isFinite(goal)||goal<0||!['A','B'].includes(team)) return res.status(400).json({error:'Nome, e-mail, meta e equipe são obrigatórios e válidos'});
    if(req.body?.password){if(String(req.body.password).length<6)return res.status(400).json({error:'A nova senha deve ter pelo menos 6 caracteres'});const hash=await bcrypt.hash(String(req.body.password),10);await dbRun('UPDATE users SET name=?,email=?,goal=?,active=?,photo_data=?,password_hash=?,team=? WHERE id=?',[name,email,goal,active,photo,hash,team,u.id]);}
    else await dbRun('UPDATE users SET name=?,email=?,goal=?,active=?,photo_data=?,team=? WHERE id=?',[name,email,goal,active,photo,team,u.id]);
    res.json({ok:true});
  }catch(e){if(String(e.message||'').includes('UNIQUE')) return res.status(400).json({error:'Este e-mail já está em uso'});console.error(e);res.status(500).json({error:'Não foi possível atualizar o consultor'});}
});

app.get('/api/card-rates',auth,async(req,res)=>{
  res.json(Object.fromEntries(Object.entries(CARD_RATES).map(([name,rates])=>[name,rates.map((rate,i)=>({installments:i+1,rate}))])));
});

app.get('/api/lead-sources',auth,async(req,res)=>{
  const rows=await dbAll('SELECT id,name,active,created_at FROM lead_sources ORDER BY active DESC,name ASC');res.json(rows);
});
app.post('/api/lead-sources',auth,adminOnly,async(req,res)=>{
  try{const name=String(req.body?.name||'').trim();if(!name)return res.status(400).json({error:'Informe o nome da origem'});const r=await dbRun('INSERT INTO lead_sources(name,active) VALUES(?,1)',[name]);res.json({id:r.lastID});}
  catch(e){res.status(400).json({error:'Essa origem já existe ou é inválida'})}
});
app.patch('/api/lead-sources/:id',auth,adminOnly,async(req,res)=>{
  try{const s=await dbGet('SELECT * FROM lead_sources WHERE id=?',[req.params.id]);if(!s)return res.status(404).json({error:'Origem não encontrada'});const name=String(req.body?.name??s.name).trim();const active=req.body?.active===undefined?s.active:(req.body.active?1:0);if(!name)return res.status(400).json({error:'Informe o nome da origem'});await dbRun('UPDATE lead_sources SET name=?,active=? WHERE id=?',[name,active,s.id]);res.json({ok:true});}
  catch(e){res.status(400).json({error:'Não foi possível atualizar a origem'})}
});

app.post('/api/leads',auth,adminOnly,async(req,res)=>{
  try{
    const leadDate=String(req.body?.lead_date||'');const consultantId=Number(req.body?.consultant_id||0);const quantity=Number(req.body?.quantity||0);const sourceId=Number(req.body?.lead_source_id||0);const state=normalizeState(req.body?.state);
    if(!validDate(leadDate)||!consultantId||!Number.isInteger(quantity)||quantity<=0||!sourceId||!STATES.includes(state)) return res.status(400).json({error:'Data, consultor, quantidade, origem e estado são obrigatórios'});
    const c=await dbGet('SELECT id FROM users WHERE id=? AND role="consultant"',[consultantId]);const s=await dbGet('SELECT id FROM lead_sources WHERE id=? AND active=1',[sourceId]);if(!c||!s)return res.status(400).json({error:'Consultor ou origem inválidos'});
    const r=await dbRun('INSERT INTO leads(lead_date,consultant_id,quantity,lead_source_id,state) VALUES(?,?,?,?,?)',[leadDate,consultantId,quantity,sourceId,state]);res.json({id:r.lastID});
  }catch(e){console.error(e);res.status(500).json({error:'Não foi possível registrar os leads'})}
});
app.get('/api/leads',auth,adminOnly,async(req,res)=>{
  const month=validMonth(req.query.month);const p=[month];let extra='';if(req.query.consultant_id){extra+=' AND l.consultant_id=?';p.push(Number(req.query.consultant_id))}if(req.query.state){extra+=' AND l.state=?';p.push(normalizeState(req.query.state))}if(req.query.lead_source_id){extra+=' AND l.lead_source_id=?';p.push(Number(req.query.lead_source_id))}
  const rows=await dbAll(`SELECT l.id,l.lead_date,l.quantity,l.state,l.consultant_id,u.name consultant_name,l.lead_source_id,ls.name lead_source_name FROM leads l JOIN users u ON u.id=l.consultant_id JOIN lead_sources ls ON ls.id=l.lead_source_id WHERE substr(l.lead_date,1,7)=?${extra} ORDER BY l.lead_date DESC,l.id DESC`,p);res.json(rows);
});
app.delete('/api/leads/:id',auth,adminOnly,async(req,res)=>{const r=await dbGet('SELECT id FROM leads WHERE id=?',[req.params.id]);if(!r)return res.status(404).json({error:'Registro de leads não encontrado'});await dbRun('DELETE FROM leads WHERE id=?',[req.params.id]);res.json({ok:true})});
app.patch('/api/leads/:id',auth,adminOnly,async(req,res)=>{
  try{const l=await dbGet('SELECT * FROM leads WHERE id=?',[req.params.id]);if(!l)return res.status(404).json({error:'Registro de leads não encontrado'});const date=String(req.body?.lead_date??l.lead_date),qty=Number(req.body?.quantity??l.quantity),cid=Number(req.body?.consultant_id??l.consultant_id),sid=Number(req.body?.lead_source_id??l.lead_source_id),state=normalizeState(req.body?.state??l.state);if(!validDate(date)||!Number.isInteger(qty)||qty<=0||!cid||!sid||!STATES.includes(state))return res.status(400).json({error:'Data, quantidade, consultor, origem e estado são obrigatórios'});const c=await dbGet("SELECT id FROM users WHERE id=? AND role='consultant'",[cid]);const src=await dbGet('SELECT id FROM lead_sources WHERE id=?',[sid]);if(!c||!src)return res.status(400).json({error:'Consultor ou origem inválidos'});await dbRun('UPDATE leads SET lead_date=?,consultant_id=?,quantity=?,lead_source_id=?,state=? WHERE id=?',[date,cid,qty,sid,state,l.id]);res.json({ok:true})}catch(e){console.error(e);res.status(500).json({error:'Não foi possível atualizar os leads'})}
});

async function analytics(req){
  const month=validMonth(req.query.month);const consultantId=Number(req.query.consultant_id||0)||null;const state=normalizeState(req.query.state)||null;const sourceId=Number(req.query.lead_source_id||0)||null;
  const salesFilter=dateFilterParts({month,consultantId,state,sourceId},'s');
  const leadFilter=dateFilterParts({month,consultantId,state,sourceId},'l');
  const salesWhere=salesFilter.where.replace(/s\.date/g,'s.sale_date');
  const leadWhere=leadFilter.where.replace(/l\.date/g,'l.lead_date');
  const salesParams=salesFilter.params,leadParams=leadFilter.params;
  const summary=await dbGet(`SELECT COALESCE(SUM(s.amount),0) revenue,COUNT(s.id) sales_count FROM sales s WHERE 1=1${salesWhere}`,salesParams);
  const leads=await dbGet(`SELECT COALESCE(SUM(l.quantity),0) leads FROM leads l WHERE 1=1${leadWhere}`,leadParams);
  const goalWhere=consultantId?' AND u.id=?':'';const goalParams=consultantId?[consultantId]:[];const goal=await dbGet(`SELECT COALESCE(SUM(u.goal),0) goal FROM users u WHERE u.role='consultant' AND u.active=1${goalWhere}`,goalParams);
  const bySource=await dbAll(`WITH source_leads AS (
      SELECT l.lead_source_id, COALESCE(SUM(l.quantity),0) leads
      FROM leads l WHERE 1=1${leadWhere}
      GROUP BY l.lead_source_id
    ), source_sales AS (
      SELECT s.lead_source_id, COUNT(s.id) sales, COALESCE(SUM(s.amount),0) revenue
      FROM sales s WHERE 1=1${salesWhere}
      GROUP BY s.lead_source_id
    )
    SELECT ls.id,ls.name,COALESCE(sl.leads,0) leads,COALESCE(ss.sales,0) sales,COALESCE(ss.revenue,0) revenue
    FROM lead_sources ls
    LEFT JOIN source_leads sl ON sl.lead_source_id=ls.id
    LEFT JOIN source_sales ss ON ss.lead_source_id=ls.id
    WHERE ls.active=1
    ORDER BY revenue DESC,sales DESC,ls.name ASC`,[...leadParams,...salesParams]);
  const byState=await dbAll(`WITH state_leads AS (
      SELECT l.state, COALESCE(SUM(l.quantity),0) leads
      FROM leads l WHERE 1=1${leadWhere}
      GROUP BY l.state
    ), state_sales AS (
      SELECT s.state, COUNT(s.id) sales, COALESCE(SUM(s.amount),0) revenue
      FROM sales s WHERE 1=1${salesWhere}
      GROUP BY s.state
    )
    SELECT COALESCE(sl.state,ss.state) state,COALESCE(sl.leads,0) leads,COALESCE(ss.sales,0) sales,COALESCE(ss.revenue,0) revenue
    FROM state_leads sl FULL OUTER JOIN state_sales ss ON ss.state=sl.state
    WHERE COALESCE(sl.state,ss.state) IS NOT NULL AND COALESCE(sl.state,ss.state)<>''
    ORDER BY revenue DESC,sales DESC,state ASC`,[...leadParams,...salesParams]);
  const consultants=await dbAll(`SELECT u.id,u.name,u.goal,u.photo_data,
    (SELECT COALESCE(SUM(l.quantity),0) FROM leads l WHERE l.consultant_id=u.id${leadWhere}) leads,
    (SELECT COUNT(s.id) FROM sales s WHERE s.consultant_id=u.id${salesWhere}) sales,
    (SELECT COALESCE(SUM(s.amount),0) FROM sales s WHERE s.consultant_id=u.id${salesWhere}) revenue
    FROM users u WHERE u.role='consultant' AND u.active=1 ${consultantId?'AND u.id=?':''}
    ORDER BY revenue DESC,sales DESC,u.name ASC`,[...leadParams,...salesParams,...salesParams,...(consultantId?[consultantId]:[])]);
  const decorate=r=>({...r,leads:Number(r.leads||0),sales:Number(r.sales||0),revenue:Number(r.revenue||0),conversion:Number(r.leads)?Number(r.sales)/Number(r.leads)*100:0,goal:Number(r.goal||0),goal_pct:Number(r.goal)?Number(r.revenue)/Number(r.goal)*100:0});
  return {month,summary:{revenue:Number(summary.revenue||0),sales:Number(summary.sales_count||0),goal:Number(goal.goal||0),leads:Number(leads.leads||0),conversion:Number(leads.leads)?Number(summary.sales||summary.sales_count||0)/Number(leads.leads)*100:0},bySource:bySource.map(decorate),byState:byState.map(decorate),consultants:consultants.map(decorate)};
}
app.get('/api/analytics',auth,async(req,res)=>{
  try{
    if(req.user.role!=='admin'){
      const clone={...req.query,consultant_id:req.user.id};
      req.query=clone;
    }
    res.json(await analytics(req));
  }catch(e){console.error('analytics',e);res.status(500).json({error:'Não foi possível carregar os indicadores'})}
});



function dateOnly(d){return new Date(`${d}T12:00:00Z`)}
function addDaysISO(date,days){const d=new Date(date.getTime());d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10)}
function weekStart(date){const d=dateOnly(date);const day=d.getUTCDay();const diff=day===0?-6:1-day;return addDaysISO(d,diff)}
async function prizeData(month, consultantId=null){
  const rules=await dbAll('SELECT * FROM prize_rules WHERE active=1 ORDER BY category,min_amount DESC,id');
  const prizeStartDate=String(process.env.PRIZE_START_DATE||'2026-09-21');
  const teamBSalesStart=String(process.env.TEAM_B_PRIZE_START_DATE||'2026-09-21');
  // Equipe A mantém as premiações normais, inclusive sobre vendas anteriores.
  // Equipe B só recebe premiação sobre vendas feitas a partir da data configurada.
  const sales=await dbAll(`SELECT s.*,u.name consultant_name,u.team FROM sales s JOIN users u ON u.id=s.consultant_id
    WHERE substr(s.sale_date,1,7)=? AND (u.team='A' OR (u.team='B' AND s.sale_date>=?))
    ORDER BY s.sale_date ASC,s.id ASC`,[month,teamBSalesStart]);
  const consultants=consultantId?await dbAll("SELECT id,name,goal,photo_data FROM users WHERE id=? AND role='consultant'",[consultantId]):await dbAll("SELECT id,name,goal,photo_data FROM users WHERE role='consultant' AND active=1 ORDER BY name");
  const out=consultants.map(c=>({id:c.id,name:c.name,goal:Number(c.goal||0),photo_data:c.photo_data||null,revenue:0,gross_revenue:0,sales_count:0,awards:[],lost:[],total_prize:0}));
  const byId=new Map(out.map(x=>[x.id,x])); const byConsultant=new Map();
  for(const s of sales){const c=byId.get(s.consultant_id);if(!c)continue;c.revenue+=Number(s.amount||0);c.gross_revenue+=(s.gross_amount==null?0:Number(s.gross_amount));c.sales_count++;if(!byConsultant.has(c.id))byConsultant.set(c.id,[]);byConsultant.get(c.id).push(s);}
  for(const c of out){
    const ss=byConsultant.get(c.id)||[];
    // Sale-based: for a sale, take the highest matching prize in its payment bracket.
    for(const s of ss){
      let matches=[]; let outsideInstallment=false;
      const prizeBase=s.gross_amount===null||s.gross_amount===undefined?null:Number(s.gross_amount);
      if(prizeBase===null) continue;
      const prizePayment=effectivePrizePayment(s);
      if(prizePayment){
        matches=rules.filter(r=>r.category==='sale' && prizeBase>=Number(r.min_amount||0) && (!r.payment_type || r.payment_type===prizePayment.payment_type) &&
          (!r.max_installments || (prizePayment.payment_type==='parcelado' && Number(prizePayment.installments)<=Number(r.max_installments) && (!r.min_installments || Number(prizePayment.installments)>=Number(r.min_installments)))));
        // Se o parcelamento não estiver em nenhuma faixa configurada (ex.: 10x),
        // aplica 50% da maior premiação que o valor da venda atingiria no parcelado.
        if(!matches.length && prizePayment?.payment_type==='parcelado'){
          const fallback=rules.filter(r=>r.category==='sale' && (!r.payment_type || r.payment_type==='parcelado') && prizeBase>=Number(r.min_amount||0) && prizePayment?.payment_type==='parcelado')
            .sort((a,b)=>Number(b.min_amount)-Number(a.min_amount)||Number(b.prize_amount)-Number(a.prize_amount))[0];
          if(fallback){ matches=[fallback]; outsideInstallment=true; }
        }
      }
      const best=matches.sort((a,b)=>Number(b.min_amount)-Number(a.min_amount)||Number(b.prize_amount)-Number(a.prize_amount))[0];
      if(best && Number(best.prize_amount)>0){
        const awardAmount=outsideInstallment?Number((Number(best.prize_amount)/2).toFixed(2)):Number(best.prize_amount);
        const detail=outsideInstallment
          ?`Venda de ${moneyJs(prizeBase)} em ${prizePayment?.installments||s.installments}x — fora das faixas configuradas, 50% da premiação base`
          :`Venda de ${moneyJs(prizeBase)}${prizePayment?.payment_type==='parcelado'?` em ${prizePayment.installments}x`:' à vista'}`;
        c.awards.push({rule_id:best.id,rule_name:outsideInstallment?`${best.name} — 50% fora da faixa`:best.name,amount:awardAmount,date:s.sale_date,reason:detail,estimated:false});
      }
    }
    // Daily and weekly accumulations.
    const days={}; ss.forEach(s=>(days[s.sale_date]??=[]).push(s));
    for(const [day,ds] of Object.entries(days)){
      const total=ds.reduce((a,s)=>a+(s.gross_amount==null?0:Number(s.gross_amount)),0);
      const best=ds.length>=2 ? rules.filter(r=>r.category==='daily'&&total>=Number(r.min_amount)).sort((a,b)=>Number(b.min_amount)-Number(a.min_amount))[0] : null;
      if(best&&Number(best.prize_amount)>0)c.awards.push({rule_id:best.id,rule_name:best.name,amount:Number(best.prize_amount),date:day,reason:`Acumulado do dia: ${moneyJs(total)}`});
    }
    const weeks={};ss.forEach(s=>{const w=weekStart(s.sale_date);(weeks[w]??=[]).push(s)});
    for(const [w,ws] of Object.entries(weeks)){
      const total=ws.reduce((a,s)=>a+(s.gross_amount==null?0:Number(s.gross_amount)),0);
      const best=ws.length>=2 ? rules.filter(r=>r.category==='weekly'&&total>=Number(r.min_amount)).sort((a,b)=>Number(b.min_amount)-Number(a.min_amount))[0] : null;
      if(best&&Number(best.prize_amount)>0)c.awards.push({rule_id:best.id,rule_name:best.name,amount:Number(best.prize_amount),date:w,reason:`Acumulado semanal: ${moneyJs(total)}`});
      const weekdays=new Set(ws.map(s=>dateOnly(s.sale_date).getUTCDay()).filter(d=>d>=1&&d<=5));
      const all=rules.filter(r=>r.category==='all_days'&&weekdays.size>=5).sort((a,b)=>Number(b.prize_amount)-Number(a.prize_amount))[0];
      if(all&&Number(all.prize_amount)>0)c.awards.push({rule_id:all.id,rule_name:all.name,amount:Number(all.prize_amount),date:w,reason:'Venda registrada em todos os dias úteis da semana'});
    }
  }
  // Daily meta ranking across all consultants in selected month.
  const dailyRule1=rules.find(r=>r.category==='daily_rank' && /1º/.test(r.name)); const dailyRule2=rules.find(r=>r.category==='daily_rank' && /2º/.test(r.name));
  if(dailyRule1||dailyRule2){
    const activeConsultants=await dbAll("SELECT id FROM users WHERE role='consultant' AND active=1");
    const activeIds=new Set(activeConsultants.map(x=>Number(x.id))); const byDay={};
    sales.filter(s=>activeIds.has(Number(s.consultant_id))).forEach(s=>{(byDay[s.sale_date]??={});byDay[s.sale_date][s.consultant_id]=(byDay[s.sale_date][s.consultant_id]||0)+(s.gross_amount==null?0:Number(s.gross_amount))});
    for(const [day,vals] of Object.entries(byDay)){
      // A meta de R$ 7.500 é da EQUIPE no dia. Depois de bater a meta,
      // 1º e 2º lugares são definidos pelo faturamento bruto individual.
      const teamTotal=Object.values(vals).reduce((a,v)=>a+Number(v||0),0);
      const teamTarget=Number(dailyRule1?.min_amount||dailyRule2?.min_amount||7500);
      if(teamTotal<teamTarget) continue;
      const hit=Object.entries(vals).filter(([,v])=>Number(v)>0).sort((a,b)=>Number(b[1])-Number(a[1]));
      if(hit[0]&&dailyRule1){const c=byId.get(Number(hit[0][0]));if(c&&Number(dailyRule1.prize_amount)>0)c.awards.push({rule_id:dailyRule1.id,rule_name:dailyRule1.name,amount:Number(dailyRule1.prize_amount),date:day,reason:`1º lugar do dia — equipe fez ${moneyJs(teamTotal)}`})}
      if(hit[1]&&dailyRule2){const c=byId.get(Number(hit[1][0]));if(c&&Number(dailyRule2.prize_amount)>0)c.awards.push({rule_id:dailyRule2.id,rule_name:dailyRule2.name,amount:Number(dailyRule2.prize_amount),date:day,reason:`2º lugar do dia — equipe fez ${moneyJs(teamTotal)}`})}
    }
  }
  out.forEach(c=>{c.total_prize=c.awards.reduce((a,x)=>a+Number(x.amount),0);c.awards.sort((a,b)=>String(b.date).localeCompare(String(a.date))||b.amount-a.amount)});
  out.sort((a,b)=>b.total_prize-a.total_prize||b.revenue-a.revenue||a.name.localeCompare(b.name));
  return {month,consultants:out,rules};
}
function moneyJs(v){return new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(Number(v)||0)}
app.get('/api/prizes',auth,async(req,res)=>{
  try{const month=validMonth(req.query.month);const cid=['admin','ranking_admin'].includes(req.user.role)?(Number(req.query.consultant_id||0)||null):req.user.id;res.json(await prizeData(month,cid));}
  catch(e){console.error('prizes',e);res.status(500).json({error:'Não foi possível calcular as premiações'})}
});
app.get('/api/prize-rules',auth,async(req,res)=>res.json(await dbAll('SELECT * FROM prize_rules ORDER BY active DESC,category,min_amount,id')));
app.post('/api/prize-rules',auth,adminOnly,async(req,res)=>{
  try{const b=req.body||{};if(!b.name||!b.category)return res.status(400).json({error:'Nome e categoria são obrigatórios'});const r=await dbRun('INSERT INTO prize_rules(name,category,frequency,payment_type,min_amount,max_installments,min_installments,min_days,prize_amount,active,description) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[String(b.name).trim(),String(b.category),String(b.frequency||b.category),b.payment_type||null,Number(b.min_amount||0),b.max_installments?Number(b.max_installments):null,b.min_installments?Number(b.min_installments):null,b.min_days?Number(b.min_days):null,Number(b.prize_amount||0),b.active===false?0:1,b.description||null]);res.json({id:r.lastID})}catch(e){res.status(400).json({error:'Não foi possível cadastrar a regra'})}
});
app.patch('/api/prize-rules/:id',auth,adminOnly,async(req,res)=>{
  try{const r=await dbGet('SELECT * FROM prize_rules WHERE id=?',[req.params.id]);if(!r)return res.status(404).json({error:'Regra não encontrada'});const b=req.body||{};await dbRun('UPDATE prize_rules SET name=?,category=?,frequency=?,payment_type=?,min_amount=?,max_installments=?,min_installments=?,min_days=?,prize_amount=?,active=?,description=? WHERE id=?',[String(b.name??r.name),String(b.category??r.category),String(b.frequency??r.frequency),b.payment_type??r.payment_type,Number(b.min_amount??r.min_amount),b.max_installments===null?null:Number(b.max_installments??r.max_installments)||null,b.min_installments===null?null:Number(b.min_installments??r.min_installments)||null,b.min_days===null?null:Number(b.min_days??r.min_days)||null,Number(b.prize_amount??r.prize_amount),b.active===undefined?r.active:(b.active?1:0),b.description??r.description,r.id]);res.json({ok:true})}catch(e){res.status(400).json({error:'Não foi possível atualizar a regra'})}
});
app.get('/api/supervisor-prizes',auth,rankingAdminOrAdmin,async(req,res)=>{
  const month=validMonth(req.query.month);
  const cfg=await dbAll('SELECT * FROM supervisor_prize_settings ORDER BY id');
  const by=Object.fromEntries(cfg.map(x=>[x.name,{value:Number(x.value),active:!!x.active}]));
  const allTeamsStart=String(process.env.SUPERVISOR_ALL_TEAMS_START_DATE||'2026-09-20');
  // Regra do supervisor: antes da data de virada, somente a Equipe A conta.
  // A partir da data de virada, Equipes A + B contam juntas. Vendas antigas da B não entram.
  const rows=await dbAll(`
    SELECT s.sale_date,COALESCE(SUM(s.gross_amount),0) revenue,COUNT(*) sales
    FROM sales s JOIN users u ON u.id=s.consultant_id
    WHERE substr(s.sale_date,1,7)=?
      AND (u.team='A' OR (u.team='B' AND s.sale_date>=?))
    GROUP BY s.sale_date ORDER BY s.sale_date
  `,[month,allTeamsStart]);
  const dailyGoal=by.daily_goal?.value??5715, weeklyGoal=by.weekly_goal?.value??28600;
  const dailyPrize=by.daily_prize?.value??50, weeklyPrize=by.weekly_prize?.value??100;
  const calcPrize=(revenue,goal,base)=>{const multiples=Math.floor(Number(revenue)/Number(goal));return multiples>0?multiples*Number(base):0};
  const daily=rows.map(r=>{const revenue=Number(r.revenue),prize=calcPrize(revenue,dailyGoal,dailyPrize);return {...r,revenue,sales:Number(r.sales),hit:revenue>=dailyGoal,multiplier:dailyGoal>0?Math.floor(revenue/dailyGoal):0,prize}});
  const weeks={};rows.forEach(r=>(weeks[weekStart(r.sale_date)]??=[]).push(r));
  const weekly=Object.entries(weeks).map(([start,rs])=>{
    const revenue=rs.reduce((a,r)=>a+Number(r.revenue),0),prize=calcPrize(revenue,weeklyGoal,weeklyPrize);
    return {week_start:start,revenue,hit:revenue>=weeklyGoal,multiplier:weeklyGoal>0?Math.floor(revenue/weeklyGoal):0,prize};
  });
  const totalDaily=daily.reduce((a,r)=>a+Number(r.prize),0), totalWeekly=weekly.reduce((a,r)=>a+Number(r.prize),0);
  return res.json({month,all_teams_start:allTeamsStart,settings:by,daily,weekly,total_daily_prize:totalDaily,total_weekly_prize:totalWeekly,total_prize:totalDaily+totalWeekly});
});
app.patch('/api/supervisor-prizes/:name',auth,adminOnly,async(req,res)=>{const n=String(req.params.name);if(!['daily_goal','daily_prize','weekly_goal','weekly_prize'].includes(n))return res.status(400).json({error:'Configuração inválida'});const v=Number(req.body?.value);if(!Number.isFinite(v)||v<0)return res.status(400).json({error:'Valor inválido'});await dbRun('UPDATE supervisor_prize_settings SET value=?,active=1,updated_at=CURRENT_TIMESTAMP WHERE name=?',[v,n]);res.json({ok:true})});
app.get('/api/prize-losses',auth,rankingAdminOrAdmin,async(req,res)=>{const month=validMonth(req.query.month);const rows=await dbAll(`SELECT pl.*,u.name consultant_name,pr.name rule_name FROM prize_losses pl JOIN users u ON u.id=pl.consultant_id LEFT JOIN prize_rules pr ON pr.id=pl.rule_id WHERE pl.period_month=? ORDER BY pl.loss_date DESC,pl.id DESC`,[month]);res.json(rows)});
app.post('/api/prize-losses',auth,adminOnly,async(req,res)=>{const b=req.body||{};if(!b.consultant_id||!b.reason||!validDate(b.loss_date))return res.status(400).json({error:'Consultor, data e motivo são obrigatórios'});const r=await dbRun('INSERT INTO prize_losses(consultant_id,rule_id,period_month,loss_date,reason,notes) VALUES(?,?,?,?,?,?)',[Number(b.consultant_id),b.rule_id?Number(b.rule_id):null,String(b.period_month||b.loss_date.slice(0,7)),b.loss_date,String(b.reason).trim(),b.notes||null]);res.json({id:r.lastID})});
app.delete('/api/prize-losses/:id',auth,adminOnly,async(req,res)=>{await dbRun('DELETE FROM prize_losses WHERE id=?',[req.params.id]);res.json({ok:true})});

init().then(()=>app.listen(PORT,'0.0.0.0',()=>console.log(`APS Ranking rodando em 0.0.0.0:${PORT}`))).catch(err=>{console.error('Falha ao iniciar banco:',err);process.exit(1)});
