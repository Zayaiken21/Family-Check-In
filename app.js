(() => {
  'use strict';

  const cfg = window.APP_CONFIG || {};
  const INTERVAL_MIN = Number(cfg.CHECKIN_INTERVAL_MINUTES || 45);
  const GRACE_MIN = Number(cfg.LATE_GRACE_MINUTES || 10);
  const configured = cfg.SUPABASE_URL && !cfg.SUPABASE_URL.includes('YOUR_PROJECT') && cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_ANON_KEY.includes('YOUR_SUPABASE');
  const db = configured ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;

  const $ = (id) => document.getElementById(id);
  const els = {};
  ['authView','parentView','caseworkerView','logoutBtn','notificationBtn','authForm','authTitle','authSubmit','authMessage','email','password','nameField','fullName','roleField','role','parentWelcome','parentLinkStatus','nextCheckin','nextCheckinSub','weekCount','onTimeRate','lastAccuracy','dueBadge','gpsCheckinBtn','virtualCheckinBtn','checkinNote','checkinResult','inviteCodeInput','linkCaseworkerBtn','linkedCaseworkers','parentRange','parentHistoryBody','parentExportBtn','caseworkerWelcome','newInviteBtn','linkedParentCount','lateParentCount','todayCheckins','pendingVirtual','parentCards','inviteList','caseworkerParentFilter','caseworkerRange','caseworkerHistoryBody','caseworkerExportBtn','mapDialog','mapTitle','mapMeta','closeMapBtn','inviteDialog','closeInviteBtn','inviteCodeDisplay','copyInviteBtn'].forEach(id => els[id] = $(id));

  let authMode = 'signin';
  let session = null;
  let profile = null;
  let currentCheckins = [];
  let linkedProfiles = [];
  let timerHandle = null;
  let leafletMap = null;
  let leafletMarker = null;
  let lastInviteCode = '';

  const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const shortTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

  document.querySelectorAll('[data-auth-mode]').forEach(btn => btn.addEventListener('click', () => setAuthMode(btn.dataset.authMode)));
  els.authForm.addEventListener('submit', handleAuth);
  els.logoutBtn.addEventListener('click', () => db?.auth.signOut());
  els.notificationBtn.addEventListener('click', enableNotifications);
  els.gpsCheckinBtn.addEventListener('click', submitLocationCheckin);
  els.virtualCheckinBtn.addEventListener('click', submitVirtualCheckin);
  els.linkCaseworkerBtn.addEventListener('click', linkCaseworker);
  els.parentRange.addEventListener('change', loadParentData);
  els.parentExportBtn.addEventListener('click', () => exportCSV(currentCheckins, 'my-checkins.csv'));
  els.newInviteBtn.addEventListener('click', createInvite);
  els.caseworkerRange.addEventListener('change', loadCaseworkerData);
  els.caseworkerParentFilter.addEventListener('change', renderCaseworkerHistory);
  els.caseworkerExportBtn.addEventListener('click', () => exportCSV(filteredCaseworkerRows(), 'caseworker-checkins.csv', true));
  els.closeMapBtn.addEventListener('click', () => els.mapDialog.close());
  els.closeInviteBtn.addEventListener('click', () => els.inviteDialog.close());
  els.copyInviteBtn.addEventListener('click', async () => {
    if (!lastInviteCode) return;
    await navigator.clipboard.writeText(lastInviteCode);
    els.copyInviteBtn.textContent = 'Copied'; setTimeout(() => els.copyInviteBtn.textContent = 'Copy code', 1200);
  });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

  if (!configured) {
    els.authMessage.textContent = 'Setup required: add your Supabase URL and anon key to config.js, then run supabase.sql.';
  } else {
    db.auth.getSession().then(({ data }) => applySession(data.session));
    db.auth.onAuthStateChange((_event, newSession) => applySession(newSession));
  }

  function setAuthMode(mode) {
    authMode = mode;
    document.querySelectorAll('[data-auth-mode]').forEach(b => b.classList.toggle('active', b.dataset.authMode === mode));
    const signup = mode === 'signup';
    els.nameField.classList.toggle('hidden', !signup);
    els.roleField.classList.toggle('hidden', !signup);
    els.authTitle.textContent = signup ? 'Create your account' : 'Welcome back';
    els.authSubmit.textContent = signup ? 'Create account' : 'Sign in';
    els.password.autocomplete = signup ? 'new-password' : 'current-password';
    els.authMessage.textContent = '';
  }

  async function handleAuth(e) {
    e.preventDefault();
    if (!db) return;
    els.authSubmit.disabled = true;
    els.authMessage.textContent = '';
    const email = els.email.value.trim();
    const password = els.password.value;
    try {
      if (authMode === 'signup') {
        const full_name = els.fullName.value.trim();
        if (!full_name) throw new Error('Please enter your full name.');
        const { error } = await db.auth.signUp({ email, password, options: { data: { full_name, role: els.role.value } } });
        if (error) throw error;
        els.authMessage.style.color = '#147d50';
        els.authMessage.textContent = 'Account created. If email confirmation is enabled, check your email before signing in.';
      } else {
        const { error } = await db.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      els.authMessage.style.color = '#b72a37'; els.authMessage.textContent = err.message || 'Unable to continue.';
    } finally { els.authSubmit.disabled = false; }
  }

  async function applySession(newSession) {
    session = newSession;
    stopTimer();
    if (!session) {
      profile = null;
      els.authView.classList.remove('hidden');
      els.parentView.classList.add('hidden'); els.caseworkerView.classList.add('hidden'); els.logoutBtn.classList.add('hidden');
      return;
    }
    els.logoutBtn.classList.remove('hidden');
    const { data, error } = await db.from('profiles').select('*').eq('id', session.user.id).single();
    if (error || !data) { alert('Your profile could not be loaded. Confirm that supabase.sql was installed.'); return; }
    profile = data;
    els.authView.classList.add('hidden');
    if (profile.role === 'caseworker') {
      els.parentView.classList.add('hidden'); els.caseworkerView.classList.remove('hidden');
      els.caseworkerWelcome.textContent = `${profile.full_name || 'Caseworker'} — visit verification overview`;
      await loadCaseworkerData();
    } else {
      els.caseworkerView.classList.add('hidden'); els.parentView.classList.remove('hidden');
      els.parentWelcome.textContent = `${profile.full_name || 'Parent'} — your visit check-ins`;
      await loadParentData();
      startTimer();
    }
  }

  function daysAgoISO(range) {
    if (range === 'all') return null;
    const d = new Date(Date.now() - Number(range) * 86400000);
    return d.toISOString();
  }

  async function loadParentData() {
    if (!session) return;
    const since = daysAgoISO(els.parentRange.value);
    let q = db.from('checkins').select('*').eq('parent_id', session.user.id).order('captured_at', { ascending: false }).limit(5000);
    if (since) q = q.gte('captured_at', since);
    const [{ data: checks, error: checkErr }, { data: relations, error: relErr }] = await Promise.all([
      q,
      db.from('relationships').select('id,caseworker_id,active,profiles!relationships_caseworker_id_fkey(id,full_name,email)').eq('parent_id', session.user.id).eq('active', true)
    ]);
    if (checkErr) console.error(checkErr);
    if (relErr) console.error(relErr);
    currentCheckins = checks || [];
    linkedProfiles = (relations || []).map(r => ({ relation_id: r.id, ...(r.profiles || {}), caseworker_id: r.caseworker_id }));
    renderParentMetrics(); renderParentHistory(); renderLinkedCaseworkers();
  }

  function renderParentMetrics() {
    const now = Date.now();
    const weekAgo = now - 7 * 86400000;
    const week = currentCheckins.filter(c => new Date(c.captured_at).getTime() >= weekAgo);
    els.weekCount.textContent = week.length;
    const loc = currentCheckins.filter(c => c.mode === 'location');
    const onTime = loc.filter(c => c.on_time === true).length;
    els.onTimeRate.textContent = loc.length ? `${Math.round(onTime / loc.length * 100)}%` : '—';
    const lastAcc = loc.find(c => c.accuracy_m != null);
    els.lastAccuracy.textContent = lastAcc ? `${Math.round(lastAcc.accuracy_m)} m` : '—';
    els.parentLinkStatus.textContent = linkedProfiles.length ? `${linkedProfiles.length} caseworker${linkedProfiles.length > 1 ? 's' : ''} linked` : 'No caseworker linked';
    updateDueState();
  }

  function updateDueState() {
    const last = currentCheckins[0];
    if (!last) {
      els.nextCheckin.textContent = 'Now'; els.nextCheckinSub.textContent = 'Start your first check-in'; setBadge('Ready', 'neutral'); return;
    }
    const due = new Date(last.captured_at).getTime() + INTERVAL_MIN * 60000;
    const diff = due - Date.now();
    if (diff > 0) {
      els.nextCheckin.textContent = duration(diff); els.nextCheckinSub.textContent = `Due ${shortTime.format(new Date(due))}`; setBadge('On schedule', 'good');
    } else if (diff > -GRACE_MIN * 60000) {
      els.nextCheckin.textContent = 'Due now'; els.nextCheckinSub.textContent = `Due ${shortTime.format(new Date(due))}`; setBadge('Due', 'warn');
    } else {
      els.nextCheckin.textContent = 'Late'; els.nextCheckinSub.textContent = `Was due ${shortTime.format(new Date(due))}`; setBadge('Late', 'bad');
    }
  }

  function setBadge(text, cls) { els.dueBadge.textContent = text; els.dueBadge.className = `badge ${cls}`; }
  function duration(ms) { const total = Math.max(0, Math.floor(ms / 1000)); const m = Math.floor(total / 60); const s = total % 60; return `${m}:${String(s).padStart(2,'0')}`; }
  function startTimer() { stopTimer(); updateDueState(); timerHandle = setInterval(updateDueState, 1000); }
  function stopTimer() { if (timerHandle) clearInterval(timerHandle); timerHandle = null; }

  function renderParentHistory() {
    els.parentHistoryBody.innerHTML = currentCheckins.length ? currentCheckins.map(c => `
      <tr><td>${esc(fmt.format(new Date(c.captured_at)))}</td><td>${modeLabel(c.mode)}</td><td>${statusBadge(c)}</td><td>${c.accuracy_m != null ? `${Math.round(c.accuracy_m)} m` : '—'}</td><td>${c.latitude != null ? `<button class="location-link" data-map="${c.id}">View map</button>` : '—'}</td><td>${esc(c.note || '—')}</td></tr>`).join('') : `<tr><td colspan="6" class="empty">No check-ins in this period.</td></tr>`;
    els.parentHistoryBody.querySelectorAll('[data-map]').forEach(b => b.addEventListener('click', () => openMap(currentCheckins.find(c => c.id === b.dataset.map))));
  }

  function renderLinkedCaseworkers() {
    els.linkedCaseworkers.innerHTML = linkedProfiles.length ? linkedProfiles.map(p => `<div class="stack-item"><div class="row"><div><b>${esc(p.full_name || 'Caseworker')}</b><br><small>${esc(p.email || '')}</small></div><button class="mini-btn danger" data-unlink="${p.relation_id}">Revoke</button></div></div>`).join('') : `<div class="empty">No linked caseworkers yet.</div>`;
    els.linkedCaseworkers.querySelectorAll('[data-unlink]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Revoke this caseworker link? Existing records will remain in your account but this caseworker will lose access.')) return;
      const { error } = await db.from('relationships').update({ active: false, revoked_at: new Date().toISOString() }).eq('id', b.dataset.unlink).eq('parent_id', session.user.id);
      if (error) alert(error.message); else loadParentData();
    }));
  }

  async function submitLocationCheckin() {
    if (!navigator.geolocation) return showCheckinResult('This browser does not support location services.', true);
    els.gpsCheckinBtn.disabled = true; els.gpsCheckinBtn.textContent = 'Getting GPS…';
    navigator.geolocation.getCurrentPosition(async pos => {
      try {
        const payload = {
          parent_id: session.user.id,
          mode: 'location',
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy_m: pos.coords.accuracy,
          altitude_m: pos.coords.altitude,
          speed_mps: pos.coords.speed,
          heading_deg: pos.coords.heading,
          client_recorded_at: new Date(pos.timestamp).toISOString(),
          note: els.checkinNote.value.trim() || null,
          review_status: 'submitted'
        };
        const { data, error } = await db.from('checkins').insert(payload).select().single();
        if (error) throw error;
        showCheckinResult(`Location check-in recorded at ${fmt.format(new Date(data.captured_at))}. GPS accuracy: about ${Math.round(data.accuracy_m)} meters.`);
        els.checkinNote.value = '';
        await loadParentData();
      } catch (err) { showCheckinResult(err.message, true); }
      finally { els.gpsCheckinBtn.disabled = false; els.gpsCheckinBtn.textContent = '📍 Confirm location'; }
    }, err => {
      const msg = err.code === 1 ? 'Location permission was denied. Allow location access in your browser settings, then try again.' : err.code === 2 ? 'Your device could not determine its location.' : 'Location request timed out. Try moving near a window or outdoors.';
      showCheckinResult(msg, true); els.gpsCheckinBtn.disabled = false; els.gpsCheckinBtn.textContent = '📍 Confirm location';
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  }

  async function submitVirtualCheckin() {
    els.virtualCheckinBtn.disabled = true;
    try {
      const { data, error } = await db.from('checkins').insert({ parent_id: session.user.id, mode: 'virtual', note: els.checkinNote.value.trim() || null, review_status: 'pending' }).select().single();
      if (error) throw error;
      showCheckinResult(`Virtual check-in request recorded at ${fmt.format(new Date(data.captured_at))}. It is marked pending until an authorized caseworker reviews it.`);
      els.checkinNote.value = ''; await loadParentData();
    } catch (err) { showCheckinResult(err.message, true); }
    finally { els.virtualCheckinBtn.disabled = false; }
  }

  function showCheckinResult(text, error = false) { els.checkinResult.classList.remove('hidden'); els.checkinResult.style.background = error ? '#fff0f1' : '#edf6ff'; els.checkinResult.style.borderColor = error ? '#ffd0d5' : '#cfe2ff'; els.checkinResult.textContent = text; }

  async function linkCaseworker() {
    const code = els.inviteCodeInput.value.trim().toUpperCase();
    if (code.length !== 6) return alert('Enter the six-character invite code.');
    els.linkCaseworkerBtn.disabled = true;
    const { data, error } = await db.rpc('redeem_caseworker_invite', { invite_code_input: code });
    els.linkCaseworkerBtn.disabled = false;
    if (error) return alert(error.message);
    if (!data?.ok) return alert(data?.message || 'Invite could not be used.');
    els.inviteCodeInput.value = ''; await loadParentData();
  }

  async function createInvite() {
    const { data, error } = await db.rpc('create_parent_invite');
    if (error) return alert(error.message);
    lastInviteCode = data.code;
    els.inviteCodeDisplay.textContent = data.code;
    els.inviteDialog.showModal();
    await loadCaseworkerData();
  }

  async function loadCaseworkerData() {
    if (!session) return;
    const since = daysAgoISO(els.caseworkerRange.value);
    const [{ data: relations, error: relErr }, { data: invites, error: invErr }] = await Promise.all([
      db.from('relationships').select('id,parent_id,active,created_at,profiles!relationships_parent_id_fkey(id,full_name,email)').eq('caseworker_id', session.user.id).eq('active', true),
      db.from('invites').select('id,code,expires_at,used_at,created_at').eq('caseworker_id', session.user.id).order('created_at', { ascending:false }).limit(30)
    ]);
    if (relErr) console.error(relErr); if (invErr) console.error(invErr);
    linkedProfiles = (relations || []).map(r => ({ relation_id:r.id, parent_id:r.parent_id, ...(r.profiles || {}) }));
    const ids = linkedProfiles.map(p => p.parent_id);
    let checks = [];
    if (ids.length) {
      let q = db.from('checkins').select('*').in('parent_id', ids).order('captured_at',{ascending:false}).limit(10000);
      if (since) q = q.gte('captured_at', since);
      const { data, error } = await q; if (error) console.error(error); checks = data || [];
    }
    currentCheckins = checks;
    renderCaseworkerMetrics(); renderParentCards(); renderInvites(invites || []); populateParentFilter(); renderCaseworkerHistory();
  }

  function renderCaseworkerMetrics() {
    els.linkedParentCount.textContent = linkedProfiles.length;
    const now = Date.now();
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    els.todayCheckins.textContent = currentCheckins.filter(c => new Date(c.captured_at) >= todayStart).length;
    els.pendingVirtual.textContent = currentCheckins.filter(c => c.mode === 'virtual' && c.review_status === 'pending').length;
    let late = 0;
    linkedProfiles.forEach(p => { const last = currentCheckins.find(c => c.parent_id === p.parent_id); if (!last || (now - new Date(last.captured_at).getTime()) > (INTERVAL_MIN + GRACE_MIN) * 60000) late++; });
    els.lateParentCount.textContent = late;
  }

  function renderParentCards() {
    const now = Date.now();
    els.parentCards.innerHTML = linkedProfiles.length ? linkedProfiles.map(p => {
      const last = currentCheckins.find(c => c.parent_id === p.parent_id);
      const mins = last ? Math.floor((now - new Date(last.captured_at).getTime()) / 60000) : null;
      const state = mins == null ? ['No check-in','bad'] : mins <= INTERVAL_MIN ? ['On schedule','good'] : mins <= INTERVAL_MIN + GRACE_MIN ? ['Due','warn'] : ['Late','bad'];
      return `<div class="parent-card"><div class="row"><div><b>${esc(p.full_name || p.email || 'Parent')}</b><br><small>${last ? `Last: ${esc(fmt.format(new Date(last.captured_at)))}` : 'No check-ins yet'}</small></div><span class="badge ${state[1]}">${state[0]}</span></div></div>`;
    }).join('') : `<div class="empty">No parents linked yet. Create an invite code to begin.</div>`;
  }

  function renderInvites(invites) {
    const now = Date.now();
    els.inviteList.innerHTML = invites.length ? invites.map(i => { const expired = new Date(i.expires_at).getTime() < now; const state = i.used_at ? 'Used' : expired ? 'Expired' : 'Active'; return `<div class="stack-item"><div class="row"><div><b style="letter-spacing:.12em">${esc(i.code)}</b><br><small>${state} • expires ${esc(fmt.format(new Date(i.expires_at)))}</small></div></div></div>`; }).join('') : `<div class="empty">No invites created yet.</div>`;
  }

  function populateParentFilter() {
    const val = els.caseworkerParentFilter.value;
    els.caseworkerParentFilter.innerHTML = '<option value="all">All parents</option>' + linkedProfiles.map(p => `<option value="${p.parent_id}">${esc(p.full_name || p.email || 'Parent')}</option>`).join('');
    if ([...els.caseworkerParentFilter.options].some(o => o.value === val)) els.caseworkerParentFilter.value = val;
  }

  function filteredCaseworkerRows() { const id = els.caseworkerParentFilter.value; return id === 'all' ? currentCheckins : currentCheckins.filter(c => c.parent_id === id); }

  function renderCaseworkerHistory() {
    const rows = filteredCaseworkerRows();
    els.caseworkerHistoryBody.innerHTML = rows.length ? rows.map(c => {
      const p = linkedProfiles.find(x => x.parent_id === c.parent_id);
      const review = c.mode === 'virtual' && c.review_status === 'pending' ? `<button class="mini-btn" data-approve="${c.id}">Verify</button> <button class="mini-btn danger" data-reject="${c.id}">Reject</button>` : esc(c.review_status || 'submitted');
      return `<tr><td>${esc(p?.full_name || p?.email || 'Parent')}</td><td>${esc(fmt.format(new Date(c.captured_at)))}</td><td>${modeLabel(c.mode)}</td><td>${statusBadge(c)}</td><td>${c.accuracy_m != null ? `${Math.round(c.accuracy_m)} m` : '—'}</td><td>${c.latitude != null ? `<button class="location-link" data-map="${c.id}">View map</button>` : '—'}</td><td>${review}</td></tr>`;
    }).join('') : `<tr><td colspan="7" class="empty">No check-ins in this period.</td></tr>`;
    els.caseworkerHistoryBody.querySelectorAll('[data-map]').forEach(b => b.addEventListener('click', () => openMap(currentCheckins.find(c => c.id === b.dataset.map))));
    els.caseworkerHistoryBody.querySelectorAll('[data-approve]').forEach(b => b.addEventListener('click', () => reviewVirtual(b.dataset.approve, 'verified')));
    els.caseworkerHistoryBody.querySelectorAll('[data-reject]').forEach(b => b.addEventListener('click', () => reviewVirtual(b.dataset.reject, 'rejected')));
  }

  async function reviewVirtual(id, status) {
    const { error } = await db.from('checkins').update({ review_status: status, reviewed_by: session.user.id, reviewed_at: new Date().toISOString() }).eq('id', id);
    if (error) alert(error.message); else loadCaseworkerData();
  }

  function openMap(c) {
    if (!c || c.latitude == null) return;
    const p = profile?.role === 'caseworker' ? linkedProfiles.find(x => x.parent_id === c.parent_id) : profile;
    els.mapTitle.textContent = `${p?.full_name || 'Parent'} • ${fmt.format(new Date(c.captured_at))}`;
    els.mapMeta.innerHTML = `Coordinates: <b>${Number(c.latitude).toFixed(6)}, ${Number(c.longitude).toFixed(6)}</b><br>Reported GPS accuracy radius: <b>${c.accuracy_m != null ? Math.round(c.accuracy_m)+' meters' : 'unknown'}</b><br>Method: <b>${modeLabel(c.mode)}</b>`;
    els.mapDialog.showModal();
    setTimeout(() => {
      const point = [c.latitude,c.longitude];
      if (!leafletMap) {
        leafletMap = L.map('map').setView(point, 16);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap contributors'}).addTo(leafletMap);
      } else leafletMap.setView(point,16);
      if (leafletMarker) leafletMarker.remove();
      leafletMarker = L.marker(point).addTo(leafletMap).bindPopup('Recorded check-in location').openPopup();
      if (c.accuracy_m) L.circle(point,{radius:c.accuracy_m}).addTo(leafletMap);
      leafletMap.invalidateSize();
    },100);
  }

  async function enableNotifications() {
    if (!('Notification' in window)) return alert('Notifications are not supported in this browser.');
    const permission = await Notification.requestPermission();
    els.notificationBtn.textContent = permission === 'granted' ? 'Reminders enabled' : 'Enable reminders';
    if (permission === 'granted') new Notification('Family Check-In reminders enabled', { body: 'Keep the app open or installed for the best reminder reliability.' });
  }

  function modeLabel(mode) { return mode === 'location' ? '📍 Location' : '🎥 Virtual'; }
  function statusBadge(c) {
    if (c.review_status === 'verified') return '<span class="badge good">Verified</span>';
    if (c.review_status === 'rejected') return '<span class="badge bad">Rejected</span>';
    if (c.mode === 'virtual') return '<span class="badge warn">Pending review</span>';
    return c.on_time === false ? '<span class="badge bad">Late</span>' : '<span class="badge good">Submitted</span>';
  }

  function exportCSV(rows, filename, includeParent = false) {
    const header = includeParent ? ['Parent','Captured At','Method','Review Status','On Time','Latitude','Longitude','Accuracy M','Note'] : ['Captured At','Method','Review Status','On Time','Latitude','Longitude','Accuracy M','Note'];
    const data = rows.map(c => {
      const p = linkedProfiles.find(x => (x.parent_id || x.id) === c.parent_id);
      const base = [c.captured_at,c.mode,c.review_status,c.on_time,c.latitude,c.longitude,c.accuracy_m,c.note || ''];
      return includeParent ? [p?.full_name || p?.email || c.parent_id,...base] : base;
    });
    const csv = [header,...data].map(row => row.map(csvCell).join(',')).join('\n');
    const blob = new Blob([csv],{type:'text/csv;charset=utf-8'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=filename; a.click(); URL.revokeObjectURL(a.href);
  }

  function csvCell(v){ const s=v==null?'':String(v); return `"${s.replaceAll('"','""')}"`; }
  function esc(v){ return String(v ?? '').replace(/[&<>'"]/g,ch=>({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[ch])); }
})();
