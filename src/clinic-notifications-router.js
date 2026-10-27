'use strict';
const express=require('express');
const router=express.Router();
const {clinicId}=require('./clinic-settings-service');
const {getPool}=require('../db/pool');
const {sessionCsrf,validateSessionCsrf}=require('./auth/session');
const pages=require('../config/page-map.json');
// Only notification actions use this small form parser; never intercept other clinic POST forms.
router.use(['/notifications/read-all','/notifications/:notice/:action'], express.urlencoded({extended:false,limit:'4kb',parameterLimit:5}));
function safeTarget(x){
 const t=String(x.Target_Type||'').toLowerCase(),r=String(x.Target_Reference||'');
 // Exact allowlisted clinic views only, never redirect user supplied origins.
 if(/^\/clinic\/[a-z-]+$/.test(r)&&pages[r.slice(1)+'.html'])return r;
 const match=/^[1-9]\d{0,17}$/.test(r);
 if(['booking','appointment'].includes(t)&&match)return '/clinic/appointment-details?id='+r;
 if(['application','job_application'].includes(t)&&match)return '/clinic/application-details?id='+r;
 if(['laboratory','lab_order'].includes(t))return '/clinic/lab-cases';
 if(['payment','invoice'].includes(t))return '/clinic/invoices';
 if(t==='job')return '/clinic/jobs';
 if(t==='document')return '/clinic/profile#sdcClinicFileVersions';
 return '/clinic/index';
}
router.use(async(req,res,next)=>{
 const id=clinicId(req);
 res.locals.clinicNotifications=[];res.locals.clinicUnreadCount=0;res.locals.notificationCsrf=sessionCsrf(req);
 if(!id||!req.sdcActor?.userId)return next();
 try{const [items,count]=await Promise.all([
 getPool().query(`SELECT "Notification_ID","Title","Body","Created_At","Read_At","Target_Type","Target_Reference" FROM sdc."NOTIFICATION" WHERE "User_ID"=$1::bigint ORDER BY "Created_At" DESC LIMIT 8`,[req.sdcActor.userId]),
 getPool().query(`SELECT COUNT(*)::int AS unread FROM sdc."NOTIFICATION" WHERE "User_ID"=$1::bigint AND "Read_At" IS NULL`,[req.sdcActor.userId])
 ]);res.locals.clinicNotifications=items.rows.map(row=>({...row,link:safeTarget(row)}));res.locals.clinicUnreadCount=count.rows[0].unread;next();}
 catch(e){console.error('[CLINIC_NOTIFICATIONS]',e.code||e.message);next(e);}
});
function valid(req,res){if(!clinicId(req))return res.sendStatus(403);if(!validateSessionCsrf(req))return res.sendStatus(403);return true;}
const idRe=/^[1-9]\d{0,17}$/;
router.post('/notifications/read-all',async(req,res,next)=>{if(!valid(req,res))return;try{await getPool().query(`UPDATE sdc."NOTIFICATION" SET "Read_At"=COALESCE("Read_At",LOCALTIMESTAMP) WHERE "User_ID"=$1::bigint AND "Read_At" IS NULL`,[req.sdcActor.userId]);return res.redirect(303,req.get('Referer')?.startsWith(req.protocol+'://'+req.get('host')+'/clinic/')?req.get('Referer'):'/clinic/index');}catch(e){next(e);}});
router.post('/notifications/:notice/:action',async(req,res,next)=>{if(!valid(req,res))return;if(!idRe.test(req.params.notice)||!['open','read','delete'].includes(req.params.action))return res.sendStatus(404);
 try{const user=req.sdcActor.userId,n=req.params.notice,a=req.params.action;
  if(a==='delete'){await getPool().query(`DELETE FROM sdc."NOTIFICATION" WHERE "Notification_ID"=$1::bigint AND "User_ID"=$2::bigint`,[n,user]);return res.redirect(303,'/clinic/index');}
  const r=await getPool().query(`UPDATE sdc."NOTIFICATION" SET "Read_At"=COALESCE("Read_At",LOCALTIMESTAMP) WHERE "Notification_ID"=$1::bigint AND "User_ID"=$2::bigint RETURNING "Target_Type","Target_Reference"`,[n,user]);if(!r.rowCount)return res.sendStatus(404);return res.redirect(303,a==='open'?safeTarget(r.rows[0]):'/clinic/index');
 }catch(e){next(e);}
});
module.exports=router;
