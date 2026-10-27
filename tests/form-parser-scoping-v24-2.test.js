'use strict';
// Regression: one role's body-parser MUST NOT reject unrelated forms due to its low parameterLimit.
// Uses a lightweight Express routing mock because npm dependencies/PostgreSQL are not available in this environment.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root=path.join(__dirname,'..');
const specs = [
 ['notifications','../src/clinic-notifications-router'],
 ['appointments','../src/appointments/router','clinic'],
 ['operations','../src/daily-operations/router','clinic'],
 ['settings','../src/clinic-settings-router'],
 ['patients','../src/clinic-patients/router'],
 ['staff','../src/clinic-staff/router'],
 ['inventory','../src/clinic-finance-inventory-router'],
 ['remaining','../src/clinic-remaining-router']
];
const instanceRouters=[];
function router(){
 const r={uses:[],posts:[],gets:[],
  use(...a){this.uses.push(a);return this;},
  post(...a){this.posts.push(a);return this;},
  get(...a){this.gets.push(a);return this;}};
 instanceRouters.push(r);return r;
}
function express(){return {};}
express.Router=router;
express.urlencoded=(opts)=>Object.assign(function parsedUrlencoded(_req,_res,next){next();},{isFormParser:true,opts});
function multer(){return {single(){return (_req,_res,next)=>next();}};}
multer.memoryStorage=()=>({});
const original=Module._load;
let modules;
try {
 Module._load=function(request,...args){
  if(request==='express')return express;
  if(request==='multer')return multer;
  if(request==='pg')return {Pool:class {}};
  return original.call(this,request,...args);
 };
 modules=Object.fromEntries(specs.map(([name,module,id])=>{
  const exp=require(module);
  return [name, id ? exp[id+'Router'] : exp];
 }));
}finally{Module._load=original;}
function isMatch(pattern, requestPath){
 if(Array.isArray(pattern))return pattern.some(p=>isMatch(p,requestPath));
 if(typeof pattern !=='string')return false;
 const parts=pattern.split('/').filter(Boolean),requested=requestPath.split('/').filter(Boolean);
 if(parts.length>requested.length)return false;
 return parts.every((part,i)=>part.startsWith(':') ? !!requested[i] : part===requested[i]);
}
function interceptors(url){
 return specs.flatMap(([name])=>modules[name].uses.filter(call=>{
  const [pathOrMiddleware, maybeMiddleware]=call;
  return (maybeMiddleware?.isFormParser||pathOrMiddleware?.isFormParser)&&isMatch(maybeMiddleware?pathOrMiddleware:null,url);
 }).map(call=>({name,limit:(call[1]||call[0]).opts.parameterLimit})));
}
const scenarios=[
 ['Job publication','/jobs/save',12,'remaining'],
 ['Job archive','/jobs/91/archive',2,'remaining'],
 ['Clinic hours / profile','/profile',10,'settings'],
 ['Clinic notifications','/notifications/read-all',1,'notifications'],
 ['Single notification','/notifications/74/read',1,'notifications'],
 ['Inventory','/inventory/add',6,'inventory'],
 ['Patient creation','/patients',10,'patients'],
 ['Staff permissions','/staff',15,'staff'],
 ['Daily operations','/operations/action',3,'operations'],
 ['Appointment','/new-appointment',11,'appointments'],
 ['Lab case creation','/lab-details/2/create',7,'remaining'],
 ['Applicant review','/application-details/6',4,'remaining'],
];
test('each clinic POST is parsed exclusively by its owning router with sufficient parameterLimit',()=>{
 for (const [name,url,fieldCount,owner] of scenarios){
  const parsers=interceptors(url);
  assert.deepEqual(parsers.map(p=>p.name),[owner],`${name} ${url}: unexpected parser(s) ${JSON.stringify(parsers)}`);
  assert(parsers[0].limit >= fieldCount,`${name} ${url}: parser limit too low`);
 }
});
test('5-field notification limit does not intercept job, service, or inventory forms',()=>{
 for(const url of ['/jobs/save','/services','/inventory/add','/operations/action']){
  assert(!interceptors(url).some(p=>p.name==='notifications'),url);
 }
});
test('unrelated or unknown clinic paths are not pre-parsed',()=>{
 for(const url of ['/unhandled-endpoint','/reports','/document/9','/logo']){
  assert.deepEqual(interceptors(url),[],url);
 }
});
test('body limits and protections remain; oversized forms return 413 rather than a misleading render error',()=>{
 const errorHandler=fs.readFileSync(path.join(root,'server.js'),'utf8');
 assert(errorHandler.includes("err.type === 'parameters.too.many'"));
 assert(errorHandler.includes('res.status(413)'));
 for(const spec of specs){
  const r=modules[spec[0]];
  assert(r.posts.length>0,`${spec[0]}: missing POST handlers`);
  assert(r.uses.every(use => !(use.length===1 && use[0]?.isFormParser)),`${spec[0]}: globally mounted body parser`);
 }
});
