const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA = path.join('/tmp', 'foden-data');
const UPLOADS = path.join('/tmp', 'foden-uploads');

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(UPLOADS, { recursive: true });

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'CHANGE_ME';
const WHATSAPP = process.env.WHATSAPP_NUMBER || '201020477414';
const KEY = Buffer.from(process.env.CREDENTIAL_KEY || '', 'base64');

if (KEY.length !== 32) console.warn('WARNING: CREDENTIAL_KEY must decode to exactly 32 bytes.');

const files = {
  orders:path.join(DATA,'orders.json'),
  visitors:path.join(DATA,'visitors.json'),
  packages:path.join(DATA,'packages.json'),
  secrets:path.join(DATA,'secrets.json')
};
const defaults = {
  orders:[], visitors:{active:{}, total:0, today:0, exited:0, day:new Date().toISOString().slice(0,10)},
  packages:[
    ...[[110,60],[231,120],[341,165],[460,220],[583,270],[1040,470],[1188,540],[2002,900],[2420,1050],[3000,1350],[5000,2190],[5600,2450]].map(x=>({type:'id',diamonds:x[0],price:x[1],active:true})),
    ...[[110,55],[310,145],[520,220],[1060,380],[2180,760],[3240,1140],[5600,1850],[11200,3700]].map(x=>({type:'account',diamonds:x[0],price:x[1],active:true}))
  ],
  secrets:{}
};
function read(k){
  try{return JSON.parse(fs.readFileSync(files[k],'utf8'))}catch{return structuredClone(defaults[k])}
}
function write(k,v){fs.writeFileSync(files[k],JSON.stringify(v,null,2))}
for(const k of Object.keys(files)){ if(!fs.existsSync(files[k])) write(k,defaults[k]); }

app.use(express.json({limit:'2mb'}));
app.use(express.urlencoded({extended:true}));
app.use('/uploads',express.static(UPLOADS));
app.use(express.static(ROOT));

const upload = multer({
  storage:multer.diskStorage({
    destination:(_,__,cb)=>cb(null,UPLOADS),
    filename:(_,file,cb)=>{
      const ext=path.extname(file.originalname).toLowerCase();
      cb(null,crypto.randomUUID()+ext);
    }
  }),
  limits:{fileSize:5*1024*1024},
  fileFilter:(_,file,cb)=>cb(null,/^image\/(jpeg|png|webp)$/.test(file.mimetype))
});

function auth(req,res,next){
  if(!ADMIN_TOKEN || req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`)
    return res.status(401).json({error:'unauthorized'});
  next();
}
function now(){return Date.now()}
function cleanupVisitors(){
  const v=read('visitors'), t=now(), timeout=35000;
  for(const [id,ts] of Object.entries(v.active)) if(t-ts>timeout) delete v.active[id];
  const today=new Date().toISOString().slice(0,10);
  if(v.day!==today){v.day=today;v.today=0;v.exited=0;}
  write('visitors',v); return v;
}
function visitorStats(){
  const v=cleanupVisitors();
  return {online:Object.keys(v.active).length,total:v.total,today:v.today,exited:v.exited};
}

app.post('/api/visitor/heartbeat',(req,res)=>{
  const id=String(req.body?.id||'').slice(0,100); if(!id)return res.status(400).json({error:'id'});
  const v=cleanupVisitors(); if(!v.active[id]){v.total++;v.today++;}
  v.active[id]=now(); write('visitors',v); res.json(visitorStats());
});
app.post('/api/visitor/exit',(req,res)=>{
  const id=String(req.body?.id||'').slice(0,100); const v=cleanupVisitors();
  if(id&&v.active[id]){delete v.active[id];v.exited++;write('visitors',v);}
  res.json(visitorStats());
});
app.get('/api/visitor/stats',(req,res)=>res.json(visitorStats()));

function enc(s){
  if(KEY.length!==32) throw new Error('CREDENTIAL_KEY not configured');
  const iv=crypto.randomBytes(12), c=crypto.createCipheriv('aes-256-gcm',KEY,iv);
  const d=Buffer.concat([c.update(String(s),'utf8'),c.final()]);
  return {iv:iv.toString('base64'),data:d.toString('base64'),tag:c.getAuthTag().toString('base64')};
}
function dec(x){
  const d=crypto.createDecipheriv('aes-256-gcm',KEY,Buffer.from(x.iv,'base64'));
  d.setAuthTag(Buffer.from(x.tag,'base64'));
  return Buffer.concat([d.update(Buffer.from(x.data,'base64')),d.final()]).toString('utf8');
}
function newOrderId(){return 'FD-'+Date.now().toString(36).toUpperCase()+'-'+crypto.randomBytes(2).toString('hex').toUpperCase();}

app.get('/api/packages',(req,res)=>{
  res.json(read('packages').filter(p=>p.active));
});

app.post('/api/orders',upload.single('receipt'),(req,res)=>{
  const {type,diamonds,price,playerId,username,password,customerName}=req.body;
  if(!['id','account'].includes(type))return res.status(400).json({error:'نوع شحن غير صحيح'});
  if(!diamonds||!price)return res.status(400).json({error:'بيانات الباقة ناقصة'});
  if(type==='id' && !String(playerId||'').trim())return res.status(400).json({error:'UID مطلوب'});
  if(type==='account' && (!String(username||'').trim() || !String(password||'')))return res.status(400).json({error:'بيانات الحساب مطلوبة'});
  const id=newOrderId();
  const orders=read('orders');
  const order={
    id,type,diamonds:Number(diamonds),price:Number(price),
    playerId:String(playerId||'').trim(),
    customerName:String(customerName||'').trim(),
    receipt:req.file?'/uploads/'+req.file.filename:null,
    status:'new',createdAt:new Date().toISOString()
  };
  if(type==='account'){
    if(KEY.length!==32)return res.status(500).json({error:'التشفير غير مهيأ على السيرفر'});
    const secrets=read('secrets');
    secrets[id]={username:enc(username),password:enc(password),expiresAt:now()+15*60*1000};
    write('secrets',secrets);
    order.hasCredentials=true;
  }
  orders.unshift(order);write('orders',orders);
  const msg=`طلب FODEN%0Aرقم الطلب: ${encodeURIComponent(id)}%0Aالباقة: ${diamonds} جوهرة%0Aالسعر: ${price} ج.م%0Aنوع الشحن: ${type==='id'?'UID':'حساب'}%0A${type==='id'?`UID: ${encodeURIComponent(playerId)}`:''}`;
  res.json({ok:true,orderId:id,whatsapp:`https://wa.me/${WHATSAPP}?text=${msg}`});
});

app.get('/api/orders',auth,(req,res)=>res.json(read('orders')));
app.patch('/api/orders/:id',auth,(req,res)=>{
  const orders=read('orders'); const o=orders.find(x=>x.id===req.params.id);
  if(!o)return res.status(404).json({error:'not found'});
  const allowed=['new','paid','processing','completed','cancelled'];
  if(!allowed.includes(req.body.status))return res.status(400).json({error:'status'});
  o.status=req.body.status;o.updatedAt=new Date().toISOString();write('orders',orders);res.json(o);
});
app.get('/api/orders/:id/credentials',auth,(req,res)=>{
  const secrets=read('secrets'), s=secrets[req.params.id];
  if(!s||s.expiresAt<now()) {delete secrets[req.params.id];write('secrets',secrets);return res.status(404).json({error:'انتهت صلاحية بيانات الدخول'});}
  const result={username:dec(s.username),password:dec(s.password)};
  delete secrets[req.params.id];write('secrets',secrets);
  res.json(result);
});

app.get('/api/admin/stats',auth,(req,res)=>{
  const orders=read('orders');
  const counts={new:0,paid:0,processing:0,completed:0,cancelled:0};
  for(const o of orders)counts[o.status]=(counts[o.status]||0)+1;
  res.json({visitors:visitorStats(),orders:orders.length,counts});
});
app.get('/api/health',(req,res)=>res.json({ok:true}));

app.get('/admin.html',(req,res)=>{
  res.sendFile(path.join(ROOT,'admin.html'));
});

app.get(/.*/,(req,res)=>res.sendFile(path.join(ROOT,'index.html')));

app.listen(PORT,()=>console.log(`FODEN running on port ${PORT}`));
