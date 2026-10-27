'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const audit=require('../src/admin-review/audit-service');
const sample={Log_ID:'2',Occurred_Label:'2026-10-25 17:53',Action_Type:'doctor.license.approved',category:'approval',Target_Type:'Doctor',Target_Reference:'1',Description:'اعتماد رقم الترخيص الطبي',Reason:'المستندات مكتملة',User_ID:'4',First_Name:'admin',Last_Name:'user',Email:'admin@example.test'};
function fakePool(count=1, rows=[sample]){
 const calls=[];return {calls,async query(sql,values){calls.push({sql,values});
  if(sql.includes('count(*)::integer AS count'))return{rows:[{count}]};
  if(sql.includes('COUNT(*) FILTER'))return{rows:[{today:1,sensitive:1,clinical:0,security:0}]};
  return {rows};
 }};
}
test('safe filter parser accepts known categories, valid calendar date, bounded search',()=>{
 assert.deepEqual(audit.parseFilters({q:'  ابحث  ',type:'approval',date:'2026-10-25',page:'2'}),{q:'ابحث',type:'approval',date:'2026-10-25',page:2});
 const bad=audit.parseFilters({q:'x'.repeat(150),type:'<script>',date:'2026-02-30',page:'-2'});
 assert.equal(bad.q.length,100);assert.equal(bad.type,'');assert.equal(bad.date,'');assert.equal(bad.page,1);
});
test('audit reads all rows, count and stat queries with real schema',async()=>{
 const pool=fakePool();const result=await audit.listAudit(pool,{});
 assert.equal(result.records[0].Log_ID,'2');assert.equal(result.total,1);
 assert(pool.calls.some(c=>c.sql.includes('LEFT JOIN sdc."USER"')));
 assert(pool.calls.some(c=>c.sql.includes('FROM sdc."AUDIT_LOG"')));
 assert(pool.calls.some(c=>c.sql.includes('LIMIT $1 OFFSET $2')));
 assert.equal(pool.calls.length,3);
});
test('audit queries bind user input and restrict pages to 25',async()=>{
 const pool=fakePool(300,[]);const malicious="%_\\' OR TRUE --";
 await audit.listAudit(pool,{q:malicious,type:'approval',date:'2026-10-25',page:'3'});
 const rows=pool.calls[1];
 assert(!rows.sql.includes(malicious));
 assert.equal(rows.values[rows.values.length-2],25);
 assert.equal(rows.values[rows.values.length-1],50);
 assert.equal(rows.values[1],'approval');
 assert(rows.values[0].includes('\\%'));assert(rows.values[0].includes('\\_'));
});
test('CSV export is escaped for spreadsheet safety, uses same bound filters, and is limited',async()=>{
 const pool=fakePool(1,[{...sample,Reason:'=HYPERLINK("evil","click")\n"quoted"'}]);
 const result=await audit.exportAudit(pool,{type:'approval'});
 assert.equal(result.tooMany,false);assert(result.csv.startsWith('\uFEFF'));
 assert(result.csv.includes("'=HYPERLINK"));
 assert(result.csv.includes('""evil""'));
 assert.equal(pool.calls[0].values[0],'approval');
 assert.equal(pool.calls[0].values[1],audit.MAX_CSV_ROWS+1);
 const over=await audit.exportAudit(fakePool(5001,Array(5001).fill(sample)),{});
 assert.deepEqual(over,{tooMany:true});
});
test('audit page has genuine EJS rendering and no old fake clinic row',()=>{
 const root=path.resolve(__dirname,'..');
 const html=fs.readFileSync(path.join(root,'views/admin/system-log.ejs'),'utf8');
 const router=fs.readFileSync(path.join(root,'src/admin-review/router.js'),'utf8');
 assert(html.includes('for(const item of records)'));
 assert(html.includes('auditTypeLabel(item.category)'));
 assert(!html.includes('عيادة الابتسامة الحديثة'));
 assert(!html.includes('data-ui-pending'));
 assert(router.indexOf("router.use(requireAdmin)")<router.indexOf("router.get('/system-log'"));
 assert(router.includes("router.get('/system-log/export'"));
});
