import 'dotenv/config';
import express from 'express';
import rateLimit from 'express-rate-limit';
import cors from 'cors';
import http from 'http';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import PDFDocument from 'pdfkit';
import { Server } from 'socket.io';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

const required=['JWT_SECRET','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY'];
for(const k of required){ if(!process.env[k]) console.warn(`Missing ${k}`); }
const PORT=process.env.PORT||10000;
const origins=(process.env.FRONTEND_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean);
const app=express();
app.disable('x-powered-by');
app.use(cors({origin:(origin,cb)=>!origin||origins.length===0||origins.includes(origin)?cb(null,true):cb(new Error('Origin not allowed')),credentials:true}));
app.use(express.json({limit:'1mb'}));
app.use('/api/login', rateLimit({windowMs:15*60*1000,limit:30,standardHeaders:'draft-8',legacyHeaders:false}));
const server=http.createServer(app);
const io=new Server(server,{cors:{origin:origins.length?origins:true,methods:['GET','POST']}});
const db=createClient(process.env.SUPABASE_URL||'',process.env.SUPABASE_SERVICE_ROLE_KEY||'',{auth:{persistSession:false,autoRefreshToken:false}});
const resend=process.env.RESEND_API_KEY?new Resend(process.env.RESEND_API_KEY):null;

const safeUser=p=>({id:p.id,case_id:p.case_id,role:p.role,display_name:p.display_name});
const sign=p=>jwt.sign(safeUser(p),process.env.JWT_SECRET,{expiresIn:'12h',issuer:'family-visit-compliance'});
const auth=(req,res,next)=>{const t=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');try{req.user=jwt.verify(t,process.env.JWT_SECRET,{issuer:'family-visit-compliance'});next();}catch{res.status(401).json({error:'Session expired or invalid.'});}};
const caseScope=(req,res,next)=>{if(req.user.case_id!==req.params.caseId)return res.status(403).json({error:'Not authorized for this case.'});next();};

app.get('/healthz',(_req,res)=>res.json({ok:true,service:'family-visit-compliance',storage:'supabase-only'}));
app.get('/api/public-config',(_req,res)=>{
  const ice=[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}];
  if(process.env.TURN_URL) ice.push({urls:process.env.TURN_URL,username:process.env.TURN_USERNAME||'',credential:process.env.TURN_CREDENTIAL||''});
  res.json({iceServers:ice,turnConfigured:!!process.env.TURN_URL});
});

app.post('/api/login',async(req,res)=>{
  const {caseCode,role,displayName,pin}=req.body||{};
  if(!caseCode||!role||!displayName||!pin)return res.status(400).json({error:'Case code, role, name, and PIN are required.'});
  const {data:caseRow,error:ce}=await db.from('cases').select('*').eq('case_code',String(caseCode).trim().toUpperCase()).eq('active',true).maybeSingle();
  if(ce||!caseRow)return res.status(401).json({error:'Case code not found.'});
  const {data:people,error:pe}=await db.from('participants').select('*').eq('case_id',caseRow.id).eq('role',role).eq('enabled',true);
  if(pe)return res.status(500).json({error:'Unable to verify participant.'});
  const normalized=String(displayName).trim().toLowerCase();
  const matches=people.filter(p=>p.display_name.trim().toLowerCase()===normalized);
  let found=null;
  for(const p of matches){ if(await bcrypt.compare(String(pin),p.pin_hash)){found=p;break;} }
  if(!found)return res.status(401).json({error:'Name or PIN did not match this case.'});
  const token=sign(found);
  const {data:members}=await db.from('participants').select('id,role,display_name').eq('case_id',caseRow.id).eq('enabled',true).order('role');
  res.json({token,user:safeUser(found),case:{id:caseRow.id,case_code:caseRow.case_code,label:caseRow.label,visit_minutes:caseRow.visit_minutes,checkin_interval_minutes:caseRow.checkin_interval_minutes},members});
});

app.get('/api/me',auth,async(req,res)=>{
  const {data:p}=await db.from('participants').select('id,case_id,role,display_name,enabled').eq('id',req.user.id).maybeSingle();
  if(!p?.enabled)return res.status(401).json({error:'Account disabled.'});
  const {data:c}=await db.from('cases').select('id,case_code,label,visit_minutes,checkin_interval_minutes').eq('id',p.case_id).single();
  const {data:members}=await db.from('participants').select('id,role,display_name').eq('case_id',p.case_id).eq('enabled',true).order('role');
  res.json({user:safeUser(p),case:c,members});
});

app.get('/api/case/:caseId/dashboard',auth,caseScope,async(req,res)=>{
  const caseId=req.params.caseId;
  const [visits,checks,members]=await Promise.all([
    db.from('visit_sessions').select('*').eq('case_id',caseId).order('started_at',{ascending:false}).limit(100),
    db.from('checkins').select('*').eq('case_id',caseId).order('created_at',{ascending:false}).limit(1000),
    db.from('participants').select('id,role,display_name').eq('case_id',caseId).eq('enabled',true)
  ]);
  if(visits.error||checks.error||members.error)return res.status(500).json({error:'Unable to load case dashboard.'});
  let visibleVisits=visits.data, visibleChecks=checks.data;
  if(req.user.role==='parent'){
    visibleChecks=visibleChecks.filter(x=>x.parent_id===req.user.id);
    const ids=new Set(visibleChecks.map(x=>x.visit_id));
    visibleVisits=visibleVisits.filter(v=>ids.has(v.id)||v.started_by===req.user.id);
  }
  res.json({visits:visibleVisits,checkins:visibleChecks,members:members.data});
});

app.post('/api/case/:caseId/visit/start',auth,caseScope,async(req,res)=>{
  if(req.user.role!=='parent')return res.status(403).json({error:'Only a parent can start a visit.'});
  const now=new Date();
  const {data:c}=await db.from('cases').select('visit_minutes').eq('id',req.params.caseId).single();
  const {data:active}=await db.from('visit_sessions').select('*').eq('case_id',req.params.caseId).eq('status','active').gte('ends_at',new Date(now.getTime()-30*60000).toISOString()).order('started_at',{ascending:false}).limit(1).maybeSingle();
  let visit=active;
  if(!visit){
    const ends=new Date(now.getTime()+(c?.visit_minutes||120)*60000);
    const {data,error}=await db.from('visit_sessions').insert({case_id:req.params.caseId,started_by:req.user.id,started_at:now.toISOString(),ends_at:ends.toISOString(),status:'active'}).select().single();
    if(error)return res.status(500).json({error:error.message}); visit=data;
  }
  await db.from('visit_attendees').upsert({visit_id:visit.id,parent_id:req.user.id,joined_at:now.toISOString()},{onConflict:'visit_id,parent_id'});
  res.json({visit});
});

app.post('/api/case/:caseId/checkin',auth,caseScope,async(req,res)=>{
  if(req.user.role!=='parent')return res.status(403).json({error:'Only parents can submit check-ins.'});
  const {visitId,method,latitude,longitude,accuracy,note}=req.body||{};
  if(!visitId||!['location','virtual','video'].includes(method))return res.status(400).json({error:'Invalid check-in.'});
  const {data:v}=await db.from('visit_sessions').select('*').eq('id',visitId).eq('case_id',req.params.caseId).maybeSingle();
  if(!v||v.status!=='active')return res.status(400).json({error:'Visit is not active.'});
  const {data:a}=await db.from('visit_attendees').select('*').eq('visit_id',visitId).eq('parent_id',req.user.id).maybeSingle();
  if(!a)return res.status(403).json({error:'Join the visit before checking in.'});
  const {count}=await db.from('checkins').select('*',{count:'exact',head:true}).eq('visit_id',visitId).eq('parent_id',req.user.id);
  const row={case_id:req.params.caseId,visit_id:visitId,parent_id:req.user.id,checkin_number:(count||0)+1,method,note:String(note||'').slice(0,500)};
  if(method==='location'){
    if(!Number.isFinite(Number(latitude))||!Number.isFinite(Number(longitude)))return res.status(400).json({error:'Location is required.'});
    Object.assign(row,{latitude:Number(latitude),longitude:Number(longitude),accuracy_m:Number.isFinite(Number(accuracy))?Number(accuracy):null});
  }
  const {data,error}=await db.from('checkins').insert(row).select().single();
  if(error)return res.status(500).json({error:error.message});
  const {count:visitCount}=await db.from('checkins').select('*',{count:'exact',head:true}).eq('visit_id',visitId);
  if((visitCount||0)>=2 && !v.second_checkin_at) await db.from('visit_sessions').update({second_checkin_at:data.created_at,review_ready:true}).eq('id',visitId);
  io.to(`case:${req.params.caseId}`).emit('checkin:new',{visitId,parentId:req.user.id});
  res.json({checkin:data,reviewReady:(visitCount||0)>=2});
});

app.post('/api/case/:caseId/visit/:visitId/review',auth,caseScope,async(req,res)=>{
  if(req.user.role!=='caseworker')return res.status(403).json({error:'Only a caseworker can finalize a visit.'});
  const {outcome,note}=req.body||{};
  if(!['compliant','non_compliant'].includes(outcome))return res.status(400).json({error:'Choose compliant or non-compliant.'});
  const {count}=await db.from('checkins').select('*',{count:'exact',head:true}).eq('visit_id',req.params.visitId).eq('case_id',req.params.caseId);
  if((count||0)<2)return res.status(400).json({error:'At least two check-ins are required before review.'});
  const now=new Date().toISOString();
  const {data,error}=await db.from('visit_sessions').update({status:outcome,reviewed_by:req.user.id,reviewed_at:now,review_note:String(note||'').slice(0,1000),completed_at:now}).eq('id',req.params.visitId).eq('case_id',req.params.caseId).select().single();
  if(error)return res.status(500).json({error:error.message});
  const report=await buildVisitReport(req.params.visitId);
  const delivery=await sendReport(report);
  await db.from('report_deliveries').insert({case_id:req.params.caseId,visit_id:req.params.visitId,recipient:process.env.SUPERVISOR_EMAIL||null,status:delivery.status,error_message:delivery.error||null});
  io.to(`case:${req.params.caseId}`).emit('visit:reviewed',{visitId:req.params.visitId,outcome});
  res.json({visit:data,reportDelivery:delivery});
});

app.get('/api/case/:caseId/visit/:visitId/report.pdf',auth,caseScope,async(req,res)=>{
  const report=await buildVisitReport(req.params.visitId);
  if(!report)return res.status(404).json({error:'Visit not found.'});
  const pdf=await makePdf(report);
  res.type('application/pdf').set('Content-Disposition',`attachment; filename="visit-${report.visit.id}.pdf"`).send(pdf);
});

async function buildVisitReport(visitId){
  const {data:visit}=await db.from('visit_sessions').select('*').eq('id',visitId).maybeSingle(); if(!visit)return null;
  const {data:caseRow}=await db.from('cases').select('*').eq('id',visit.case_id).single();
  const {data:checkins}=await db.from('checkins').select('*').eq('visit_id',visitId).order('created_at');
  const ids=[...new Set([visit.started_by,visit.reviewed_by,...(checkins||[]).map(c=>c.parent_id)].filter(Boolean))];
  const {data:people}=ids.length?await db.from('participants').select('id,display_name,role').in('id',ids):{data:[]};
  const byId=Object.fromEntries((people||[]).map(p=>[p.id,p]));
  return {visit,caseRow,checkins:checkins||[],byId};
}
function reportCsv(r){
  const esc=v=>`"${String(v??'').replaceAll('"','""')}"`;
  const rows=[['parent','checkin_number','timestamp_utc','method','latitude','longitude','accuracy_m','note']];
  for(const c of r.checkins)rows.push([r.byId[c.parent_id]?.display_name||'Parent',c.checkin_number,c.created_at,c.method,c.latitude,c.longitude,c.accuracy_m,c.note]);
  return rows.map(x=>x.map(esc).join(',')).join('\n');
}
function makePdf(r){return new Promise((resolve,reject)=>{
  const doc=new PDFDocument({margin:50}); const chunks=[]; doc.on('data',d=>chunks.push(d)); doc.on('end',()=>resolve(Buffer.concat(chunks))); doc.on('error',reject);
  doc.fontSize(20).text('Family Visit Compliance Report').moveDown(.4);
  doc.fontSize(10).fillColor('#555').text(`Case: ${r.caseRow?.label||r.caseRow?.case_code||r.visit.case_id}`).text(`Visit ID: ${r.visit.id}`).text(`Started: ${r.visit.started_at}`).text(`Scheduled end: ${r.visit.ends_at}`).text(`Outcome: ${String(r.visit.status).replace('_',' ')}`).text(`Reviewed: ${r.visit.reviewed_at||'Not reviewed'}`).text(`Caseworker: ${r.byId[r.visit.reviewed_by]?.display_name||'—'}`).moveDown();
  doc.fillColor('#111').fontSize(13).text('Check-ins').moveDown(.3);
  for(const c of r.checkins){doc.fontSize(10).text(`${r.byId[c.parent_id]?.display_name||'Parent'} • #${c.checkin_number} • ${c.created_at} • ${c.method}`); if(c.latitude!=null)doc.fillColor('#555').text(`Location: ${c.latitude}, ${c.longitude} • accuracy ±${Math.round(c.accuracy_m||0)} m`).fillColor('#111'); if(c.note)doc.fillColor('#555').text(`Note: ${c.note}`).fillColor('#111'); doc.moveDown(.35);}
  if(r.visit.review_note){doc.moveDown().fontSize(13).text('Caseworker note').fontSize(10).text(r.visit.review_note);}
  doc.moveDown().fontSize(8).fillColor('#666').text('Generated from server-timestamped records stored in Supabase. This report documents submitted check-ins; it does not independently prove device possession or physical identity.'); doc.end();
});}
async function sendReport(report){
  if(!report)return {status:'failed',error:'Report not found'};
  if(!resend||!process.env.SUPERVISOR_EMAIL||!process.env.REPORT_FROM)return {status:'not_configured'};
  try{const pdf=await makePdf(report);const csv=Buffer.from(reportCsv(report));await resend.emails.send({from:process.env.REPORT_FROM,to:[process.env.SUPERVISOR_EMAIL],subject:`Visit report • ${report.caseRow?.label||report.caseRow?.case_code} • ${report.visit.status}`,text:`A visit was finalized as ${report.visit.status}. Visit ID: ${report.visit.id}`,attachments:[{filename:`visit-${report.visit.id}.pdf`,content:pdf},{filename:`visit-${report.visit.id}.csv`,content:csv}]});return {status:'sent'};}catch(e){return {status:'failed',error:e.message};}
}

io.use((socket,next)=>{try{const t=socket.handshake.auth?.token;socket.user=jwt.verify(t,process.env.JWT_SECRET,{issuer:'family-visit-compliance'});next();}catch{next(new Error('unauthorized'));}});
io.on('connection',socket=>{
  socket.join(`case:${socket.user.case_id}`); socket.join(`user:${socket.user.id}`);
  socket.on('presence:hello',()=>io.to(`case:${socket.user.case_id}`).emit('presence:update',{userId:socket.user.id,online:true}));
  socket.on('rtc:call',({targetId,callId,offer})=>{io.to(`user:${targetId}`).emit('rtc:incoming',{fromId:socket.user.id,fromName:socket.user.display_name,callId,offer});});
  socket.on('rtc:answer',({targetId,callId,answer})=>io.to(`user:${targetId}`).emit('rtc:answer',{fromId:socket.user.id,callId,answer}));
  socket.on('rtc:ice',({targetId,callId,candidate})=>io.to(`user:${targetId}`).emit('rtc:ice',{fromId:socket.user.id,callId,candidate}));
  socket.on('rtc:decline',({targetId,callId})=>io.to(`user:${targetId}`).emit('rtc:declined',{fromId:socket.user.id,callId}));
  socket.on('rtc:end',({targetId,callId})=>io.to(`user:${targetId}`).emit('rtc:ended',{fromId:socket.user.id,callId}));
});

server.listen(PORT,()=>console.log(`Family Visit Compliance API listening on ${PORT}`));
