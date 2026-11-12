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
    itinId: null, schedDraft: [],
  };

  /* ---------- dates & times ---------- */
  const iso = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const todayIso = () => iso(new Date());
  const fmtTime = (t) => { if (!t) return ''; const [h, m] = t.split(':').map(Number); return (h % 12 || 12) + (m ? ':' + pad(m) : '') + (h < 12 ? ' AM' : ' PM'); };
  const fmtTimeShort = (t) => { const [h, m] = t.split(':').map(Number); return (h % 12 || 12) + (m ? ':' + pad(m) : '') + (h < 12 ? 'a' : 'p'); };
  const fmtLong = (s) => parse(s).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const fmtShort = (s) => parse(s).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const daysUntil = (s) => Math.round((parse(s) - parse(todayIso())) / 864e5);
  const whenLabel = (s) => { const n = daysUntil(s); return n === 0 ? 'Tonight' : n === 1 ? 'Tomorrow' : n > 1 ? `In ${n} days` : n === -1 ? 'Yesterday' : `${-n} days ago`; };
  // Times before 5 AM count as "late night" (after midnight) when ordering a show day.
  const sortKey = (t) => { if (!t) return 9999; const [h, m] = t.split(':').map(Number); return (h < 5 ? h + 24 : h) * 60 + m; };
  const nowKey = () => { const d = new Date(); return sortKey(pad(d.getHours()) + ':' + pad(d.getMinutes())); };

  /* ---------- availability entries ---------- */
  // An entry is "free" | "maybe" | "busy" or { s, from, to }.
  const norm = (v) => (typeof v === 'string' ? { s: v } : v && typeof v === 'object' ? { s: v.s || '', from: v.from || '', to: v.to || '' } : { s: '' });
  function pack(e) {
    if (!e.s) return null;
    if (e.s === 'busy' || (!e.from && !e.to)) return e.s;
    const o = { s: e.s }; if (e.from) o.from = e.from; if (e.to) o.to = e.to; return o;
  }
  function winLabel(e, short) {
    const f = short ? fmtTimeShort : fmtTime;
    if (e.from && e.to) return `${f(e.from)}–${f(e.to)}`;
    if (e.from) return `after ${f(e.from)}`;
    if (e.to) return `until ${f(e.to)}`;
    return '';
  }
  function entry(name, date) { return norm(name === S.me ? S.myDates[date] : (S.availability[name] || {})[date]); }
  const statusOf = (name, date) => entry(name, date).s;

  // Does this person's time window clash with a show's call time or set?
  function callTime(show) {
    const c = [['load-in', show.loadIn], ['soundcheck', show.soundcheck], ['doors', show.doors], ['the set', show.setStart]].filter((x) => x[1]);
    c.sort((a, b) => sortKey(a[1]) - sortKey(b[1]));
    return c[0] || null;
  }
  function conflict(e, show) {
    if (!e.s || e.s === 'busy') return '';
    const first = callTime(show);
    if (e.from && first && sortKey(e.from) > sortKey(first[1])) return `Gets there after ${first[0]} (${fmtTime(first[1])})`;
    const end = show.setEnd || show.setStart;
    if (e.to && end && sortKey(e.to) < sortKey(end)) return `Has to leave before the set ends (${fmtTime(end)})`;
    return '';
  }

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

  function members() {
    const names = new Set(Object.keys(S.availability));
    if (S.me) names.add(S.me);
    return [...names].sort((a, b) => a.localeCompare(b));
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
      // Don't redraw the availability panel under someone's fingers while they edit a time.
      const editingTime = document.activeElement && document.activeElement.closest && document.activeElement.closest('#dayDetail');
      if (editingTime && !st.unchanged) { setTimeout(refresh, 1500); return; }
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
  const TABS = ['shows', 'itinerary', 'availability'];
  function showTab() {
    const h = location.hash.slice(1);
    const t = TABS.includes(h) ? h : 'shows';
    document.querySelectorAll('.tab').forEach((s) => (s.hidden = s.id !== 'tab-' + t));
    document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + t));
    if (t === 'itinerary') renderItinerary();
  }
  addEventListener('hashchange', () => { showTab(); scrollTo(0, 0); });

  /* ---------- render ---------- */
  function render() {
    if ($('#app').hidden) return;
    $('#bandName').textContent = S.config.bandName || 'Our Shows';
    document.title = (S.config.bandName ? S.config.bandName + ' · ' : '') + 'Show Planner';
    $('#meName').textContent = S.me;
    renderBanner(); renderShows(); renderItinerary(); renderCalendar(); renderDetail(); renderBest(); renderMembers();
  }
  function renderBanner() {
    const b = $('#banner');
    b.textContent = S.online ? '' : 'Can’t reach the server right now — changes will show up once it’s back.';
    b.hidden = S.online;
  }

  function personChip(n, date, show) {
    const e = entry(n, date);
    const w = winLabel(e);
    const c = show ? conflict(e, show) : '';
    return `<span class="p ${e.s || 'none'}${c ? ' warn' : ''}"${c ? ` title="${esc(c)}"` : ''}>${esc(n)}${w ? ` <em>${esc(w)}</em>` : ''}${e.s ? '' : ' ?'}${c ? ' <b class="flag">!</b>' : ''}</span>`;
  }

  /* ---------- shows list ---------- */
  function showCard(s, isNext, isPast) {
    const d = parse(s.date);
    const tl = [['Load-in', s.loadIn], ['Soundcheck', s.soundcheck], ['Doors', s.doors]].filter((x) => x[1]);
    const set = s.setStart ? fmtTime(s.setStart) + (s.setEnd ? '–' + fmtTime(s.setEnd) : '') : '';
    const mapQ = [s.address, s.venue, s.city].filter(Boolean).join(', ');
    const who = isPast ? '' : `<div class="who">${members().map((n) => personChip(n, s.date, s)).join('')}</div>`;
    const armed = S.armed === s.id;
    const extra = (s.schedule || []).length;
    return `<article class="show${isNext ? ' next' : ''}">
      <div class="datebox"><div class="dow">${d.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase()}</div><div class="day">${d.getDate()}</div><div class="mon">${d.toLocaleDateString(undefined, { month: 'short' }).toUpperCase()}</div></div>
      <div>
        <div class="show-head">
          <div>
            <h3>${esc(s.venue)}${isNext ? '<span class="badge nextup">' + whenLabel(s.date) + '</span>' : ''}${s.status !== 'confirmed' ? `<span class="badge ${s.status}">${s.status === 'hold' ? 'On hold' : 'Idea'}</span>` : ''}</h3>
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
          <button class="btn small" type="button" data-itin="${esc(s.id)}">Itinerary${extra ? ` · ${extra + tl.length + (set ? 1 : 0)} steps` : ''}</button>
          <button class="btn ghost small" type="button" data-edit="${esc(s.id)}">Edit</button>
          <button class="btn ${armed ? 'danger' : 'ghost'} small" type="button" data-del="${esc(s.id)}">${armed ? 'Tap again to delete' : 'Delete'}</button>
        </div>
        ${s.updatedBy ? `<div class="muted small" style="margin-top:8px">Last updated by ${esc(s.updatedBy)}</div>` : ''}
      </div>
    </article>`;
  }
  function sortedShows() { return [...S.shows].sort((a, b) => a.date.localeCompare(b.date) || sortKey(a.setStart) - sortKey(b.setStart)); }
  function renderShows() {
    const today = todayIso();
    const sorted = sortedShows();
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
    const it = e.target.closest('[data-itin]');
    if (it) { S.itinId = it.dataset.itin; if (location.hash === '#itinerary') renderItinerary(); else location.hash = '#itinerary'; return; }
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

  /* ---------- itinerary ---------- */
  function itinSteps(s) {
    const steps = [];
    if (s.loadIn) steps.push({ time: s.loadIn, label: 'Load-in', kind: 'core' });
    if (s.soundcheck) steps.push({ time: s.soundcheck, label: 'Soundcheck', kind: 'core' });
    if (s.doors) steps.push({ time: s.doors, label: 'Doors open', kind: 'core' });
    if (s.setStart) steps.push({ time: s.setStart, end: s.setEnd, label: 'Showtime', kind: 'set' });
    (s.schedule || []).forEach((i) => steps.push({ time: i.time, label: i.label, note: i.note, kind: 'custom' }));
    const timed = steps.filter((x) => x.time).sort((a, b) => sortKey(a.time) - sortKey(b.time));
    const anytime = steps.filter((x) => !x.time);
    return { timed, anytime };
  }
  function pickItinShow() {
    const sorted = sortedShows();
    if (S.itinId && sorted.some((s) => s.id === S.itinId)) return sorted.find((s) => s.id === S.itinId);
    const today = todayIso();
    return sorted.find((s) => s.date >= today) || sorted[sorted.length - 1] || null;
  }
  function renderItinerary() {
    const body = $('#itinBody'), picker = $('#itinPicker');
    const show = pickItinShow();
    if (!show) {
      picker.innerHTML = '';
      body.innerHTML = `<div class="empty"><h3>No shows yet</h3><p class="muted">Add a show and its day-of schedule shows up here as a timeline.</p><button class="btn" type="button" data-new="">+ Add show</button></div>`;
      return;
    }
    const today = todayIso();
    const list = sortedShows().filter((s) => s.date >= today || s.id === show.id);
    picker.innerHTML = list.map((s) => {
      const d = parse(s.date);
      return `<button type="button" class="tix${s.id === show.id ? ' on' : ''}" data-itin="${esc(s.id)}">
        <span class="tix-d">${d.toLocaleDateString(undefined, { weekday: 'short' })} ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
        <span class="tix-v">${esc(s.venue)}</span></button>`;
    }).join('');

    const d = parse(show.date);
    const { timed, anytime } = itinSteps(show);
    const isToday = show.date === today;
    const nk = nowKey();
    let nextMarked = false;
    const mapQ = [show.address, show.venue, show.city].filter(Boolean).join(', ');
    const statusTxt = show.status === 'hold' ? 'On hold' : show.status === 'idea' ? 'Idea' : 'Confirmed';
    const ppl = members();

    const stepHtml = (x) => {
      let state = '';
      if (isToday && x.time) {
        if (sortKey(x.time) < nk && !(x.end && sortKey(x.end) > nk)) state = ' done';
        else if (!nextMarked) { state = ' upnext'; nextMarked = true; }
      }
      return `<li class="step ${x.kind}${state}">
        <div class="st-time">${x.time ? `<b>${fmtTime(x.time).replace(/ (AM|PM)/, '')}</b><span>${fmtTime(x.time).slice(-2)}</span>` : '<span>Any&shy;time</span>'}</div>
        <div class="st-rail"><i></i></div>
        <div class="st-body">
          ${state === ' upnext' ? '<div class="st-tag">Up next</div>' : ''}
          <div class="st-label">${esc(x.label)}</div>
          ${x.kind === 'set' && x.end ? `<div class="st-sub">${fmtTime(x.time)} – ${fmtTime(x.end)}</div>` : ''}
          ${x.note ? `<div class="st-note">${esc(x.note)}</div>` : ''}
        </div>
      </li>`;
    };

    body.innerHTML = `<div class="itin">
      <div class="hero">
        <div class="hero-date"><span>${d.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase()}</span><b>${d.getDate()}</b><span>${d.toLocaleDateString(undefined, { month: 'short' }).toUpperCase()}</span></div>
        <div class="hero-main">
          <p class="eyebrow">${esc(whenLabel(show.date))} · ${statusTxt}</p>
          <h2 class="hero-venue">${esc(show.venue)}</h2>
          <p class="hero-where">${esc([show.address, show.city].filter(Boolean).join(' · '))}${mapQ ? ` <a href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(mapQ)}" target="_blank" rel="noopener">Directions ↗</a>` : ''}</p>
          ${show.pay || show.contact ? `<div class="hero-meta">${show.pay ? `<span><em>Deal</em>${esc(show.pay)}</span>` : ''}${show.contact ? `<span><em>Contact</em>${esc(show.contact)}</span>` : ''}</div>` : ''}
        </div>
        <div class="hero-acts">
          <button class="btn small" type="button" id="copyItin">Copy for group text</button>
          <button class="btn ghost small" type="button" data-edit="${esc(show.id)}">Edit schedule</button>
        </div>
      </div>
      <div class="itin-grid">
        <div class="panel tl-panel">
          ${timed.length || anytime.length ? `<ol class="tl">${timed.map(stepHtml).join('')}${anytime.map(stepHtml).join('')}</ol>`
            : `<div class="tl-empty"><p class="muted">No times yet. Add load-in, set times and your own steps (leave the rehearsal space, dinner, load-out…).</p><button class="btn small" type="button" data-edit="${esc(show.id)}">Build the schedule</button></div>`}
        </div>
        <aside class="side">
          <div class="panel">
            <h3>Who’s in</h3>
            ${ppl.length ? `<ul class="crew">${ppl.map((n) => {
              const e = entry(n, show.date), c = conflict(e, show), w = winLabel(e);
              const lbl = { free: 'Free', maybe: 'Maybe', busy: 'Can’t make it', '': 'No answer yet' }[e.s];
              return `<li><span class="dot ${e.s || 'none'}"></span><div><b>${esc(n)}</b><div class="small ${c ? 'warn-txt' : 'muted'}">${lbl}${w ? ' · ' + esc(w) : ''}${c ? '<br>' + esc(c) : ''}</div></div></li>`;
            }).join('')}</ul>` : '<p class="muted small">Nobody has marked availability yet.</p>'}
            <a class="small" href="#availability">Update availability →</a>
          </div>
          ${show.notes ? `<div class="panel"><h3>Notes</h3><div class="notes">${esc(show.notes)}</div></div>` : ''}
        </aside>
      </div>
    </div>`;
  }
  function itinText(show) {
    const { timed, anytime } = itinSteps(show);
    const lines = [`${S.config.bandName ? S.config.bandName + ' @ ' : ''}${show.venue} — ${fmtLong(show.date)}`];
    const where = [show.address, show.city].filter(Boolean).join(', ');
    if (where) lines.push(where);
    lines.push('');
    timed.forEach((x) => lines.push(`${fmtTime(x.time).padEnd(8)}  ${x.label}${x.end ? ' (until ' + fmtTime(x.end) + ')' : ''}${x.note ? ' — ' + x.note : ''}`));
    anytime.forEach((x) => lines.push(`Anytime   ${x.label}${x.note ? ' — ' + x.note : ''}`));
    if (show.notes) lines.push('', 'Notes: ' + show.notes);
    return lines.join('\n');
  }
  $('#itinBody').addEventListener('click', async (e) => {
    if (e.target.id !== 'copyItin') return;
    const show = pickItinShow(); if (!show) return;
    const text = itinText(show);
    try { await navigator.clipboard.writeText(text); toast('Itinerary copied — paste it in the group chat'); }
    catch {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('Itinerary copied'); } catch { toast('Couldn’t copy on this device'); }
      ta.remove();
    }
  });

  /* ---------- show editor ---------- */
  const form = $('#showForm');
  const FIELDS = ['date', 'status', 'venue', 'city', 'address', 'loadIn', 'soundcheck', 'doors', 'setStart', 'setEnd', 'contact', 'pay', 'notes'];
  function renderSched() {
    $('#schedRows').innerHTML = S.schedDraft.map((it, i) => `<div class="sched-row" data-i="${i}">
      <input type="time" data-k="time" value="${esc(it.time)}" aria-label="Time">
      <input data-k="label" maxlength="80" value="${esc(it.label)}" placeholder="What's happening" aria-label="Step">
      <input data-k="note" maxlength="300" value="${esc(it.note)}" placeholder="Note (optional)" aria-label="Note">
      <button type="button" class="iconbtn sm" data-rm-step="${i}" aria-label="Remove step">&times;</button>
    </div>`).join('') || '<p class="muted small" style="margin:0">Add your own steps: when to meet, travel, dinner, load-out, hotel…</p>';
  }
  $('#schedRows').addEventListener('input', (e) => {
    const row = e.target.closest('.sched-row'); if (!row) return;
    S.schedDraft[Number(row.dataset.i)][e.target.dataset.k] = e.target.value;
  });
  $('#showForm').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm-step]');
    if (rm) { S.schedDraft.splice(Number(rm.dataset.rmStep), 1); renderSched(); return; }
    const q = e.target.closest('[data-quick]');
    if (q || e.target.id === 'addStep') {
      if (S.schedDraft.length >= 40) return toast('That’s the most steps one show can have.');
      S.schedDraft.push({ time: '', label: q ? q.dataset.quick : '', note: '' });
      renderSched();
      const rows = $('#schedRows').querySelectorAll('.sched-row');
      const last = rows[rows.length - 1];
      if (last) last.querySelector(q ? '[data-k=time]' : '[data-k=label]').focus();
    }
  });
  function openShow(show, date) {
    S.editing = show ? show.id : null;
    $('#showFormTitle').textContent = show ? 'Edit show' : 'Add show';
    FIELDS.forEach((f) => (form[f].value = show ? show[f] || '' : ''));
    if (!show) { form.status.value = 'confirmed'; form.date.value = date || ''; }
    S.schedDraft = show ? (show.schedule || []).map((x) => ({ ...x })) : [];
    renderSched();
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
    body.schedule = S.schedDraft.map((x) => ({ time: x.time || '', label: (x.label || '').trim(), note: (x.note || '').trim() })).filter((x) => x.label);
    if (!body.date) return ($('#showErr').textContent = 'Pick a date.');
    if (!body.venue) return ($('#showErr').textContent = 'Add the venue name.');
    if (S.schedDraft.some((x) => !(x.label || '').trim() && (x.time || x.note))) return ($('#showErr').textContent = 'Each schedule step needs a name.');
    $('#saveShow').disabled = true;
    try {
      const st = S.editing ? await api('PUT', '/api/shows/' + S.editing, body) : await api('POST', '/api/shows', body);
      if (!S.editing) { const added = st.shows.filter((s) => s.date === body.date && s.venue === body.venue).pop(); if (added) S.itinId = added.id; }
      apply(st);
      closeShow(); toast('Show saved');
      if (location.hash === '#availability') location.hash = '#shows';
    } catch (err) { $('#showErr').textContent = err.message; }
    $('#saveShow').disabled = false;
  });

  /* ---------- availability ---------- */
  const CYCLE = { '': 'free', free: 'maybe', maybe: 'busy', busy: '' };
  const showsOn = (date) => S.shows.filter((s) => s.date === date);

  function renderCalendar() {
    if (!S.month) { const t = new Date(); S.month = new Date(t.getFullYear(), t.getMonth(), 1); }
    document.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === S.mode));
    $('#calHint').textContent = S.mode === 'mine'
      ? 'Tap a date to cycle Free → Maybe → Busy → blank. Add times like “after 6 PM” in the panel. Saves automatically.'
      : 'Dots show each person. Tap a date to see who’s free, when, and book a show.';
    const y = S.month.getFullYear(), m = S.month.getMonth();
    $('#monthLabel').textContent = S.month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const startDow = new Date(y, m, 1).getDay();
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
        const e = entry(S.me, k); if (e.s) cls += ' ' + e.s;
        const w = winLabel(e, true); if (w) inner = `<span class="win">${esc(w)}</span>`;
      } else {
        const es = ppl.map((n) => entry(n, k));
        const free = es.filter((x) => x.s === 'free').length;
        if (ppl.length && free === ppl.length) cls += ' all-free';
        inner = `<div class="dots">${es.map((x) => `<i class="${x.s}${x.from || x.to ? ' part' : ''}"></i>`).join('')}</div>${free ? `<span class="cnt">${free}/${ppl.length}</span>` : ''}`;
      }
      html += `<button type="button" class="${cls}" data-day="${k}" ${inMonth ? '' : 'tabindex="-1"'}><span class="n">${d.getDate()}</span>${inner}${gig}</button>`;
    }
    $('#cal').innerHTML = html;
  }
  $('#cal').addEventListener('click', (e) => {
    const b = e.target.closest('[data-day]'); if (!b || b.classList.contains('out')) return;
    const k = b.dataset.day;
    if (S.mode === 'mine' && k >= todayIso()) {
      const cur = entry(S.me, k);
      setMine(k, { ...cur, s: CYCLE[cur.s] });
    }
    S.sel = k; renderCalendar(); renderDetail();
  });
  $('#prevMonth').addEventListener('click', () => { S.month = new Date(S.month.getFullYear(), S.month.getMonth() - 1, 1); renderCalendar(); });
  $('#nextMonth').addEventListener('click', () => { S.month = new Date(S.month.getFullYear(), S.month.getMonth() + 1, 1); renderCalendar(); });
  document.querySelector('.seg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.mode = b.dataset.mode; renderCalendar(); renderDetail(); });

  function setMine(date, e) {
    if (e.s === 'busy' || !e.s) { e.from = ''; e.to = ''; }
    const v = pack(e);
    if (v) S.myDates[date] = v; else delete S.myDates[date];
    queueSave(); renderCalendar(); renderDetail(); renderBest(); renderMembers(); renderShows(); renderItinerary();
  }

  function renderDetail() {
    const el = $('#dayDetail');
    if (!S.sel) {
      const n = Object.keys(S.myDates).filter((d) => d >= todayIso()).length;
      el.innerHTML = `<h3>${S.mode === 'mine' ? 'Your dates' : 'Pick a date'}</h3><p class="muted small" style="margin:0">${S.mode === 'mine' ? `Tap dates on the calendar to mark when you can play. You’ve marked ${n} upcoming date${n === 1 ? '' : 's'}.` : 'Tap any date to see who can make it.'}</p>`;
      return;
    }
    const k = S.sel, gigs = showsOn(k), ppl = members(), isPast = k < todayIso();
    const groups = { free: [], maybe: [], busy: [], '': [] };
    ppl.forEach((n) => groups[statusOf(n, k)].push(n));
    const gig = gigs[0];
    const list = (label, arr) => arr.length ? `<div class="muted small" style="margin-top:10px">${label}</div><div class="who" style="margin-top:4px">${arr.map((n) => personChip(n, k, gig)).join('')}</div>` : '';
    const mine = entry(S.me, k);
    const timeRow = mine.s === 'free' || mine.s === 'maybe' ? `
      <div class="muted small" style="margin-top:12px">When? <span class="faint">(leave blank for all day)</span></div>
      <div class="win-row">
        <label>From<input type="time" id="winFrom" value="${esc(mine.from)}"></label>
        <label>Until<input type="time" id="winTo" value="${esc(mine.to)}"></label>
      </div>
      <div class="win-quick">
        <button type="button" data-win="18:00|">After 6 PM</button>
        <button type="button" data-win="|17:00">Until 5 PM</button>
        <button type="button" data-win="|">All day</button>
      </div>` : '';
    el.innerHTML = `<h3>${esc(fmtLong(k))}</h3>
      ${gigs.map((g) => `<button type="button" class="gig-link" data-itin="${esc(g.id)}"><span class="sw gig"></span> <b>${esc(g.venue)}</b>${g.setStart ? ' · set ' + fmtTime(g.setStart) : ''} →</button>`).join('')}
      ${!isPast ? `<div class="muted small" style="margin-top:10px">Your answer</div><div class="status-pick">
        ${['free', 'maybe', 'busy'].map((s) => `<button type="button" class="${s}${mine.s === s ? ' on' : ''}" data-set="${s}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}
        ${mine.s ? '<button type="button" data-set="">Clear</button>' : ''}
      </div>${timeRow}` : ''}
      ${list('Free', groups.free)}${list('Maybe', groups.maybe)}${list('Busy', groups.busy)}${list('No answer yet', groups[''])}
      ${!isPast && !gigs.length ? `<button class="btn small" type="button" data-new="${k}" style="margin-top:14px">+ Book a show on this date</button>` : ''}`;
  }
  $('#dayDetail').addEventListener('click', (e) => {
    if (!S.sel) return;
    const b = e.target.closest('[data-set]');
    if (b) { const cur = entry(S.me, S.sel); return setMine(S.sel, { ...cur, s: b.dataset.set }); }
    const w = e.target.closest('[data-win]');
    if (w) { const [from, to] = w.dataset.win.split('|'); const cur = entry(S.me, S.sel); return setMine(S.sel, { ...cur, from, to }); }
  });
  $('#dayDetail').addEventListener('change', (e) => {
    if (!S.sel || (e.target.id !== 'winFrom' && e.target.id !== 'winTo')) return;
    const cur = entry(S.me, S.sel);
    let from = $('#winFrom').value, to = $('#winTo').value;
    if (from && to && sortKey(to) <= sortKey(from)) { toast('“Until” needs to be after “From”.'); return; }
    setMine(S.sel, { ...cur, from, to });
  });

  function renderBest() {
    const ppl = members(); const out = [];
    if (ppl.length) {
      const d = parse(todayIso());
      for (let i = 0; i < 90; i++, d.setDate(d.getDate() + 1)) {
        const k = iso(d); if (showsOn(k).length) continue;
        const es = ppl.map((n) => entry(n, k));
        const free = es.filter((x) => x.s === 'free').length, maybe = es.filter((x) => x.s === 'maybe').length, busy = es.filter((x) => x.s === 'busy').length;
        const partial = es.filter((x) => x.s === 'free' && (x.from || x.to)).length;
        if (free) out.push({ k, free, maybe, busy, partial });
      }
      out.sort((a, b) => b.free - a.free || a.busy - b.busy || a.partial - b.partial || b.maybe - a.maybe || a.k.localeCompare(b.k));
    }
    $('#bestDates').innerHTML = out.length ? '<ul class="best">' + out.slice(0, 8).map((r) => {
      const none = ppl.length - r.free - r.maybe - r.busy;
      const sub = [r.partial ? r.partial + ' only part of the day' : '', r.maybe ? r.maybe + ' maybe' : '', r.busy ? r.busy + ' busy' : '', none ? none + ' no answer' : ''].filter(Boolean).join(' · ');
      return `<li><div><b>${esc(fmtShort(r.k))}</b><span class="pill">${r.free}/${ppl.length} free</span><div class="sub">${sub || 'Everyone’s free all day'}</div></div>
        <button class="btn ghost small" type="button" data-new="${r.k}">Book</button></li>`;
    }).join('') + '</ul>' : '<p class="muted small" style="margin:0">Once people mark free dates, the best ones show up here.</p>';
  }

  function renderMembers() {
    const ppl = members(), today = todayIso();
    $('#members').innerHTML = `<div class="members">${ppl.map((n) => {
      const dates = n === S.me ? S.myDates : (S.availability[n] || {});
      const c = Object.entries(dates).filter(([d, v]) => d >= today && norm(v).s === 'free').length;
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

  /* ---------- saving my availability ---------- */
  let saveT = null, saving = false, again = false;
  function queueSave() { S.dirty = true; $('#saveStatus').textContent = 'Saving…'; clearTimeout(saveT); saveT = setTimeout(save, 600); }
  function flushSave() { if (S.dirty) { clearTimeout(saveT); save(); } }
  async function save() {
    if (saving) { again = true; return; }
    saving = true;
    try {
      const st = await api('PUT', '/api/availability', { name: S.me, dates: S.myDates });
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
