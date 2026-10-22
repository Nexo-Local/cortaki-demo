import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const PROD = process.env.NODE_ENV === 'production';
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
const db = new DatabaseSync(path.join(__dirname, 'data', 'cortaki-dev.sqlite'));

db.exec(`
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('CLIENT','BARBER','SHOP_ADMIN','OWNER_ADMIN')), active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS shops(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, address TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS shop_members(shop_id TEXT NOT NULL REFERENCES shops(id), barber_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'ACTIVE', PRIMARY KEY(shop_id,barber_id));
CREATE TABLE IF NOT EXISTS services(id TEXT PRIMARY KEY, owner_type TEXT NOT NULL CHECK(owner_type IN ('BARBER','SHOP')), owner_id TEXT NOT NULL, name TEXT NOT NULL, price_cents INTEGER NOT NULL CHECK(price_cents>=0), duration_minutes INTEGER NOT NULL CHECK(duration_minutes BETWEEN 5 AND 720), active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS service_offerings(service_id TEXT NOT NULL REFERENCES services(id), barber_id TEXT NOT NULL REFERENCES users(id), shop_id TEXT REFERENCES shops(id), active INTEGER NOT NULL DEFAULT 1, price_cents INTEGER, duration_minutes INTEGER, PRIMARY KEY(service_id,barber_id,shop_id));
CREATE TABLE IF NOT EXISTS appointments(id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES users(id), barber_id TEXT NOT NULL REFERENCES users(id), shop_id TEXT REFERENCES shops(id), mode TEXT NOT NULL CHECK(mode IN ('SCHEDULED','FLASH')), status TEXT NOT NULL, scheduled_at TEXT, address TEXT, gross_cents INTEGER NOT NULL, platform_fee_cents INTEGER NOT NULL DEFAULT 0, security_code_hash TEXT, security_code_demo TEXT, code_verified_at TEXT, customer_checkin_at TEXT, barber_checkin_at TEXT, completed_at TEXT, code_attempts INTEGER NOT NULL DEFAULT 0, code_locked_until TEXT, idempotency_key TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS appointment_services(appointment_id TEXT NOT NULL REFERENCES appointments(id), service_id TEXT NOT NULL REFERENCES services(id), name_snapshot TEXT NOT NULL, price_snapshot_cents INTEGER NOT NULL, duration_snapshot_minutes INTEGER NOT NULL, PRIMARY KEY(appointment_id,service_id));
CREATE TABLE IF NOT EXISTS payments(id TEXT PRIMARY KEY, appointment_id TEXT UNIQUE NOT NULL REFERENCES appointments(id), status TEXT NOT NULL, amount_cents INTEGER NOT NULL, provider TEXT NOT NULL, created_at TEXT NOT NULL, paid_at TEXT);
CREATE TABLE IF NOT EXISTS commission_policies(id TEXT PRIMARY KEY, shop_id TEXT NOT NULL REFERENCES shops(id), barber_id TEXT NOT NULL REFERENCES users(id), pct INTEGER NOT NULL CHECK(pct BETWEEN 0 AND 10000), effective_from TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS ledger_entries(id TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL, appointment_id TEXT REFERENCES appointments(id), type TEXT NOT NULL, amount_cents INTEGER NOT NULL, idempotency_key TEXT UNIQUE NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS payouts(id TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents>0), status TEXT NOT NULL, idempotency_key TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL, paid_at TEXT);
CREATE TABLE IF NOT EXISTS audit_logs(id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT, outcome TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, appointment_id TEXT NOT NULL REFERENCES appointments(id), sender_id TEXT NOT NULL REFERENCES users(id), body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 4000), created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_shop_per_barber ON shop_members(barber_id) WHERE status='ACTIVE';
CREATE INDEX IF NOT EXISTS appt_barber_time ON appointments(barber_id,scheduled_at,status);
CREATE INDEX IF NOT EXISTS appt_client_time ON appointments(client_id,scheduled_at);
CREATE INDEX IF NOT EXISTS ledger_owner_time ON ledger_entries(owner_type,owner_id,created_at);
`);

function now(){return new Date().toISOString()}
function id(prefix='id'){return `${prefix}_${crypto.randomUUID()}`}
function hash(v){return crypto.createHash('sha256').update(v).digest('hex')}
function json(res,status,payload){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(payload))}
function body(req){return new Promise((resolve,reject)=>{let s='';req.on('data',c=>{s+=c;if(s.length>1e6){req.destroy();reject(new Error('payload too large'))}});req.on('end',()=>{try{resolve(s?JSON.parse(s):{})}catch{reject(new Error('invalid json'))}})})}
function user(req){if(PROD) return null; const id=req.headers['x-dev-user-id']||'customer-1'; return db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(id)||null}
function requireUser(req,res,roles=[]){const u=user(req); if(!u)return json(res,401,{error:'AUTH_REQUIRED'}); if(roles.length&&!roles.includes(u.role))return json(res,403,{error:'FORBIDDEN'}); return u}
function audit(actor,action,targetType,targetId,outcome,metadata={}){db.prepare('INSERT INTO audit_logs(actor_id,action,target_type,target_id,outcome,metadata,created_at) VALUES(?,?,?,?,?,?,?)').run(actor,action,targetType,targetId,outcome,JSON.stringify(metadata),now())}
function sendFile(req,res,file){const full=path.normalize(path.join(__dirname,file)); if(!full.startsWith(__dirname)) return json(res,403,{error:'FORBIDDEN'}); if(!fs.existsSync(full)||fs.statSync(full).isDirectory()) return json(res,404,{error:'NOT_FOUND'}); const ext=path.extname(full); const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.json':'application/json'}; res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','X-Content-Type-Options':'nosniff'});fs.createReadStream(full).pipe(res)}
function seed(){
 if(db.prepare('SELECT count(*) c FROM users').get().c) return;
 db.exec(`INSERT INTO users VALUES ('customer-1','Carlos Oliveira','CLIENT',1),('barber-1','João Silva','BARBER',1),('barber-2','Marcos Andrade','BARBER',1),('barber-3','Diego Ferreira','BARBER',1),('shop-admin-1','Administrador da Barbearia','SHOP_ADMIN',1),('admin-1','Administrador CortaKi','OWNER_ADMIN',1);
 INSERT INTO shops VALUES ('shop-1','shop-admin-1','Barbearia Style',1,'Rua Clemente Cunha Ferreira, 1206 — Poá/SP');
 INSERT INTO shop_members VALUES ('shop-1','barber-1','ACTIVE'),('shop-1','barber-2','ACTIVE');
 INSERT INTO services VALUES ('svc-b1','BARBER','barber-1','Corte de cabelo',6000,40,1),('svc-b2','BARBER','barber-1','Barba',4000,30,1),('svc-s1','SHOP','shop-1','Corte de cabelo',6000,40,1),('svc-s2','SHOP','shop-1','Barba',4000,30,1),('svc-s3','SHOP','shop-1','Luzes / Mechas',12000,70,1);
 INSERT INTO service_offerings VALUES ('svc-s1','barber-1','shop-1',1,6000,40),('svc-s2','barber-1','shop-1',1,4000,30),('svc-s3','barber-1','shop-1',1,12000,70),('svc-s1','barber-2','shop-1',1,6500,45),('svc-s2','barber-2','shop-1',1,4500,30);
 INSERT INTO commission_policies VALUES ('cmp-1','shop-1','barber-1',5000,datetime('now'),1),('cmp-2','shop-1','barber-2',5000,datetime('now'),1);`);
}
seed();

function getServicesForBarber(barberId,shopId){
 const own=db.prepare(`SELECT id,name,price_cents,duration_minutes,'BARBER' source FROM services WHERE owner_type='BARBER' AND owner_id=? AND active=1`).all(barberId);
 const shop=shopId?db.prepare(`SELECT s.id,s.name,COALESCE(o.price_cents,s.price_cents) price_cents,COALESCE(o.duration_minutes,s.duration_minutes) duration_minutes,'SHOP' source FROM services s JOIN service_offerings o ON o.service_id=s.id WHERE s.owner_type='SHOP' AND s.owner_id=? AND o.barber_id=? AND o.shop_id=? AND o.active=1 AND s.active=1`).all(shopId,barberId,shopId):[];
 return [...own,...shop];
}
function conflict(barberId,start,end,ignoreId=null){
 const rows=db.prepare(`SELECT id,scheduled_at FROM appointments WHERE barber_id=? AND scheduled_at IS NOT NULL AND status IN ('REQUESTED','CONFIRMED','PAID','CHECKED_IN','IN_SERVICE')`).all(barberId);
 for(const a of rows){
   if(a.id===ignoreId) continue;
   const s=new Date(a.scheduled_at).getTime();
   const d=db.prepare('SELECT COALESCE(SUM(duration_snapshot_minutes),0) m FROM appointment_services WHERE appointment_id=?').get(a.id);
   const e=s+Number(d.m||0)*60000;
   if(start<e && end>s) return a.id;
 }
 return null;
}
function availableBalance(ownerType,ownerId){
 const credits=db.prepare(`SELECT COALESCE(SUM(CASE WHEN amount_cents>0 THEN amount_cents ELSE 0 END),0) c FROM ledger_entries WHERE owner_type=? AND owner_id=?`).get(ownerType,ownerId).c;
 const debits=db.prepare(`SELECT COALESCE(SUM(CASE WHEN amount_cents<0 THEN -amount_cents ELSE 0 END),0) c FROM ledger_entries WHERE owner_type=? AND owner_id=?`).get(ownerType,ownerId).c;
 const payouts=db.prepare(`SELECT COALESCE(SUM(amount_cents),0) c FROM payouts WHERE owner_type=? AND owner_id=? AND status IN ('REQUESTED','PROCESSING','PAID')`).get(ownerType,ownerId).c;
 return Math.max(0,Number(credits)-Number(debits)-Number(payouts));
}
function settleAppointment(apptId){
 const a=db.prepare('SELECT * FROM appointments WHERE id=?').get(apptId); if(!a||a.status!=='COMPLETED')return {ok:false,error:'NOT_COMPLETED'};
 if(db.prepare('SELECT 1 FROM ledger_entries WHERE appointment_id=? LIMIT 1').get(apptId))return {ok:true,already:true};
 const fee=Math.round(a.gross_cents*5/100); const distributable=a.gross_cents-fee;
 db.exec('BEGIN IMMEDIATE'); try {
   db.prepare(`INSERT INTO ledger_entries VALUES (?,?,?,?,?,?,?,?,?)`).run(id('led'),'PLATFORM','platform',a.id,'PLATFORM_FEE',-fee,`fee:${a.id}`,JSON.stringify({pct:5}),now());
   if(a.shop_id){
     const policy=db.prepare(`SELECT pct FROM commission_policies WHERE shop_id=? AND barber_id=? AND active=1 ORDER BY effective_from DESC LIMIT 1`).get(a.shop_id,a.barber_id);
     if(!policy) throw new Error('COMMISSION_POLICY_REQUIRED');
     const barberAmount=Math.round(distributable*policy.pct/10000); const shopAmount=distributable-barberAmount;
     db.prepare(`INSERT INTO ledger_entries VALUES (?,?,?,?,?,?,?,?,?)`).run(id('led'),'BARBER',a.barber_id,a.id,'SERVICE_REVENUE',barberAmount,`barber:${a.id}`,JSON.stringify({commission_bps:policy.pct,base:distributable}),now());
     db.prepare(`INSERT INTO ledger_entries VALUES (?,?,?,?,?,?,?,?,?)`).run(id('led'),'BARBERSHOP',a.shop_id,a.id,'SERVICE_REVENUE',shopAmount,`shop:${a.id}`,JSON.stringify({commission_bps:policy.pct,base:distributable}),now());
   } else {
     db.prepare(`INSERT INTO ledger_entries VALUES (?,?,?,?,?,?,?,?,?)`).run(id('led'),'BARBER',a.barber_id,a.id,'SERVICE_REVENUE',distributable,`barber:${a.id}`,JSON.stringify({platform_fee_bps:500}),now());
   }
   db.exec('COMMIT');
   return {ok:true};
 } catch(e) { db.exec('ROLLBACK'); return {ok:false,error:e.message}; }
}

async function api(req,res){
 const u=new URL(req.url,`http://${HOST}:${PORT}`); const p=u.pathname; const method=req.method;
 if(p==='/api/health') return json(res,200,{ok:true,mode:PROD?'production':'local-demo',db:'sqlite',auth:PROD?'required':'dev-header'});
 if(p==='/api/me'&&method==='GET'){const me=requireUser(req,res);if(!me)return;return json(res,200,{user:me})}
 if(p==='/api/barbers'&&method==='GET'){return json(res,200,{barbers:db.prepare(`SELECT u.id,u.name,EXISTS(SELECT 1 FROM shop_members m WHERE m.barber_id=u.id AND m.status='ACTIVE') has_shop FROM users u WHERE role='BARBER' AND active=1`).all()})}
 const sm=p.match(/^\/api\/barbers\/([^/]+)\/services$/); if(sm&&method==='GET'){const services=getServicesForBarber(sm[1],u.searchParams.get('shopId'));return json(res,200,{services})}
 const am=p.match(/^\/api\/appointments\/([^/]+)$/);
 if(am&&method==='GET'){const me=requireUser(req,res);if(!me)return;const a=db.prepare('SELECT * FROM appointments WHERE id=?').get(am[1]);if(!a)return json(res,404,{error:'NOT_FOUND'});if(![a.client_id,a.barber_id].includes(me.id)&&!(a.shop_id&&db.prepare('SELECT owner_id FROM shops WHERE id=?').get(a.shop_id)?.owner_id===me.id)&&me.role!=='OWNER_ADMIN')return json(res,403,{error:'FORBIDDEN'});return json(res,200,{appointment:a,services:db.prepare('SELECT * FROM appointment_services WHERE appointment_id=?').all(a.id)})}
 if(am&&method==='POST'&&u.searchParams.get('action')==='checkin'){
   const me=requireUser(req,res,['CLIENT','BARBER']);if(!me)return;const a=db.prepare('SELECT * FROM appointments WHERE id=?').get(am[1]);if(!a)return json(res,404,{error:'NOT_FOUND'});if(![a.client_id,a.barber_id].includes(me.id))return json(res,403,{error:'FORBIDDEN'});
   const nowMs=Date.now();if(a.scheduled_at){const s=new Date(a.scheduled_at).getTime();if(nowMs<s-30*60000||nowMs>s+60*60000)return json(res,409,{error:'CHECKIN_WINDOW'});} const field=me.role==='CLIENT'?'customer_checkin_at':'barber_checkin_at';db.prepare(`UPDATE appointments SET ${field}=?,updated_at=? WHERE id=?`).run(now(),now(),a.id);audit(me.id,'CHECKIN','APPOINTMENT',a.id,'SUCCESS');return json(res,200,{ok:true})
 }
 if(am&&method==='POST'&&u.searchParams.get('action')==='verify-code'){
   const me=requireUser(req,res,['BARBER']);if(!me)return;const a=db.prepare('SELECT * FROM appointments WHERE id=?').get(am[1]);if(!a||a.barber_id!==me.id)return json(res,403,{error:'FORBIDDEN'});const b=await body(req);if(a.code_locked_until&&new Date(a.code_locked_until)>new Date())return json(res,429,{error:'CODE_LOCKED'});if(hash(String(b.code||''))!==a.security_code_hash){const attempts=a.code_attempts+1;const lock=attempts>=5?new Date(Date.now()+15*60000).toISOString():a.code_locked_until;db.prepare('UPDATE appointments SET code_attempts=?,code_locked_until=?,updated_at=? WHERE id=?').run(attempts,lock,now(),a.id);audit(me.id,'VERIFY_SECURITY_CODE','APPOINTMENT',a.id,'DENIED',{attempts});return json(res,401,{error:'INVALID_CODE',attempts_remaining:Math.max(0,5-attempts)})}db.prepare(`UPDATE appointments SET code_verified_at=?,status=CASE WHEN customer_checkin_at IS NOT NULL AND barber_checkin_at IS NOT NULL THEN 'IN_SERVICE' ELSE 'CHECKED_IN' END,updated_at=? WHERE id=?`).run(now(),now(),a.id);audit(me.id,'VERIFY_SECURITY_CODE','APPOINTMENT',a.id,'SUCCESS');return json(res,200,{ok:true,status:db.prepare('SELECT status FROM appointments WHERE id=?').get(a.id).status})
 }
 if(am&&method==='POST'&&u.searchParams.get('action')==='complete'){
   const me=requireUser(req,res,['BARBER']);if(!me)return;const a=db.prepare('SELECT * FROM appointments WHERE id=?').get(am[1]);if(!a||a.barber_id!==me.id)return json(res,403,{error:'FORBIDDEN'});if(a.status!=='IN_SERVICE'||!a.code_verified_at)return json(res,409,{error:'INVALID_STATE'});db.prepare(`UPDATE appointments SET status='COMPLETED',completed_at=?,updated_at=? WHERE id=?`).run(now(),now(),a.id);const s=settleAppointment(a.id);if(!s.ok){db.prepare(`UPDATE appointments SET status='DISPUTED',updated_at=? WHERE id=?`).run(now(),a.id);return json(res,409,{error:s.error})}audit(me.id,'COMPLETE_APPOINTMENT','APPOINTMENT',a.id,'SUCCESS');return json(res,200,{ok:true})
 }
 if(am&&method==='POST'&&u.searchParams.get('action')==='cancel'){
   const me=requireUser(req,res,['CLIENT','BARBER','SHOP_ADMIN','OWNER_ADMIN']);if(!me)return;const a=db.prepare('SELECT * FROM appointments WHERE id=?').get(am[1]);if(!a)return json(res,404,{error:'NOT_FOUND'});if(me.role!=='OWNER_ADMIN'&&!([a.client_id,a.barber_id].includes(me.id)))return json(res,403,{error:'FORBIDDEN'});if(['COMPLETED','CANCELLED','DISPUTED'].includes(a.status))return json(res,409,{error:'INVALID_STATE'});db.prepare(`UPDATE appointments SET status='CANCELLED',updated_at=? WHERE id=?`).run(now(),a.id);audit(me.id,'CANCEL_APPOINTMENT','APPOINTMENT',a.id,'SUCCESS');return json(res,200,{ok:true})
 }
 if(p==='/api/appointments'&&method==='POST'){
   const me=requireUser(req,res,['CLIENT']);if(!me)return;const b=await body(req);const {barberId,shopId=null,serviceIds=[],mode='SCHEDULED',scheduledAt,address=null,idempotencyKey}=b;if(!barberId||!Array.isArray(serviceIds)||!serviceIds.length||!idempotencyKey)return json(res,400,{error:'INVALID_INPUT'});const old=db.prepare('SELECT id FROM appointments WHERE idempotency_key=?').get(idempotencyKey);if(old)return json(res,200,{appointmentId:old.id,replayed:true});const services=getServicesForBarber(barberId,shopId);const selected=services.filter(s=>serviceIds.includes(s.id));if(selected.length!==new Set(serviceIds).size)return json(res,400,{error:'SERVICE_NOT_AVAILABLE'});if(shopId&&!db.prepare(`SELECT 1 FROM shop_members WHERE shop_id=? AND barber_id=? AND status='ACTIVE'`).get(shopId,barberId))return json(res,400,{error:'BARBER_NOT_MEMBER'});const gross=selected.reduce((x,s)=>x+s.price_cents,0);const duration=selected.reduce((x,s)=>x+s.duration_minutes,0);let start=null;if(mode==='SCHEDULED'){if(!scheduledAt)return json(res,400,{error:'SCHEDULE_REQUIRED'});start=new Date(scheduledAt);if(Number.isNaN(start.getTime()))return json(res,400,{error:'INVALID_DATE'});const end=start.getTime()+duration*60000;if(conflict(barberId,start.getTime(),end))return json(res,409,{error:'SLOT_UNAVAILABLE'});}if(mode==='FLASH'&&!address)return json(res,400,{error:'ADDRESS_REQUIRED'});const apptId=id('apt'),code=String(crypto.randomInt(100000,1000000));const created=now();db.exec('BEGIN IMMEDIATE'); try { db.prepare(`INSERT INTO appointments(id,client_id,barber_id,shop_id,mode,status,scheduled_at,address,gross_cents,platform_fee_cents,security_code_hash,security_code_demo,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(apptId,me.id,barberId,shopId,mode,'REQUESTED',start?start.toISOString():null,address,gross,Math.round(gross*.05),hash(code),PROD?null:code,idempotencyKey,created,created);for(const s of selected)db.prepare('INSERT INTO appointment_services VALUES (?,?,?,?,?)').run(apptId,s.id,s.name,s.price_cents,s.duration_minutes);db.prepare('INSERT INTO payments VALUES (?,?,?,?,?,?,?)').run(id('pay'),apptId,'PENDING',gross,'DEMO_PROVIDER',created,null); db.exec('COMMIT'); } catch(e) { db.exec('ROLLBACK'); throw e; } audit(me.id,'CREATE_APPOINTMENT','APPOINTMENT',apptId,'SUCCESS',{gross,duration,mode});return json(res,201,{appointmentId:apptId,securityCode:PROD?undefined:code,status:'REQUESTED',grossCents:gross,durationMinutes:duration})
 }
 const pay=p.match(/^\/api\/payments\/([^/]+)\/simulate$/); if(pay&&method==='POST'){const me=requireUser(req,res,['CLIENT']);if(!me)return;const a=db.prepare('SELECT * FROM appointments WHERE id=?').get(pay[1]);if(!a||a.client_id!==me.id)return json(res,403,{error:'FORBIDDEN'});db.prepare(`UPDATE payments SET status='PAID',paid_at=? WHERE appointment_id=?`).run(now(),a.id);db.prepare(`UPDATE appointments SET status='CONFIRMED',updated_at=? WHERE id=?`).run(now(),a.id);audit(me.id,'SIMULATE_PAYMENT','PAYMENT',a.id,'SUCCESS');return json(res,200,{ok:true,status:'CONFIRMED'})}
 if(p==='/api/wallet/barber'&&method==='GET'){const me=requireUser(req,res,['BARBER']);if(!me)return;return json(res,200,{availableCents:availableBalance('BARBER',me.id),entries:db.prepare(`SELECT * FROM ledger_entries WHERE owner_type='BARBER' AND owner_id=? ORDER BY created_at DESC`).all(me.id),payouts:db.prepare('SELECT * FROM payouts WHERE owner_type=\'BARBER\' AND owner_id=? ORDER BY created_at DESC').all(me.id)})}
 if(p==='/api/wallet/shop'&&method==='GET'){const me=requireUser(req,res,['SHOP_ADMIN','OWNER_ADMIN']);if(!me)return;const shop=me.role==='OWNER_ADMIN'?db.prepare('SELECT id FROM shops LIMIT 1').get():db.prepare('SELECT id FROM shops WHERE owner_id=?').get(me.id);if(!shop)return json(res,404,{error:'SHOP_NOT_FOUND'});return json(res,200,{shopId:shop.id,availableCents:availableBalance('BARBERSHOP',shop.id),entries:db.prepare(`SELECT * FROM ledger_entries WHERE owner_type='BARBERSHOP' AND owner_id=? ORDER BY created_at DESC`).all(shop.id),payouts:db.prepare('SELECT * FROM payouts WHERE owner_type=\'BARBERSHOP\' AND owner_id=? ORDER BY created_at DESC').all(shop.id)})}
 if(p==='/api/payouts'&&method==='POST'){const me=requireUser(req,res,['BARBER','SHOP_ADMIN','OWNER_ADMIN']);if(!me)return;const b=await body(req);const amount=Math.round(Number(b.amountCents));if(!Number.isSafeInteger(amount)||amount<=0)return json(res,400,{error:'INVALID_AMOUNT'});let type,idOwner;if(me.role==='BARBER'){type='BARBER';idOwner=me.id}else{const shop=me.role==='OWNER_ADMIN'?db.prepare('SELECT id FROM shops LIMIT 1').get():db.prepare('SELECT id FROM shops WHERE owner_id=?').get(me.id);if(!shop)return json(res,404,{error:'SHOP_NOT_FOUND'});type='BARBERSHOP';idOwner=shop.id}const avail=availableBalance(type,idOwner);if(amount>avail)return json(res,409,{error:'INSUFFICIENT_AVAILABLE_BALANCE',availableCents:avail});const pId=id('payout');db.prepare(`INSERT INTO payouts VALUES (?,?,?,?,?,?,?,?)`).run(pId,type,idOwner,amount,'REQUESTED',b.idempotencyKey||crypto.randomUUID(),now(),null);audit(me.id,'REQUEST_PAYOUT','PAYOUT',pId,'SUCCESS',{amount,type});return json(res,201,{payoutId:pId,status:'REQUESTED',availableCents:availableBalance(type,idOwner)})}
 if(p==='/api/messages'&&method==='POST'){const me=requireUser(req,res,['CLIENT','BARBER']);if(!me)return;const b=await body(req);const a=db.prepare('SELECT * FROM appointments WHERE id=?').get(b.appointmentId);if(!a||![a.client_id,a.barber_id].includes(me.id))return json(res,403,{error:'FORBIDDEN'});const m=String(b.body||'').trim();if(!m||m.length>4000)return json(res,400,{error:'INVALID_MESSAGE'});const mid=id('msg');db.prepare('INSERT INTO messages VALUES (?,?,?, ?,?)').run(mid,a.id,me.id,m,now());return json(res,201,{id:mid})}
 if(p.startsWith('/api/')) return json(res,404,{error:'NOT_FOUND'});
 let file=p==='/'?'/index.html':p; if(file.includes('..'))return json(res,400,{error:'BAD_PATH'});return sendFile(req,res,file.slice(1));
}

const server=http.createServer((req,res)=>{api(req,res).catch(e=>{console.error(e);json(res,500,{error:'INTERNAL_ERROR'})})});
server.listen(PORT,HOST,()=>console.log(`CortaKi local server: http://${HOST}:${PORT}`));
