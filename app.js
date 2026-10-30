const sb = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);
const PUSH_INTERVAL = 30000;

let user = null, devices = [], selectedId = null, channel = null;
let myId = localStorage.getItem('findmy_device_id');
let map, markers = {}, circles = {}, fitted = false;
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
  if (!map) {
    map = L.map('map', { zoomControl: false }).setView([25.04, 121.56], 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap',
    }).addTo(map);
  }
  setTimeout(() => map.invalidateSize(), 50);
  await loadDevices();
  subscribe();
  if (myId && me()) { startTracking(); checkRemote(me()); }
  else if (myId) { localStorage.removeItem('findmy_device_id'); myId = null; }
}
sb.auth.onAuthStateChange((_e, session) => {
  // never await supabase calls directly inside this callback
  setTimeout(() => (session ? showApp(session.user) : showLogin()), 0);
});

async function authCall(kind) {
  $('msg').textContent = '';
  const email = $('email').value.trim(), password = $('password').value;
  const { error } = kind === 'in'
    ? await sb.auth.signInWithPassword({ email, password })
    : await sb.auth.signUp({ email, password });
  if (error) $('msg').textContent = error.message;
  else if (kind === 'up') $('msg').textContent = '若專案開啟 Email 驗證，請先到信箱點確認連結。';
}
$('btnSignIn').onclick = () => authCall('in');
$('btnSignUp').onclick = () => authCall('up');
$('btnOut').onclick = () => sb.auth.signOut();

// ---------- data ----------
async function loadDevices() {
  const { data, error } = await sb.from('devices').select('*').order('created_at');
  if (error) { alert(error.message); return; }
  devices = data;
  render();
}
function subscribe() {
  if (channel) sb.removeChannel(channel);
  channel = sb.channel('devices-' + user.id)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'devices' }, (p) => {
      if (p.eventType === 'DELETE') {
        devices = devices.filter((d) => d.id !== p.old.id);
        if (p.old.id === myId) { stopTracking(); localStorage.removeItem('findmy_device_id'); myId = null; }
      } else {
        const i = devices.findIndex((d) => d.id === p.new.id);
        if (i >= 0) devices[i] = p.new; else devices.push(p.new);
        if (p.new.id === myId) checkRemote(p.new);
      }
      render();
    })
    .subscribe();
}

// ---------- render ----------
function render() {
  const list = $('list');
  list.replaceChildren();
  devices.forEach((d) => {
    const name = el('span', {}, d.name);
    if (d.id === myId) name.append(el('span', { className: 'tag', textContent: '此裝置' }));
    if (d.lost_mode) name.append(el('span', { className: 'tag lost', textContent: '遺失模式' }));
    const sub = el('small', { textContent: ago(d.last_seen) + (d.battery != null ? ' · 🔋' + Math.round(d.battery * 100) + '%' : '') });
    const b = el('button', { className: 'dev' + (d.id === selectedId ? ' sel' : '') }, el('div', {}, name, sub), el('span', { textContent: '›' }));
    b.onclick = () => select(d.id);
    list.append(b);
  });
  if (!devices.length) list.append(el('p', { textContent: '還沒有裝置。在要追蹤的手機/電腦上登入，按「註冊此裝置」。' }));

  // markers
  const ids = new Set(devices.filter((d) => d.lat != null).map((d) => d.id));
  Object.keys(markers).forEach((id) => {
    if (!ids.has(id)) { map.removeLayer(markers[id]); map.removeLayer(circles[id]); delete markers[id]; delete circles[id]; }
  });
  devices.forEach((d) => {
    if (d.lat == null) return;
    const ll = [d.lat, d.lng];
    if (!markers[d.id]) {
      markers[d.id] = L.marker(ll).addTo(map);
      circles[d.id] = L.circle(ll, { radius: d.accuracy || 0, weight: 1 }).addTo(map);
      markers[d.id].on('click', () => select(d.id));
    } else {
      markers[d.id].setLatLng(ll);
      circles[d.id].setLatLng(ll).setRadius(d.accuracy || 0);
    }
    markers[d.id].bindTooltip(d.name);
  });
  if (!fitted && ids.size) {
    map.fitBounds(L.latLngBounds([...ids].map((id) => markers[id].getLatLng())), { maxZoom: 16, padding: [40, 40] });
    fitted = true;
  }
  renderDetail();
}

function select(id) {
  selectedId = id;
  const d = devices.find((x) => x.id === id);
  if (d && d.lat != null) map.setView([d.lat, d.lng], 16);
  render();
}

function renderDetail() {
  const box = $('detail');
  box.replaceChildren();
  const d = devices.find((x) => x.id === selectedId);
  if (!d) return;
  const btn = (text, fn, cls = 'sec') => { const b = el('button', { className: cls, textContent: text }); b.onclick = fn; return b; };
  const actions = el('div', { className: 'actions' });
  actions.append(btn('🔔 播放聲音', () => update(d.id, { ring_requested_at: new Date().toISOString() })));
  if (d.lat != null) {
    actions.append(btn('🧭 導航', () => window.open(`https://www.google.com/maps/dir/?api=1&destination=${d.lat},${d.lng}`, '_blank', 'noopener')));
    actions.append(btn('🕘 軌跡', () => showTrail(d.id)));
  }
  if (d.lost_mode) actions.append(btn('✅ 關閉遺失模式', () => update(d.id, { lost_mode: false, lost_message: null })));
  else actions.append(btn('🚨 遺失模式', () => {
    const m = prompt('顯示在遺失裝置上的訊息（例如聯絡電話）：', '請聯絡我：');
    if (m !== null) update(d.id, { lost_mode: true, lost_message: m.slice(0, 200) });
  }));
  actions.append(btn('🗑 移除', async () => {
    if (!confirm(`移除「${d.name}」？位置紀錄也會刪除。`)) return;
    await sb.from('devices').delete().eq('id', d.id);
  }, 'bad'));
  box.append(actions);
}

let trailLine = null;
async function showTrail(id) {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data, error } = await sb.from('device_locations').select('lat,lng').eq('device_id', id).gte('created_at', since).order('created_at');
  if (error) return alert(error.message);
  if (trailLine) map.removeLayer(trailLine);
  if (!data.length) return alert('過去 24 小時沒有紀錄');
  trailLine = L.polyline(data.map((r) => [r.lat, r.lng]), { weight: 4 }).addTo(map);
  map.fitBounds(trailLine.getBounds(), { padding: [40, 40] });
}

async function update(id, patch) {
  const { error } = await sb.from('devices').update(patch).eq('id', id);
  if (error) alert(error.message);
}

// ---------- this device: register + track ----------
$('btnAdd').onclick = async () => {
  unlockAudio();
  if (myId && me()) return alert('此裝置已註冊：' + me().name);
  if (!navigator.geolocation) return alert('此瀏覽器不支援定位');
  const name = prompt('裝置名稱：', /iPhone|Android|Mobile/i.test(navigator.userAgent) ? '我的手機' : '我的電腦');
  if (!name) return;
  const { data, error } = await sb.from('devices').insert({ name: name.trim().slice(0, 60) }).select().single();
  if (error) return alert(error.message);
  myId = data.id;
  localStorage.setItem('findmy_device_id', myId);
  devices.push(data);
  startTracking();
  render();
};

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
if ('serviceWorker' in navigator) { /* add a service worker later for installable PWA */ }
