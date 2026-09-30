  const result = await dbQuery(pgSql(sql, params), params);
  return result.rows;
};
const dbRun = async (sql, params=[]) => {
  const isInsert = /^\s*INSERT\b/i.test(sql);
  const finalSql = isInsert && !/\bRETURNING\b/i.test(sql) ? `${pgSql(sql, params)} RETURNING id` : pgSql(sql, params);
  const result = await dbQuery(finalSql, params);
  return { lastID: result.rows[0]?.id, rowCount: result.rowCount, rows: result.rows };
};

app.use(express.json({limit:'4mb'}));

// Nunca deixe respostas da API de ranking/vendas em cache.
// No Cloudflare, uma resposta antiga pode sobreviver a uma exclusão/edição
// e fazer parecer que uma venda apagada ainda está no ranking.
app.use((req,res,next)=>{
  if(req.path.startsWith('/api/')){
    res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma','no-cache');
    res.setHeader('Expires','0');
  }
  next();
});
if (!IS_CF_WORKER) {
  app.use((req,res,next)=>{if(req.path==='/'||req.path.endsWith('.html')||req.path.startsWith('/api/'))res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');next()});
  app.get('/',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html'),{headers:{'Cache-Control':'no-store, no-cache, must-revalidate, proxy-revalidate','Pragma':'no-cache','Expires':'0'}}));
  app.get('/api/health',async(req,res)=>{
    try{
      await dbGet('SELECT 1 AS ok');
      res.status(200).json({ok:true});
    }catch(err){
      console.error('Healthcheck DB error:',err);
      res.status(503).json({ok:false,error:'database_unavailable'});
    }
  });
  app.use(express.static(path.join(__dirname,'public'),{setHeaders:(res,filePath)=>{if(filePath.endsWith('.html')){res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');res.setHeader('Pragma','no-cache');res.setHeader('Expires','0')}}}));
}
