const crypto = require('crypto');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function clean(str, max = 500) {
  return String(str ?? '').trim().slice(0, max);
}

function cleanEmail(str) {
  const email = clean(str, 200).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

// Form fields that may be sent once or many times (checkboxes).
function idList(value) {
  const arr = Array.isArray(value) ? value : value == null ? [] : [value];
  return arr.map((v) => parseInt(v, 10)).filter(Number.isInteger);
}

// Only allow http(s) links so nobody can sneak in javascript: URLs.
function cleanUrl(str) {
  let url = clean(str, 2000);
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Escape text, then turn any http(s) links in it into clickable links.
function linkify(text) {
  const urlRe = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/gi;
  const str = String(text || '');
  let out = '';
  let last = 0;
  for (const m of str.matchAll(urlRe)) {
    out += escapeHtml(str.slice(last, m.index));
    const url = escapeHtml(m[0]);
    out += `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
    last = m.index + m[0].length;
  }
  return out + escapeHtml(str.slice(last));
}

const randomToken = (bytes = 18) => crypto.randomBytes(bytes).toString('base64url');

function render404(res, message = "That doesn't exist, or you don't have access to it.") {
  return res.status(404).render('error', { message });
}
function render403(res, message) {
  return res.status(403).render('error', { message });
}

module.exports = {
  wrap, clean, cleanEmail, idList, cleanUrl, hostOf, escapeHtml, linkify, randomToken, render404, render403,
};
