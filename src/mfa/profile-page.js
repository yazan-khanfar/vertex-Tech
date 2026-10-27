'use strict';
const {getPool}=require('../../db/pool');
const {sessionCsrf}=require('../auth/session');
const {mfaState}=require('./service');
const {otpauthUri}=require('./crypto');
const {take}=require('./one-time-feedback');

// The canonical original role profile/settings page owns the MFA interface.
// POST handlers redirect there instead of rendering HTML under /auth/security/*.
async function mfaViewFor(req,overrides={}){
 const state=await mfaState(getPool(),req.sdcActor.userId);
 const secret=req.sdcSession?.mfaEnrollSecret||null;
 const flash=take(req)||{};
 return {enabled:state?.Two_Factor_Enabled===true,secret,
  uri:secret?otpauthUri(secret,state.Email):null,
  csrfToken:sessionCsrf(req),error:'',message:'',codes:null,...flash,...overrides};
}
module.exports={mfaViewFor};
