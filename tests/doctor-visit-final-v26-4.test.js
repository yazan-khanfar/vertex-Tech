'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const fsp=require('node:fs/promises');const path=require('node:path');
const svc=require('../src/doctor-workspace/clinical-service');
const pdf=require('../src/doctor-workspace/report-pdf');
const report=require('../src/doctor-workspace/report-service');
const privateFiles=require('../src/doctor-workspace/visit-files');
const root=path.resolve(__dirname,'..');
const template=()=>fs.readFileSync(path.join(root,'views/doctor/visit.ejs'),'utf8');
const bridge=()=>fs.readFileSync(path.join(root,'public/doctor/assets/visit-bridge.js'),'utf8');
const fakeContext={doc:'4',id:'5',user:'6'};
function fakeDb(action, status='completed'){
 const calls=[];let released=false;
 const query=async(q,args=[])=>{calls.push({sql:q,args});
  if(q.includes('SELECT v."Visit_ID"')&&q.includes('FOR UPDATE OF v'))return {rowCount:1,rows:[{id:'88',approved:null,status:'in_progress',patient_id:'8'}]};
  if(q.includes('"OFFERS"')&&q.includes('"PROVIDES"'))return {rowCount:1,rows:[{price:'150.00'}]};
  if(q.includes('FROM sdc."PROCEDURE"')&&q.includes('FOR UPDATE'))return {rowCount:1,rows:[{stage_id:null,status}]};
  if(q.includes('RETURNING'))return {rowCount:1,rows:[{id:'20'}]};
  return {rowCount:1,rows:[{}]};
 };
 return {pool:{connect:async()=>({query,release(){released=true;}})},calls,get released(){return released;}};
}
test('invoice displays ONLY scoped invoice totals and payments, never creates a bill in doctor workflow',()=>{
 const code=fs.readFileSync(path.join(root,'src/doctor-workspace/clinical-service.js'),'utf8');
 assert.match(code,/i\."Visit_ID"=\$1::bigint AND i\."Clinic_ID"=\$2::bigint AND i\."Patient_ID"=\$3::bigint/);
 assert.match(code,/"INVOICE_INVOICE_ITEMS"/);assert.match(code,/"RECORDS_PAYMENT"/);
 assert.match(template(),/ملخص فاتورة الزيارة \(للعرض فقط\)/);
 assert.doesNotMatch(bridge(),/INSERT INTO.*INVOICE/i);
});
test('procedure status whitelist follows exact PostgreSQL CHECK constraint',()=>{
 assert.deepEqual(['planned','completed','cancelled'].map(s=>svc.procedureStatus(s)),['planned','completed','cancelled']);
 for(const status of ['in_progress','stopped','unpaid','','unknown'])assert.throws(()=>svc.procedureStatus(status));
 const ui=template();assert.match(ui,/name="procedure_status"/);assert.match(bridge(),/procedure_status:section/);
});
test('planned procedure saves as planned; does not auto-complete a treatment stage',async()=>{
 const data=fakeDb();await svc.clinicalAction(data.pool,fakeContext,{action:'procedure',booking_id:'19',service_id:'22',quantity:'1',procedure_status:'planned'});
 const insert=data.calls.find(q=>q.sql.includes('INSERT INTO sdc."PROCEDURE"'));
 assert.ok(insert);assert.equal(insert.args[7],'planned');assert.ok(!data.calls.some(q=>q.sql.includes('UPDATE sdc."TREATMENT_STAGE"')));assert.ok(data.released);
});
test('completed procedure marks linked stage completed, but rejected statuses do not persist',async()=>{
 const data=fakeDb();await svc.clinicalAction(data.pool,fakeContext,{action:'procedure',booking_id:'19',service_id:'22',quantity:'1',procedure_status:'completed',stage_id:'12'});
 assert.ok(data.calls.some(q=>q.sql.includes('UPDATE sdc."TREATMENT_STAGE"')));
 const blocked=fakeDb();await assert.rejects(()=>svc.clinicalAction(blocked.pool,fakeContext,{action:'procedure',booking_id:'19',service_id:'22',quantity:'1',procedure_status:'stopped'}));
 assert.ok(blocked.calls.some(q=>q.sql==='ROLLBACK'));assert.ok(!blocked.calls.some(q=>q.sql.includes('INSERT INTO sdc."PROCEDURE"')));
});
test('changing procedure status requires owning visit and row locking',async()=>{
 const data=fakeDb();await svc.clinicalAction(data.pool,fakeContext,{action:'update_procedure_status',booking_id:'19',procedure_id:'33',procedure_status:'cancelled'});
 assert.ok(data.calls.some(q=>q.sql.includes('"Procedure_ID"=$1::bigint AND "Visit_ID"=$2::bigint FOR UPDATE')));
 assert.ok(data.calls.some(q=>q.sql.includes('UPDATE sdc."PROCEDURE" SET "Procedure_Status"=$1')));
});
test('medical report includes tooth chart, treatment stages and inlined verified images',async()=>{
 const code=fs.readFileSync(path.join(root,'src/doctor-workspace/report-service.js'),'utf8');
 assert.match(code,/"VISIT_ODONTOGRAM"/);assert.match(code,/"TREATMENT_STAGE"/);assert.match(code,/p\."Doctor_ID"=\$1::bigint AND p\."Clinic_ID"=\$2::bigint AND p\."Patient_ID"=\$3::bigint/);
 const html=pdf.content({visit:{id:'8'},diagnoses:[],procedures:[],medications:[],odontogram:[{tooth:11,status:'filled'}],stages:[{plan:'خطة',step:1,description:'حشوة',status:'completed',tooth:11}],images:[{name:'xray.png',src:'data:image/png;base64,YQ=='}]});
 assert.match(html,/السن 11: filled/);assert.match(html,/مرحلة 1: حشوة/);assert.match(html,/data:image\/png;base64,YQ==/);assert.match(html,/xray.png/);
});
test('image embedding uses private file path with magic-check, blocks path traversal',async()=>{
 assert.equal(privateFiles.securePath('../secrets.txt'),null);
 const fileName='c90f0cb1-0080-4a00-9bcd-000000000028.png';
 const loc=privateFiles.securePath(fileName);
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScYvZwAAAABJRU5ErkJggg==','base64');
 try{await fsp.mkdir(path.dirname(loc),{recursive:true});await fsp.writeFile(loc,png,{flag:'wx'});
  const result=await report.selectedImages([{name:'مرفق خاص.png',reference:fileName,mime:'image/png'}]);
  assert.equal(result.length,1);assert.match(result[0].src,/^data:image\/png;base64,/);
  await assert.rejects(()=>report.selectedImages([{name:'danger',reference:'../../etc/passwd',mime:'image/png'}]));
 }finally{await fsp.unlink(loc).catch(()=>{});}
});
test('clinic-managed laboratory and inventory remain out of doctor action scope',()=>{
 assert.match(template(),/إدارة العيادة تتولى الإرسال والاستلام/);
 const source=fs.readFileSync(path.join(root,'src/doctor-workspace/visit-completion-service.js'),'utf8');
 assert.match(source,/'draft'/);assert.doesNotMatch(source,/"STOCK_MOVEMENT"/);
});
test('prescription void uses exact database state and supports prescribed issuance',()=>{
 const service=fs.readFileSync(path.join(root,'src/doctor-workspace/visit-completion-service.js'),'utf8');
 assert.match(service,/"Prescription_Status"='void'/);assert.doesNotMatch(service,/"Prescription_Status"='voided'/);
 assert.match(service,/prescriptionStatus=String\(b\.prescription_status\|\|'draft'\)/);
 assert.match(service,/"Issued_At"/);assert.match(template(),/rx.status==='void'/);
 assert.match(bridge(),/const prescription_status=q\('#sdcPrescriptionLifecycle/);
});
test('procedure stages are limited to booking plan, not merely other patient plans',()=>{
 const service=fs.readFileSync(path.join(root,'src/doctor-workspace/clinical-service.js'),'utf8');
 assert.match(service,/b\."Plan_ID"::text booking_plan/);
 assert.match(service,/AND \(\$5::bigint IS NULL OR s\."Plan_ID"=\$5::bigint\)/);
 assert.match(service,/AND \(\$4::bigint IS NULL OR st\."Plan_ID"=\$4::bigint\)/);
 const report=fs.readFileSync(path.join(root,'src/doctor-workspace/report-service.js'),'utf8');
 assert.match(report,/bk\."Plan_ID"=p\."Plan_ID"/);
});
