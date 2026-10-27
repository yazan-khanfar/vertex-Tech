// UI-only form submission. Session token and CSRF are managed by the server.
(() => {
  document.addEventListener('click', event => {
    const button=event.target.closest('[data-logout]');
    if(!button)return;
    const form=document.querySelector('#sdcUnifiedLogoutForm');
    if(!form)return;
    event.preventDefault();event.stopImmediatePropagation();form.requestSubmit();
  },true);
})();
