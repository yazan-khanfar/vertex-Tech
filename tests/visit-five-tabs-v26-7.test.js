'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const ejs=fs.readFileSync(path.join(root,'views/doctor/visit.ejs'),'utf8');
const js=fs.readFileSync(path.join(root,'public/doctor/assets/visit-bridge.js'),'utf8');
const styles=fs.readFileSync(path.join(root,'public/doctor/assets/styles.css'),'utf8');
const expected={start:['complaint','exam'],diagnosis:['odontogram','diagnosis','attachments'],treatment:['procedure','plan'],orders:['prescription','lab','followup'],finish:['report','doctorInvoiceCard']};
function node(props={}){
 const handlers={};const attrs={};const classes=new Set();
 return {dataset:props.dataset||{},hidden:false,tabIndex:0,attrs,handlers,classList:{add:v=>classes.add(v),contains:v=>classes.has(v)},textContent:'',
  setAttribute:(k,v)=>{attrs[k]=v},removeAttribute:k=>delete attrs[k],addEventListener:(k,fn)=>{handlers[k]=fn},
  scrollIntoView:()=>{},focus:()=>{},querySelectorAll:()=>[],querySelector:()=>null};
}
test('all 12 clinical sections are grouped under five tabs without new visit pages',()=>{
 assert.equal((ejs.match(/class="clinical-card clinical-section mb-4"/g)||[]).length,13);
 assert.equal((ejs.match(/role="tab" id="visit-tab-/g)||[]).length,5);
 for(const [tab,ids] of Object.entries(expected))for(const id of ids){
  const re=new RegExp('id="'+id+'" data-visit-tab="'+tab+'"');assert.match(ejs,re);
 }
 assert.match(ejs,/id="patient-info"/);assert.equal((ejs.match(/src="assets\/visit-bridge.js"/g)||[]).length,1);
 assert.match(ejs,/id="finishVisitModal"/);assert.match(ejs,/id="doctor-visit-clinical-form"/);
});
test('tab-only CSS is scoped and respects hidden states',()=>{
 assert.match(styles,/main\[data-booking-id\]\.visit-tabs-ready \[data-visit-tab\]\[hidden\]/);
 assert.match(styles,/max-width:575\.98px/);
 assert.match(styles,/:focus-visible/);
});
test('real visit JS activates different tabs and keeps state within booking',()=>{
 const cards=Object.entries(expected).flatMap(([tab,ids])=>ids.map(id=>node({dataset:{visitTab:tab,id}})));
 const buttons=Object.keys(expected).map(tab=>node({dataset:{visitTabTarget:tab}}));
 const quick=Object.keys(expected).map(tab=>node({dataset:{visitTabTarget:tab}}));
 const heading=node(),help=node(),actions=node(),save=node(),finish=node(),dirty=node(),workflow=node();
 const nodes={'#visit-tab-help':help,'#visit-tab-heading-text':heading,'[data-visit-actions]':actions,'#saveVisitDraft':save,'#finishVisit':finish,'#visit-unsaved-note':dirty,'#visit-workflow':workflow};
 const list=node(),page=node({dataset:{bookingId:'999',clinicalEnabled:'no'}});
 page.querySelectorAll=s=>s==='.clinical-section[data-visit-tab]'?cards:s==='[role="tab"][data-visit-tab-target]'?buttons:s==='[data-visit-tab-target]'?[...buttons,...quick]:s==='.visit-quick-link[data-visit-tab-target]'?quick:[];
 page.querySelector=s=>s==='#visit-tab-list'?list:nodes[s]||null;
 const map=new Map();const storage={getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v)};
 const doc={readyState:'complete',querySelector:s=>s==='main[data-booking-id]'?page:null,addEventListener(){}};
 vm.runInNewContext(js,{document:doc,window:{addEventListener:()=>{}},location:{hash:''},sessionStorage:storage,confirm:()=>true,HTMLFormElement:function(){}});
 assert.equal(cards.filter(n=>!n.hidden).length,2);
 const diag=buttons[1];diag.handlers.click();
 assert.equal(cards.filter(n=>!n.hidden).length,3);
 assert.equal(heading.textContent,'الأسنان والتشخيص');
 assert.equal(map.get('sdc-visit-tab:999'),'diagnosis');
 assert.equal(save.hidden,true);assert.equal(finish.hidden,true);
 buttons[4].handlers.click();assert.equal(cards.filter(n=>!n.hidden).length,2);
 assert.equal(actions.hidden,false);assert.equal(finish.hidden,false);assert.equal(save.hidden,true);
 buttons[0].handlers.click();assert.equal(save.hidden,false);assert.equal(finish.hidden,true);
});
test('selecting a stage from an active patient plan links an unlinked booking transactionally',async()=>{
 const {clinicalAction}=require('../src/doctor-workspace/clinical-service');
 const queries=[];
 const pool={connect:async()=>({async query(sql,args=[]){queries.push({sql,args});
  if(sql.includes('FROM sdc."VISIT" v JOIN'))return {rowCount:1,rows:[{id:'50',approved:null,status:'in_progress',patient_id:'33',booking_plan:null}]};
  if(sql.includes('FROM sdc."OFFERS"'))return {rowCount:1,rows:[{price:'100'}]};
  if(sql.includes('FROM sdc."TREATMENT_STAGE" s JOIN'))return {rowCount:1,rows:[{tooth:11,plan_id:'45'}]};
  if(sql.includes('UPDATE sdc."BOOKING" SET "Plan_ID"'))return {rowCount:1,rows:[{Booking_ID:'77'}]};
  return {rowCount:1,rows:[]};},release(){}})};
 const result=await clinicalAction(pool,{id:'20',doc:'10',user:'3'},{action:'procedure',booking_id:'77',service_id:'4',stage_id:'66',tooth_number:'11',quantity:'1',procedure_status:'planned'});
 assert.equal(result.bookingId,'77');
 assert(queries.some(q=>q.sql.includes('UPDATE sdc."BOOKING" SET "Plan_ID"')&&q.args[0]==='45'&&q.args[1]==='77'));
 assert(queries.some(q=>q.sql.includes('INSERT INTO sdc."PROCEDURE"')));
 assert.equal(queries.at(-1).sql,'COMMIT');
});
