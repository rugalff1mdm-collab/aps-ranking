require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'TROQUE-ESTE-SEGREDO-EM-PRODUCAO';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'aps.db');

const db = new sqlite3.Database(DB_PATH);
const dbRun = (sql, params=[]) => new Promise((resolve,reject)=>db.run(sql,params,function(err){err?reject(err):resolve(this)}));
const dbGet = (sql, params=[]) => new Promise((resolve,reject)=>db.get(sql,params,(err,row)=>err?reject(err):resolve(row)));
const dbAll = (sql, params=[]) => new Promise((resolve,reject)=>db.all(sql,params,(err,rows)=>err?reject(err):resolve(rows)));

app.use(express.json({limit:'4mb'}));
app.use(express.static(path.join(__dirname,'public')));

async function tableExists(table){
  const row=await dbGet("SELECT name FROM sqlite_master WHERE type='table' AND name=?",[table]);
  return !!row;
}
async function hasColumn(table,column){
  if(!(await tableExists(table))) return false;
  const rows=await dbAll(`PRAGMA table_info(${table})`);
  return rows.some(r=>r.name===column);
}
function backupDatabase(){
  if(!fs.existsSync(DB_PATH)) return null;
  const dir=path.join(__dirname,'backups');
  fs.mkdirSync(dir,{recursive:true});
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const dest=path.join(dir,`aps-${stamp}.db`);
  fs.copyFileSync(DB_PATH,dest);
  return dest;
}

async function init(){
  const existed=fs.existsSync(DB_PATH);
  await dbRun('PRAGMA foreign_keys = ON');
  if(existed){
    const schemaNeedsBackup=!(await tableExists('lead_sources')) || !(await tableExists('leads')) || !(await hasColumn('users','photo_data')) || !(await hasColumn('sales','state')) || !(await hasColumn('sales','lead_source_id'));
    if(schemaNeedsBackup) backupDatabase();
  }
  await dbRun(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'consultant',
    active INTEGER NOT NULL DEFAULT 1,
    goal REAL NOT NULL DEFAULT 0,
    photo_data TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    consultant_id INTEGER NOT NULL,
    client_name TEXT NOT NULL,
    amount REAL NOT NULL,
    sale_date TEXT NOT NULL,
    state TEXT,
    lead_source_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (consultant_id) REFERENCES users(id)
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS lead_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_date TEXT NOT NULL,
    consultant_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    lead_source_id INTEGER NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (consultant_id) REFERENCES users(id),
    FOREIGN KEY (lead_source_id) REFERENCES lead_sources(id)
  )`);

  if(!(await hasColumn('users','photo_data'))) await dbRun('ALTER TABLE users ADD COLUMN photo_data TEXT');
  if(!(await hasColumn('sales','state'))) await dbRun('ALTER TABLE sales ADD COLUMN state TEXT');
  if(!(await hasColumn('sales','lead_source_id'))) await dbRun('ALTER TABLE sales ADD COLUMN lead_source_id INTEGER');

  for(const name of ['Daniel','Tom','Remalho']){
    await dbRun('INSERT OR IGNORE INTO lead_sources (name,active) VALUES (?,1)',[name]);
  }
  const email=(process.env.ADMIN_EMAIL || 'admin@aps.local').trim().toLowerCase();
  const password=process.env.ADMIN_PASSWORD || '123456';
  const existing=await dbGet('SELECT id FROM users WHERE role="admin" ORDER BY id LIMIT 1');
  if(!existing){
    const hash=await bcrypt.hash(password,10);
    await dbRun('INSERT INTO users (name,email,password_hash,role,goal) VALUES (?,?,?,?,?)',['Administrador',email,hash,'admin',0]);
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
function validMonth(value){return /^\d{4}-\d{2}$/.test(value||'')?value:new Date().toISOString().slice(0,7)}
function validDate(value){return /^\d{4}-\d{2}-\d{2}$/.test(value||'')}
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
  const u=await dbGet('SELECT id,name,email,role,goal,photo_data FROM users WHERE id=?',[req.user.id]);
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
  const month=validMonth(req.query.month); const {where:rawWhere,params}=dateFilterParts({month},'s');
  const where=rawWhere.replace(/s\.date/g,'s.sale_date');
  const rows=await dbAll(`SELECT u.id,u.name,u.goal,u.photo_data,COALESCE(SUM(s.amount),0) revenue,COUNT(s.id) sales_count
    FROM users u LEFT JOIN sales s ON s.consultant_id=u.id ${where?where.replace(' AND s.',' AND s.'):''}
    WHERE u.role='consultant' AND u.active=1 GROUP BY u.id ORDER BY revenue DESC,sales_count DESC,u.name ASC`,params);
  res.json(rows.map(r=>({...r,revenue:Number(r.revenue||0),sales_count:Number(r.sales_count||0),avg_ticket:r.sales_count?Number(r.revenue)/Number(r.sales_count):0,goal_pct:r.goal?Number(r.revenue)/Number(r.goal)*100:0})));
});

app.get('/api/sales',auth,async(req,res)=>{
  const month=validMonth(req.query.month); const p=[month]; let extra='';
  if(req.user.role!=='admin'){extra=' AND s.consultant_id=?';p.push(req.user.id)}
  const rows=await dbAll(`SELECT s.id,s.client_name,s.amount,s.sale_date,s.state,s.lead_source_id,ls.name lead_source_name,u.name consultant_name,u.id consultant_id
    FROM sales s JOIN users u ON u.id=s.consultant_id LEFT JOIN lead_sources ls ON ls.id=s.lead_source_id
    WHERE substr(s.sale_date,1,7)=?${extra} ORDER BY s.sale_date DESC,s.id DESC`,p);
  res.json(rows.map(r=>({...r,amount:Number(r.amount)})));
});

app.post('/api/sales',auth,async(req,res)=>{
  try{
    const {client_name,amount,sale_date}=req.body||{}; const value=Number(amount); const state=normalizeState(req.body?.state); const sourceId=Number(req.body?.lead_source_id||0);
    if(!client_name || !Number.isFinite(value) || value<=0 || !validDate(sale_date) || !state || !STATES.includes(state) || !sourceId) return res.status(400).json({error:'Cliente, valor, data, estado e origem do lead são obrigatórios'});
    const consultantId=req.user.role==='admin'?Number(req.body.consultant_id||0):req.user.id;
    if(!consultantId) return res.status(400).json({error:'Informe o consultor'});
    const c=await dbGet('SELECT id FROM users WHERE id=? AND role="consultant" AND active=1',[consultantId]);
    const source=await dbGet('SELECT id FROM lead_sources WHERE id=? AND active=1',[sourceId]);
    if(!c) return res.status(400).json({error:'Consultor inválido ou inativo'});
    if(!source) return res.status(400).json({error:'Origem de lead inválida ou inativa'});
    const result=await dbRun('INSERT INTO sales (consultant_id,client_name,amount,sale_date,state,lead_source_id) VALUES (?,?,?,?,?,?)',[consultantId,String(client_name).trim(),value,sale_date,state,sourceId]);
    res.json({id:result.lastID});
  }catch(e){console.error(e);res.status(500).json({error:'Não foi possível lançar a venda'})}
});

app.delete('/api/sales/:id',auth,adminOnly,async(req,res)=>{
  const sale=await dbGet('SELECT id FROM sales WHERE id=?',[req.params.id]);
  if(!sale) return res.status(404).json({error:'Venda não encontrada'});
  await dbRun('DELETE FROM sales WHERE id=?',[req.params.id]);
  res.json({ok:true});
});

app.get('/api/users',auth,adminOnly,async(req,res)=>{
  const rows=await dbAll(`SELECT id,name,email,role,active,goal,photo_data,created_at FROM users ORDER BY role DESC,name ASC`);res.json(rows);
});
app.post('/api/users',auth,adminOnly,async(req,res)=>{
  try{
    const {name,email,password,goal,photo_data}=req.body||{};
    if(!name||!email||!password) return res.status(400).json({error:'Nome, e-mail e senha são obrigatórios'});
    if(String(password).length<6) return res.status(400).json({error:'A senha deve ter pelo menos 6 caracteres'});
    const goalValue=Number(goal||0);if(!Number.isFinite(goalValue)||goalValue<0) return res.status(400).json({error:'Meta inválida'});
    const hash=await bcrypt.hash(String(password),10);const result=await dbRun('INSERT INTO users (name,email,password_hash,role,goal,photo_data) VALUES (?,?,?,?,?,?)',[String(name).trim(),String(email).trim().toLowerCase(),hash,'consultant',goalValue,photo_data||null]);res.json({id:result.lastID});
  }catch(e){res.status(400).json({error:'E-mail já cadastrado ou dados inválidos'})}
});
app.patch('/api/users/:id',auth,adminOnly,async(req,res)=>{
  try{
    const u=await dbGet('SELECT * FROM users WHERE id=?',[req.params.id]);if(!u) return res.status(404).json({error:'Usuário não encontrado'});
    const name=String(req.body?.name??u.name).trim(),goal=Number(req.body?.goal??u.goal),active=req.body?.active===undefined?u.active:(req.body.active?1:0),photo=req.body?.photo_data===undefined?u.photo_data:req.body.photo_data,email=req.body?.email===undefined?u.email:String(req.body.email).trim().toLowerCase();
    if(!name||!email||!Number.isFinite(goal)||goal<0) return res.status(400).json({error:'Nome, e-mail e meta são obrigatórios e válidos'});
    if(req.body?.password){if(String(req.body.password).length<6)return res.status(400).json({error:'A senha deve ter pelo menos 6 caracteres'});const hash=await bcrypt.hash(String(req.body.password),10);await dbRun('UPDATE users SET name=?,email=?,goal=?,active=?,photo_data=?,password_hash=? WHERE id=?',[name,email,goal,active,photo,hash,u.id]);}
    else await dbRun('UPDATE users SET name=?,email=?,goal=?,active=?,photo_data=? WHERE id=?',[name,email,goal,active,photo,u.id]);
    res.json({ok:true});
  }catch(e){if(String(e.message||'').includes('UNIQUE')) return res.status(400).json({error:'Este e-mail já está em uso'});console.error(e);res.status(500).json({error:'Não foi possível atualizar o consultor'});}
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
  const bySource=await dbAll(`SELECT ls.id,ls.name,
    (SELECT COALESCE(SUM(l.quantity),0) FROM leads l WHERE l.lead_source_id=ls.id${leadWhere}) leads,
    (SELECT COUNT(s.id) FROM sales s WHERE s.lead_source_id=ls.id${salesWhere}) sales,
    (SELECT COALESCE(SUM(s.amount),0) FROM sales s WHERE s.lead_source_id=ls.id${salesWhere}) revenue
    FROM lead_sources ls WHERE ls.active=1 ORDER BY revenue DESC,sales DESC,ls.name ASC`,[...leadParams,...salesParams,...salesParams]);
  const byState=await dbAll(`SELECT x.state,
    (SELECT COALESCE(SUM(l.quantity),0) FROM leads l WHERE l.state=x.state${leadWhere}) leads,
    (SELECT COUNT(s.id) FROM sales s WHERE s.state=x.state${salesWhere}) sales,
    (SELECT COALESCE(SUM(s.amount),0) FROM sales s WHERE s.state=x.state${salesWhere}) revenue
    FROM (SELECT DISTINCT state FROM sales WHERE state IS NOT NULL AND state<>'' UNION SELECT DISTINCT state FROM leads WHERE state IS NOT NULL AND state<>'') x
    ORDER BY revenue DESC,sales DESC,x.state ASC`,[...leadParams,...salesParams,...salesParams]);
  const consultants=await dbAll(`SELECT u.id,u.name,u.goal,u.photo_data,
    (SELECT COALESCE(SUM(l.quantity),0) FROM leads l WHERE l.consultant_id=u.id${leadWhere}) leads,
    (SELECT COUNT(s.id) FROM sales s WHERE s.consultant_id=u.id${salesWhere}) sales,
    (SELECT COALESCE(SUM(s.amount),0) FROM sales s WHERE s.consultant_id=u.id${salesWhere}) revenue
    FROM users u WHERE u.role='consultant' AND u.active=1 ${consultantId?'AND u.id=?':''}
    ORDER BY revenue DESC,sales DESC,u.name ASC`,[...leadParams,...salesParams,...(consultantId?[consultantId]:[])]);
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


init().then(()=>app.listen(PORT,()=>console.log(`APS Ranking rodando em http://localhost:${PORT}`))).catch(err=>{console.error('Falha ao iniciar banco:',err);process.exit(1)});
