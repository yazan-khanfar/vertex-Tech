/* Restore the original visit UI with server-backed form submissions.
 * This script handles UI selection and form submits ONLY. All records, options,
 * access checks, prices and tooth states are supplied and validated by the server.
 */
(()=>{
 'use strict';
 // One visit page, five visual tabs. No backend operations or patient data in this controller.
 function initVisitTabs(page){
  const names={start:['بداية الزيارة','سجّل الشكوى والفحص الأولي، ثم انتقل إلى الأقسام الأخرى حسب الحاجة.'],diagnosis:['الأسنان والتشخيص','وثّق حالة سن واحد وتشخيصه، وأرفق الأشعة عند الحاجة.'],treatment:['العلاج','سجّل الإجراءات وراجع خطة العلاج الموجودة.'],orders:['الوصفات والطلبات','الوصفات الطبية والطلبات المخبرية واقتراح المتابعة.'],finish:['التقرير والإنهاء','راجع المعلومات والفاتورة للعرض فقط، ثم أنهِ الزيارة واعتمد التقرير عند استيفاء الشروط.']};
  const cards=[...page.querySelectorAll('.clinical-section[data-visit-tab]')];
  const buttons=[...page.querySelectorAll('[role="tab"][data-visit-tab-target]')];
  if(cards.length!==12||buttons.length!==5)return; // Fallback: show original complete page.
  const help=page.querySelector('#visit-tab-help'),title=page.querySelector('#visit-tab-heading-text');
  const actions=page.querySelector('[data-visit-actions]'),save=page.querySelector('#saveVisitDraft'),finish=page.querySelector('#finishVisit');
  const dirty=page.querySelector('#visit-unsaved-note');
  const key='sdc-visit-tab:'+page.dataset.bookingId;
  let active='start';
  const readSaved=()=>{try{return sessionStorage.getItem(key);}catch{return null;}};
  const saveSelected=v=>{try{sessionStorage.setItem(key,v);}catch{}};
  const hashTab=()=>{const id=decodeURIComponent(location.hash.slice(1));return cards.find(x=>x.id===id)?.dataset.visitTab;};
  function activate(v,focus=false){
   if(!names[v])return;
   active=v;
   cards.forEach(card=>card.hidden=card.dataset.visitTab!==v);
   buttons.forEach(b=>{const current=b.dataset.visitTabTarget===v;b.setAttribute('aria-selected',String(current));b.tabIndex=current?0:-1;});
   page.querySelectorAll('.visit-quick-link[data-visit-tab-target]').forEach(b=>{if(b.dataset.visitTabTarget===v)b.setAttribute('aria-current','step');else b.removeAttribute('aria-current');});
   if(title)title.textContent=names[v][0];if(help)help.textContent=names[v][1];
   if(actions){actions.hidden=v!=='start'&&v!=='finish';}
   if(save)save.hidden=v!=='start';if(finish)finish.hidden=v!=='finish';
   saveSelected(v);
   if(focus){page.querySelector('#visit-workflow')?.scrollIntoView({behavior:'smooth',block:'start'});buttons.find(b=>b.dataset.visitTabTarget===v)?.focus({preventScroll:true});}
  }
  page.classList.add('visit-tabs-ready');
  activate(hashTab()||readSaved()||'start');
  page.querySelectorAll('[data-visit-tab-target]').forEach(b=>b.addEventListener('click',()=>activate(b.dataset.visitTabTarget,true)));
  page.querySelector('#visit-tab-list')?.addEventListener('keydown',e=>{
   if(!['ArrowRight','ArrowLeft','Home','End'].includes(e.key))return;
   e.preventDefault();let index=buttons.findIndex(b=>b.dataset.visitTabTarget===active);
   if(e.key==='Home')index=0;else if(e.key==='End')index=buttons.length-1;else index=(index+(e.key==='ArrowRight'?-1:1)+buttons.length)%buttons.length;
   activate(buttons[index].dataset.visitTabTarget,true);
  });
  window.addEventListener('hashchange',()=>{const v=hashTab();if(v)activate(v);});
  page.addEventListener('input',e=>{if(e.target.matches('input:not([type="hidden"]),textarea,select')&&dirty)dirty.hidden=false;});
  page.addEventListener('change',e=>{if(e.target.matches('input:not([type="hidden"]),select,textarea')&&dirty)dirty.hidden=false;});
  // Saving submits a real backend form. A successful redirect will reset pending hint.
  page.addEventListener('submit',()=>{if(dirty)dirty.hidden=true;});
 }
 const ready=()=>{
  const page=document.querySelector('main[data-booking-id]');
  if(!page)return;
  initVisitTabs(page);
  // Initialize new and approved visits too: starting and locking are lifecycle actions.
  const q=(sel,base=page)=>base.querySelector(sel);
  const mainForm=q('#doctor-visit-action-form');
  const clinicalForm=q('#doctor-visit-clinical-form');
  // A new booking has no VISIT row yet. This is NOT the same as an approved report.
  const hasVisit=Boolean(page.dataset.visitId),approved=page.dataset.reportApproved==='yes';
  const completed=page.dataset.visitStatus==='completed';
  const followupCheckbox=q('#needsFollowup');if(followupCheckbox)followupCheckbox.checked=followupCheckbox.dataset.savedFollowup==='1';
  const notice=(s)=>window.alert(s);
  function post(form,action,values){
   if(!form)return;
   form.elements.action.value=action;
   form.querySelectorAll('[data-dynamic-field]').forEach(x=>x.remove());
   for(const [name,value] of Object.entries(values||{})){
    const el=document.createElement('input');el.type='hidden';el.name=name;el.value=String(value??'');el.dataset.dynamicField='1';form.appendChild(el);
   }
   HTMLFormElement.prototype.submit.call(form);
  }
  function saveNotes(action){
   if(completed)return notice('الزيارة مكتملة؛ لا يمكن تعديل بياناتها الأساسية.');
   if(action==='start' && page.dataset.patientArrived==='no')return notice('يجب تسجيل وصول المريض من عمليات العيادة قبل بدء الزيارة.');
   const complaint=q('#chiefComplaint')?.value.trim()||'';
   const exam=q('#examinationNotes')?.value.trim()||'';
   if(!complaint)return notice('أدخل سبب الزيارة أولًا.');
   if(action==='complete'&&!exam)return notice('أدخل ملاحظات الفحص قبل إنهاء الزيارة.');
   mainForm.elements.chief_complaint.value=complaint;
   mainForm.elements.examination_notes.value=exam;
   post(mainForm,action,{});
  }
  q('#saveVisitDraft')?.addEventListener('click',e=>{e.preventDefault();saveNotes(hasVisit?'save':'start');});
  q('#finishVisit')?.addEventListener('click',e=>{
   e.preventDefault();
   if(!hasVisit||completed)return notice('ابدأ الزيارة أولًا، ولا يمكن إنهاء زيارة مكتملة مجددًا.');
   if(!(q('#chiefComplaint')?.value||'').trim()||!(q('#examinationNotes')?.value||'').trim())return notice('أدخل سبب الزيارة وملاحظات الفحص السريري قبل الإنهاء.');
   const modal=q('#finishVisitModal');
   if(modal&&window.bootstrap)window.bootstrap.Modal.getOrCreateInstance(modal).show();
   else if(confirm('هل تريد إكمال الزيارة؟'))saveNotes('complete');
  });
  q('[data-visit-complete]')?.addEventListener('click',e=>{
   e.preventDefault();
   if(!hasVisit||completed)return;
   saveNotes('complete');
  });
  let selectedTooth='';
  const teeth=q('#odontogram');
  const label=q('#selectedTooth'),stateLabel=q('#selectedToothState');
  const descriptions={healthy:'سليم',caries:'تسوس',filled:'حشوة',root_canal:'علاج جذور',crown:'تاج',missing:'مفقود',implant:'زرعة',other:'أخرى'};
  teeth?.addEventListener('click',e=>{
   const tooth=e.target.closest('button.tooth[data-tooth]');
   if(tooth){
    selectedTooth=tooth.dataset.tooth;
    teeth.querySelectorAll('button.tooth').forEach(b=>b.classList.remove('selected'));
    tooth.classList.add('selected');
    const surfaceTooth=q('#sdcToothSurface [data-field="tooth"]');if(surfaceTooth)surfaceTooth.value=selectedTooth;
    if(label)label.textContent=selectedTooth;
    if(stateLabel)stateLabel.textContent=descriptions[tooth.dataset.state]||tooth.dataset.state||'—';
    return;
   }
   const state=e.target.closest('button[data-visit-tooth-status]');
   if(!state)return;
   e.preventDefault();
   if(!hasVisit)return notice('ابدأ الزيارة أولًا من زر بدء الزيارة وحفظ الشكوى، ثم حدد حالة السن.');
   if(approved)return notice('التقرير معتمد ولا يمكن تغيير حالة السن.');
   if(!selectedTooth)return notice('اختر سنًا واحدًا أولًا.');
   post(clinicalForm,'odontogram',{tooth_number:selectedTooth,tooth_status:state.dataset.visitToothStatus});
  });
  const labToggle=q('#needsLab');const labFields=q('#labFields');
  labToggle?.addEventListener('change',()=>labFields?.classList.toggle('d-none',!labToggle.checked));
  q('#sdcAddLab')?.addEventListener('click',e=>{
   e.preventDefault();const list=q('#ui-slot-sdcAddLab');const template=list?.querySelector('[data-lab-item]');
   if(!list||!template||list.querySelectorAll('[data-lab-item]').length>=10)return notice('الحد الأعلى 10 أعمال في الطلب الواحد.');
   const clone=template.cloneNode(true);clone.querySelectorAll('input').forEach(x=>{x.value=x.type==='number'?'1':'';});list.appendChild(clone);
  });
  q('#lab')?.addEventListener('click',e=>{
   const b=e.target.closest('[data-remove-lab-item]');if(!b)return;e.preventDefault();const list=q('#ui-slot-sdcAddLab');
   if(list?.querySelectorAll('[data-lab-item]').length>1)b.closest('[data-lab-item]').remove();
  });
  const medicationRoot=q('#medicationList');
  q('#addMedication')?.addEventListener('click',e=>{
   e.preventDefault();const row=medicationRoot?.querySelector('[data-sdc-enriched]');if(!row)return;
   if(medicationRoot.querySelectorAll('[data-sdc-enriched]').length>=12)return notice('الحد الأعلى 12 دواء في الوصفة.');
   const clone=row.cloneNode(true);clone.querySelectorAll('input').forEach((x,i)=>{x.value='';x.removeAttribute('id');});
   clone.querySelectorAll('label').forEach(x=>x.removeAttribute('for'));medicationRoot.appendChild(clone);
  });
  medicationRoot?.addEventListener('click',e=>{
   const b=e.target.closest('[data-remove-medication]');if(!b)return;e.preventDefault();e.stopPropagation();const rows=medicationRoot.querySelectorAll('[data-sdc-enriched]');
   if(rows.length>1)b.closest('[data-sdc-enriched]').remove();else b.closest('[data-sdc-enriched]').querySelectorAll('input').forEach(x=>x.value='');
  });
  q('[data-add-prescription]')?.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();medicationRoot?.querySelectorAll('[data-sdc-enriched]').forEach((row,i)=>{if(i)row.remove();else row.querySelectorAll('input').forEach(x=>x.value='');});medicationRoot?.querySelector('[data-sdc-enriched] input')?.focus();});
  document.addEventListener('click',e=>{
   const action=e.target.closest('button[data-visit-save]');
   if(!action||!page.contains(action))return;
   e.preventDefault();
   if(!hasVisit)return notice('ابدأ الزيارة أولًا من زر بدء الزيارة وحفظ الشكوى، ثم احفظ بيانات هذا القسم.');
   if(approved)return notice('التقرير معتمد ولا يمكن تعديل بيانات الزيارة.');
   const kind=action.dataset.visitSave;
   if(kind==='findings'){
    const selected=[...q('#exam').querySelectorAll('input[name="finding"]:checked')].map(x=>x.value);
    post(clinicalForm,'findings',{findings:selected.join('|')});return;
   }
   if(kind==='surface_note'){
    const section=q('#sdcToothSurface'),t=section.querySelector('[data-field="tooth"]')?.value||'',surface=section.querySelector('[data-field="surface"]')?.value||'',note=section.querySelector('[data-field="surfaceNote"]')?.value.trim()||'';
    if(!t||!surface||!note)return notice('اختر سنًا واحدًا وسطحًا وملاحظة.');
    post(clinicalForm,'surface_note',{tooth_number:t,surface,surface_note:note});return;
   }
   if(kind==='lab_order'){
    const section=q('#lab');if(!section.querySelector('#needsLab')?.checked)return notice('فعّل خيار الحاجة إلى المختبر.');
    const items=[...section.querySelectorAll('[data-lab-item]')].map(row=>{const field=k=>row.querySelector('[data-field="'+k+'"]')?.value.trim()||'';return {work:field('work_type'),tooth:field('tooth_code'),area:field('area_text'),quantity:field('quantity'),material:field('material'),shade:field('shade'),instructions:field('instructions')};});
    const laboratory_id=section.querySelector('[data-field="lab"]')?.value||'',delivery_date=section.querySelector('[data-field="due"]')?.value||'',lab_notes=section.querySelector('[data-field="labNotes"]')?.value||'',attachment_file_id=section.querySelector('[data-field="labFile"]')?.value||'';
    if(!laboratory_id||!delivery_date||items.some(i=>!i.work||!i.quantity))return notice('اختر المختبر وموعد التسليم وأكمل الأعمال المطلوبة.');
    post(clinicalForm,'lab_order',{laboratory_id,delivery_date,lab_notes,attachment_file_id,lab_items:JSON.stringify(items)});return;
   }
   if(kind==='recommendations'){
    post(clinicalForm,'recommendations',{recommendations:q('#visitRecommendations')?.value||''});return;
   }
   if(kind==='diagnosis'){
    const tooth=q('#newDiagnosisTooth')?.value.trim(),diagnosis=q('#newDiagnosisText')?.value.trim();
    if(!tooth||!diagnosis)return notice('أدخل رقم السن والتشخيص.');
    post(clinicalForm,'diagnosis',{tooth_number:tooth,diagnosis});
   }
   if(kind==='procedure'){
    if(completed)return notice('تسجيل إجراء منفذ متاح أثناء الزيارة فقط.');
    const section=q('#procedure'),service=section.querySelector('[data-field="work"]')?.value||'';
    if(!service)return notice('لا توجد خدمات مخصصة لك في العيادة المختارة.');
    post(clinicalForm,'procedure',{
     service_id:service,tooth_number:section.querySelector('[data-field="tooth"]')?.value||'',
     quantity:section.querySelector('[data-field="quantity"]')?.value||'1',
     stage_id:section.querySelector('[data-field="planItem"]')?.value||'',
     procedure_status:section.querySelector('[data-field="status"]')?.value||'completed',
     notes:section.querySelector('[data-field="notes"]')?.value||''
    });
   }
   if(kind==='prescription'){
    const medicines=[...q('#medicationList').querySelectorAll('[data-sdc-enriched]')].map(row=>{const read=k=>row.querySelector('[data-medication-field="'+k+'"]')?.value.trim()||'';return {name:read('medication_name'),dose:read('dosage'),frequency:read('frequency'),duration:read('duration'),route:read('route'),instructions:read('instructions')};});
    const missingIndex=medicines.findIndex(m=>!m.name||!m.dose||!m.frequency||!m.duration||!m.route);
    if(!medicines.length||missingIndex>=0){const row=q('#medicationList')?.querySelectorAll('[data-sdc-enriched]')[Math.max(0,missingIndex)];const missing=[...row?.querySelectorAll('input[data-medication-field]')||[]].find(x=>x.dataset.medicationField!=='instructions'&&!x.value.trim());missing?.focus();return notice('أكمل حقول الدواء رقم '+(Math.max(0,missingIndex)+1)+'، بما فيها طريق الاستعمال.');}
    const prescription_status=q('#sdcPrescriptionLifecycle [data-rx-status]')?.value||'draft';
    post(clinicalForm,'prescription_multi',{medications:JSON.stringify(medicines),prescription_status});
   }
   if(kind==='followup'){
    const section=q('#followup');
    if(!section.querySelector('#needsFollowup')?.checked)return notice('فعّل خيار يحتاج المريض متابعة أولًا.');
    const args={followup_type:section.querySelector('[name="follow_up_type"]')?.value||'',followup_date:section.querySelector('[name="suggested_date"]')?.value||'',followup_notes:section.querySelector('[name="follow_up_notes"]')?.value||''};
    if(!args.followup_type||!args.followup_date)return notice('حدد نوع المتابعة والتاريخ المقترح.');
    post(clinicalForm,'followup',args);
   }
  });
  // Stage edits remain on the existing treatment-plan detail route, which owns the stage writes.
  q('#addPlanStep')?.addEventListener('click',e=>{
   e.preventDefault();const link=q('#plan a[href*="treatment-plan-details"]');
   if(link)window.location.assign(link.href);else window.location.assign('/doctor/treatment-plans');
  });
  // Medical report approval continues through the existing form with CSRF; it is not simulated here.
  if(completed){
   [q('#chiefComplaint'),q('#examinationNotes')].filter(Boolean).forEach(x=>{
    x.readOnly=true;
    x.setAttribute('aria-readonly','true');
    x.title='الزيارة مكتملة؛ هذه الملاحظة للقراءة فقط.';
   });
   [q('#saveVisitDraft'),q('#finishVisit')].filter(Boolean).forEach(x=>{x.disabled=true;x.setAttribute('aria-disabled','true');});
  }
  if(approved){
   // Only an approved report locks clinical controls. A new booking is not approved;
   // let doctors interact with fields and guide them to start before saving.
   // Completed but unapproved visits may still save permitted findings.
   q('#exam')?.querySelectorAll('input[name="finding"]').forEach(x=>x.disabled=true);
   q('#odontogram')?.querySelectorAll('button.state-btn').forEach(x=>x.disabled=true);
   q('#addDiagnosis')?.setAttribute('disabled','disabled');
   q('#sdcAddProcedure')?.setAttribute('disabled','disabled');
   q('#needsFollowup')?.setAttribute('disabled','disabled');
   q('[data-visit-save="prescription"]')?.setAttribute('disabled','disabled');
   q('[data-visit-save="followup"]')?.setAttribute('disabled','disabled');
   page.querySelectorAll('[data-visit-save],#addMedication,#sdcAddLab').forEach(x=>x.setAttribute('disabled','disabled'));
  }
 };
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready);else ready();
})();
