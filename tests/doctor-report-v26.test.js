'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const pdf=require('../src/doctor-workspace/report-pdf');const svc=require('../src/doctor-workspace/report-service');
const c={id:'20',doc:'10',user:'3'};
function mockTx(fn){const calls=[];const client={query:async(sql,args=[])=>{calls.push({sql,args});return fn(sql,args);},release(){}};return {calls,pool:{async connect(){return client;}}};}
const ok={rowCount:1,rows:[]};
test('PDF content escapes stored medical text instead of interpreting user HTML',()=>{
 const html=pdf.content({visit:{id:'1',clinic_name:'Clinic',doctor_name:'Dr',patient_name:'<img src=x onerror=alert(1)>',patient_id:'2',date:'2026-10-27',service:'Exam',complaint:'<script>bad()</script>',examination:'Normal'},diagnoses:[],procedures:[],medications:[]});
 assert(html.includes('&lt;script&gt;'));assert(!html.includes('<script>'));assert(html.includes('&lt;img'));
});
test('only completed visits scoped by doctor and clinic can be approved',async()=>{
 const f=mockTx(sql=>sql.includes('SELECT v."Visit_ID"')?{rowCount:1,rows:[{id:'8',status:'in_progress',booking_status:'in_progress',approved:null}]}:ok);
 await assert.rejects(()=>svc.approve(f.pool,c,'9'),{status:409});assert.equal(f.calls.at(-1).sql,'ROLLBACK');
 assert(!f.calls.some(x=>x.sql.includes('"Report_Approved_At"=LOCALTIMESTAMP')));
 const scope=f.calls.find(x=>x.sql.includes('SELECT v."Visit_ID"'));
 assert(scope.sql.includes('b."Doctor_ID"=$2::bigint')&&scope.sql.includes('b."Clinic_ID"=$3::bigint'));
});
test('approved report cannot be approved a second time',async()=>{
 const f=mockTx(sql=>sql.includes('SELECT v."Visit_ID"')?{rowCount:1,rows:[{id:'8',status:'completed',booking_status:'completed',approved:'already'}]}:ok);
 await assert.rejects(()=>svc.approve(f.pool,c,'9'),{status:409});
});
test('a real file reference and audit are committed together only after PDF generation',async()=>{
 const original=pdf.generate;const originalRemove=pdf.remove;
 let generated=0;
 pdf.generate=async()=>{generated++;return {reference:'visit-8-0123456789abcdef01234567.pdf',hash:'abc',path:'/tmp/fake_sdc_report.pdf'};};
 pdf.remove=async()=>{throw Error('do not remove on successful commit');};
 try{
 const f=mockTx(sql=>sql.includes('SELECT v."Visit_ID"')?{rowCount:1,rows:[{id:'8',status:'completed',booking_status:'completed',approved:null,complaint:'complaint',examination:'exam'}]}:
 sql.includes('COUNT(*)::int total')?{rowCount:1,rows:[{total:0}]}:
 sql.includes('UPDATE sdc."VISIT" SET "Report_Approved_At"')?{rowCount:1,rows:[{Visit_ID:8}]}:ok);
 const out=await svc.approve(f.pool,c,'9');assert.equal(out.visitId,'8');assert.equal(generated,1);
 assert(f.calls.some(x=>x.sql.includes('"Report_Approved_At"=LOCALTIMESTAMP')&&x.args[0]===out.reference));
 assert(f.calls.some(x=>x.sql.includes('visit.report.approved')));assert.equal(f.calls.at(-1).sql,'COMMIT');
 }finally{pdf.generate=original;pdf.remove=originalRemove;}
});
test('approved PDF file access always checks booking doctor and clinic',async()=>{
 const f={async query(sql,args){assert(sql.includes('b."Doctor_ID"=$2::bigint'));assert(sql.includes('b."Clinic_ID"=$3::bigint'));assert.deepEqual(args,['99','10','20']);return {rows:[],rowCount:0};}};
 assert.equal(await svc.fileForBooking(f,c,'99'),null);
});
