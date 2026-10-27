'use strict';
const express=require('express');
const {getPool}=require('../../db/pool');
const {resolveSession}=require('./guard');
const {validateSessionCsrf,revokeTrackedSession,revokeOtherTrackedSessions,dropSession}=require('./session');
const {profilePath}=require('../password-reset/profile-destinations');
const router=express.Router();
const BODY=express.urlencoded({extended:false,limit:'2kb',parameterLimit:5});
router.post('/revoke',BODY,async(req,res)=>{
  try{
    const actor=await resolveSession(req,res);
    if(!actor)return res.redirect(303,'/auth/login');
    if(!validateSessionCsrf(req))return res.status(403).send('انتهت صلاحية النموذج. حدّث الصفحة.');
    const profile=profilePath(actor,req.body?.profile_scope,req.sdcSession,req.sdcClinics);
    const action=req.body?.action;
    if(action==='others'){
      await revokeOtherTrackedSessions(getPool(),actor.userId,req.sdcSession);
      return res.redirect(303,profile+'?sessions=updated#sdc-sessions');
    }
    if(action!=='single'||typeof req.body?.session_id!=='string'||!/^[1-9]\d{0,18}$/.test(req.body.session_id))
      return res.status(422).send('طلب إدارة جلسة غير صالح.');
    const isCurrent=req.body.session_id===String(req.sdcSession.sessionId);
    const ok=await revokeTrackedSession(getPool(),actor.userId,req.body.session_id);
    if(!ok)return res.status(404).send('الجلسة غير موجودة أو انتهت.');
    if(isCurrent){dropSession(req,res);return res.redirect(303,'/auth/login');}
    return res.redirect(303,profile+'?sessions=updated#sdc-sessions');
  }catch(e){console.error('[SESSION_REVOKE_FAILED]',e.code||'UNKNOWN');return res.status(503).send('تعذر تحديث الجلسات حاليًا.');}
});
module.exports=router;
