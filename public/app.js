(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const store = {
    get(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
    set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} },
  };

  const S = {
    config: { needsPasscode: false, bandName: '' },
    pass: store.get('sp_pass'),
    me: store.get('sp_me'),
    rev: 0, shows: [], availability: {},
    myDates: {}, dirty: false,
    mode: 'mine', month: null, sel: null,
    editing: null, armed: null, online: true,
  };

  /* ---------- dates ---------- */
  const iso = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const todayIso = () => iso(new Date());
  const fmtTime = (t) => { if (!t) return ''; const [h, m] = t.split(':').map(Number); return (h % 12 || 12) + (m ? ':' + pad(m) : '') + (h < 12 ? ' AM' : ' PM'); };
  const fmtLong = (s) => parse(s).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const fmtShort = (s) => parse(s).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  function daysUntil(s) { return Math.round((parse(s) - parse(todayIso())) / 864e5); }

  /* ---------- api ---------- */
  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-passcode': S.pass },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (res.status === 401) { const e = new Error(data.error || 'Wrong passcode.'); e.auth = true; throw e; }
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }

  let toastT;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 3500); }

  /* ---------- people ---------- */
  function members() {
    const names = new Set(Object.keys(S.availability));
    if (S.me) names.add(S.me);
    return [...names].sort((a, b) => a.localeCompare(b));
  }
  function statusOf(name, date) {
    if (name === S.me) return S.myDates[date] || '';
    return (S.availability[name] || {})[date] || '';
  }

  /* ---------- state ---------- */
  function apply(st) {
    if (!st || st.unchanged) return;
    S.rev = st.rev; S.shows = st.shows || []; S.availability = st.availability || {};
    if (st.bandName !== undefined) S.config.bandName = st.bandName;
    if (!S.dirty && !saving) S.myDates = { ...(S.availability[S.me] || {}) };
    render();
  }
  async function refresh() {
    try {
      const st = await api('GET', '/api/state?since=' + S.rev);
      if (!S.online) { S.online = true; renderBanner(); }
      apply(st);
    } catch (e) {
      if (e.auth) return showGate('Your passcode changed. Enter the new one.');
      if (S.online) { S.online = false; renderBanner(); }
    }
  }

  /* ---------- gate ---------- */
  let gateNames = [];
  async function showGate(err) {
    $('#app').hidden = true; $('#gate').hidden = false;
    $('#gateTitle').textContent = S.config.bandName || 'Show Planner';
    $('#passWrap').hidden = !S.config.needsPasscode;
    $('#passInput').value = S.pass;
    $('#nameInput').value = S.me;
    $('#gateErr').textContent = err || '';
    gateNames = [];
    if (!S.config.needsPasscode || S.pass) {
      try { const st = await api('GET', '/api/state'); gateNames = Object.keys(st.availability || {}).sort(); } catch {}
    }
    renderChips();
  }
  function renderChips() {
    const cur = $('#nameInput').value.trim();
    $('#nameChips').innerHTML = gateNames.map((n) => `<button type="button" class="${n === cur ? 'on' : ''}" data-name="${esc(n)}">${esc(n)}</button>`).join('');
  }
  $('#nameChips').addEventListener('click', (e) => { const b = e.target.closest('[data-name]'); if (!b) return; $('#nameInput').value = b.dataset.name; renderChips(); });
  $('#nameInput').addEventListener('input', renderChips);
  $('#passInput').addEventListener('change', async () => {
    S.pass = $('#passInput').value.trim();
    try { const st = await api('GET', '/api/state'); gateNames = Object.keys(st.availability || {}).sort(); $('#gateErr').textContent = ''; renderChips(); } catch {}
  });
  $('#gateForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    S.pass = $('#passInput').value.trim();
    const name = $('#nameInput').value.trim().replace(/\s+/g, ' ').slice(0, 40);
    if (S.config.needsPasscode && !S.pass) return ($('#gateErr').textContent = 'Enter the band passcode.');
    if (!name) return ($('#gateErr').textContent = 'Pick or type your name.');
    try {
      const st = await api('GET', '/api/state');
      S.me = name; store.set('sp_me', name); store.set('sp_pass', S.pass);
      S.dirty = false; S.rev = 0; apply(st);
      enterApp();
    } catch (err) {
      $('#gateErr').textContent = err.auth ? 'That passcode isn’t right.' : 'Can’t reach the server. Try again.';
    }
  });
  $('#switchMe').addEventListener('click', () => { flushSave(); showGate(); });

  let pollT;
  function enterApp() {
    $('#gate').hidden = true; $('#app').hidden = false;
    clearInterval(pollT); pollT = setInterval(refresh, 5000);
    showTab(); render();
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#app').hidden) refresh(); });

  /* ---------- tabs ---------- */
  function showTab() {
    const t = location.hash === '#availability' ? 'availability' : 'shows';
    document.querySelectorAll('.tab').forEach((s) => (s.hidden = s.id !== 'tab-' + t));
    document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + t));
  }
  addEventListener('hashchange', showTab);

  /* ---------- render ---------- */
  function render() {
    if ($('#app').hidden) return;
    const band = S.config.bandName || 'Our Shows';
    $('#bandName').textContent = band;
    document.title = (S.config.bandName ? S.config.bandName + ' · ' : '') + 'Show Planner';
    $('#meName').textContent = S.me;
    renderBanner(); renderShows(); renderCalendar(); renderDetail(); renderBest(); renderMembers();
  }
  function renderBanner() {
    const b = $('#banner');
    b.textContent = S.online ? '' : 'Can’t reach the server right now — changes will show up once it’s back.';
    b.hidden = S.online;
  }

  /* shows */
  function showCard(s, isNext, isPast) {
    const d = parse(s.date);
    const tl = [['Load-in', s.loadIn], ['Soundcheck', s.soundcheck], ['Doors', s.doors]].filter((x) => x[1]);
    const set = s.setStart ? fmtTime(s.setStart) + (s.setEnd ? '–' + fmtTime(s.setEnd) : '') : '';
    const until = daysUntil(s.date);
    const when = until === 0 ? 'Tonight' : until === 1 ? 'Tomorrow' : `In ${until} days`;
    const mapQ = [s.address, s.venue, s.city].filter(Boolean).join(', ');
    const who = isPast ? '' : `<div class="who">${members().map((n) => {
      const st = statusOf(n, s.date);
      return `<span class="p ${st || 'none'}">${esc(n)}${st ? '' : ' ?'}</span>`;
    }).join('')}</div>`;
    const armed = S.armed === s.id;
    return `<article class="show${isNext ? ' next' : ''}">
      <div class="datebox"><div class="dow">${d.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase()}</div><div class="day">${d.getDate()}</div><div class="mon">${d.toLocaleDateString(undefined, { month: 'short' }).toUpperCase()}</div></div>
      <div>
        <div class="show-head">
          <div>
            <h3>${esc(s.venue)}${isNext ? '<span class="badge nextup">' + when + '</span>' : ''}${s.status !== 'confirmed' ? `<span class="badge ${s.status}">${s.status === 'hold' ? 'On hold' : 'Idea'}</span>` : ''}</h3>
            <div class="where">${esc(s.city || '')}${s.city && mapQ ? ' · ' : ''}${mapQ ? `<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQ)}" target="_blank" rel="noopener">Map</a>` : ''}</div>
          </div>
        </div>
        ${tl.length || set ? `<div class="timeline">${tl.map(([k, v]) => `<div class="t"><span>${k}</span><b>${fmtTime(v)}</b></div>`).join('')}${set ? `<div class="t set"><span>Set</span><b>${set}</b></div>` : ''}</div>` : ''}
        ${who}
        ${s.contact || s.pay || s.notes ? `<div class="extra">
          ${s.contact ? `<div><span class="k">Contact:</span> ${esc(s.contact)}</div>` : ''}
          ${s.pay ? `<div><span class="k">Deal:</span> ${esc(s.pay)}</div>` : ''}
          ${s.notes ? `<div class="notes">${esc(s.notes)}</div>` : ''}
        </div>` : ''}
        <div class="show-acts">
          <button class="btn ghost small" type="button" data-edit="${esc(s.id)}">Edit</button>
          <button class="btn ${armed ? 'danger' : 'ghost'} small" type="button" data-del="${esc(s.id)}">${armed ? 'Tap again to delete' : 'Delete'}</button>
        </div>
        ${s.updatedBy ? `<div class="muted small" style="margin-top:8px">Last updated by ${esc(s.updatedBy)}</div>` : ''}
      </div>
    </article>`;
  }
  function renderShows() {
    const today = todayIso();
    const sorted = [...S.shows].sort((a, b) => a.date.localeCompare(b.date) || (a.setStart || '99').localeCompare(b.setStart || '99'));
    const upcoming = sorted.filter((s) => s.date >= today);
    const past = sorted.filter((s) => s.date < today).reverse();
    if (!upcoming.length) {
      $('#showsList').innerHTML = `<div class="empty"><h3>No shows on the books</h3><p class="muted">Add your next gig, or check <a href="#availability">Availability</a> to see which dates the band is free.</p><button class="btn" type="button" data-new="">+ Add show</button></div>`;
    } else {
      let html = '', lastMonth = '';
      upcoming.forEach((s, i) => {
        const m = parse(s.date).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
        if (m !== lastMonth) { html += `<div class="month-label">${esc(m)}</div>`; lastMonth = m; }
        html += showCard(s, i === 0, false);
      });
      $('#showsList').innerHTML = html;
    }
    $('#pastWrap').hidden = !past.length;
    $('#pastCount').textContent = past.length ? `(${past.length})` : '';
    $('#pastList').innerHTML = past.map((s) => showCard(s, false, true)).join('');
  }
  document.addEventListener('click', async (e) => {
    const ed = e.target.closest('[data-edit]');
    if (ed) { const s = S.shows.find((x) => x.id === ed.dataset.edit); if (s) openShow(s); return; }
    const nw = e.target.closest('[data-new]');
    if (nw) { openShow(null, nw.dataset.new); return; }
    const del = e.target.closest('[data-del]');
    if (del) {
      const id = del.dataset.del;
      if (S.armed !== id) { S.armed = id; renderShows(); setTimeout(() => { if (S.armed === id) { S.armed = null; renderShows(); } }, 4000); return; }
      S.armed = null;
      try { apply(await api('DELETE', '/api/shows/' + id)); toast('Show deleted'); } catch (err) { toast(err.message); }
    }
  });

  /* show editor */
  const form = $('#showForm');
  const FIELDS = ['date', 'status', 'venue', 'city', 'address', 'loadIn', 'soundcheck', 'doors', 'setStart', 'setEnd', 'contact', 'pay', 'notes'];
  function openShow(show, date) {
    S.editing = show ? show.id : null;
    $('#showFormTitle').textContent = show ? 'Edit show' : 'Add show';
    FIELDS.forEach((f) => (form[f].value = show ? show[f] || '' : ''));
    if (!show) { form.status.value = 'confirmed'; form.date.value = date || ''; }
    $('#showErr').textContent = '';
    $('#modal').hidden = false;
    setTimeout(() => (show || date ? form.venue : form.date).focus(), 30);
  }
  const closeShow = () => { $('#modal').hidden = true; S.editing = null; };
  $('#addShow').addEventListener('click', () => openShow(null));
  $('#closeModal').addEventListener('click', closeShow);
  $('#cancelShow').addEventListener('click', closeShow);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeShow(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) closeShow(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { by: S.me };
    FIELDS.forEach((f) => (body[f] = form[f].value.trim()));
    if (!body.date) return ($('#showErr').textContent = 'Pick a date.');
    if (!body.venue) return ($('#showErr').textContent = 'Add the venue name.');
    $('#saveShow').disabled = true;
    try {
      apply(S.editing ? await api('PUT', '/api/shows/' + S.editing, body) : await api('POST', '/api/shows', body));
      closeShow(); toast('Show saved');
      if (location.hash === '#availability') location.hash = '#shows';
    } catch (err) { $('#showErr').textContent = err.message; }
    $('#saveShow').disabled = false;
  });

  /* ---------- availability ---------- */
  const CYCLE = { '': 'free', free: 'maybe', maybe: 'busy', busy: '' };
  function showsOn(date) { return S.shows.filter((s) => s.date === date); }

  function renderCalendar() {
    if (!S.month) { const t = new Date(); S.month = new Date(t.getFullYear(), t.getMonth(), 1); }
    document.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === S.mode));
    $('#calHint').textContent = S.mode === 'mine'
      ? 'Tap a date to cycle Free → Maybe → Busy → blank. Saves automatically.'
      : 'Dots show each person. Tap a date to see who’s free and book a show.';
    const y = S.month.getFullYear(), m = S.month.getMonth();
    $('#monthLabel').textContent = S.month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const first = new Date(y, m, 1), startDow = first.getDay();
    const today = todayIso(), ppl = members();
    let html = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div class="dow-h">${d}</div>`).join('');
    const start = new Date(y, m, 1 - startDow);
    for (let i = 0; i < 42; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      if (i >= 35 && d.getMonth() !== m) break;
      const k = iso(d), inMonth = d.getMonth() === m, isPast = k < today;
      const gig = showsOn(k).length ? '<span class="gig" title="Show booked"></span>' : '';
      let cls = 'd', inner = '';
      if (!inMonth) cls += ' out';
      if (isPast) cls += ' past';
      if (k === today) cls += ' today';
      if (S.sel === k) cls += ' sel';
      if (S.mode === 'mine') {
        const st = S.myDates[k]; if (st) cls += ' ' + st;
      } else {
        const sts = ppl.map((n) => statusOf(n, k));
        const free = sts.filter((x) => x === 'free').length;
        if (ppl.length && free === ppl.length) cls += ' all-free';
        inner = `<div class="dots">${sts.map((x) => `<i class="${x}"></i>`).join('')}</div>${free ? `<span class="cnt">${free}/${ppl.length}</span>` : ''}`;
      }
      html += `<button type="button" class="${cls}" data-day="${k}" ${inMonth ? '' : 'tabindex="-1"'}><span class="n">${d.getDate()}</span>${inner}${gig}</button>`;
    }
    $('#cal').innerHTML = html;
  }
  $('#cal').addEventListener('click', (e) => {
    const b = e.target.closest('[data-day]'); if (!b || b.classList.contains('out')) return;
    const k = b.dataset.day;
    if (S.mode === 'mine' && k >= todayIso()) setMine(k, CYCLE[S.myDates[k] || '']);
    S.sel = k; renderCalendar(); renderDetail();
  });
  $('#prevMonth').addEventListener('click', () => { S.month = new Date(S.month.getFullYear(), S.month.getMonth() - 1, 1); renderCalendar(); });
  $('#nextMonth').addEventListener('click', () => { S.month = new Date(S.month.getFullYear(), S.month.getMonth() + 1, 1); renderCalendar(); });
  document.querySelector('.seg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.mode = b.dataset.mode; renderCalendar(); renderDetail(); });

  function setMine(date, status) {
    if (status) S.myDates[date] = status; else delete S.myDates[date];
    queueSave(); renderCalendar(); renderDetail(); renderBest(); renderMembers(); renderShows();
  }

  function renderDetail() {
    const el = $('#dayDetail');
    if (!S.sel) {
      el.innerHTML = `<h3>${S.mode === 'mine' ? 'Your dates' : 'Pick a date'}</h3><p class="muted small" style="margin:0">${S.mode === 'mine' ? 'Tap dates on the calendar to mark when you can play. You’ve marked ' + Object.keys(S.myDates).filter((d) => d >= todayIso()).length + ' upcoming dates.' : 'Tap any date to see who can make it.'}</p>`;
      return;
    }
    const k = S.sel, gigs = showsOn(k), ppl = members(), isPast = k < todayIso();
    const groups = { free: [], maybe: [], busy: [], '': [] };
    ppl.forEach((n) => groups[statusOf(n, k)].push(n));
    const list = (label, arr, cls) => arr.length ? `<div class="muted small" style="margin-top:8px">${label}</div><div class="who" style="margin-top:4px">${arr.map((n) => `<span class="p ${cls}">${esc(n)}</span>`).join('')}</div>` : '';
    const mine = S.myDates[k] || '';
    el.innerHTML = `<h3>${esc(fmtLong(k))}</h3>
      ${gigs.map((g) => `<div style="margin-top:6px"><span class="sw gig"></span> <b>${esc(g.venue)}</b>${g.setStart ? ' · set ' + fmtTime(g.setStart) : ''}</div>`).join('')}
      ${!isPast ? `<div class="muted small" style="margin-top:10px">Your answer</div><div class="status-pick">
        ${['free', 'maybe', 'busy'].map((s) => `<button type="button" class="${s}${mine === s ? ' on' : ''}" data-set="${s}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}
        ${mine ? '<button type="button" data-set="">Clear</button>' : ''}
      </div>` : ''}
      ${list('Free', groups.free, 'free')}${list('Maybe', groups.maybe, 'maybe')}${list('Busy', groups.busy, 'busy')}${list('No answer yet', groups[''], 'none')}
      ${!isPast && !gigs.length ? `<button class="btn small" type="button" data-new="${k}" style="margin-top:14px">+ Book a show on this date</button>` : ''}`;
  }
  $('#dayDetail').addEventListener('click', (e) => { const b = e.target.closest('[data-set]'); if (b && S.sel) setMine(S.sel, b.dataset.set); });

  function renderBest() {
    const ppl = members(); const out = [];
    if (ppl.length) {
      const d = parse(todayIso());
      for (let i = 0; i < 90; i++, d.setDate(d.getDate() + 1)) {
        const k = iso(d); if (showsOn(k).length) continue;
        const sts = ppl.map((n) => statusOf(n, k));
        const free = sts.filter((x) => x === 'free').length, maybe = sts.filter((x) => x === 'maybe').length, busy = sts.filter((x) => x === 'busy').length;
        if (free) out.push({ k, free, maybe, busy });
      }
      out.sort((a, b) => b.free - a.free || a.busy - b.busy || b.maybe - a.maybe || a.k.localeCompare(b.k));
    }
    $('#bestDates').innerHTML = out.length ? '<ul class="best">' + out.slice(0, 8).map((r) => `<li>
      <div><b>${esc(fmtShort(r.k))}</b><span class="pill">${r.free}/${ppl.length} free</span>
        <div class="sub">${[r.maybe ? r.maybe + ' maybe' : '', r.busy ? r.busy + ' busy' : '', ppl.length - r.free - r.maybe - r.busy ? ppl.length - r.free - r.maybe - r.busy + ' no answer' : ''].filter(Boolean).join(' · ') || 'Everyone’s free'}</div></div>
      <button class="btn ghost small" type="button" data-new="${r.k}">Book</button></li>`).join('') + '</ul>'
      : '<p class="muted small" style="margin:0">Once people mark free dates, the best ones show up here.</p>';
  }

  function renderMembers() {
    const ppl = members(), today = todayIso();
    $('#members').innerHTML = `<div class="members">${ppl.map((n) => {
      const dates = n === S.me ? S.myDates : (S.availability[n] || {});
      const c = Object.entries(dates).filter(([d, s]) => d >= today && s === 'free').length;
      const armed = S.armed === 'p:' + n;
      return `<div class="member"><span>${esc(n)}${n === S.me ? ' <span class="muted">(you)</span>' : ''} <span class="muted small">· ${c} free date${c === 1 ? '' : 's'}</span></span>
        ${n !== S.me ? `<button class="x" type="button" data-rm="${esc(n)}">${armed ? 'Confirm remove' : 'Remove'}</button>` : ''}</div>`;
    }).join('')}</div><p class="muted small" style="margin:10px 0 0">Send bandmates the link${S.config.needsPasscode ? ' and passcode' : ''} so they can add their dates.</p>`;
  }
  $('#members').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-rm]'); if (!b) return;
    const n = b.dataset.rm, key = 'p:' + n;
    if (S.armed !== key) { S.armed = key; renderMembers(); setTimeout(() => { if (S.armed === key) { S.armed = null; renderMembers(); } }, 4000); return; }
    S.armed = null;
    try { apply(await api('DELETE', '/api/people/' + encodeURIComponent(n))); toast(n + ' removed'); } catch (err) { toast(err.message); }
  });

  /* saving my availability */
  let saveT = null, saving = false, again = false;
  function queueSave() { S.dirty = true; $('#saveStatus').textContent = 'Saving…'; clearTimeout(saveT); saveT = setTimeout(save, 600); }
  function flushSave() { if (S.dirty) { clearTimeout(saveT); save(); } }
  async function save() {
    if (saving) { again = true; return; }
    saving = true;
    const name = S.me;
    try {
      const st = await api('PUT', '/api/availability', { name, dates: S.myDates });
      saving = false;
      if (again) { again = false; return save(); }
      S.dirty = false; $('#saveStatus').textContent = 'Saved';
      apply(st);
    } catch (err) {
      saving = false;
      $('#saveStatus').textContent = 'Not saved — retrying';
      if (err.auth) return showGate('Your passcode changed. Enter the new one.');
      setTimeout(save, 4000);
    }
  }
  addEventListener('pagehide', flushSave);

  /* ---------- boot ---------- */
  (async function boot() {
    try { S.config = await (await fetch('/api/config')).json(); } catch {}
    if (!S.me) return showGate();
    try { apply(await api('GET', '/api/state')); enterApp(); }
    catch (e) { showGate(e.auth ? '' : 'Can’t reach the server. Try again.'); }
  })();
})();
