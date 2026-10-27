'use strict';
// Read-only, server-side audit history. Never accept SQL fragments from request input.
const PAGE_SIZE = 25;
const MAX_CSV_ROWS = 5000;
const TYPES = Object.freeze(['create','edit','delete','suspend','approval','finance','login','domain']);
const CATEGORY_SQL = `CASE
  WHEN a."Action_Type" ~* '(approv|reject|licen[cs]e|review)' THEN 'approval'
  WHEN a."Action_Type" ~* '(login|logon|logout|auth|password|mfa|session|security|reset)' THEN 'login'
  WHEN a."Action_Type" ~* '(invoice|payment|commission|settlement|finance)' THEN 'finance'
  WHEN a."Action_Type" ~* '(suspend|reactivat|disable|enable|block)' THEN 'suspend'
  WHEN a."Action_Type" ~* '(delet|remov)' THEN 'delete'
  WHEN a."Action_Type" ~* '(creat|register|insert|add)' THEN 'create'
  WHEN a."Action_Type" ~* '(updat|edit|chang|modif)' THEN 'edit'
  ELSE 'domain' END`;
const BASE_SQL = `FROM (
   SELECT a."Log_ID", a."Occurred_At", to_char(a."Occurred_At",'YYYY-MM-DD') AS "Occurred_Date",
    to_char(a."Occurred_At",'YYYY-MM-DD HH24:MI') AS "Occurred_Label",a."Action_Type", a."Target_Type",
    a."Target_Reference", a."Description", a."Reason", a."User_ID",
    u."First_Name",u."Last_Name",u."Email",
    ${CATEGORY_SQL} AS category
   FROM sdc."AUDIT_LOG" a LEFT JOIN sdc."USER" u ON u."User_ID"=a."User_ID"
 ) audit`;
function parseFilters(query={}) {
  const q = typeof query.q === 'string' ? query.q.trim().slice(0,100) : '';
  const type = typeof query.type === 'string' && TYPES.includes(query.type) ? query.type : '';
  const date = typeof query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(query.date) &&
    Number.isFinite(Date.parse(query.date)) && new Date(query.date).toISOString().slice(0,10) === query.date ? query.date : '';
  const requested = typeof query.page === 'string' && /^\d{1,5}$/.test(query.page) ? Number(query.page) : 1;
  const page = Math.min(Math.max(requested,1),10000);
  return {q,type,date,page};
}
function whereClause(f) {
 const predicates=[];const values=[];
 if(f.q){values.push('%'+f.q.replace(/[\\%_]/g,'\\$&')+'%');predicates.push(`concat_ws(' ',audit."Action_Type",audit."Target_Type",audit."Target_Reference",audit."Description",audit."Reason",audit."User_ID"::text,audit."First_Name",audit."Last_Name",audit."Email") ILIKE $${values.length} ESCAPE '\\'`);}
 if(f.type){values.push(f.type);predicates.push(`audit.category=$${values.length}`);}
 if(f.date){values.push(f.date);predicates.push(`audit."Occurred_At" >= $${values.length}::date AND audit."Occurred_At" < ($${values.length}::date+INTERVAL '1 day')`);}
 return {sql:predicates.length?' WHERE '+predicates.join(' AND '):'',values};
}
const FIELDS = 'audit."Log_ID",audit."Occurred_At",audit."Occurred_Date",audit."Occurred_Label",audit."Action_Type",audit."Target_Type",audit."Target_Reference",audit."Description",audit."Reason",audit."User_ID",audit."First_Name",audit."Last_Name",audit."Email",audit.category';
async function listAudit(pool, filters) {
 const f=parseFilters(filters),{sql,values}=whereClause(f);
 const countRows=await pool.query(`SELECT count(*)::integer AS count ${BASE_SQL}${sql}`,values);
 const total=Number(countRows.rows[0].count)||0;
 const pages=Math.max(1,Math.ceil(total/PAGE_SIZE));
 const page=Math.min(f.page,pages);
 const records=await pool.query(`SELECT ${FIELDS} ${BASE_SQL}${sql} ORDER BY audit."Occurred_At" DESC,audit."Log_ID" DESC LIMIT $${values.length+1} OFFSET $${values.length+2}`,[...values,PAGE_SIZE,(page-1)*PAGE_SIZE]);
 const summary=await pool.query(`SELECT
    COUNT(*) FILTER (WHERE "Occurred_At" >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Hebron')::date AND "Occurred_At" < (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Hebron')::date + INTERVAL '1 day')::integer AS today,
    COUNT(*) FILTER (WHERE "Action_Type" ~* '(approv|reject|suspend|disabl|delet|password|licen[cs]e)')::integer AS sensitive,
    COUNT(*) FILTER (WHERE "Target_Type" ~* '(Visit|Patient|Medical|Procedure|Prescription|Report)')::integer AS clinical,
    COUNT(*) FILTER (WHERE "Action_Type" ~* '(login|auth|password|mfa|session|security|reset)')::integer AS security
    FROM sdc."AUDIT_LOG"`);
 return {records:records.rows,total,page,pages,stats:summary.rows[0],filters:{...f,page}};
}
async function exportAudit(pool, query) {
 const filters=parseFilters(query),{sql,values}=whereClause(filters);
 const result=await pool.query(`SELECT ${FIELDS} ${BASE_SQL}${sql} ORDER BY audit."Occurred_At" DESC,audit."Log_ID" DESC LIMIT $${values.length+1}`,[...values,MAX_CSV_ROWS+1]);
 if(result.rows.length>MAX_CSV_ROWS) return {tooMany:true};
 const headers=['Log_ID','Occurred_At','Action_Type','Category','Target_Type','Target_Reference','Description','Reason','User_ID','Actor_Name','Actor_Email'];
 const csvCell=(value)=>{
  let s=value==null?'':String(value).replace(/\r\n?/g,'\n');
  // Spreadsheet applications can evaluate cells beginning with formula operators.
  if(/^[\s]*[=+\-@]/.test(s)) s="'"+s;
  return '"'+s.replace(/"/g,'""')+'"';
 };
 const rows=result.rows.map(r=>[
   r.Log_ID, r.Occurred_Label||r.Occurred_At,
   r.Action_Type,r.category,r.Target_Type,r.Target_Reference,r.Description,r.Reason,r.User_ID,
   [r.First_Name,r.Last_Name].filter(Boolean).join(' '),r.Email
 ]);
 return {tooMany:false,csv:'\uFEFF'+[headers.map(csvCell).join(','),...rows.map(x=>x.map(csvCell).join(','))].join('\r\n')+'\r\n'};
}
function auditTypeLabel(type){return ({approval:'اعتماد ومراجعة',login:'أمان',finance:'مالية',suspend:'تعليق أو تفعيل',delete:'حذف',create:'إضافة',edit:'تعديل',domain:'حدث نظام'})[type]||'حدث نظام';}
function auditTypeIcon(type){return ({approval:'bi-patch-check',login:'bi-shield-lock',finance:'bi-receipt',suspend:'bi-pause-circle',delete:'bi-trash',create:'bi-plus-circle',edit:'bi-pencil-square',domain:'bi-clock-history'})[type]||'bi-clock-history';}
module.exports={parseFilters,whereClause,listAudit,exportAudit,auditTypeLabel,auditTypeIcon,PAGE_SIZE,MAX_CSV_ROWS};
