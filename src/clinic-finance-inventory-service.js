'use strict';
// Clinic finance & stock. All authoritative values come from the v20 PostgreSQL schema.
const ID=/^[1-9]\d{0,17}$/;
const MONEY=/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/;
const QUANTITY=/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/;
const num=v=>Number(v||0);
const cents=v=>Math.round(num(v)*100);
const validId=v=>ID.test(String(v||''));
const dateOnly=v=>/^\d{4}-\d\d-\d\d$/.test(v)&&!Number.isNaN(Date.parse(v+'T12:00:00Z'))&&new Date(v+'T12:00:00Z').toISOString().slice(0,10)===v;
const labels={cash:'نقداً',card:'بطاقة',bank_transfer:'تحويل بنكي'};
async function inventory(pool,clinic,page=1){
 const safePage=Number.isSafeInteger(Number(page))&&Number(page)>0&&Number(page)<=10000?Number(page):1;
 const [rows,history,count]=await Promise.all([
  pool.query(`SELECT i."Item_ID"::text id,i."Item_Name" name,i."Category" category,i."Unit" unit,i."Minimum_Quantity" min_qty,to_char(i."Expiry_Date",'YYYY-MM-DD') expiry,
   COALESCE(sum(m."Quantity_Change"),0)::numeric AS qty
   FROM sdc."INVENTORY_ITEM" i LEFT JOIN sdc."STOCK_MOVEMENT" m ON m."Item_ID"=i."Item_ID"
   WHERE i."Clinic_ID"=$1::bigint GROUP BY i."Item_ID" ORDER BY i."Item_Name",i."Item_ID" LIMIT 1000`,[clinic]),
  pool.query(`SELECT m."Movement_ID"::text id,to_char(m."Movement_At",'DD/MM/YYYY HH24:MI') at,m."Movement_Type" type,m."Quantity_Change" change,m."Reason" reason,
   i."Item_Name" name,u."First_Name"||' '||u."Last_Name" actor,
   COALESCE(sum(m."Quantity_Change") OVER(PARTITION BY m."Item_ID" ORDER BY m."Movement_At",m."Movement_ID" ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)::numeric balance_before
   FROM sdc."STOCK_MOVEMENT" m JOIN sdc."INVENTORY_ITEM" i ON i."Item_ID"=m."Item_ID"
   JOIN sdc."USER" u ON u."User_ID"=m."User_ID" WHERE i."Clinic_ID"=$1::bigint
   ORDER BY m."Movement_At" DESC,m."Movement_ID" DESC LIMIT 20 OFFSET $2::integer`,[clinic,(safePage-1)*20]),
  pool.query(`SELECT COUNT(*)::int total FROM sdc."STOCK_MOVEMENT" m JOIN sdc."INVENTORY_ITEM" i ON i."Item_ID"=m."Item_ID" WHERE i."Clinic_ID"=$1::bigint`,[clinic])
 ]);
 const items=rows.rows.map(r=>({...r,qty:num(r.qty),minQty:num(r.min_qty),state:num(r.qty)<=0?'empty':num(r.qty)<=num(r.min_qty)?'low':'available'}));
 const today=new Date().toISOString().slice(0,10);
 return {items,movements:history.rows.map(r=>({...r,change:num(r.change),before:num(r.balance_before)})),
  stats:{total:items.length,low:items.filter(x=>x.state==='low').length,empty:items.filter(x=>x.state==='empty').length,expiring:items.filter(x=>x.expiry&&x.expiry<=new Date(Date.now()+30*86400e3).toISOString().slice(0,10)).length},today,historyTotal:Number(count.rows[0]?.total||0),page:safePage,pages:Math.ceil(Number(count.rows[0]?.total||0)/20)};
}
function itemInput(b){
 const name=String(b.inv_name||'').trim(),category=String(b.inv_category||'').trim(),unit=String(b.inv_unit||'').trim();
 const start=String(b.inv_initial??''),min=String(b.inv_min??''),expiry=String(b.inv_exp||'');
 if(!name||name.length>150||!category||category.length>150||!unit||unit.length>150||!QUANTITY.test(start)||!QUANTITY.test(min)||expiry&&!dateOnly(expiry))return null;
 return {name,category,unit,start:num(start),min:num(min),expiry:expiry||null};
}
async function addItem(pool,clinic,actor,b){
 const v=itemInput(b);if(!v)return {status:'invalid'};
 const client=await pool.connect();try{
  await client.query('BEGIN');await client.query("SELECT set_config('sdc.user_id',$1,true)",[actor]);
  const c=await client.query(`SELECT "Clinic_ID" FROM sdc."CLINIC" WHERE "Clinic_ID"=$1::bigint AND "Approval_Status"='approved' AND "Clinic_Status"='active' FOR UPDATE`,[clinic]);
  if(!c.rowCount){await client.query('ROLLBACK');return {status:'forbidden'};}
  const already=await client.query(`SELECT 1 FROM sdc."INVENTORY_ITEM" WHERE "Clinic_ID"=$1::bigint AND lower("Item_Name")=lower($2::text) AND "Unit"=$3 LIMIT 1`,[clinic,v.name,v.unit]);
  if(already.rowCount){await client.query('ROLLBACK');return {status:'duplicate'};}
  const r=await client.query(`INSERT INTO sdc."INVENTORY_ITEM"("Item_Name","Category","Unit","Minimum_Quantity","Expiry_Date","Clinic_ID")
   VALUES($1,$2,$3,$4::numeric,$5::date,$6::bigint) RETURNING "Item_ID"::text id`,[v.name,v.category,v.unit,v.min,v.expiry,clinic]);
  if(v.start>0)await client.query(`INSERT INTO sdc."STOCK_MOVEMENT"("Movement_Type","Quantity_Change","Movement_At","Reason","Item_ID","User_ID")
   VALUES('opening_balance',$1::numeric,LOCALTIMESTAMP,'الرصيد الافتتاحي',$2::bigint,$3::bigint)`,[v.start,r.rows[0].id,actor]);
  await client.query('COMMIT');return {status:'ok',id:r.rows[0].id};
 }catch(e){try{await client.query('ROLLBACK')}catch{};throw e;}finally{client.release();}
}
function moveInput(b){
 const id=String(b.item_id||''),type=String(b.inventory_move_type||''),value=String(b.inventory_move_qty??''),reason=String(b.inventory_move_reason||'').trim();
 if(!validId(id)||!['issue','in','damaged','adjust'].includes(type)||!QUANTITY.test(value)||reason.length>2000)return null;
 if(type!=='adjust'&&num(value)<=0)return null;
 return {id,type,value:num(value),reason};
}
async function moveStock(pool,clinic,actor,b){
 const v=moveInput(b);if(!v)return {status:'invalid'};
 const client=await pool.connect();try{
  await client.query('BEGIN');await client.query("SELECT set_config('sdc.user_id',$1,true)",[actor]);
  const item=await client.query(`SELECT "Item_ID" FROM sdc."INVENTORY_ITEM" WHERE "Clinic_ID"=$1::bigint AND "Item_ID"=$2::bigint FOR UPDATE`,[clinic,v.id]);
  if(!item.rowCount){await client.query('ROLLBACK');return {status:'not_found'};}
  const sum=await client.query(`SELECT COALESCE(sum("Quantity_Change"),0)::numeric qty FROM sdc."STOCK_MOVEMENT" WHERE "Item_ID"=$1::bigint`,[v.id]);
  const before=num(sum.rows[0].qty);
  const change=v.type==='adjust'?v.value-before:v.type==='in'?v.value:-v.value;
  if(before+change<0){await client.query('ROLLBACK');return {status:'insufficient'};}
  if(!change){await client.query('ROLLBACK');return {status:'unchanged'};}
  const kind=v.type==='in'?'purchase':v.type==='adjust'?'adjustment':'usage';
  await client.query(`INSERT INTO sdc."STOCK_MOVEMENT"("Movement_Type","Quantity_Change","Movement_At","Reason","Item_ID","User_ID")
   VALUES($1,$2::numeric,LOCALTIMESTAMP,$3,$4::bigint,$5::bigint)`,[kind,change,v.reason||(v.type==='damaged'?'مادة تالفة':v.type==='issue'?'صرف للاستخدام':v.type==='in'?'توريد':'جرد'),v.id,actor]);
  await client.query('COMMIT');return {status:'ok'};
 }catch(e){try{await client.query('ROLLBACK')}catch{};throw e;}finally{client.release();}
}
async function invoices(pool,clinic){
 const list=await pool.query(`SELECT i."Invoice_ID"::text id,i."Invoice_Status" status,to_char(i."Issued_At",'DD/MM/YYYY') issued,
  u."First_Name"||' '||u."Last_Name" patient,
  COALESCE(x.total,0)::numeric total,COALESCE(p.paid,0)::numeric paid,
  COALESCE(x.lines,0)::int lines,
  COALESCE((SELECT du."First_Name"||' '||du."Last_Name" FROM sdc."VISIT" v JOIN sdc."BOOKING" b ON b."Booking_ID"=v."Booking_ID" JOIN sdc."DOCTOR" d ON d."Doctor_ID"=b."Doctor_ID" JOIN sdc."USER" du ON du."User_ID"=d."User_ID" WHERE v."Visit_ID"=i."Visit_ID"),'—') doctor,
  COALESCE((SELECT string_agg(DISTINCT s."Service_Name",'، ') FROM sdc."VISIT" v JOIN sdc."BOOKING" b ON b."Booking_ID"=v."Booking_ID" JOIN sdc."SERVICE" s ON s."Service_ID"=b."Service_ID" WHERE v."Visit_ID"=i."Visit_ID"),'خدمات طبية') service
  FROM sdc."INVOICE" i JOIN sdc."PATIENT" pat ON pat."Patient_ID"=i."Patient_ID" JOIN sdc."USER" u ON u."User_ID"=pat."User_ID"
  LEFT JOIN LATERAL(SELECT sum("Quantity"*"Unit_Price"-"Discount_Amount") total,count(*) lines FROM sdc."INVOICE_INVOICE_ITEMS" WHERE "Invoice_ID"=i."Invoice_ID") x ON TRUE
  LEFT JOIN LATERAL(SELECT sum("Amount") paid FROM sdc."RECORDS_PAYMENT" WHERE "Invoice_ID"=i."Invoice_ID") p ON TRUE
  WHERE i."Clinic_ID"=$1::bigint ORDER BY i."Created_At" DESC,i."Invoice_ID" DESC LIMIT 250`,[clinic]);
 const ids=list.rows.map(v=>v.id);
 const [lines,pays]=ids.length?await Promise.all([
  pool.query(`SELECT "Invoice_ID"::text id,"Description" description,"Quantity" qty,"Unit_Price" unit_price,"Discount_Amount" discount FROM sdc."INVOICE_INVOICE_ITEMS" WHERE "Invoice_ID"=ANY($1::bigint[]) ORDER BY "Item_ID"`,[ids]),
  pool.query(`SELECT p."Invoice_ID"::text id,to_char(p."Paid_At",'DD/MM/YYYY HH24:MI') at,p."Amount" amount,p."Payment_Method" method,p."Reference_Number" ref,u."First_Name"||' '||u."Last_Name" actor FROM sdc."RECORDS_PAYMENT" p JOIN sdc."USER" u ON u."User_ID"=p."User_ID" WHERE p."Invoice_ID"=ANY($1::bigint[]) ORDER BY p."Paid_At" DESC`,[ids])
 ]):[{rows:[]},{rows:[]}];
 const items=list.rows.map(r=>({...r,total:num(r.total),paid:num(r.paid),remaining:Math.max(0,(cents(r.total)-cents(r.paid))/100),financialState:r.status==='void'?'void':r.status==='draft'?'draft':cents(r.total)<=cents(r.paid)?'paid':cents(r.paid)>0?'partial':'unpaid',lines:lines.rows.filter(l=>l.id===r.id),payments:pays.rows.filter(p=>p.id===r.id)}));
 return {items,stats:{count:items.length,paid:items.reduce((a,b)=>a+b.paid,0),partial:items.filter(i=>i.financialState==='partial').reduce((a,b)=>a+b.remaining,0),unpaid:items.filter(i=>i.financialState==='unpaid').length}};
}
async function recordPayment(pool,clinic,actor,b){
 const id=String(b.invoice_id||''),amount=String(b.amount||''),method=String(b.method||'');
 if(!validId(id)||!MONEY.test(amount)||cents(amount)<=0||!['cash','card','bank_transfer'].includes(method))return {status:'invalid'};
 const client=await pool.connect();try{
  await client.query('BEGIN');await client.query("SELECT set_config('sdc.user_id',$1,true)",[actor]);
  const bill=await client.query(`SELECT "Invoice_ID","Invoice_Status","Issued_At" FROM sdc."INVOICE" WHERE "Invoice_ID"=$1::bigint AND "Clinic_ID"=$2::bigint FOR UPDATE`,[id,clinic]);
  if(!bill.rowCount){await client.query('ROLLBACK');return {status:'not_found'};}
  if(bill.rows[0].Invoice_Status!=='issued'){await client.query('ROLLBACK');return {status:'not_issued'};}
  const balance=await client.query(`SELECT COALESCE((SELECT sum("Quantity"*"Unit_Price"-"Discount_Amount") FROM sdc."INVOICE_INVOICE_ITEMS" WHERE "Invoice_ID"=$1::bigint),0)::numeric total,
   COALESCE((SELECT sum("Amount") FROM sdc."RECORDS_PAYMENT" WHERE "Invoice_ID"=$1::bigint),0)::numeric paid`,[id]);
  if(cents(amount)>cents(balance.rows[0].total)-cents(balance.rows[0].paid)){await client.query('ROLLBACK');return {status:'excess'};}
  await client.query(`INSERT INTO sdc."RECORDS_PAYMENT"("Amount","Payment_Method","Paid_At","Invoice_ID","User_ID")
  VALUES($1::numeric,$2,LOCALTIMESTAMP,$3::bigint,$4::bigint)`,[amount,method,id,actor]);
  await client.query('COMMIT');return {status:'ok'};
 }catch(e){try{await client.query('ROLLBACK')}catch{};throw e;}finally{client.release();}
}
async function settlements(pool,clinic){
 const r=await pool.query(`SELECT s."Settlement_ID"::text id,to_char(s."Period_Start",'DD/MM/YYYY') start,to_char(s."Period_End",'DD/MM/YYYY') finish,
  COALESCE(b.base,0)::numeric base,COALESCE(b.due,0)::numeric due,COALESCE(p.paid,0)::numeric paid
  FROM sdc."SETTLEMENT" s
  LEFT JOIN LATERAL(SELECT sum("Service_Price_Snapshot") base,sum("Service_Price_Snapshot"*"Commission_Rate_Snapshot"/100) due FROM sdc."BOOKING" WHERE "Settlement_ID"=s."Settlement_ID" AND "Booking_Status"='completed') b ON TRUE
  LEFT JOIN LATERAL(SELECT sum("Amount") paid FROM sdc."RECORDS_SETTLEMENT_PAYMENT" WHERE "Settlement_ID"=s."Settlement_ID") p ON TRUE
  WHERE s."Clinic_ID"=$1::bigint ORDER BY s."Period_End" DESC,s."Settlement_ID" DESC LIMIT 100`,[clinic]);
 const ids=r.rows.map(x=>x.id); const bookings=ids.length?await pool.query(`SELECT b."Settlement_ID"::text id,b."Booking_ID"::text booking_id,b."Service_Price_Snapshot" price,b."Commission_Rate_Snapshot" rate,to_char(b."Appointment_Date",'DD/MM/YYYY') date,u."First_Name"||' '||u."Last_Name" patient
  FROM sdc."BOOKING" b JOIN sdc."PATIENT" p ON p."Patient_ID"=b."Patient_ID" JOIN sdc."USER" u ON u."User_ID"=p."User_ID" WHERE b."Clinic_ID"=$1::bigint AND b."Settlement_ID"=ANY($2::bigint[]) ORDER BY b."Appointment_Date" DESC`,[clinic,ids]):{rows:[]};
 const payments=ids.length?await pool.query(`SELECT p."Settlement_ID"::text id,to_char(p."Paid_At",'DD/MM/YYYY') at,p."Amount" amount,p."Payment_Method" method,p."Reference_Number" ref,u."First_Name"||' '||u."Last_Name" actor
  FROM sdc."RECORDS_SETTLEMENT_PAYMENT" p JOIN sdc."USER" u ON u."User_ID"=p."User_ID" WHERE p."Settlement_ID"=ANY($1::bigint[]) ORDER BY p."Paid_At" DESC`,[ids]):{rows:[]};
 return r.rows.map(v=>({...v,base:num(v.base),due:num(v.due),paid:num(v.paid),remaining:Math.max(0,(cents(v.due)-cents(v.paid))/100),bookings:bookings.rows.filter(b=>b.id===v.id),payments:payments.rows.filter(p=>p.id===v.id)}));
}
module.exports={inventory,addItem,moveStock,itemInput,moveInput,invoices,recordPayment,settlements,validId,cents,labels};
