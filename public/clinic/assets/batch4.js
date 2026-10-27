/* v24: DOM interactions only; real records/ids come exclusively from EJS. */
(()=>{'use strict';
 const run=()=>{
  const q=(s,p=document)=>p.querySelector(s),qa=(s,p=document)=>[...p.querySelectorAll(s)];
  const search=(input,selector)=>q(input)?.addEventListener('input',e=>{const v=e.target.value.trim().toLocaleLowerCase();qa(selector).forEach(n=>n.hidden=!n.textContent.toLocaleLowerCase().includes(v));});
  search('#labSearch','.lab-card-item');
  search('#labCaseSearch','[data-lab-case]');
  search('#jobSearch','.job-item');
  search('#applicantSearch','.applicant-row');
  function filterLabs(st){let visible=0;qa('[data-lab-card]').forEach(n=>{const show=st==='all'||n.dataset.status===st;n.hidden=!show;if(show)visible++;});const e=q('#labsEmpty');if(e)e.classList.toggle('d-none',visible>0);qa('[data-lab-filter]').forEach(b=>{b.classList.toggle('btn-primary',b.dataset.labFilter===st);b.classList.toggle('btn-light',b.dataset.labFilter!==st);});}
  if(q('#labsGrid')){filterLabs('active');qa('[data-lab-filter]').forEach(b=>b.addEventListener('click',()=>filterLabs(b.dataset.labFilter)));}
  const f=q('#backend-form-2'),jobModal=q('#jobModal');
  function resetJob(){if(!jobModal||!f)return;qa('[form="backend-form-2"]',jobModal).forEach(n=>{if(n.matches('input,textarea'))n.value='';if(n.matches('select'))n.selectedIndex=0;});f.elements.job_id.value='';q('#clinicJobModalTitle').textContent='إضافة وظيفة';}
  q('[data-job-new]')?.addEventListener('click',resetJob);
  qa('[data-job-edit]').forEach(b=>b.addEventListener('click',()=>{
   const n=b.closest('.job-item');if(!n||!f)return;resetJob();f.elements.job_id.value=n.dataset.jobCode;
   const values={clinicJobTitle:n.dataset.jobTitle,clinicJobSpecialty:n.dataset.jobSpecialty,clinicJobType:n.dataset.jobType,clinicJobExperience:n.dataset.jobExperience,clinicJobDeadline:n.dataset.jobDeadline,clinicJobHours:n.dataset.jobHours,clinicJobSalary:n.dataset.jobSalary};
   for(const [id,v] of Object.entries(values)){const c=q('#'+id);if(c)c.value=v||'';}
   const records=q('[data-job-html-record]',n),copy=(id,selector)=>{const element=q(id);if(element)element.value=q(selector,records)?.textContent.trim()||'';};
   copy('#clinicJobDescription','[data-job-description]');copy('#clinicJobResponsibilities','[data-job-responsibilities]');copy('#clinicJobRequirements','[data-job-requirements]');q('#clinicJobModalTitle').textContent='تعديل وظيفة';
  }));
  qa('[data-job-archive]').forEach(b=>b.addEventListener('click',()=>{const f=q('#archiveJobForm');if(f)f.action='/clinic/jobs/'+encodeURIComponent(b.dataset.jobArchive)+'/archive';}));
  const filterJobs=()=>{const v=q('#jobStatus')?.value||'all';qa('.job-item').forEach(n=>n.hidden=v!=='all'&&n.dataset.status!==v);};
  q('#jobStatus')?.addEventListener('change',filterJobs);
  const filterCases=()=>{const st=q('#labCaseStatus')?.value||'all',doc=q('#labCaseDoctor')?.value||'all';qa('[data-lab-case]').forEach(n=>n.hidden=(st!=='all'&&n.dataset.status!==st)||(doc!=='all'&&n.dataset.doctor!==doc));};
  q('#labCaseStatus')?.addEventListener('change',filterCases);q('#labCaseDoctor')?.addEventListener('change',filterCases);
  qa('[data-lab-transfer]').forEach(b=>b.addEventListener('click',()=>{const f=q('#backend-form-2');if(f)f.action=f.action.replace(/\/case\/\d+(?:\?.*)?$/,'/case/'+encodeURIComponent(b.dataset.labTransfer));q('#transferLabCaseLabel').textContent='نقل الحالة LC-'+b.dataset.labTransfer+' إلى مختبر نشط';}));
  q('#applicantStatusFilter')?.addEventListener('change',e=>{const s=e.target.value;qa('.applicant-row').forEach(n=>n.hidden=s!=='all'&&n.dataset.status!== (s==='review'?'pending':s));});
  const reportPeriod=q('#clinicReportPeriod'),dates=q('#clinicCustomReportDates');const showDates=()=>dates?.classList.toggle('d-none',reportPeriod?.value!=='custom');reportPeriod?.addEventListener('change',()=>{showDates();if(reportPeriod.value!=='custom'){q('#backend-form-1')?.requestSubmit();}});showDates();
  q('#applyClinicCustomReport')?.addEventListener('click',()=>q('#backend-form-1')?.requestSubmit());
 };
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',run);else run();
})();
