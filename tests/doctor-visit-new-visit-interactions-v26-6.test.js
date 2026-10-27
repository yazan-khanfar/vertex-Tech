'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

function initialize({visitId='',approved='no',status='not_started',arrived='yes'}={}){
  const listeners={};
  const checkboxes=[{disabled:false},{disabled:false}];
  const save={disabled:false,setAttribute(){},addEventListener(name,fn){listeners['save:'+name]=fn;}};
  const findings={disabled:false,setAttribute(name){if(name==='disabled')this.disabled=true;}};
  const stateButton={disabled:false};
  const alerts=[];
  const form={elements:{action:{value:''},chief_complaint:{value:''},examination_notes:{value:''}},querySelectorAll:()=>[],appendChild(){},submitted:false};
  const rootItems={
    '#doctor-visit-action-form':form,
    '#doctor-visit-clinical-form':{querySelectorAll:()=>[],elements:{action:{value:''}},appendChild(){}},
    '#saveVisitDraft':save,
    '#chiefComplaint':{value:'ألم الأسنان',setAttribute(){}},
    '#examinationNotes':{value:'',setAttribute(){}},
    '#exam':{querySelectorAll:selector=>selector==='input[name="finding"]'?checkboxes:[]},
    '#odontogram':{addEventListener(name,fn){listeners['teeth:'+name]=fn;},querySelectorAll:()=>[stateButton]},
    '#addDiagnosis':{disabled:false,setAttribute(name){if(name==='disabled')this.disabled=true;}},
    '#sdcAddProcedure':{disabled:false,setAttribute(name){if(name==='disabled')this.disabled=true;}},
    '#needsFollowup':{disabled:false,dataset:{savedFollowup:'0'},setAttribute(name){if(name==='disabled')this.disabled=true;}}
  };
  const page={dataset:{bookingId:'10',visitId,visitStatus:status,reportApproved:approved,patientArrived:arrived,clinicalEnabled:visitId&&approved==='no'?'yes':'no'},
    querySelector(selector){return rootItems[selector]||null;},querySelectorAll(selector){return selector==='[data-visit-save],#addMedication,#sdcAddLab'?[findings]:[];},contains:()=>true};
  const document={readyState:'complete',querySelector(selector){return selector==='main[data-booking-id]'?page:null;},addEventListener(name,fn){listeners['document:'+name]=fn;},createElement:()=>({dataset:{}})};
  function HTMLFormElement(){};
  HTMLFormElement.prototype.submit=function(){this.submitted=true;};
  vm.runInNewContext(read('public/doctor/assets/visit-bridge.js'),{document,window:{alert:s=>alerts.push(s)},HTMLFormElement}, {timeout:2000});
  return {listeners,checkboxes,save,form,alerts,findings,stateButton};
}

test('new visit is not mistaken for approved report; inputs and buttons remain clickable',()=>{
  const x=initialize();
  assert.equal(x.checkboxes.every(c=>!c.disabled),true);
  assert.equal(x.stateButton.disabled,false);
  assert.equal(x.findings.disabled,false);
  assert.equal(x.save.disabled,false);
  x.listeners['document:click']({target:{closest:selector=>selector==='button[data-visit-save]'?{dataset:{visitSave:'findings'}}:null},preventDefault(){}});
  assert.match(x.alerts[0],/ابدأ الزيارة أولًا/);
  assert.equal(x.form.submitted,false);
});

test('starting a new visit submits the real server action, not a demo button',()=>{
  const x=initialize();
  x.listeners['save:click']({preventDefault(){}});
  assert.equal(x.form.elements.action.value,'start');
  assert.equal(x.form.elements.chief_complaint.value,'ألم الأسنان');
  assert.equal(x.form.submitted,true);
});


test('new visits require clinic check-in before starting, without disabling the UI',()=>{
  const x=initialize({arrived:'no'});
  x.listeners['save:click']({preventDefault(){}});
  assert.match(x.alerts[0],/تسجيل وصول المريض/);
  assert.equal(x.form.submitted,false);
  assert.equal(x.save.disabled,false);
});

test('started, unapproved visit keeps clinical controls active',()=>{
  const x=initialize({visitId:'12',status:'in_progress'});
  assert.equal(x.checkboxes.every(c=>!c.disabled),true);
  assert.equal(x.stateButton.disabled,false);
  assert.equal(x.findings.disabled,false);
});

test('approved report locks clinical controls and keeps the notes protected',()=>{
  const x=initialize({visitId:'12',status:'completed',approved:'yes'});
  assert.equal(x.checkboxes.every(c=>c.disabled),true);
  assert.equal(x.stateButton.disabled,true);
  assert.equal(x.findings.disabled,true);
  assert.equal(x.save.disabled,true);
});

test('template distinguishes report approval from the existence of a visit and labels start action clearly',()=>{
  const view=read('views/doctor/visit.ejs');
  const bridge=read('public/doctor/assets/visit-bridge.js');
  assert.match(view,/data-patient-arrived=/);
  assert.match(view,/data-report-approved="<%= clinical && clinical\.approved \? "yes" : "no" %>"/);
  assert.match(bridge,/approved=page\.dataset\.reportApproved==='yes'/);
  assert.doesNotMatch(bridge,/approved=page\.dataset\.clinicalEnabled/);
  assert.match(view,/liveVisit\.visit_id \? "حفظ كمسودة" : "بدء الزيارة وحفظ الشكوى"/);
});
