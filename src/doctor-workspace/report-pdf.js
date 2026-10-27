'use strict';
// Generate genuine immutable PDFs using locally installed Chromium/Edge.
// Never serve output from /public. This module must fail closed if no renderer exists.
const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');
const crypto=require('node:crypto');const {execFile}=require('node:child_process');
const {promisify}=require('node:util');const run=promisify(execFile);
const root=path.resolve(__dirname,'../../storage/approved-reports');
function encode(v){return String(v??'—').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
const tr=(label,val)=>`<tr><th>${encode(label)}</th><td>${encode(val)}</td></tr>`;
function content(data){const visit=data.visit;
const rows=[tr('العيادة',visit.clinic_name),tr('الطبيب',visit.doctor_name),tr('المريض',visit.patient_name),tr('رقم المريض',visit.patient_id),tr('رقم الزيارة',visit.id),tr('تاريخ الموعد',visit.date),tr('الخدمة',visit.service),tr('الشكوى',visit.complaint),tr('الفحص السريري',visit.examination),tr('نتائج الفحص المختارة',(data.findings||[]).map(x=>x.finding).join('، ')||'لا يوجد'),tr('ملاحظات أسطح الأسنان',(data.surfaces||[]).map(x=>`سن ${x.tooth} (${x.surface}): ${x.note}`).join(' | ')||'لا يوجد'),tr('مخطط الأسنان',(data.odontogram||[]).map(x=>`السن ${x.tooth}: ${x.status}`).join(' | ')||'لا توجد حالات محفوظة'),tr('مراحل خطط العلاج',(data.stages||[]).map(x=>`${x.plan} / مرحلة ${x.step}: ${x.description} (${x.status})${x.tooth?' - سن '+x.tooth:''}`).join(' | ')||'لا توجد مراحل'),tr('ملفات مرفقة ومعتمدة بالإشارة',(data.files||[]).map(x=>x.name).join('، ')||'لا يوجد'),tr('التوصيات',visit.recommendations),tr('اقتراح المتابعة',visit.followup_type?`${visit.followup_type} - ${visit.followup_date||''} - ${visit.followup_notes||''}`:'لا يوجد'),tr('التشخيصات',data.diagnoses.map(x=>`سن ${x.tooth}: ${x.text}`).join(' | ')||'لا يوجد'),tr('الإجراءات المنفذة',data.procedures.map(x=>`${x.service}${x.tooth?' - سن '+x.tooth:''} (${x.quantity} × ${x.price} ₪)`).join(' | ')||'لا يوجد'),tr('الوصفات',data.medications.map(x=>`${x.name}؛ ${x.dosage}؛ ${x.frequency}؛ ${x.duration}؛ ${x.route}`).join(' | ')||'لا يوجد')];
const imageSection=(data.images||[]).length?`<section class="images"><h2>صور الأشعة والمرفقات المختارة</h2>${data.images.map(x=>`<figure><figcaption>${encode(x.name)}</figcaption><img src="${x.src}" alt="مرفق طبي"></figure>`).join('')}</section>`:'';
return `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>تقرير طبي معتمد - ${encode(visit.id)}</title><style>@page{size:A4;margin:18mm}body{font-family:'Arial','Segoe UI',sans-serif;font-size:12pt;color:#202939;direction:rtl}h1{color:#12577c;text-align:center;font-size:22pt}h2{font-size:13pt;margin:0 0 12px;text-align:center;color:#4b5563}.label{border:1px solid #cbd5e1;padding:9px;margin:15px 0;border-radius:5px;background:#f4f7fa}table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{border:1px solid #cbd5e1;padding:8px;vertical-align:top;overflow-wrap:anywhere;text-align:right}th{background:#f2f6f9;width:27%;font-weight:bold}footer{font-size:9pt;margin-top:20px;border-top:1px solid #cbd5e1;padding-top:10px}.sub{color:#586779;font-size:10pt}.images{margin-top:22px}.images figure{break-inside:avoid;page-break-inside:avoid;border:1px solid #ccd5e0;padding:10px}.images img{width:auto;max-width:100%;max-height:200mm;object-fit:contain;display:block;margin:8px auto}figcaption{font-weight:bold;text-align:right}</style><h1>Smart Dental Clinic</h1><h2>التقرير الطبي النهائي للزيارة</h2><div class="label">وثيقة طبية معتمدة من الطبيب المعالج، مبنية على السجلات المحفوظة وقت الاعتماد. لا يجوز تعديلها بعد اعتمادها.</div><table>${rows.join('')}</table>${imageSection}<footer>تاريخ إنشاء الوثيقة (UTC): ${encode(new Date().toISOString())}<div class="sub">تم توليد هذه الوثيقة تلقائيًا في Smart Dental Clinic.</div></footer></html>`;}
function browserCandidates(){const p=process.platform;const candidates=[];
if(process.env.SDC_PDF_BROWSER)candidates.push(process.env.SDC_PDF_BROWSER);
if(p==='win32')candidates.push(
'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
);else candidates.push('/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome','/opt/google/chrome/chrome');
return [...new Set(candidates)];}
async function renderer(){for(const file of browserCandidates()){try{await fs.access(file);return file;}catch{}}const e=new Error('تعذّر العثور على Edge أو Chrome لإنشاء PDF معتمد. حدّد SDC_PDF_BROWSER إلى المسار الكامل للمتصفح.');e.status=503;throw e;}
async function generate(data,visitId){if(!/^\d{1,18}$/.test(String(visitId)))throw Error('Invalid visit ID');const browser=await renderer();const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'sdc-medical-'));
const local=path.join(tmp,'draft.html'),pdf=path.join(tmp,'approved.pdf');try{
 await fs.writeFile(local,content(data),{encoding:'utf8',mode:0o600});
 const url=new URL('file://'+(process.platform==='win32'?'/':'')+local.split(path.sep).join('/')).href;
 try{await run(browser,['--headless','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check','--no-pdf-header-footer','--disable-extensions',`--user-data-dir=${path.join(tmp,'browser-profile')}`,`--print-to-pdf=${pdf}`,url],{timeout:30000,windowsHide:true,maxBuffer:300000});}
 catch(e){const error=new Error('فشل محرك Edge/Chrome في توليد PDF، لذلك لم يُعتمد التقرير. تحقق من إعداد SDC_PDF_BROWSER على الخادم.');error.status=503;error.cause=e;throw error;}
 const buf=await fs.readFile(pdf).catch(()=>{const e=new Error('لم ينشئ المتصفح ملف PDF صالحًا، ولذلك لم يُعتمد التقرير.');e.status=503;throw e;});if(buf.length<700||buf.toString('ascii',0,5)!=='%PDF-')throw Error('PDF verification failed');
 const digest=crypto.createHash('sha256').update(buf).digest('hex');const name=`visit-${visitId}-${digest.slice(0,24)}.pdf`;
 await fs.mkdir(root,{recursive:true,mode:0o700});const location=path.join(root,name);
 // 'wx' prevents replacing any existing approved document.
 try{await fs.writeFile(location,buf,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
 return {reference:name,path:location,hash:digest};
}finally{await fs.rm(tmp,{recursive:true,force:true}).catch(()=>{});}}
async function remove(generated){if(generated?.path)await fs.unlink(generated.path).catch(()=>{});}
async function find(name){if(!/^visit-\d+-[a-f0-9]{24}\.pdf$/.test(String(name||'')))return null;const file=path.join(root,name);const st=await fs.stat(file).catch(()=>null);return st?.isFile()?file:null;}
module.exports={root,content,generate,find,remove,encode};
