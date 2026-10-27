'use strict';
// Real email delivery uses Resend HTTP API (Node >=20 fetch), or explicit local-only console mode.
function config(){
  const mode=(process.env.PASSWORD_RESET_DELIVERY||'').toLowerCase();
  if(mode==='console'){
    if(process.env.NODE_ENV==='production')throw Error('Console reset links are not allowed in production');
    return {mode,origin:process.env.APP_BASE_URL||'http://localhost:3000'};
  }
  if(mode==='resend' && process.env.RESEND_API_KEY && process.env.EMAIL_FROM && process.env.APP_BASE_URL){
    if(process.env.NODE_ENV==='production'&&!process.env.APP_BASE_URL.startsWith('https://'))throw Error('APP_BASE_URL must use HTTPS in production');
    return {mode,origin:process.env.APP_BASE_URL};
  }
  throw Object.assign(Error('Password reset delivery is not configured'),{code:'MAIL_NOT_CONFIGURED'});
}
async function deliver(email,token,send=globalThis.fetch){
  const settings=config();
  const origin=new URL(settings.origin);
  if(!['http:','https:'].includes(origin.protocol)||origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/')throw Error('Invalid APP_BASE_URL');
  const url=new URL('/auth/password/reset',origin);
  url.searchParams.set('token',token);
  if(settings.mode==='console'){
    if(!['localhost','127.0.0.1'].includes(origin.hostname))throw Error('Console mode requires localhost APP_BASE_URL');
    // WARNING: local debugging only. Anyone with terminal log access can use this token.
    process.stdout.write(`[LOCAL DEVELOPMENT ONLY] Reset link for ${email}: ${url.href}\n`);
    return;
  }
  const response=await send('https://api.resend.com/emails',{
    method:'POST',headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json'},
    body:JSON.stringify({from:process.env.EMAIL_FROM,to:[email],subject:'Smart Dental Clinic — استعادة كلمة المرور',text:`طلب استعادة كلمة المرور لحسابك. افتح الرابط التالي خلال 30 دقيقة:\n${url.href}\nإذا لم تطلب ذلك فتجاهل الرسالة. سيظل MFA مفعّلًا.`}),
    signal:AbortSignal.timeout(10000)
  });
  if(!response.ok)throw Object.assign(Error('Reset delivery provider rejected request'),{code:'MAIL_DELIVERY_FAILED'});
}
module.exports={config,deliver};
