'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeGender, genderLabel } = require('../src/patients/gender');
const { parsePatientForm } = require('../src/registration/validate');
const { parsePatient } = require('../src/clinic-patients/service');
const validRegistration={ first_name:'سارة',last_name:'خالد',email:'sara@example.com',phone:'0599123456',date_of_birth:'2001-04-03',gender:'ذكر',password:'Secure1234',confirm_password:'Secure1234',accept_policies:'on' };
const clinicInput={clinic_patient_first_name:'سارة',clinic_patient_last_name:'أحمد',clinic_patient_birthdate:'2001-04-03',clinic_patient_gender:'ذكر',clinic_patient_phone:'0599123456'};

test('Arabic and English gender values are recognized and label correctly',()=>{
 for(const raw of ['ذكر','male',' MALE ']){assert.equal(normalizeGender(raw),'male');assert.equal(genderLabel(raw),'ذكر');}
 for(const raw of ['أنثى','انثى','female',' FEMALE ']){assert.equal(normalizeGender(raw),'female');assert.equal(genderLabel(raw),'أنثى');}
 for(const raw of ['',undefined,'unknown','other']){assert.equal(normalizeGender(raw),null);assert.equal(genderLabel(raw),'غير محدد');}
});
test('patient registration accepts legacy Arabic but writes canonical values',()=>{
 assert.equal(parsePatientForm(validRegistration).data.gender,'male');
 assert.equal(parsePatientForm({...validRegistration,gender:'male'}).data.gender,'male');
 assert.equal(parsePatientForm({...validRegistration,gender:'أنثى'}).data.gender,'female');
 assert.equal(parsePatientForm({...validRegistration,gender:'invalid'}).error,'يرجى اختيار الجنس.');
});
test('clinic patient creation also stores canonical gender',()=>{
 assert.equal(parsePatient(clinicInput).gender,'male');
 assert.equal(parsePatient({...clinicInput,clinic_patient_gender:'أنثى'}).gender,'female');
 assert.equal(parsePatient({...clinicInput,clinic_patient_gender:'unknown'}),null);
});
test('patient detail uses explicit gender label instead of male/else female assumption',()=>{
 const detail=fs.readFileSync(path.join(__dirname,'../views/clinic/patient-details.ejs'),'utf8');
 const service=fs.readFileSync(path.join(__dirname,'../src/clinic-patients/service.js'),'utf8');
 const form=fs.readFileSync(path.join(__dirname,'../views/auth/register/patient.ejs'),'utf8');
 assert(detail.includes("patient.genderLabel || 'غير محدد'"));
 assert(!detail.includes("patient.gender==='male'?'ذكر':'أنثى'"));
 assert(service.includes('genderLabel:genderLabel(r.rows[0].gender)'));
 assert(form.includes('value="male"')&&form.includes('value="female"'));
});

test('clinic patient detail labels an existing Arabic male record correctly without database migration', async()=>{
  const service=require('../src/clinic-patients/service');
  const pool={query:async(sql)=>{
    if(sql.includes('FROM sdc."REGISTERED_AT" a JOIN sdc."PATIENT" p')){
      return {rowCount:1,rows:[{id:'1',gender:'ذكر',dob:'2004-03-20',name:'مريض تجريبي',phone:'0599999999'}]};
    }
    return {rowCount:0,rows:[]};
  }};
  const p=await service.detail(pool,'3','1');
  assert.equal(p.gender,'ذكر');
  assert.equal(p.genderLabel,'ذكر');
  assert.equal(p.bill.total,0);
  assert.equal(p.bill.remaining,0);
});
