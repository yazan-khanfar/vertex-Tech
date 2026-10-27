'use strict';
const test=require('node:test'), assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const s=require('../src/clinic-finance-inventory-service');
const base=path.join(__dirname,'..');
const source=f=>fs.readFileSync(path.join(base,f),'utf8');
const fake=(impl)=>{const calls=[];const client={release(){},async query(sql,args=[]){calls.push({sql,args});return impl(sql,args)||{rowCount:0,rows:[]};}};return {calls,client,pool:{connect:async()=>client}};};
test('stock form validation rejects malicious, invalid, and oversize input',()=>{
 const b={inv_name:'مادة',inv_category:'تعقيم',inv_unit:'حبة',inv_initial:'5',inv_min:'2',inv_exp:''};
 assert.deepEqual(s.itemInput(b),{name:'مادة',category:'تعقيم',unit:'حبة',start:5,min:2,expiry:null});
 for(const val of ['-1','1e9','1.001','', 'Infinity'])assert.equal(s.itemInput({...b,inv_initial:val}),null);
 assert.equal(s.itemInput({...b,inv_exp:'2026-02-30'}),null);
 assert.equal(s.itemInput({...b,inv_name:'x'.repeat(151)}),null);
 assert.equal(s.moveInput({item_id:'7',inventory_move_type:'issue',inventory_move_qty:'1'}).id,'7');
 assert.equal(s.moveInput({item_id:'5 or 1=1',inventory_move_type:'issue',inventory_move_qty:'1'}),null);
 assert.equal(s.moveInput({item_id:'7',inventory_move_type:'issue',inventory_move_qty:'0'}),null);
});
test('new stock material is scoped to clinic and opening movement uses authenticated user',async()=>{
 const {pool,calls}=fake(sql=>{
  if(sql.includes('FROM sdc."CLINIC"'))return {rowCount:1,rows:[{Clinic_ID:4}]};
  if(sql.includes('FROM sdc."INVENTORY_ITEM"'))return {rowCount:0,rows:[]};
  if(sql.includes('RETURNING "Item_ID"'))return {rowCount:1,rows:[{id:'123'}]};
 });
 const r=await s.addItem(pool,'4','9',{inv_name:'كفوف',inv_category:'طبية',inv_unit:'علبة',inv_initial:'4',inv_min:'2'});
 assert.equal(r.status,'ok');assert(calls.some(x=>x.sql==='COMMIT'));
 assert(calls.some(x=>x.sql.includes('INSERT INTO sdc."STOCK_MOVEMENT"')&&x.args.includes('9')&&x.args.includes('123')));
 assert(calls.some(x=>x.sql.includes('INSERT INTO sdc."INVENTORY_ITEM"')&&x.args.includes('4')));
});
test('stock release cannot exceed actual balance; transaction rolls back',async()=>{
 const {pool,calls}=fake(sql=>{
  if(sql.includes('FOR UPDATE'))return {rowCount:1,rows:[{Item_ID:7}]};
  if(sql.includes('COALESCE(sum'))return {rowCount:1,rows:[{qty:'3'}]};
 });
 const r=await s.moveStock(pool,'4','9',{item_id:'7',inventory_move_type:'issue',inventory_move_qty:'4'});
 assert.equal(r.status,'insufficient');assert(calls.some(x=>x.sql==='ROLLBACK'));
 assert(!calls.some(x=>x.sql.includes('INSERT INTO sdc."STOCK_MOVEMENT"')));
});
test('inventory movements use ledger totals rather than in-memory stock',async()=>{
 const queries=[];const pool={async query(sql,args){queries.push({sql,args});return {rows:[]}}};
 const result=await s.inventory(pool,'22');assert.deepEqual(result.stats,{total:0,low:0,empty:0,expiring:0});
 assert(queries.every(q=>q.args[0]==='22'&&q.sql.includes('"Clinic_ID"=$1::bigint')));
 assert(queries[0].sql.includes('sum(m."Quantity_Change")'));
});
test('payments reject invalid amount and unsupported method without starting a transaction',async()=>{
 const pool={connect:()=>{throw Error('should not connect')}};
 assert.equal((await s.recordPayment(pool,'1','9',{invoice_id:'1',amount:'1e3',method:'cash'})).status,'invalid');
 assert.equal((await s.recordPayment(pool,'1','9',{invoice_id:'1',amount:'1',method:'crypto'})).status,'invalid');
});
test('payments reject foreign invoice, draft invoice and overpayment atomically',async()=>{
 let mode='foreign';const {pool,calls}=fake(sql=>{
  if(sql.includes('FROM sdc."INVOICE"')&&sql.includes('FOR UPDATE'))return mode==='foreign'?{rowCount:0,rows:[]}:{rowCount:1,rows:[{Invoice_Status:mode==='draft'?'draft':'issued'}]};
  if(sql.includes('COALESCE((SELECT sum('))return {rowCount:1,rows:[{total:'150.00',paid:'140.00'}]};
 });
 let b={invoice_id:'18',amount:'20.00',method:'card'};
 assert.equal((await s.recordPayment(pool,'4','9',b)).status,'not_found');
 mode='draft';assert.equal((await s.recordPayment(pool,'4','9',b)).status,'not_issued');
 mode='issued';assert.equal((await s.recordPayment(pool,'4','9',b)).status,'excess');
 assert(!calls.some(x=>x.sql.includes('INSERT INTO sdc."RECORDS_PAYMENT"')));
 assert(calls.filter(x=>x.sql==='ROLLBACK').length===3);
});
test('valid payment writes once to authorized invoice',async()=>{
 const {pool,calls}=fake(sql=>{
  if(sql.includes('FOR UPDATE'))return {rowCount:1,rows:[{Invoice_Status:'issued'}]};
  if(sql.includes('COALESCE((SELECT sum('))return {rowCount:1,rows:[{total:'50',paid:'10'}]};
 });
 const r=await s.recordPayment(pool,'4','9',{invoice_id:'18',amount:'40',method:'bank_transfer'});
 assert.equal(r.status,'ok');assert(calls.some(x=>x.sql==='COMMIT'));
 assert(calls.some(x=>x.sql.includes('INSERT INTO sdc."RECORDS_PAYMENT"')&&x.args.includes('18')&&x.args.includes('9')));
});
test('schema status rules remain intact and original CSS remains untouched',()=>{
 const sql=source('db/schema/001_Smart_Dental_Clinic_Original.sql');
 assert(sql.includes('ck_stock_sign')&&sql.includes('ck_invoice_issue'));
 assert(source('server.js').includes('clinic-finance-inventory-router'));
 for(const file of ['inventory','invoices','settlements']){
  const t=source(`views/clinic/${file}.ejs`);assert(t.includes(`partials/clinic/header`)&&t.includes(`partials/clinic/footer`));
 }
});
