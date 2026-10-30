const sb = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);
const PUSH_INTERVAL = 30000;
const TAB_H = 56;

let user = null, devices = [], selectedId = null, channel = null, tab = 'devices', loadError = null;
let myId = localStorage.getItem('findmy_device_id');
let map, markers = {}, fitted = false, hereMarker = null, hasTrail = false;
let watchId = null, lastPush = 0;
let audioCtx = null, ringTimer = null;
let lastRing = localStorage.getItem('findmy_last_ring') || '';

// ---------- helpers ----------
function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  kids.forEach((k) => e.append(k));
  return e;
}
function ago(iso) {
  if (!iso) return '尚無位置';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return '剛剛';
  if (s < 3600) return Math.floor(s / 60) + ' 分鐘前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小時前';
  return Math.floor(s / 86400) + ' 天前';
}
const me = () => devices.find((d) => d.id === myId);
const icon = (d) => /手機|phone|iphone|android/i.test(d.name) ? '📱' : /電腦|pc|laptop|mac|筆電/i.test(d.name) ? '💻' : '📍';
const batt = (d) => d.battery != null ? ' · 🔋 ' + Math.round(d.battery * 100) + '%' : '';

// iOS-style dialog. Returns the input text (or true) on OK, null on cancel.
function ask({ title, msg = '', input = false, def = '', ok = '好', danger = false }) {
  return new Promise((resolve) => {
    const m = $('modal');
    const field = input ? el('input', { value: def, maxLength: 60 }) : null;
    const done = (v) => { m.classList.add('hidden'); m.replaceChildren(); resolve(v); };
    const cancel = el('button', { textContent: '取消', onclick: () => done(null) });
    const yes = el('button', { textContent: ok, className: danger ? 'danger' : '', onclick: () => done(input ? field.value.trim() : true) });
    m.replaceChildren(el('div', { className: 'box' },
      el('div', { className: 'in' }, el('h3', { textContent: title }), el('p', { textContent: msg }), ...(field ? [field] : [])),
      el('div', { className: 'bt' }, cancel, yes)));
    m.classList.remove('hidden');
    if (field) field.focus();
  });
}

// ---------- auth ----------
function showLogin() {
  user = null;
  stopTracking();
  if (channel) { sb.removeChannel(channel); channel = null; }
  $('app').classList.add('hidden');
  $('login').classList.remove('hidden');
}
async function showApp(u) {
  if (user && user.id === u.id) return;
  user = u;
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  initMap();
  setH(detents()[0], false);
  await loadDevices();
  subscribe();
  if (myId && me()) { startTracking(); checkRemote(me()); }
  else if (myId && !loadError) { localStorage.removeItem('findmy_device_id'); myId = null; }
}
sb.auth.onAuthStateChange((_e, session) => {
  // never await supabase calls directly inside this callback
  setTimeout(() => (session ? showApp(session.user) : showLogin()), 0);
});

async function authCall(kind) {
  $('msg').textContent = '';
  if (!$('loginForm').reportValidity()) return;
  const email = $('email').value.trim(), password = $('password').value;
  const { error } = kind === 'in'
    ? await sb.auth.signInWithPassword({ email, password })
    : await sb.auth.signUp({ email, password });
  if (error) $('msg').textContent = error.message;
  else if (kind === 'up') $('msg').textContent = '若專案開啟 Email 驗證，請先到信箱點確認連結。';
}
$('btnSignIn').onclick = () => authCall('in');
$('btnSignUp').onclick = () => authCall('up');
$('loginForm').onsubmit = (e) => { e.preventDefault(); authCall('in'); };

// ---------- map ----------
// Vector map (MapLibre + OpenFreeMap, no API key). Dark mode re-colours the light style with CSS.
function initMap() {
  if (map) { setTimeout(() => map.resize(), 50); return; }
  map = new maplibregl.Map({
    container: 'map', style: 'https://tiles.openfreemap.org/styles/positron',
    center: [121.56, 25.04], zoom: 11, attributionControl: false, dragRotate: false, pitchWithRotate: false,
  });
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'top-left');
  map.touchZoomRotate.disableRotation();
  map.on('click', () => { if (selectedId) back(); });
}
$('btnLocate').onclick = () => {
  navigator.geolocation.getCurrentPosition((p) => {
    const ll = [p.coords.longitude, p.coords.latitude];
    if (!hereMarker) hereMarker = new maplibregl.Marker({ element: el('div', { className: 'here' }), anchor: 'center' }).setLngLat(ll).addTo(map);
    else hereMarker.setLngLat(ll);
    map.flyTo({ center: ll, zoom: 16 });
  }, (e) => ask({ title: '無法取得位置', msg: e.message, ok: '好' }), { enableHighAccuracy: true, timeout: 15000 });
};

function pinClass(d) {
  return ['pin', d.id === selectedId ? 'sel' : '', d.lost_mode ? 'lost' : '', d.id === myId ? 'me' : ''].join(' ').trim();
}
function makePin(d) {
  const wrap = el('div', { className: pinClass(d) }, el('div', { className: 'dot', textContent: icon(d) }), el('div', { className: 'lbl', textContent: d.name }));
  wrap.addEventListener('click', (e) => { e.stopPropagation(); select(d.id); });
  return wrap;
}
function syncMarkers() {
  const withPos = devices.filter((d) => d.lat != null);
  const ids = new Set(withPos.map((d) => d.id));
  Object.keys(markers).forEach((id) => { if (!ids.has(id)) { markers[id].remove(); delete markers[id]; } });
  withPos.forEach((d) => {
    const ll = [d.lng, d.lat];
    if (!markers[d.id]) {
      markers[d.id] = new maplibregl.Marker({ element: makePin(d), anchor: 'center' }).setLngLat(ll).addTo(map);
    } else {
      const mk = markers[d.id], node = mk.getElement();
      mk.setLngLat(ll);
      node.classList.remove('sel', 'lost', 'me');
      pinClass(d).split(' ').slice(1).forEach((c) => node.classList.add(c));
      node.querySelector('.dot').textContent = icon(d);
      node.querySelector('.lbl').textContent = d.name;
    }
  });
  if (!fitted && withPos.length) {
    const bb = new maplibregl.LngLatBounds();
    withPos.forEach((d) => bb.extend([d.lng, d.lat]));
    map.fitBounds(bb, { maxZoom: 16, padding: 80, duration: 0 });
    fitted = true;
  }
}

// ---------- bottom sheet ----------
const sheet = $('sheet');
let sheetH = 140;
const detents = () => [140, Math.round(innerHeight * 0.45), Math.round(innerHeight * 0.85 - TAB_H)];
function setH(v, animate = true) {
  sheet.style.transition = animate ? 'height .32s cubic-bezier(.2,.8,.2,1)' : 'none';
  sheet.style.height = v + 'px';
  sheetH = v;
}
(() => {
  const grab = $('grab');
  let y0 = 0, h0 = 0, drag = false, moved = false;
  grab.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    drag = true; moved = false; y0 = e.clientY; h0 = sheetH; grab.setPointerCapture(e.pointerId);
  });
  grab.addEventListener('pointermove', (e) => {
    if (!drag) return;
    moved = true;
    const d = detents();
    setH(Math.max(d[0] - 20, Math.min(d[2], h0 + (y0 - e.clientY))), false);
  });
  const end = () => {
    if (!drag) return;
    drag = false;
    const d = detents();
    if (!moved) return setH(sheetH < d[1] ? d[1] : d[0]); // tap toggles
    setH(d.reduce((a, b) => (Math.abs(b - sheetH) < Math.abs(a - sheetH) ? b : a)));
  };
  grab.addEventListener('pointerup', end);
  grab.addEventListener('pointercancel', end);
})();

// ---------- tabs / render ----------
document.querySelectorAll('#tabs button').forEach((b) => {
  b.onclick = () => {
    tab = b.dataset.tab;
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
    if (tab === 'me') clearSelection();
    render();
    if (sheetH < detents()[1]) setH(detents()[1]);
  };
});

function row({ ic, title, sub, chev, cls = '', onclick }) {
  const r = el('button', { className: 'row ' + cls });
  if (ic) r.append(el('div', { className: 'ic', textContent: ic }));
  const tx = el('div', { className: 'tx' }, el('b', { textContent: title }));
  if (sub) tx.append(el('small', { textContent: sub }));
  r.append(tx);
  if (chev) r.append(el('span', { className: 'chev', textContent: '›' }));
  if (onclick) r.onclick = onclick;
  return r;
}

function render() {
  syncMarkers();
  const head = $('head'), body = $('body');
  head.replaceChildren(); body.replaceChildren();
  const d = devices.find((x) => x.id === selectedId);

  if (tab === 'me') {
    head.append(el('h1', { textContent: '我' }));
    body.append(el('div', { className: 'label', textContent: '帳號' }),
      el('div', { className: 'group' }, row({ ic: '👤', title: user.email, sub: '已登入' })));
    body.append(el('div', { className: 'label', textContent: '此裝置' }));
    const g = el('div', { className: 'group' });
    const mine = me();
    g.append(mine
      ? row({ ic: icon(mine), title: mine.name, sub: '正在回報位置' })
      : row({ ic: '＋', title: '註冊此裝置', sub: '讓你能在其他裝置上找到它', cls: 'link', onclick: registerThisDevice }));
    body.append(g, el('div', { className: 'label' }));
    body.append(el('div', { className: 'group' }, row({ title: '登出', cls: 'danger', onclick: () => sb.auth.signOut() })));
    return;
  }

  if (d) { renderDetail(d, head, body); return; }

  head.append(el('h1', { textContent: '裝置' }));
  if (!myId || !me()) head.append(el('button', { className: 'plus', textContent: '+', onclick: registerThisDevice, 'aria-label': '註冊此裝置' }));
  if (loadError) {
    body.append(el('div', { className: 'notice' }, el('b', { textContent: '無法載入裝置：' }), ' ' + loadError,
      el('br'), '請先在 Supabase 的 SQL Editor 執行 schema.sql 建立資料表。'));
    return;
  }
  body.append(el('div', { className: 'label', textContent: '我的裝置' }));
  if (!devices.length) {
    body.append(el('div', { className: 'notice', textContent: '還沒有裝置。在要追蹤的手機或電腦上登入，按右上角「+」註冊。' }));
    return;
  }
  const g = el('div', { className: 'group' });
  devices.forEach((x) => g.append(row({
    ic: icon(x), chev: true, onclick: () => select(x.id),
    title: x.name + (x.id === myId ? '（此裝置）' : ''),
    sub: (x.lost_mode ? '🚨 遺失模式 · ' : '') + ago(x.last_seen) + batt(x),
  })));
  body.append(g);
}

function renderDetail(d, head, body) {
  head.append(el('button', { className: 'back', onclick: back }, el('span', { textContent: '‹ 裝置' })));
  const title = el('div', { className: 'big', textContent: d.name });
  if (d.id === myId) title.append(el('span', { className: 'pill me', textContent: '此裝置' }));
  if (d.lost_mode) title.append(el('span', { className: 'pill', textContent: '遺失' }));
  body.append(title,
    el('div', { className: 'stat', innerHTML: '' }, ...(d.lat != null
      ? [el('b', { textContent: ago(d.last_seen) }), ` · 精度 ±${Math.round(d.accuracy || 0)} 公尺${batt(d)}`]
      : ['尚無位置資料'])));

  const tile = (ic, label, fn, off) => el('button', { className: 'tile' + (off ? ' off' : ''), onclick: fn }, el('span', { textContent: ic }), el('span', { textContent: label }));
  body.append(el('div', { className: 'tiles' },
    tile('🔔', '播放聲音', () => update(d.id, { ring_requested_at: new Date().toISOString() })),
    tile('🧭', '路線', () => window.open(`https://www.google.com/maps/dir/?api=1&destination=${d.lat},${d.lng}`, '_blank', 'noopener'), d.lat == null),
    tile('🕘', '24 小時軌跡', () => showTrail(d.id), d.lat == null)));

  const g = el('div', { className: 'group' });
  g.append(d.lost_mode
    ? row({ ic: '✅', title: '關閉遺失模式', sub: d.lost_message || '', cls: 'link', onclick: () => update(d.id, { lost_mode: false, lost_message: null }) })
    : row({ ic: '🚨', title: '標示為遺失', sub: '在裝置上顯示你的聯絡訊息', chev: true, onclick: async () => {
        const m = await ask({ title: '遺失模式', msg: '輸入要顯示在此裝置上的訊息（例如聯絡電話）', input: true, def: '請聯絡我：', ok: '啟用' });
        if (m !== null) update(d.id, { lost_mode: true, lost_message: m.slice(0, 200) });
      } }));
  body.append(el('div', { className: 'label' }), g, el('div', { className: 'label' }),
    el('div', { className: 'group' }, row({ title: '移除此裝置', cls: 'danger', onclick: async () => {
      if (await ask({ title: `移除「${d.name}」？`, msg: '位置紀錄也會一併刪除。', ok: '移除', danger: true })) {
        const { error } = await sb.from('devices').delete().eq('id', d.id);
        if (error) return ask({ title: '失敗', msg: error.message });
        back();
      }
    } })));
}

function select(id) {
  selectedId = id;
  tab = 'devices';
  const d = devices.find((x) => x.id === id);
  if (d && d.lat != null) map.flyTo({ center: [d.lng, d.lat], zoom: Math.max(map.getZoom(), 15) });
  render();
  setH(detents()[1]);
}
function clearSelection() {
  selectedId = null;
  clearTrail();
}
function clearTrail() {
  if (!hasTrail) return;
  if (map.getLayer('trail')) map.removeLayer('trail');
  if (map.getSource('trail')) map.removeSource('trail');
  hasTrail = false;
}
function back() { clearSelection(); render(); setH(detents()[0]); }

async function showTrail(id) {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data, error } = await sb.from('device_locations').select('lat,lng').eq('device_id', id).gte('created_at', since).order('created_at');
  if (error) return ask({ title: '失敗', msg: error.message });
  clearTrail();
  if (data.length < 2) return ask({ title: '沒有軌跡', msg: '過去 24 小時的位置紀錄不足。' });
  const coords = data.map((r) => [r.lng, r.lat]);
  map.addSource('trail', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } } });
  map.addLayer({ id: 'trail', type: 'line', source: 'trail', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#007aff', 'line-width': 5, 'line-opacity': 0.85 } });
  hasTrail = true;
  const bb = new maplibregl.LngLatBounds();
  coords.forEach((c) => bb.extend(c));
  map.fitBounds(bb, { padding: 80, maxZoom: 17 });
  setH(detents()[0]);
}

// ---------- data ----------
async function loadDevices() {
  const { data, error } = await sb.from('devices').select('*').order('created_at');
  loadError = error ? error.message : null;
  if (!error) devices = data;
  render();
}
function subscribe() {
  if (channel) sb.removeChannel(channel);
  channel = sb.channel('devices-' + user.id)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'devices' }, (p) => {
      if (p.eventType === 'DELETE') {
        devices = devices.filter((d) => d.id !== p.old.id);
        if (p.old.id === myId) { stopTracking(); localStorage.removeItem('findmy_device_id'); myId = null; }
        if (p.old.id === selectedId) clearSelection();
      } else {
        const i = devices.findIndex((d) => d.id === p.new.id);
        if (i >= 0) devices[i] = p.new; else devices.push(p.new);
        if (p.new.id === myId) checkRemote(p.new);
      }
      render();
    })
    .subscribe();
}
async function update(id, patch) {
  const { error } = await sb.from('devices').update(patch).eq('id', id);
  if (error) ask({ title: '失敗', msg: error.message });
}

// ---------- this device: register + track ----------
async function registerThisDevice() {
  unlockAudio();
  if (myId && me()) return;
  if (!navigator.geolocation) return ask({ title: '不支援定位', msg: '此瀏覽器不支援定位。' });
  const name = await ask({
    title: '註冊此裝置', msg: '為這個裝置取個名字', input: true, ok: '註冊',
    def: /iPhone|Android|Mobile/i.test(navigator.userAgent) ? '我的手機' : '我的電腦',
  });
  if (!name) return;
  const { data, error } = await sb.from('devices').insert({ name: name.slice(0, 60) }).select().single();
  if (error) return ask({ title: '失敗', msg: error.message });
  myId = data.id;
  localStorage.setItem('findmy_device_id', myId);
  if (!devices.some((d) => d.id === data.id)) devices.push(data);
  startTracking();
  render();
}

function startTracking() {
  if (watchId != null || !navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition(onPosition, (e) => console.warn('geo', e.message), {
    enableHighAccuracy: true, maximumAge: 15000, timeout: 30000,
  });
}
function stopTracking() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}
async function onPosition(pos) {
  if (!myId || Date.now() - lastPush < PUSH_INTERVAL) return;
  lastPush = Date.now();
  const { latitude: lat, longitude: lng, accuracy } = pos.coords;
  let battery = null;
  try { battery = (await navigator.getBattery()).level; } catch {}
  await update(myId, { lat, lng, accuracy, battery, last_seen: new Date().toISOString() });
  await sb.from('device_locations').insert({ device_id: myId, lat, lng, accuracy });
}

// ---------- this device: react to remote commands ----------
function checkRemote(d) {
  if (d.ring_requested_at && d.ring_requested_at !== lastRing && Date.now() - Date.parse(d.ring_requested_at) < 60000) {
    lastRing = d.ring_requested_at;
    localStorage.setItem('findmy_last_ring', lastRing);
    ring();
  }
  $('lostBanner').classList.toggle('hidden', !d.lost_mode);
  $('lostText').textContent = d.lost_message || '';
}

function unlockAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}
document.addEventListener('pointerdown', unlockAudio, { once: true });

function beep() {
  if (!audioCtx) return;
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = 'square'; o.frequency.value = 1000;
  g.gain.value = 0.4;
  o.connect(g).connect(audioCtx.destination);
  o.start(); o.stop(audioCtx.currentTime + 0.25);
  navigator.vibrate && navigator.vibrate(250);
}
function ring() {
  stopRing();
  $('ringBar').classList.remove('hidden');
  let n = 0;
  beep();
  ringTimer = setInterval(() => { beep(); if (++n > 40) stopRing(); }, 500);
}
function stopRing() {
  clearInterval(ringTimer); ringTimer = null;
  $('ringBar').classList.add('hidden');
}
$('btnStopRing').onclick = stopRing;

// ---------- boot ----------
sb.auth.getSession().then(({ data }) => { if (!data.session) showLogin(); });
