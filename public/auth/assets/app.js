/* تفاعلات العرض الخاصة بدور: الدخول والتسجيل.
 * للتعديل: ابحث عن التعليق أو data-ui-* المقابل للعنصر في HTML.
 * المحتوى والسجلات داخل HTML؛ لا يتعامل هذا الملف مع قاعدة بيانات أو حفظ أو مصادقة.
 */
(() => {
  'use strict';

  function initializeUI() {
    // اختصارات للوصول إلى عناصر الصفحة باستخدام محددات CSS.
    const find = (selector, root = document) => root?.querySelector(selector);
    const targetOf = (control, attribute) => find(control.getAttribute(attribute));

    // تنبيه HTML ثابت للعمليات التي تنتظر ربط الخادم؛ لا ينشئ أو يعدّل سجلات.
    function showPendingNotice() {
      const notice = find('#backendPendingNotice');
      if (notice && window.bootstrap) bootstrap.Toast.getOrCreateInstance(notice).show();
    }

    // منع إرسال النماذج غير المربوطة بالخادم عند الضغط على Enter أو زر الإرسال.
    document.addEventListener('submit', (event) => {
      if (!event.target.matches('form[data-ui-unbound]')) return;
      event.preventDefault();
      showPendingNotice();
    });

    // تفويض النقر يسمح باستمرار عمل أزرار النماذج المضافة من قوالب HTML.
    document.addEventListener('click', (event) => {
      const control = event.target.closest('button,a');
      if (!control) return;
      if (control.matches('[data-ui-pending]')) {
        // إظهار تنبيه انتظار الربط عند طلب عملية تحتاج إلى الخادم.
        event.preventDefault();
        showPendingNotice();
      } else if (control.matches('[data-toggle-password]')) {
        // تبديل إظهار كلمة المرور فقط، دون قراءة قيمتها.
        event.preventDefault();
        const field = targetOf(control, 'data-toggle-password');
        if (field) field.type = field.type === 'password' ? 'text' : 'password';
      }
    });

    // فتح وإغلاق صندوق المساعدة؛ نصوصه موجودة في HTML.
    find('#chatToggleBtn')?.addEventListener('click', () => find('#chatWindow')?.classList.toggle('active'));
    find('#chatCloseBtn')?.addEventListener('click', () => find('#chatWindow')?.classList.remove('active'));

    // إظهار زر العودة للأعلى بعد التمرير وتنفيذ التمرير السلس.
    const topButton = find('.ux-top');
    topButton?.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    window.addEventListener('scroll', () => topButton?.classList.toggle('show', window.scrollY > 500), { passive: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeUI);
  } else {
    initializeUI();
  }
})();


/* UI alignment: local form interactions only. Server remains authoritative for
   authentication, scope permissions, record validation, persistence and transactions. */
(() => {
 'use strict';
 const ready = () => {
  const q=(s,r=document)=>r.querySelector(s), qa=(s,r=document)=>[...r.querySelectorAll(s)];
  const notice=()=>{const n=q('#backendPendingNotice');if(n&&window.bootstrap)bootstrap.Toast.getOrCreateInstance(n).show();};
  const fail=(e,msg)=>{e.setCustomValidity(msg);e.reportValidity();return false;};
  document.addEventListener('input',e=>{if(e.target.setCustomValidity)e.target.setCustomValidity('');});
  document.addEventListener('change',e=>{if(e.target.setCustomValidity)e.target.setCustomValidity('');});
  function clinicContext(){
   const s=q('[data-active-clinic]');if(!s)return;
   // Options come only from actual memberships; changing context requires server reauthorization.
   s.addEventListener('change',()=>{document.documentElement.dataset.clinicId=s.value;qa('[data-requires-permission]').forEach(x=>x.dataset.clinicId=s.value);notice();});
  }
  clinicContext();
  q('#catalogServiceId')?.addEventListener('change',e=>{
   const box=q('[data-new-service]'),n=q('#newCatalogServiceName');const yes=e.target.value==='__new__';box.hidden=!yes;n.disabled=!yes;n.required=yes;
  });
  q('[data-existing-doctor]')?.addEventListener('change',e=>{
   const o=e.target.selectedOptions[0];[['clinicDoctorName','name'],['clinicDoctorLicense','license'],['clinicDoctorEmail','email'],['clinicDoctorPhone','phone'],['clinicDoctorSpecialty','specialty']].forEach(([id,key])=>{const n=q('#'+id);if(n)n.value=o.dataset[key]||'';});
  });
  q('#existingStaffAccount')?.addEventListener('change',e=>{
   const o=e.target.selectedOptions[0];[['staffFormName','name'],['staffFormEmail','email'],['staffFormPhone','phone']].forEach(([id,key])=>{q('#'+id).value=o.dataset[key]||'';});
  });
  q('#applyRoleTemplate')?.addEventListener('click',()=>{
   const selected=q('#staffFormRole')?.selectedOptions[0];const values=(selected?.dataset.templatePermissions||'').split(',');
   qa('.staff-permissions-grid input[type="checkbox"]').forEach(e=>e.checked=values.includes(e.value));
  });
  function total(editor){
   let amount=0;
   qa('[data-invoice-line]',editor).forEach(row=>{
    const qty=q('[data-line-quantity]',row),price=q('[data-line-price]',row),discount=q('[data-line-discount]',row);
    const gross=Number(qty.value)*Number(price.value);discount.max=String(Math.max(0,gross));amount+=Math.max(0,gross-Number(discount.value));
   });
   const paid=q('[data-initial-payment]',editor);if(paid)paid.max=amount.toFixed(2);
   q('[data-invoice-total]',editor).textContent=amount.toFixed(2);
   q('[data-invoice-remaining]',editor).textContent=(amount-Number(paid?.value||0)).toFixed(2);
  }
  qa('[data-invoice-editor]').forEach(e=>{total(e);e.addEventListener('input',()=>total(e));});
  let nextLine=1;
  document.addEventListener('click',e=>{
   const add=e.target.closest('[data-add-invoice-line]');
   if(add){
    const editor=add.closest('[data-invoice-editor]'),body=q('[data-invoice-lines]',editor),row=q('[data-invoice-line]',body).cloneNode(true),idx=nextLine++;
    qa('input',row).forEach(i=>{i.name=i.name.replace(/items\[\d+\]/,`items[${idx}]`);i.value=i.matches('[data-line-quantity]')?'1':i.type==='number'?'0':'';});body.append(row);total(editor);return;
   }
   const rem=e.target.closest('[data-remove-invoice-line]');
   if(rem){const editor=rem.closest('[data-invoice-editor]');if(qa('[data-invoice-line]',editor).length>1){rem.closest('tr').remove();total(editor);}return;}
   const rm=e.target.closest('[data-remove-medication]');if(rm){rm.closest('.dynamic-list-item')?.remove();return;}
  });
  // Each prescription keeps its own form, medicine list and lifecycle.
  let rxNumber=1;
  document.addEventListener('click',e=>{
   const add=e.target.closest('[data-add-prescription]');if(!add)return;
   const source=q('[data-prescription-card]'),copy=source.cloneNode(true),n=++rxNumber,formId='prescription-form-'+n;
   copy.dataset.prescriptionId='RX-DRAFT-'+n;q('[data-rx-title]',copy).textContent='وصفة '+n+' — مسودة';
   const mapping=new Map();qa('[id]',copy).forEach(el=>{mapping.set(el.id,el.id+'-rx'+n);el.id+='-rx'+n;});
   qa('[for]',copy).forEach(el=>{if(mapping.has(el.htmlFor))el.htmlFor=mapping.get(el.htmlFor);});
   qa('input,select,textarea,button',copy).forEach(el=>{
    if(el.hasAttribute('form'))el.setAttribute('form',formId);
    if(el.matches('input,textarea'))el.value='';
    if(el.matches('select'))el.value='draft';
   });
   const list=q('.dynamic-list-item',copy);qa('.dynamic-list-item',copy).slice(1).forEach(el=>el.remove());
   const addMed=q('[data-ui-add-template]',copy);if(addMed){addMed.removeAttribute('data-ui-add-template');addMed.removeAttribute('data-ui-add-slot');addMed.dataset.addRxMedicine='';}
   q('[data-rx-status]',copy).value='draft';
   const f=document.createElement('form');f.id=formId;f.method='post';f.hidden=true;f.dataset.uiUnbound='';f.dataset.visitId='V-001';f.dataset.prescriptionId='RX-DRAFT-'+n;document.body.append(f);
   q('#additionalPrescriptions').append(copy);
  });
  document.addEventListener('click',e=>{
   const b=e.target.closest('[data-add-rx-medicine]');if(!b)return;
   const card=b.closest('[data-prescription-card]'),list=q('[id^="medicationList"]',card),base=q('.dynamic-list-item',card)||q('.dynamic-list-item',q('[data-prescription-card]'));
   const row=base.cloneNode(true),formId=q('[data-rx-status]',card).getAttribute('form');
   qa('[id]',row).forEach(el=>el.removeAttribute('id'));qa('label[for]',row).forEach(el=>el.removeAttribute('for'));
   qa('input,textarea,select,button',row).forEach(el=>{if(el.hasAttribute('form'))el.setAttribute('form',formId);if(el.matches('input,textarea'))el.value='';});list.append(row);
  });
  function rxFields(card){
   const status=q('[data-rx-status]',card)?.value;
   qa('.dynamic-list-item input',card).forEach(el=>el.required=status==='issued'&&!el.matches('[data-field="instructions"]'));
   const reason=q('[data-field="voidReason"]',card);if(reason)reason.required=status==='voided';
  }
  document.addEventListener('change',e=>{if(e.target.matches('[data-rx-status]'))rxFields(e.target.closest('[data-prescription-card]'));});
  // Form validation runs before the original unbound-submit handler. No fake save.
  document.addEventListener('submit',e=>{
   const f=e.target;if(!(f instanceof HTMLFormElement))return;
   const editor=qa('[data-invoice-editor]').find(ed=>q('button[form="'+f.id+'"]',ed));
   if(editor){
    total(editor);
    const invalid=qa('input',editor).find(el=>!el.checkValidity());
    if(invalid){e.preventDefault();e.stopImmediatePropagation();invalid.reportValidity();return;}
   }
   const card=qa('[data-prescription-card]').find(c=>q('[data-rx-status]',c)?.getAttribute('form')===f.id);
   if(card){rxFields(card);const status=q('[data-rx-status]',card).value;
    if(status==='issued'&&!q('.dynamic-list-item',card)){e.preventDefault();e.stopImmediatePropagation();fail(q('[data-rx-status]',card),'أضف دواء واحدًا على الأقل قبل الإصدار.');return;}
    const invalid=qa('input',card).find(el=>!el.checkValidity());if(invalid){e.preventDefault();e.stopImmediatePropagation();invalid.reportValidity();return;}
   }
   const pass=f.querySelector('input[type="password"][autocomplete="new-password"]'),confirm=f.querySelector('#confirmPassword');
   if(pass&&confirm&&pass.value!==confirm.value){e.preventDefault();e.stopImmediatePropagation();fail(confirm,'كلمتا المرور غير متطابقتين.');return;}
   const catalog=q('#catalogServiceId');if(catalog?.form===f&&catalog.value==='__new__'){
    const name=q('#newCatalogServiceName');if(qa('option',catalog).some(o=>o.value!=='__new__'&&o.textContent.trim()===name.value.trim())){e.preventDefault();e.stopImmediatePropagation();fail(name,'الخدمة موجودة في الكتالوج؛ اخترها بدل تكرارها.');return;}
   }
  },true);
  // All save buttons submit the associated form so native validity can run.
  qa('button[type="submit"][form][data-ui-pending],form button[type="submit"][data-ui-pending]').forEach(b=>b.removeAttribute('data-ui-pending'));
  // Blank template IDs are not duplicated when adding rows.
  document.addEventListener('click',e=>{
   const b=e.target.closest('[data-ui-add-template]');if(!b)return;
   const template=q(b.dataset.uiAddTemplate);if(!template)return;
   qa('input',template.content).forEach(el=>{if(el.name==='quantity'){el.value='1';el.min='1';el.step='1';}});
  },true);
  // Internal filters operate on existing demo rows, without inventing records.
  [['#invoiceSearch','.invoice-filter-item'],['#jobSearch','.job-filter-item'],['#patientSearch','.patient-filter-item']].forEach(([inputSel,rowSel])=>{
   q(inputSel)?.addEventListener('input',e=>{const term=e.target.value.trim();qa(rowSel).forEach(row=>row.hidden=!row.textContent.includes(term));});
  });
 };
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready);else ready();
})();

(() => {
 'use strict';
 const init=()=>{
  const q=(s,r=document)=>r.querySelector(s),qa=(s,r=document)=>[...r.querySelectorAll(s)];
  [['#needsLab','#labFields'],['#needsFollowup','#followupFields']].forEach(([c,s])=>{
   const box=q(c),panel=q(s);if(box&&panel){const apply=()=>{panel.classList.toggle('d-none',!box.checked);};box.addEventListener('change',apply);apply();}
  });
  const role=q('#userFormRole');
  if(role){const apply=()=>qa('[data-user-role-fields]').forEach(section=>{
   const active=section.dataset.userRoleFields===role.value;section.classList.toggle('d-none',!active);qa('input,select,textarea',section).forEach(e=>e.disabled=!active);
  });role.addEventListener('change',apply);apply();}
  function bindRx(){qa('[data-prescription-card]').forEach(card=>{
   const formId=q('[data-rx-status]',card)?.getAttribute('form');
   qa('.dynamic-list-item',card).forEach((row,i)=>qa('input[data-medication-field]',row).forEach(e=>{e.name=`medications[${i}][${e.dataset.medicationField}]`;if(formId)e.setAttribute('form',formId);}));
  });}
  bindRx();const rx=q('#prescription');if(rx)new MutationObserver(bindRx).observe(rx,{childList:true,subtree:true});
  const money=()=>{
   const qty=q('[data-admin-quantity]'),price=q('[data-admin-price]'),total=q('[data-admin-invoice-total]'),paid=q('#invoiceFormPaid');
   if(qty&&price&&total){total.value=(Number(qty.value)*Number(price.value)).toFixed(2);if(paid)paid.max=total.value;}
  };
  qa('[data-admin-quantity],[data-admin-price]').forEach(e=>e.addEventListener('input',money));money();
  // Permission attributes are rendering/integration hooks; server authorization is mandatory.
  qa('[data-requires-permission]').forEach(e=>{if(!e.dataset.clinicId)e.dataset.clinicId='C-008';});
 };
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();

/* Registration correction: one professional-specialties input group. */
(() => {
 const init=()=>{
  const group=document.querySelector('[data-specialty-group]');
  if(group){
   const checks=[...group.querySelectorAll('input[name="specialty_ids[]"]')];
   const error=group.querySelector('#specialtySelectionError');
   function validate(show=false){const count=checks.filter(c=>c.checked).length,valid=count>0&&count<=6;if(checks[0])checks[0].setCustomValidity(valid?'':'اختر بين تخصص واحد وستة تخصصات.');if(error)error.hidden=valid||!show;return valid;}
   checks.forEach(c=>c.addEventListener('change',()=>validate(true)));validate();
   const form=group.closest('form');
   form.addEventListener('invalid',()=>validate(true),true);
   form.addEventListener('submit',e=>{if(!validate(true)){e.preventDefault();e.stopImmediatePropagation();checks[0]?.reportValidity();}},true);
  }
  const login=document.querySelector('form[data-demo-login]')||document.querySelector('form');
  if(login&&new URLSearchParams(location.search).get('first_login')==='1'&&location.pathname.endsWith('/login')){
   login.dataset.afterAuthentication='../patient/index?first_login=1';
  }
 };
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();

/* Authentication integration: server cookie owns the pending MFA challenge and session.
 * No password, reset token, or permission is stored in browser storage. */
(() => {
 'use strict';
 const authRoot=new URL(location.pathname.includes('/auth/password/')?'../':'./',location.href);
 const projectRoot=new URL('../',authRoot);
 const authUrl=rel=>new URL(rel,authRoot).href;
 const activeMemberships=s=>(s.memberships||[]).filter(m=>m.status==='active'&&(!m.clinicStatus||m.clinicStatus==='active'));
 const staffRoute=async s=>{
  if(!s||s.authenticated!==true||s.requiresMfa===true)throw Error('Incomplete authentication');
  if(s.role!=='staff')return null;
  if(s.accountStatus!=='active'||activeMemberships(s).length!==1)return authUrl('../staff/choose-clinic');
  const id=String(activeMemberships(s)[0].clinicId);
  if(String(s.activeClinicId||'')!==id){
   if(typeof window.SDC_STAFF_API?.selectClinic!=='function')throw Error('Selection unavailable');
   const result=await window.SDC_STAFF_API.selectClinic({clinicId:id});
   if(String(result?.activeClinicId)!==id)throw Error('Selection rejected');
  }
  return authUrl('../staff/index?clinic='+encodeURIComponent(id));
 };
 window.SDCStaffLogin={destination:staffRoute};
 const destination=async s=>{
  if(s?.requiresMfa===true)return authUrl('mfa');
  if(s?.authenticated!==true||s.accountStatus!=='active')throw Error('Inactive or unauthenticated account');
  if(s.role==='staff')return staffRoute(s);
  if(!['admin','patient','doctor'].includes(s.role))throw Error('Unknown role');
  // A server-selected onboarding route must stay within this project and role.
  if(s.nextUrl){
   const u=new URL(s.nextUrl,projectRoot),rolePrefix=new URL(s.role+'/',projectRoot).pathname;
   const onboarding=s.role==='doctor'&&u.pathname.startsWith(new URL('onboarding/doctor/',projectRoot).pathname);
   if(u.origin!==projectRoot.origin||(!u.pathname.startsWith(rolePrefix)&&!onboarding)||u.username||u.password)throw Error('Invalid destination');
   return u.href;
  }
  return new URL(s.role+'/index'+(s.role==='patient'&&s.healthProfileCompleted===false?'?first_login=1':''),projectRoot).href;
 };
 window.SDCAuthFlow={destination};
 const go=async s=>location.assign(await destination(s));
 document.addEventListener('sdc:authenticated',e=>go(e.detail).catch(()=>document.dispatchEvent(new CustomEvent('sdc:staff-routing-error'))));
 document.addEventListener('sdc:mfa-required',()=>location.assign(authUrl('mfa')));
 const init=()=>{
  const login=document.querySelector('#loginForm'),forgot=document.querySelector('#forgotPasswordForm'),reset=document.querySelector('#resetPasswordForm'),mfa=document.querySelector('#mfaForm');
  const form=login||forgot||reset||mfa;if(!form)return;
  if(login?.dataset.serverAuth==='true'||form?.dataset.serverAuth==='true')return; // Native SSR flows; do not intercept POST.
  let box=document.querySelector('#authFlowMessage');if(!box){box=document.createElement('div');box.id='authFlowMessage';box.className='alert alert-info mt-3';box.setAttribute('role','status');form.after(box);box.hidden=true;}
  const show=(text,error=false)=>{box.textContent=text;box.className='alert mt-3 '+(error?'alert-danger':'alert-info');box.hidden=false;};
  const token=reset?new URLSearchParams(location.search).get('token'):null;
  let resetValid=false;
  if(reset){
   const check=async()=>{
    const button=reset.querySelector('button');button.disabled=true;
    if(!token){show('رابط الاستعادة غير صالح. اطلب رابطًا جديدًا.',true);return;}
    if(typeof window.SDC_AUTH_API?.validateResetToken!=='function'){show('التحقق من صلاحية الرابط بانتظار ربط الخدمة.');return;}
    try{resetValid=(await window.SDC_AUTH_API.validateResetToken({token}))?.valid===true;if(!resetValid)show('انتهت صلاحية الرابط أو تم استخدامه. اطلب رابطًا جديدًا.',true);else{button.disabled=false;box.hidden=true;}}
    catch{show('تعذّر التحقق من الرابط. أعد المحاولة.',true);}
   };check();
  }
  document.addEventListener('submit',async e=>{
   if(e.target!==form)return;e.preventDefault();e.stopImmediatePropagation();if(!form.reportValidity())return;
   const api=window.SDC_AUTH_API;
   const method=login?'authenticate':forgot?'requestPasswordReset':reset?'resetPassword':'verifyMfa';
   if(typeof api?.[method]!=='function'){show('هذه العملية بانتظار ربط الخدمة. لم تتغير أي بيانات.');return;}
   if(reset&&!resetValid){show('تحقق من صلاحية رابط الاستعادة أولًا.',true);return;}
   const values=Object.fromEntries(new FormData(form));
   if(reset&&values.password!==values.password_confirmation){show('كلمتا المرور غير متطابقتين.',true);return;}
   const button=form.querySelector('button[type="submit"]');button.disabled=true;box.hidden=true;
   try{
    if(login){await go(await api.authenticate(values));}
    else if(mfa){await go(await api.verifyMfa({code:values.code}));}
    else if(forgot){const result=await api.requestPasswordReset({email:values.email});if(result?.accepted!==true)throw Error();location.assign(authUrl('password/reset-link-sent'));}
    else {const result=await api.resetPassword({token,password:values.password,password_confirmation:values.password_confirmation});if(result?.reset!==true)throw Error();form.reset();form.hidden=true;show('تم تغيير كلمة المرور. يمكنك الآن العودة لتسجيل الدخول.');}
   }catch{show(login?'تعذّر تسجيل الدخول. تحقق من البيانات وحالة الحساب.':mfa?'الرمز غير صحيح أو انتهت جلسة التحقق. أعد المحاولة أو ارجع لتسجيل الدخول.':reset?'تعذّر تغيير كلمة المرور. قد يكون الرابط منتهي الصلاحية أو مستخدمًا.':'تعذّر إرسال الطلب. أعد المحاولة لاحقًا.',true);}
   finally{button.disabled=false;}
  },true);
 };
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
