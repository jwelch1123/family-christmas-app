// Confirm before destructive actions.
document.addEventListener('submit', (e) => {
  const msg = e.target.dataset.confirm;
  if (msg && !confirm(msg)) e.preventDefault();
});

// Login: reveal the right fields once a name is picked.
const loginForm = document.getElementById('login-form');
if (loginForm) {
  const fields = loginForm.querySelector('.login-fields');
  const update = () => {
    const picked = loginForm.querySelector('input[name=user_id]:checked');
    if (!picked) return;
    fields.hidden = false;
    const first = picked.dataset.hasPin !== 'true';
    loginForm.querySelectorAll('.first-time').forEach((el) => (el.hidden = !first));
    loginForm.querySelector('[name=family_code]').required = first;
    loginForm.querySelector('[name=pin_confirm]').required = first;
    loginForm.querySelector('[name=pin]').autocomplete = first ? 'new-password' : 'current-password';
  };
  loginForm.addEventListener('change', (e) => {
    update();
    if (e.target.name === 'user_id') loginForm.querySelector(
      picked().dataset.hasPin === 'true' ? '[name=pin]' : '[name=family_code]'
    ).focus();
  });
  const picked = () => loginForm.querySelector('input[name=user_id]:checked');
  update();
}

// Keep the page from jumping to the top after a form post: highlight the item we came back to.
if (location.hash) {
  const el = document.querySelector(location.hash);
  if (el) {
    el.classList.add('flash-target');
    setTimeout(() => el.classList.remove('flash-target'), 1600);
  }
}

// Show/hide owner edit panels.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-toggle]');
  if (!btn) return;
  const panel = document.getElementById(btn.dataset.toggle);
  panel.hidden = !panel.hidden;
  btn.setAttribute('aria-expanded', String(!panel.hidden));
  if (!panel.hidden) panel.querySelector('input')?.focus();
});

// New list form: switch suggestions with the list type, and tap a chip to use it as the name.
const newList = document.getElementById('new-list');
if (newList) {
  const title = newList.querySelector('[name=title]');
  const placeholders = { gifts: 'e.g. Books, Big-ticket, Stocking stuffers', interests: "e.g. I'm interested in…" };
  newList.addEventListener('change', (e) => {
    if (e.target.name !== 'kind') return;
    newList.querySelectorAll('.suggestions').forEach((el) => (el.hidden = el.dataset.for !== e.target.value));
    title.placeholder = placeholders[e.target.value];
  });
  newList.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) title.value = chip.dataset.title;
  });
}
