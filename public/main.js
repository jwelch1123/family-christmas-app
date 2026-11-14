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

// Invite page: switch between "I'm new" and "I have an account".
document.querySelectorAll('.tabs .tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tabs .tab').forEach((t) => t.classList.toggle('on', t === tab));
    document.querySelectorAll('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== tab.dataset.tab));
  });
});

// Share buttons: use the phone's share sheet, or copy the link.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-share]');
  if (!btn) return;
  const url = btn.dataset.share;
  if (navigator.share) {
    try { await navigator.share({ title: btn.dataset.shareTitle, url }); } catch {}
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    const label = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => (btn.textContent = label), 1500);
  } catch {
    btn.closest('section')?.querySelector('.invite-url')?.select();
  }
});

// Open the group we were sent back to.
if (location.hash.startsWith('#group-')) {
  const g = document.querySelector(location.hash);
  if (g && g.tagName === 'DETAILS') g.open = true;
}
