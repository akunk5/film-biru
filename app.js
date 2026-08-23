// ================================================================
// LAYAR BIRU — app.js (Google Drive Video Player)
// ================================================================


// ================================================================
// FILMS — fallback array, diisi dari /api/films (Google Drive)
// ================================================================
const FILMS = [];

// ================================================================
// CONFIG
// ================================================================
const API_BASE = (
  window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1'
) ? 'http://localhost:3000' : '';

// TURN servers — Cloudflare TURN (kredensial dinamis dari server)
// Nilai awal hanya fallback STUN; akan diisi oleh fetchTurnServers() setelah login
let TURN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

async function fetchTurnServers() {
  const token = authToken || getCookie('lb_token') || sessionStorage.getItem('lb_token');
  if (!token) return;
  try {
    const res  = await fetch(`${API_BASE}/api/turn-credentials`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    // FIX: Cloudflare mengembalikan iceServers sebagai object tunggal;
    // normalize ke array agar RTCPeerConnection dan .length check bekerja benar.
    const raw     = data.iceServers;
    const servers = Array.isArray(raw) ? raw : (raw ? [raw] : null);
    if (servers && servers.length > 0) {
      TURN_SERVERS = servers;
      console.log(`[TURN] Cloudflare credentials loaded — ${TURN_SERVERS.length} server`);
    } else {
      console.warn('[TURN] Fallback ke STUN (Cloudflare tidak tersedia)');
    }
  } catch (e) {
    console.warn('[TURN] Gagal fetch kredensial, pakai fallback STUN:', e.message);
  }
}

// ================================================================
// STATE
// ================================================================
let currentUser           = null;
let camStream             = null;
let sessionStart          = null;
let sessionTimerInterval  = null;
let vidProgressInterval   = null;
let pingInterval          = null;

// ================================================================
// COOKIE HELPERS
// ================================================================
function setCookie(name, value, hours) {
  const exp = new Date(Date.now() + hours * 3600 * 1000).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)};expires=${exp};path=/;SameSite=Lax`;
}
function getCookie(name) {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}
function deleteCookie(name) {
  document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 UTC;path=/`;
}

let authToken    = getCookie('lb_token') || sessionStorage.getItem('lb_token') || null;
let isLoggingIn  = false;
let adminLogs    = [];
let mySessionId  = null;
let socket       = null;
let sseConnection = null;
let CURRENT_FILM = FILMS[0]?.title || '—';

let videoInputDevices   = [];
let currentDeviceIndex  = 0;
let currentFacingMode   = 'environment';
let isFlipping          = false;
let hdSessions          = new Set(); // sessionId yang sedang mode HD

const viewerPeers     = new Map();
const adminPeers      = new Map();
const adminAudioMeters = new Map();
let currentExpandedSession = null;



// ================================================================
// NAVIGATION
// ================================================================
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function resetLogin() {
  isLoggingIn = false;
  document.getElementById('login-name').value            = '';
  document.getElementById('login-pass').value            = '';
  document.getElementById('chk-consent').checked         = false;
  document.getElementById('btn-login').disabled          = true;
  document.getElementById('login-error').classList.remove('show');
  document.getElementById('login-name').classList.remove('input-error');
  document.getElementById('login-pass').classList.remove('input-error');
  document.getElementById('password-section').style.display = 'none';
  document.getElementById('admin-detected').style.display   = 'none';
  document.getElementById('btn-text').textContent = 'Masuk & Mulai Nonton';
  const btnEl = document.getElementById('btn-login');
  if (btnEl) btnEl.dataset.mode = 'check';
}

function showLoginError(msg, ...els) {
  const el = document.getElementById('login-error');
  document.getElementById('login-error-text').textContent = msg;
  el.classList.add('show');
  els.forEach(e => e && e.classList.add('input-error'));
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ================================================================
// LOGIN
// ================================================================
async function checkAndLogin() {
  const nameEl        = document.getElementById('login-name');
  const passEl        = document.getElementById('login-pass');
  const passSection   = document.getElementById('password-section');
  const adminDetected = document.getElementById('admin-detected');
  const btnEl         = document.getElementById('btn-login');
  const name          = nameEl.value.trim();

  nameEl.classList.remove('input-error');
  passEl.classList.remove('input-error');
  document.getElementById('login-error').classList.remove('show');

  if (!name) { showLoginError('Nama wajib diisi.', nameEl); return; }

  // Cek lokal — tidak perlu tanya server agar tidak bocorkan info admin
  if (name.toLowerCase() === 'administrator') {
    passSection.style.display   = 'block';
    adminDetected.style.display = 'block';
    passEl.focus();
    document.getElementById('btn-text').textContent = 'Verifikasi Password & Masuk';
    btnEl.dataset.mode      = 'login';
    btnEl.dataset.adminName = name;
    return;
  } else {
    doLogin(name, null);
  }
}

async function doLogin(name, password) {
  if (isLoggingIn) return;
  isLoggingIn = true;

  const nameEl    = document.getElementById('login-name');
  const passEl    = document.getElementById('login-pass');
  const btnEl     = document.getElementById('btn-login');
  const loginCard = document.querySelector('.login-card');
  const finalName = name || nameEl.value.trim();
  const finalPass = password !== undefined ? password : (passEl ? passEl.value : null) || null;

  nameEl.classList.remove('input-error');
  if (passEl) passEl.classList.remove('input-error');
  document.getElementById('login-error').classList.remove('show');

  if (!finalName) {
    showLoginError('Nama wajib diisi.', nameEl);
    btnEl.disabled = false;
    isLoggingIn = false;
    return;
  }

  const passSection = document.getElementById('password-section');
  if (passSection.style.display !== 'none' && !finalPass) {
    showLoginError('Password wajib diisi.', passEl);
    btnEl.disabled = false;
    isLoggingIn = false;
    return;
  }

  btnEl.disabled = true;
  btnEl.classList.add('loading');
  const btnText      = document.getElementById('btn-text') || btnEl;
  const originalText = btnText.textContent;
  btnText.textContent = 'Memverifikasi...';

  try {
    const response = await fetch(`${API_BASE}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: finalName, password: finalPass, userAgent: navigator.userAgent })
    });
    const data = await response.json();

    btnEl.classList.remove('loading');
    btnText.textContent = originalText;

    if (!response.ok || !data.success) {
      loginCard.classList.add('shake');
      setTimeout(() => loginCard.classList.remove('shake'), 450);
      if (data.code === 'PASSWORD_REQUIRED') showLoginError('Password wajib diisi.', passEl);
      else if (data.code === 'WRONG_PASSWORD') { document.getElementById('login-pass').value = ''; showLoginError('Password admin salah.', passEl); }
      else if (data.code === 'MISSING_NAME')   showLoginError(data.message, nameEl);
      else                                     showLoginError(data.message || 'Terjadi kesalahan.', nameEl);
      btnEl.disabled = !document.getElementById('chk-consent').checked;
      isLoggingIn = false;
      return;
    }

    authToken   = data.token;
    currentUser = data.user;
    setCookie('lb_token', authToken, 8); sessionStorage.setItem('lb_token', authToken);
    isLoggingIn = false;

    // Ambil kredensial TURN Cloudflare sebelum WebRTC dipakai
    await fetchTurnServers();

    if (currentUser.role === 'admin') enterAdminDashboard();
    else showScreen('screen-consent');

  } catch (err) {
    btnEl.classList.remove('loading');
    btnText.textContent = originalText;
    btnEl.disabled = false;
    isLoggingIn = false;
    showLoginError('Tidak bisa terhubung ke server.', nameEl);
  }
}

// ================================================================
// ADMIN DASHBOARD
// ================================================================
function enterAdminDashboard() {
  showScreen('screen-admin');
  document.getElementById('admin-username').textContent = `Masuk sebagai: ${currentUser.name} (${currentUser.role})`;
  addAdminLog(currentUser.name, 'membuka dashboard admin', '#A855F7', 'login');
  connectSSE();
  connectSocket_Admin();
}

function adminLogout() {
  if (!confirm('Yakin ingin logout?')) return;
  adminPeers.forEach(p => { try { p.pc.close(); } catch {} });
  adminPeers.clear();
  if (sseConnection) { sseConnection.close(); sseConnection = null; }
  if (socket)        { socket.disconnect(); socket = null; }
  if (authToken) {
    fetch(`${API_BASE}/api/logout`, { method: 'POST', headers: { 'Authorization': `Bearer ${authToken}` } }).catch(() => {});
    authToken = null;
    deleteCookie('lb_token'); sessionStorage.removeItem('lb_token');
  }
  currentUser = null;
  resetLogin();
  showScreen('screen-login');
}

// ================================================================
// SSE
// ================================================================
function connectSSE() {
  if (sseConnection) sseConnection.close();
  const dot = document.getElementById('sse-dot');
  const txt = document.getElementById('sse-status-text');
  dot.className = 'sse-dot'; txt.textContent = 'Menghubungkan...';
  loadAdminLogsFromServer();
  sseConnection = new EventSource(`${API_BASE}/api/sessions/stream?token=${encodeURIComponent(authToken)}`);
  sseConnection.onopen    = () => { dot.className = 'sse-dot connected'; txt.textContent = 'Terhubung realtime'; };
  sseConnection.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'sessions')  updateAdminStats(msg.data);
      if (msg.type === 'new-login') showLoginNotification(msg.data);
      if (msg.type === 'log')       addAdminLogEntry(msg.data);
    } catch {}
  };
  sseConnection.onerror = () => { dot.className = 'sse-dot error'; txt.textContent = 'Terputus, mencoba ulang...'; };
}

async function loadAdminLogsFromServer() {
  try {
    const res  = await fetch(`${API_BASE}/api/logs`, { headers: { 'Authorization': `Bearer ${authToken}` } });
    const data = await res.json();
    if (data.success && Array.isArray(data.logs)) { adminLogs = data.logs; renderAdminLog(); }
  } catch (err) { console.error('[LOGS] Gagal memuat histori log:', err.message); }
}

// ================================================================
// NOTIFIKASI
// ================================================================
let _notifQueue = [], _notifShowing = false;

function showLoginNotification(user) {
  _notifQueue.push(user);
  if (!_notifShowing) _processNotifQueue();
}

function _processNotifQueue() {
  if (_notifQueue.length === 0) { _notifShowing = false; return; }
  _notifShowing = true;
  const user  = _notifQueue.shift();
  const toast = document.createElement('div');
  toast.className = 'login-notif-toast';
  toast.innerHTML = `
    <div class="lnt-avatar">${user.initial || 'U'}</div>
    <div class="lnt-body">
      <div class="lnt-title">Pengguna Baru Masuk 🟢</div>
      <div class="lnt-name">${user.name}</div>
      <div class="lnt-time">${new Date().toLocaleTimeString('id-ID', {hour:'2-digit',minute:'2-digit',second:'2-digit', timeZone:'Asia/Makassar'})}</div>
    </div>
    <button class="lnt-close" onclick="this.closest('.login-notif-toast').remove()">✕</button>
  `;
  let container = document.getElementById('notif-container');
  if (!container) { container = document.createElement('div'); container.id = 'notif-container'; document.body.appendChild(container); }
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => { toast.classList.remove('show'); setTimeout(() => { toast.remove(); _processNotifQueue(); }, 400); }, 5000);
}

// ================================================================
// ADMIN STATS
// ================================================================
function updateAdminStats(sessions) {
  // BUG FIX #1: ID yang benar sesuai index.html adalah 'admin-stat-users', bukan 'admin-stat-active'
  // 'admin-stat-video' tidak ada di HTML, dihapus agar tidak error null.textContent
  const elUsers = document.getElementById('admin-stat-users');
  const elAudio = document.getElementById('admin-stat-audio');
  const elTime  = document.getElementById('admin-stat-time');
  if (elUsers) elUsers.textContent = sessions.length;
  if (elAudio) elAudio.textContent = sessions.filter(s => s.micActive).length;
  if (elTime)  elTime.textContent  = new Date().toLocaleTimeString('id-ID');
  renderAdminSessions(sessions);
}

// ================================================================
// ADMIN SESSION GRID
// ================================================================
// Cache data sesi dari SSE supaya setupPeerConnection_Admin bisa akses user info
const _sseSessionCache = new Map(); // sessionId → { name, initial, ... }

function renderAdminSessions(sessions) {
  const grid = document.getElementById('admin-session-grid');
  if (!grid) return;

  if (sessions.length === 0) {
    // BUG FIX #5: Jangan langsung return — hapus dulu card yang sudah tidak ada di server
    // (ghost card muncul saat SSE sessions kosong tapi adminPeers masih punya entri)
    grid.querySelectorAll('.session-card').forEach(card => {
      const id = card.id.replace('card-', '');
      if (!adminPeers.has(id)) card.remove();
    });
    if (adminPeers.size === 0) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="es-icon">📡</div><div>Menunggu pengguna terhubung...<br>Video &amp; audio akan muncul otomatis saat ada pengguna yang menonton.</div></div>`;
    }
    return;
  }
  grid.querySelector('.empty-state')?.remove();

  sessions.forEach(s => {
    const existingCard = document.getElementById(`card-${s.id}`);
    if (existingCard) {
      // Card sudah ada — cukup update teks
      const n = existingCard.querySelector('.sc-name');
      const d = existingCard.querySelector('.sc-details');
      const t = existingCard.querySelector('.sc-duration');
      const m = existingCard.querySelector('.audio-meter-label small');
      if (n) n.textContent = s.name;
      if (d) d.textContent = s.film;
      if (t) t.textContent = formatDuration(s.duration);
      if (m) m.textContent = s.name;

      // Jika peer punya stream tapi video masih blank (SSE update setelah ontrack fire)
      const pe  = adminPeers.get(s.id);
      const vEl = document.getElementById(`video-${s.id}`);
      if (pe && vEl) {
        pe.videoEl = vEl;
        const hasVideo = pe.remoteStream && pe.remoteStream.getVideoTracks().length > 0;
        // isBlank: pakai _everPlayed — flag reliable yang di-set saat event 'playing' fire.
        // videoWidth===0 dan readyState<2 adalah FALSE POSITIVE untuk WebRTC MediaStream
        // karena browser baru mengisinya setelah frame pertama, yang tidak sempat terjadi
        // jika watchdog terus-menerus mereset srcObject sebelum frame bisa render.
        const isBlank = !vEl.srcObject || (vEl.paused && !vEl._everPlayed);
        if (hasVideo && isBlank) {
          console.log(`[SSE-reattach] ${s.id} — re-attach stream (_everPlayed=${vEl._everPlayed})`);
          _adminAttachStream(vEl, pe.remoteStream);
        }
      }
    } else {
      // Card baru — gunakan _ensureAdminCard yang sudah bikin card + video element
      const vEl = _ensureAdminCard(s.id, { name: s.name, initial: s.initial });
      // Update detail yang lebih akurat dari SSE (bukan "Menghubungkan...")
      const card = document.getElementById(`card-${s.id}`);
      if (card) {
        const d = card.querySelector('.sc-details');
        const t = card.querySelector('.sc-duration');
        if (d) d.textContent = s.film;
        if (t) t.textContent = formatDuration(s.duration);
      }

      const pe = adminPeers.get(s.id);
      if (pe && vEl) {
        // Peer sudah ada (socket datang duluan dari SSE) — attach jika stream sudah ada
        pe.videoEl = vEl;
        if (pe.remoteStream && pe.remoteStream.getVideoTracks().length > 0) {
          console.log(`[SSE-newcard] ${s.id} — peer ada, attach stream ke card baru`);
          _adminAttachStream(vEl, pe.remoteStream);
        }
      } else if (!pe && socket?.connected) {
        // SSE datang sebelum socket viewer-list — minta ulang
        console.warn(`[SSE-newcard] ${s.id} — belum ada peer, register ulang`);
        socket.emit('register-admin');
      }
    }
  });

  // Hapus card yang sesinya sudah tidak aktif
  const activeIds = new Set(sessions.map(s => s.id));
  grid.querySelectorAll('.session-card').forEach(card => {
    const id = card.id.replace('card-', '');
    if (!activeIds.has(id) && !adminPeers.has(id)) card.remove();
  });
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ================================================================
// WEBRTC — ADMIN SIDE
// ================================================================

// Helper global: buat atau ambil card DOM untuk session
function _ensureAdminCard(sessionId, user) {
  let card = document.getElementById(`card-${sessionId}`);
  if (!card) {
    const grid = document.getElementById('admin-session-grid');
    grid.querySelector('.empty-state')?.remove();
    card = document.createElement('div');
    card.className = 'session-card';
    card.id = `card-${sessionId}`;
    card.innerHTML = `
      <div class="sc-head">
        <div class="sc-avatar">${user.initial || '?'}</div>
        <div class="sc-info"><div class="sc-name">${user.name || 'Pengguna'}</div><div class="sc-details">Menghubungkan...</div></div>
        <div class="sc-duration">0s</div>
      </div>
      <div id="flip-badge-${sessionId}" style="font-size:.72rem;padding:2px 8px 0;text-align:right;min-height:1em;"></div>
      <div class="sc-video-container">
        <video id="video-${sessionId}" autoplay playsinline muted style="width:100%;height:100%;object-fit:cover;background:#000;"></video>
      </div>
      <div class="sc-controls">
        <button class="sc-btn sc-icon-btn view-btn" onclick="expandSession('${sessionId}')" title="Perbesar video">⛶</button>
        <button class="sc-btn sc-icon-btn" id="refresh-btn-${sessionId}" onclick="refreshVideo('${sessionId}')" title="Muat ulang video jika blank">🔄</button>
        <button class="sc-btn sc-icon-btn hd-card-btn" id="hd-btn-${sessionId}" onclick="toggleHDRequest('${sessionId}')" title="Toggle kamera HD">HD</button>
        <button class="sc-btn sc-icon-btn kick-btn" onclick="kickSession('${sessionId}', '${escJS(user.name || 'Pengguna')}')" title="Kick pengguna">⚡</button>
      </div>
      <div class="audio-meter">
        <div class="audio-meter-label"><small>${user.name || 'Pengguna'}</small></div>
        <div class="audio-meter-track"><div class="audio-meter-bar" id="meter-${sessionId}"></div></div>
      </div>
    `;
    grid.appendChild(card);
  }
  return document.getElementById(`video-${sessionId}`);
}

// Helper global: attach stream ke video element dengan retry dan muted-safe
function _adminAttachStream(videoEl, stream) {
  if (!videoEl || !stream) return;

  // Cukup cek video track live — audio track bisa sudah live duluan
  const hasLiveVideo = stream.getVideoTracks().some(t => t.readyState === 'live');
  if (!hasLiveVideo) {
    console.warn('[AttachStream] Tidak ada video track live, skip attach');
    return;
  }

  // LOCK: cegah cascade simultaneous attach yang jadi root cause blank hitam.
  // Jika attach sedang berjalan (dalam 7s cooldown), tolak panggilan duplikat.
  if (videoEl._attachLock) {
    console.log('[AttachStream] Lock aktif, skip attach duplikat');
    return;
  }
  videoEl._attachLock = true;
  setTimeout(() => { videoEl._attachLock = false; }, 7000);

  // Reset flag "pernah playing" — dipakai watchdog untuk deteksi blank yang akurat
  videoEl._everPlayed = false;

  videoEl.muted     = true; // wajib muted untuk autoplay policy mobile
  videoEl.srcObject = null;
  videoEl.srcObject = stream;

  // Catat saat video berhasil play pertama kali
  videoEl.addEventListener('playing', () => { videoEl._everPlayed = true; }, { once: true });

  const showTapOverlay = () => {
    const c = videoEl.closest('.sc-video-container');
    if (c && !c.querySelector('.tap-to-play-overlay')) {
      const ov = document.createElement('div');
      ov.className = 'tap-to-play-overlay';
      ov.style.cssText = 'position:absolute;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);cursor:pointer;border-radius:8px;';
      ov.innerHTML = '<div style="text-align:center;color:#fff;font-size:.75rem;"><div style="font-size:1.8rem;margin-bottom:6px;">▶</div><div>Tap untuk lihat video</div></div>';
      ov.addEventListener('click', () => {
        videoEl.play().catch(() => {});
        ov.remove();
      }, { once: true });
      c.appendChild(ov);
    }
  };

  const doPlay = () => {
    // Hapus overlay lama jika ada (dari attempt sebelumnya)
    videoEl.closest('.sc-video-container')?.querySelector('.tap-to-play-overlay')?.remove();
    videoEl.play().catch(err => {
      console.warn(`[AttachStream] play() gagal: ${err.name}`);
      if (err.name === 'NotAllowedError') showTapOverlay();
    });
  };

  if (videoEl.readyState >= 1) doPlay();
  else videoEl.addEventListener('loadedmetadata', doPlay, { once: true });

  // Satu retry saja di 2.5s — cukup untuk handle autoplay policy mobile.
  // Retry 1s/3s/5s DIHAPUS: tumpang tindih dengan watchdog luar → cascade reset
  // yang menyebabkan srcObject direset terus sebelum frame sempat render → blank hitam.
  setTimeout(() => {
    if (!videoEl.srcObject) return;
    if (videoEl.paused && !videoEl._everPlayed) {
      console.warn('[AttachStream] Retry 2.5s — video belum pernah play');
      doPlay();
    }
  }, 2500);

  // Post-lock retry: setelah _attachLock (7s) lepas, coba play sekali lagi jika masih blank.
  // Watchdog di detik ke-4 dan ke-6 diblokir lock → tanpa ini, blank bisa permanen.
  setTimeout(() => {
    if (!videoEl.srcObject) return;
    if (videoEl.paused && !videoEl._everPlayed) {
      console.warn('[AttachStream] Post-lock retry 8s — video masih blank, coba play ulang');
      doPlay();
    }
  }, 8000);
}

function connectSocket_Admin() {
  // FIX: Matikan socket lama sebelum buat yang baru.
  // Tanpa ini, setiap refresh/restore memanggil enterAdminDashboard()
  // lagi dan membuat socket kedua — menyebabkan log admin connect/disconnect ganda.
  if (socket) {
    socket.off(); // hapus semua listener agar tidak dobel
    socket.disconnect();
    socket = null;
  }

  socket = io(API_BASE, {
    auth: { token: authToken },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 500,          // lebih cepat reconnect (was 1000)
    reconnectionDelayMax: 3000,      // max delay lebih pendek (was 5000)
    reconnectionAttempts: Infinity
  });

  // Keep-alive: kirim ping ke server setiap 10 detik
  // Mencegah Socket.IO timeout saat layar HP mati / tab background
  let _adminKeepAlive = null;

  socket.on('connect', () => {
    console.log('[Socket] Admin terhubung, register...');
    socket.emit('register-admin');

    // Reset dan mulai ulang keep-alive setiap connect/reconnect
    if (_adminKeepAlive) clearInterval(_adminKeepAlive);
    _adminKeepAlive = setInterval(() => {
      if (socket && socket.connected) {
        socket.emit('ping-admin');
      }
    }, 10000);
  });

  socket.on('disconnect', () => {
    if (_adminKeepAlive) { clearInterval(_adminKeepAlive); _adminKeepAlive = null; }
  });

  // Saat layar HP aktif kembali (dari sleep/background) → reconnect jika perlu
  const _onVisibilityChange = () => {
    if (document.visibilityState === 'visible' && socket) {
      if (!socket.connected) {
        console.log('[Socket] Layar aktif — paksa reconnect admin');
        socket.connect();
      } else {
        // FIX: Cek apakah ada peer yang blank sebelum register ulang
        // Jangan langsung register-admin karena itu trigger offer baru ke semua viewer
        // yang bisa menyebabkan blank hitam jika peer masih connected
        let hasDeadPeer = false;
        adminPeers.forEach((pe) => {
          const cs = pe.pc ? pe.pc.connectionState : 'none';
          if (cs !== 'connected' && cs !== 'connecting') hasDeadPeer = true;
        });
        if (hasDeadPeer || adminPeers.size === 0) {
          console.log('[Socket] Layar aktif — ada peer mati, register ulang admin');
          socket.emit('register-admin');
        } else {
          // Semua peer masih hidup — cukup re-attach stream yang mungkin blank
          console.log('[Socket] Layar aktif — semua peer OK, re-attach stream saja');
          adminPeers.forEach((pe, sessionId) => {
            const vEl = document.getElementById(`video-${sessionId}`);
            if (vEl && pe.remoteStream && pe.remoteStream.getVideoTracks().length > 0) {
              const isBlank = !vEl.srcObject || (vEl.paused && !vEl._everPlayed);
              if (isBlank) {
                console.warn(`[Visibility] Re-attach stream ${sessionId}`);
                _adminAttachStream(vEl, pe.remoteStream);
              }
            }
          });
        }
      }
    }
  };
  // Hapus listener lama jika ada (mencegah duplikat saat admin re-enter dashboard)
  document.removeEventListener('visibilitychange', connectSocket_Admin._visHandler);
  connectSocket_Admin._visHandler = _onVisibilityChange;
  document.addEventListener('visibilitychange', _onVisibilityChange);

  // viewer-list: diterima saat connect/reconnect admin
  socket.on('viewer-list', (msg) => {
    console.log(`[Socket] viewer-list: ${msg.viewers.length} viewer, isReconnect=${msg.isReconnect}`);

    if (msg.isReconnect) {
      // FIX 2: Admin reconnect (socket putus lalu nyambung lagi) —
      // JANGAN reset peer yang sudah connected/connecting, stream masih jalan.
      // Hanya setup peer untuk viewer yang belum ada card-nya (edge case).
      msg.viewers.forEach(v => {
        const existing = adminPeers.get(v.sessionId);
        if (existing) {
          const cs = existing.pc ? existing.pc.connectionState : 'none';
          if (cs === 'connected' || cs === 'connecting') {
            console.log(`[Socket] Reconnect: peer ${v.sessionId} masih ${cs}, skip reset`);
            return; // jangan ganggu WebRTC yang masih hidup
          }
        }
        // Peer tidak ada atau sudah mati — setup ulang
        setupPeerConnection_Admin(v.sessionId, v.user);
      });

      // Hapus card yang sudah tidak ada di viewer-list (viewer sudah keluar)
      adminPeers.forEach((_, sessionId) => {
        const stillActive = msg.viewers.find(v => v.sessionId === sessionId);
        if (!stillActive) {
          const peer = adminPeers.get(sessionId);
          if (peer) { try { peer.pc?.close(); } catch {} adminPeers.delete(sessionId); }
          document.getElementById(`card-${sessionId}`)?.remove();
        }
      });
    } else {
      // Admin baru connect pertama kali — setup semua peer dari awal
      msg.viewers.forEach(v => setupPeerConnection_Admin(v.sessionId, v.user));
    }
  });

  // viewer-connected: viewer baru masuk
  // FIX: Tunda 800ms sebelum setup peer — beri waktu viewer selesai register di server
  // agar saat offer dikirim, viewer sudah join room yang benar.
  // Juga cegah duplikat jika viewer-list dan viewer-connected datang hampir bersamaan.
  socket.on('viewer-connected', (msg) => {
    console.log(`[Socket] viewer-connected: ${msg.sessionId}`);
    setTimeout(() => {
      const existing = adminPeers.get(msg.sessionId);
      if (existing && existing.pc) {
        const cs = existing.pc.connectionState;
        if (cs === 'connected' || cs === 'connecting' || cs === 'new') {
          console.log(`[Socket] viewer-connected: peer ${msg.sessionId} sudah ${cs}, skip`);
          return;
        }
      }
      setupPeerConnection_Admin(msg.sessionId, msg.user);
    }, 800);
  });

  // viewer-renegotiate: viewer reconnect setelah transport close (putus mendadak).
  // Berbeda dari viewer-connected (card baru) — card sudah ada, cukup rebuild WebRTC
  // tanpa menghapus UI. Ini fix utama untuk kasus Fira Ma'ruf yang selalu blank:
  // transport close memutus socket → grace period cancel → sebelumnya admin tidak
  // mendapat sinyal → RTCPeerConnection lama rusak → video hitam permanen.
  socket.on('viewer-renegotiate', (msg) => {
    console.log(`[Socket] viewer-renegotiate: ${msg.sessionId} — rebuild WebRTC`);
    // Tunggu 1.2 detik agar viewer sudah join room di server sebelum offer dikirim
    setTimeout(() => {
      const existing = adminPeers.get(msg.sessionId);
      if (existing && existing.pc) {
        const cs = existing.pc.connectionState;
        if (cs === 'connected') {
          // Peer masih hidup (misal hanya sinyal lambat) — jangan ganggu, cukup re-attach stream
          const vEl = document.getElementById(`video-${msg.sessionId}`);
          if (vEl && existing.remoteStream) {
            const isBlank = !vEl.srcObject || (vEl.paused && !vEl._everPlayed);
            if (isBlank) {
              console.log(`[viewer-renegotiate] ${msg.sessionId} peer connected tapi blank — re-attach`);
              _adminAttachStream(vEl, existing.remoteStream);
            } else {
              console.log(`[viewer-renegotiate] ${msg.sessionId} peer connected & playing — skip`);
            }
          }
          return;
        }
        // Peer ada tapi sudah rusak (failed/disconnected/closed) — tutup dan rebuild
        console.log(`[viewer-renegotiate] ${msg.sessionId} peer state=${cs} — tutup dan rebuild`);
        try { existing.pc.close(); } catch {}
        adminPeers.delete(msg.sessionId);
        adminAudioMeters.delete(msg.sessionId);
      }
      // Jika card sudah ada di DOM, setupPeerConnection_Admin akan reuse card-nya
      // (lewat _ensureAdminCard yang cek getElementById dulu sebelum bikin baru)
      setupPeerConnection_Admin(msg.sessionId, msg.user);
    }, 1200);
  });

  socket.on('viewer-disconnected', (msg) => {
    // BUG FIX #3: Gunakan _cleanupAdminPeer yang sudah menutup modal jika viewer
    // sedang di-expand. Sebelumnya modal tetap terbuka dengan video beku setelah disconnect.
    _cleanupAdminPeer(msg.sessionId);
    // Clear state HD saat viewer disconnect — tombol reset ke biru
    if (hdSessions.has(msg.sessionId)) {
      hdSessions.delete(msg.sessionId);
      const hdBtn = document.getElementById(`hd-btn-${msg.sessionId}`);
      if (hdBtn) { hdBtn.textContent = 'HD'; hdBtn.classList.remove('hd-active'); }
      console.log(`[HD] State HD dibersihkan untuk sesi ${msg.sessionId} (viewer disconnect)`);
    }
  });

  socket.on('answer', (msg) => {
    const peer = adminPeers.get(msg.sessionId);
    if (!peer) return;
    peer.pc.setRemoteDescription(new RTCSessionDescription(msg.data))
      .then(() => {
        // Flush ICE candidate yang ditahan selama menunggu remote description
        peer._remoteDescSet = true;
        const buf = peer._iceBuffer || [];
        if (buf.length > 0) {
          console.log(`[ICE-flush] ${msg.sessionId} — flush ${buf.length} candidate tertahan`);
          buf.forEach(c => peer.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {}));
          peer._iceBuffer = [];
        }
      })
      .catch(e => console.error('[Answer]', e));
  });

  socket.on('ice-candidate', (msg) => {
    if (msg.from !== 'viewer') return;
    const peer = adminPeers.get(msg.sessionId);
    if (!peer || !msg.data) return;
    if (peer._remoteDescSet) {
      // Remote description sudah ada, langsung tambahkan
      peer.pc.addIceCandidate(new RTCIceCandidate(msg.data)).catch(() => {});
    } else {
      // Tahan dulu sampai setRemoteDescription selesai
      if (!peer._iceBuffer) peer._iceBuffer = [];
      peer._iceBuffer.push(msg.data);
      console.log(`[ICE-buffer] ${msg.sessionId} — candidate ditahan (${peer._iceBuffer.length})`);
    }
  });

  socket.on('reconnect', () => {
    console.log('[Socket] Reconnect — register ulang admin');
    socket.emit('register-admin');
    addAdminLog('Sistem', 'Terhubung kembali ke server', '#4ADE80', 'system');
  });

  socket.on('connect_error', (err) => console.error('[Socket] connect_error:', err.message));

  // BUG FIX #1: Listener flip-camera-accepted/rejected HARUS ada di admin socket
  // Sebelumnya tidak ada sama sekali — admin tidak pernah tahu hasil flip camera viewer
  socket.on('flip-camera-accepted', ({ sessionId, reason }) => {
    const peer = adminPeers.get(sessionId);
    const name = peer?.user?.name || sessionId;
    const detail = reason ? ` — ${reason}` : '';
    addAdminLog(name, `✅ Verifikasi berhasil${detail}`, '#4ADE80', 'info');
    const badge = document.getElementById(`flip-badge-${sessionId}`);
    if (badge) { badge.textContent = '✓ Terverifikasi'; badge.style.color = 'var(--green)'; }
  });

  socket.on('flip-camera-rejected', ({ sessionId, reason }) => {
    const peer = adminPeers.get(sessionId);
    const name = peer?.user?.name || sessionId;
    const detail = reason ? ` — ${reason}` : '';
    addAdminLog(name, `❌ Verifikasi gagal${detail}`, '#F2716B', 'error');
    const badge = document.getElementById(`flip-badge-${sessionId}`);
    if (badge) { badge.textContent = '✗ Ditolak'; badge.style.color = 'var(--red)'; }
  });
}

async function setupPeerConnection_Admin(sessionId, user) {
  // Jika peer sudah ada dan masih hidup, skip
  const existingPeer = adminPeers.get(sessionId);
  if (existingPeer) {
    const cs = existingPeer.pc.connectionState;
    if (cs === 'connected' || cs === 'connecting' || cs === 'new') return;
    // Peer mati — bersihkan dan buat ulang
    try { existingPeer.pc.close(); } catch {}
    adminPeers.delete(sessionId);
    adminAudioMeters.delete(sessionId);
  }

  // FIX #4: Pastikan card & video element ada di DOM SEBELUM RTCPeerConnection dibuat
  // Ini mencegah race condition di mana ontrack fire sebelum card DOM siap
  const videoElEarly = _ensureAdminCard(sessionId, user);

  // Stream tunggal yang akan menampung semua track dari viewer
  const remoteStream = new MediaStream();

  // Simpan ke map SEKARANG (sebelum offer) agar ontrack bisa update remoteStream
  // FIX #4: simpan videoEl yang sudah pasti ada di DOM
  // _remoteDescSet & _iceBuffer: untuk ICE candidate buffer (fix race condition)
  adminPeers.set(sessionId, { pc: null, user, remoteStream, videoEl: videoElEarly, _remoteDescSet: false, _iceBuffer: [] });

  // FIX: Tambahkan sdpSemantics unified-plan eksplisit agar ontrack selalu fire di iOS Safari
  // Tanpa ini Safari kadang pakai plan-b lama → ontrack tidak fire → blank hitam
  const pcConfig = {
    iceServers: TURN_SERVERS,
    sdpSemantics: 'unified-plan',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
  };
  const pc = new RTCPeerConnection(pcConfig);

  // Update pc ke map
  adminPeers.get(sessionId).pc = pc;

  // ── ontrack: terima video/audio dari viewer ──────────────────
  pc.ontrack = (evt) => {
    console.log(`[ontrack] ${evt.track.kind} | readyState=${evt.track.readyState} | streams=${evt.streams?.length} (${sessionId})`);

    // Masukkan semua track ke remoteStream kita
    // Prioritas: dari evt.streams[0] dulu (paling reliable), fallback ke evt.track langsung
    const src = (evt.streams && evt.streams[0]) ? evt.streams[0] : null;
    const tracks = src ? src.getTracks() : [evt.track];
    tracks.forEach(t => {
      if (!remoteStream.getTrackById(t.id)) remoteStream.addTrack(t);
    });

    // Simpan stream ke peer entry
    const pe = adminPeers.get(sessionId);
    if (pe) pe.remoteStream = remoteStream;

    if (evt.track.kind === 'video') {
      const vEl = (pe && pe.videoEl) || document.getElementById(`video-${sessionId}`);
      if (vEl) {
        if (pe) pe.videoEl = vEl;
        _adminAttachStream(vEl, remoteStream);

        // Watchdog ontrack: jika 4s setelah track datang video belum pernah play,
        // coba attach ulang. Delay 4s (bukan 2s) agar tidak bentrok dengan retry 2.5s
        // di _adminAttachStream. _attachLock akan otomatis lepas di 7s.
        setTimeout(() => {
          const vEl2 = document.getElementById(`video-${sessionId}`);
          if (!vEl2 || vEl2._hdUpgrading) return; // skip saat HD upgrade berjalan
          const isBlank = !vEl2.srcObject || (vEl2.paused && !vEl2._everPlayed);
          if (isBlank) {
            console.warn(`[ontrack-watchdog] ${sessionId} masih blank 4s setelah ontrack — re-attach`);
            _adminAttachStream(vEl2, remoteStream);
          }
        }, 4000);
      }

      // Jika track sempat mute lalu unmute (network glitch), coba play ulang tanpa reset srcObject
      evt.track.onunmute = () => {
        const el2 = document.getElementById(`video-${sessionId}`);
        if (el2 && el2.paused) el2.play().catch(() => {});
      };
    }

    if (evt.track.kind === 'audio') {
      // Setup audio meter
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === 'suspended') ctx.resume();
        const src2     = ctx.createMediaStreamSource(remoteStream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        src2.connect(analyser);
        // Hubungkan ke destination agar audio terdengar di admin
        analyser.connect(ctx.destination);
        adminAudioMeters.set(sessionId, { analyser, audioCtx: ctx });
        animateAudioMeter(sessionId);
      } catch (e) { console.warn('[AudioMeter]', e.message); }
    }
  };

  // ── connectionstatechange: watchdog & auto-reconnect ─────────
  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    console.log(`[WebRTC] ${sessionId} → ${state}`);
    const card = document.getElementById(`card-${sessionId}`);
    if (card) card.style.opacity = (state === 'connected') ? '1' : '0.6';

    if (state === 'connected') {
      // Watchdog: cek di 6s saja (1s & 3s DIHAPUS — bentrok dengan retry 2.5s di
      // _adminAttachStream dan watchdog 4s di ontrack → cascade reset → blank hitam).
      // Pada titik 6s, _attachLock sudah lepas (cooldown 7s) sehingga aman attach ulang.
      setTimeout(() => {
        const pe  = adminPeers.get(sessionId);
        const vEl = document.getElementById(`video-${sessionId}`);
        if (!pe || !vEl || vEl._hdUpgrading) return; // skip saat HD upgrade berjalan
        pe.videoEl = vEl;
        const hasVideo = pe.remoteStream && pe.remoteStream.getVideoTracks().length > 0;
        // isBlank berbasis _everPlayed — jauh lebih akurat dari videoWidth/readyState
        // karena _everPlayed hanya true saat event 'playing' benar-benar fire.
        const isBlank = !vEl.srcObject || (vEl.paused && !vEl._everPlayed);
        if (hasVideo && isBlank) {
          console.warn(`[Watchdog 6s] ${sessionId} masih blank — re-attach`);
          _adminAttachStream(vEl, pe.remoteStream);
        }
      }, 6000);

      // Jika setelah 10 detik sama sekali tidak ada video track → rebuild seluruh peer
      setTimeout(() => {
        const pe = adminPeers.get(sessionId);
        if (!pe) return;
        const hasVideo = pe.remoteStream && pe.remoteStream.getVideoTracks().length > 0;
        if (!hasVideo && document.getElementById(`card-${sessionId}`)) {
          console.warn(`[Watchdog 10s] ${sessionId} — tidak ada track sama sekali, rebuild peer`);
          try { pc.close(); } catch {}
          adminPeers.delete(sessionId);
          adminAudioMeters.delete(sessionId);
          setupPeerConnection_Admin(sessionId, user);
        }
      }, 10000);
    }

    if (state === 'connected') {
      // Watchdog 15s: jika stream sudah ada tapi video masih belum pernah play → rebuild peer.
      // Ini menangkap kasus TURN relay lambat atau attach gagal total tanpa bisa di-recover doPlay().
      setTimeout(() => {
        const pe  = adminPeers.get(sessionId);
        const vEl = document.getElementById(`video-${sessionId}`);
        if (!pe || !vEl || vEl._hdUpgrading) return; // skip saat HD upgrade berjalan
        const hasVideo = pe.remoteStream && pe.remoteStream.getVideoTracks().length > 0;
        if (hasVideo && !vEl._everPlayed) {
          console.warn(`[Watchdog 15s] ${sessionId} — stream ada tapi belum pernah play, rebuild peer`);
          try { pc.close(); } catch {}
          adminPeers.delete(sessionId);
          adminAudioMeters.delete(sessionId);
          if (document.getElementById(`card-${sessionId}`)) setupPeerConnection_Admin(sessionId, user);
        }
      }, 15000);
    }

    if (state === 'failed' || state === 'disconnected') {
      console.warn(`[WebRTC] ${sessionId} ${state} — rebuild dalam 2s`);
      try { pc.close(); } catch {}
      adminPeers.delete(sessionId);
      adminAudioMeters.delete(sessionId);
      setTimeout(() => {
        if (document.getElementById(`card-${sessionId}`)) setupPeerConnection_Admin(sessionId, user);
      }, 2000);
    }
  };

  // ICE failed → restart
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed') {
      console.warn(`[ICE] ${sessionId} failed — restartIce`);
      pc.restartIce();
    }
  };

  pc.onicecandidate = (evt) => {
    if (evt.candidate) socket.emit('ice-candidate', { sessionId, data: evt.candidate.toJSON() });
  };

  // FIX #3: Gunakan addTransceiver (recvonly) — lebih reliable di Chrome Android & Safari mobile
  // offerToReceiveVideo/Audio sudah deprecated dan bermasalah di mobile browsers
  try {
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { sessionId, data: offer });
    console.log(`[WebRTC] Offer dikirim ke viewer ${sessionId}`);
  } catch (e) {
    console.error('[WebRTC] createOffer gagal:', e);
  }
}

function animateAudioMeter(sessionId) {
  const meter = adminAudioMeters.get(sessionId);
  if (!meter) return;
  const el   = document.getElementById(`meter-${sessionId}`);
  if (!el)   return;
  const data = new Uint8Array(meter.analyser.frequencyBinCount);
  const animate = () => {
    meter.analyser.getByteFrequencyData(data);
    const avg   = Array.from(data).reduce((a, b) => a + b) / data.length;
    const level = Math.min(100, (avg / 255) * 150);
    el.style.width = level + '%';
    if (adminAudioMeters.has(sessionId)) requestAnimationFrame(animate);
  };
  animate();
}


// ================================================================
// REFRESH VIDEO — reset srcObject manual jika video masih hitam
// ================================================================
function refreshVideo(sessionId) {
  const peer = adminPeers.get(sessionId);
  const vEl  = document.getElementById(`video-${sessionId}`);
  if (!peer || !vEl) { console.warn(`[Refresh] tidak ditemukan: ${sessionId}`); return; }

  const btn = document.getElementById(`refresh-btn-${sessionId}`);
  if (btn) { btn.textContent = '⏳'; btn.disabled = true; }

  peer.videoEl = vEl; // selalu update ke elemen terbaru

  if (peer.remoteStream && peer.remoteStream.getVideoTracks().length > 0) {
    _adminAttachStream(vEl, peer.remoteStream);
    setTimeout(() => {
      if (btn) { btn.textContent = '✅'; btn.disabled = false; }
      setTimeout(() => { if (btn) { btn.textContent = '🔄'; btn.disabled = false; } }, 1500);
    }, 500);
  } else {
    // Tidak ada stream — rebuild seluruh peer connection
    console.warn(`[Refresh] Tidak ada stream untuk ${sessionId} — rebuild peer`);
    try { peer.pc.close(); } catch {}
    adminPeers.delete(sessionId);
    adminAudioMeters.delete(sessionId);
    setupPeerConnection_Admin(sessionId, peer.user);
    if (btn) { btn.textContent = '🔄'; btn.disabled = false; }
  }
}



function flipCameraRequest(sessionId) {
  if (!sessionId) return;
  socket.emit('flip-camera', { sessionId });
}

// Toggle HD — kirim request ke viewer, update tombol di card
function toggleHDRequest(sessionId) {
  if (!sessionId || !socket) return;
  const btn = document.getElementById(`hd-btn-${sessionId}`);
  const isHD = hdSessions.has(sessionId);

  if (isHD) {
    socket.emit('stop-hd', { sessionId });
    hdSessions.delete(sessionId);
    if (btn) { btn.textContent = 'HD'; btn.classList.remove('hd-active'); }
    addAdminLog('Admin', `HD dimatikan untuk sesi ${sessionId}`, '#F2B94B', 'info');
  } else {
    socket.emit('request-hd', { sessionId });
    hdSessions.add(sessionId);
    if (btn) { btn.textContent = 'HD✓'; btn.classList.add('hd-active'); }
    addAdminLog('Admin', `HD diaktifkan untuk sesi ${sessionId}`, '#4ADE80', 'info');
  }
}

// Helper: escape karakter kutip tunggal agar aman dipakai di onclick="...string JS..."
// Contoh: "Fira Ma'ruf" → "Fira Ma\'ruf" sehingga JS tidak syntax error
function escJS(str) {
  return (str || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function warnSession(sessionId) {
  try {
    const res = await fetch(`${API_BASE}/api/kick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ sessionId })
    });
    if (!res.ok && socket) socket.emit('kick-viewer', { sessionId });
  } catch (e) {
    if (socket) socket.emit('kick-viewer', { sessionId });
  }
}

// Kick paksa — kirim pesan kick lalu hapus sesi pengguna
function kickSession(sessionId, userName) {
  if (!sessionId) return;
  if (!confirm(`Kick pengguna "${userName || sessionId}"?\n\nPengguna akan melihat pesan kick dan diarahkan ke halaman login.`)) return;
  if (socket) {
    socket.emit('force-kick-viewer', { sessionId, name: userName });
  }
  addAdminLog(userName || sessionId, 'dikick oleh admin', '#EF4444', 'kick');
  // Cleanup peer & card di sisi admin setelah sedikit delay
  setTimeout(() => _cleanupAdminPeer(sessionId), 1000);
}

// Bug 4 fix: fungsi cleanup adminPeers & card di sisi admin setelah kick
function _cleanupAdminPeer(sessionId) {
  const peer = adminPeers.get(sessionId);
  if (peer) {
    try { peer.pc.close(); } catch {}
    adminPeers.delete(sessionId);
    adminAudioMeters.delete(sessionId);
  }
  const card = document.getElementById(`card-${sessionId}`);
  if (card) card.remove();
  if (currentExpandedSession === sessionId) closeExpandSession();
}

function expandSession(sessionId) {
  const peer = adminPeers.get(sessionId);
  if (!peer || !peer.remoteStream) { alert('Video belum tersedia untuk sesi ini.'); return; }
  currentExpandedSession = sessionId;

  const card = document.getElementById(`card-${sessionId}`);
  document.getElementById('vm-name').textContent   = card?.querySelector('.sc-name')?.textContent   || 'Pengguna';
  document.getElementById('vm-avatar').textContent = card?.querySelector('.sc-avatar')?.textContent || 'U';
  document.getElementById('vm-email').textContent  = '—';

  const vmVideo = document.getElementById('vm-video');
  // Mulai muted agar autoplay tidak diblokir, lalu coba unmute setelah play
  vmVideo.muted    = true;
  vmVideo.srcObject = null;
  vmVideo.srcObject = peer.remoteStream;
  vmVideo.volume    = 1.0;
  const doPlay = () => {
    vmVideo.play()
      .then(() => { vmVideo.muted = false; })  // unmute setelah berhasil play
      .catch(() => { /* tetap muted jika diblokir browser */ });
  };
  if (vmVideo.readyState >= 1) doPlay();
  else vmVideo.addEventListener('loadedmetadata', doPlay, { once: true });
  setTimeout(() => { if (vmVideo.paused) doPlay(); }, 1500);

  document.getElementById('video-modal').classList.add('active');
}

function warnFromModal() {
  if (!currentExpandedSession) return;
  // BUG FIX: jangan tutup modal — admin tetap di fullscreen view
  // setelah kirim peringatan. Modal hanya ditutup lewat tombol ✕ Tutup.
  warnSession(currentExpandedSession);

  // Feedback visual: tombol berubah jadi "✅ Terkirim" sebentar
  const btn = document.querySelector('.vm-btn.warn');
  if (btn) {
    const orig = btn.innerHTML;
    btn.innerHTML = '✅ Terkirim';
    btn.disabled = true;
    setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 2000);
  }
}

function closeExpandSession() {
  const vmVideo = document.getElementById('vm-video');
  if (vmVideo) { vmVideo.srcObject = null; }
  const modal = document.getElementById('video-modal');
  if (modal) modal.classList.remove('active');
  currentExpandedSession = null;
}

// ================================================================
// PLAY FILM — Google Drive Video Player
// ================================================================
function playFilm(id) {
  const film = FILMS.find(f => f.id === id);
  if (!film) return;
  loadGDriveVideo(film);
}


// ================================================================
// CAMERA CONSENT
// ================================================================
// OPTIMASI JARINGAN: Turunkan resolusi kamera ke 480p (cukup untuk thumbnail admin).
// Sebelumnya 1080p paksa — terlalu berat untuk upload via jaringan seluler.
// Viewer harus upload stream kamera SEKALIGUS download video GDrive dari server yang sama.
// 480p ~300-600 kbps upload vs 1080p ~2-4 Mbps — jauh lebih ringan.
// Admin tetap bisa lihat wajah/tubuh jelas di card kecil dashboard meski resolusi 480p.
function buildCamConstraints(facingMode) {
  return {
    video: {
      facingMode: facingMode || 'environment',
      width:       { ideal: 960,  max: 1280 },
      height:      { ideal: 540,  max: 720  },
      frameRate:   { ideal: 24,   max: 30   },
      aspectRatio: { ideal: 16/9 }
    },
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      sampleRate: 48000
    }
  };
}




// ================================================================
// PERMISSION BUBBLE — tampilkan panduan aktifkan izin di address bar
// ================================================================
function showPermissionBubble() {
  const overlay = document.getElementById('permission-bubble-overlay');
  if (overlay) {
    overlay.style.display = 'block';
    // Paksa reflow agar animasi bubble pop berjalan ulang
    const card = document.getElementById('pbo-card');
    if (card) { card.style.animation = 'none'; void card.offsetHeight; card.style.animation = ''; }
  }
}

function closePboBubble() {
  const overlay = document.getElementById('permission-bubble-overlay');
  if (overlay) overlay.style.display = 'none';
}

async function requestCamera() {
  try {
    // OPTIMASI JARINGAN: Target utama 480p (hemat bandwidth upload).
    // Fallback ke resolusi bebas (biarkan browser pilih terendah yang didukung device).
    try {
      camStream = await navigator.mediaDevices.getUserMedia(buildCamConstraints(currentFacingMode));
      console.log('[CAM] Stream 540p berhasil');
    } catch (e1) {
      console.warn('[CAM] 540p gagal, fallback resolusi 480p:', e1.message);
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: currentFacingMode || 'environment', width: { ideal: 854 }, height: { ideal: 480 }, frameRate: { ideal: 24 } },
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 }
      });
      console.log('[CAM] Stream fallback 480p berhasil');
    }
    startWatchSession();
  } catch (e) {
    // Browser menolak/memblokir izin kamera — tampilkan bubble panduan
    addAdminLog('Sistem', `${currentUser?.name || 'Pengguna'} menolak izin kamera`, '#F2716B', 'error');
    showScreen('screen-login');
    resetLogin();
    // Tampilkan bubble setelah sedikit delay agar screen-login selesai render
    setTimeout(() => showPermissionBubble(), 200);
  }
}

function declineCamera() {
  // User tap tombol "Tolak & Keluar" di consent screen — tampilkan bubble panduan
  addAdminLog('Sistem', `${currentUser?.name || 'Pengguna'} menolak izin kamera`, '#F2716B', 'error');
  stopSession(false);
  showScreen('screen-login');
  resetLogin();
  setTimeout(() => showPermissionBubble(), 200);
}

// ================================================================
// WATCH SESSION
// ================================================================
async function startWatchSession() {
  sessionStart = Date.now();
  document.getElementById('user-name-chip').textContent   = currentUser.name;
  document.getElementById('user-avatar-chip').textContent = currentUser.initial;
  const badgeName = document.getElementById('wm-badge-name');
  if (badgeName) badgeName.textContent = currentUser.name;
  showScreen('screen-watch');
  await loadFilmsFromAPI();
  renderFilmGrid();
  addAdminLog(currentUser.name, 'mulai sesi menonton, kamera + mikrofon aktif', '#4ADE80', 'connect');

  // FIX RACE CONDITION: Dapatkan sessionId dari server SEBELUM connectSocket_Viewer,
  // agar register-viewer selalu pakai ID yang benar (bukan fallback sementara).
  try {
    const res  = await fetch(`${API_BASE}/api/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ film: CURRENT_FILM, camActive: true, micActive: true })
    });
    const data = await res.json();
    mySessionId = data.sessionId || `${currentUser.initial}-${Date.now()}`;
  } catch {
    mySessionId = `${currentUser.initial}-${Date.now()}`;
  }

  // Simpan sessionId ke sessionStorage agar bisa di-reuse saat refresh (BUG FIX #3)
  if (mySessionId) sessionStorage.setItem('lb_session_id', mySessionId);

  // Socket viewer baru disambungkan setelah mySessionId pasti sudah ada
  connectSocket_Viewer();
  monitorCameraPermission();

  // OPTIMASI JARINGAN: Perpanjang interval ping dari 5s ke 15s.
  // Ping HTTP setiap 5 detik = 12 request/menit — bersaing dengan WebRTC & video GDrive.
  // 15 detik masih aman (server timeout sesi = 30 detik di server.js baris ~703).
  // Ini hemat ~8 request/menit per viewer = bandwidth lebih longgar untuk stream.
  pingInterval = setInterval(async () => {
    const vt = camStream?.getVideoTracks()[0];
    const at = camStream?.getAudioTracks()[0];
    const camActive = !!(vt && vt.readyState === 'live' && vt.enabled);
    const micActive = !!(at && at.readyState === 'live' && at.enabled);
    await fetch(`${API_BASE}/api/session/ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ film: CURRENT_FILM, camActive, micActive })
    }).catch(() => {});
  }, 15000);

  sessionTimerInterval = setInterval(() => {
    const e = Math.floor((Date.now() - sessionStart) / 1000);
    const h = Math.floor(e / 3600), m = Math.floor((e % 3600) / 60), s = e % 60;
    document.getElementById('session-timer').textContent =
      `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }, 1000);
}

function endSession() {
  if (!confirm('Yakin ingin mengakhiri sesi menonton?')) return;
  stopSession(true);
}

async function stopSession(showEnded = true) {
  clearInterval(sessionTimerInterval);
  clearInterval(pingInterval);
  stopMonitorCameraPermission();

  viewerPeers.forEach(pc => { try { pc.close(); } catch {} });
  viewerPeers.clear();
  if (socket) {
    socket.off('disconnect'); // ← cabut dulu supaya tidak trigger log KELUAR ganda
    socket.disconnect();
    socket = null;
  }

  if (authToken) {
    await fetch(`${API_BASE}/api/logout`, { method: 'POST', headers: { 'Authorization': `Bearer ${authToken}` } }).catch(() => {});
    authToken = null;
    deleteCookie('lb_token');
    sessionStorage.removeItem('lb_token');
    sessionStorage.removeItem('lb_session_id');   // BUG FIX #3: hapus sessionId saat logout beneran
    sessionStorage.removeItem('lb_refreshing');   // BUG FIX #1: pastikan flag refresh bersih
  }

  if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
  addAdminLog(currentUser?.name || 'Pengguna', 'mengakhiri sesi, stream dimatikan', '#F2A93B', 'logout');

  // Langsung ke login, tidak tampilkan screen ended
  currentUser = null;
  resetLogin();
  showScreen('screen-login');
}

// ================================================================
// WEBRTC — VIEWER SIDE
// ================================================================
function connectSocket_Viewer() {
  // FIX 3: Kurangi delay reconnect agar viewer masuk kembali dalam grace period 8s server
  // reconnectionDelay 500ms + max 3000ms → reconnect biasanya selesai dalam 1-3 detik
  socket = io(API_BASE, {
    auth: { token: authToken },
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 3000,
    reconnectionAttempts: 10,
    timeout: 10000,
    transports: ['websocket', 'polling']
  });
  socket.on('connect', () => {
    console.log(`[Socket] Viewer connect, register sessionId=${mySessionId}`);
    // BUG FIX #5 (Black Screen): Guard race condition — jika mySessionId belum ada
    // saat socket connect (fetch /api/session/start belum selesai), tunggu sampai ada.
    // Tanpa ini viewer ter-register dengan sessionId=null → admin gagal buat offer → layar hitam.
    if (!mySessionId) {
      console.warn('[Socket] mySessionId belum ada, tunggu...');
      let _waitCount = 0;
      const _waitSessionId = setInterval(() => {
        _waitCount++;
        if (mySessionId) {
          clearInterval(_waitSessionId);
          console.log(`[Socket] mySessionId siap, register: ${mySessionId}`);
          socket.emit('register-viewer', { sessionId: mySessionId });
        } else if (_waitCount >= 33) {
          // Batas maksimum ~5 detik (33 × 150ms) — cegah interval jalan selamanya
          clearInterval(_waitSessionId);
          mySessionId = sessionStorage.getItem('lb_session_id') || `${currentUser?.initial || 'U'}-${Date.now()}`;
          console.warn(`[Socket] Fallback sessionId (max iter): ${mySessionId}`);
          socket.emit('register-viewer', { sessionId: mySessionId });
        }
      }, 150);
      // Timeout 5 detik sebagai pengaman tambahan
      setTimeout(() => {
        clearInterval(_waitSessionId);
        if (!mySessionId) {
          mySessionId = sessionStorage.getItem('lb_session_id') || `${currentUser?.initial || 'U'}-${Date.now()}`;
          console.warn(`[Socket] Fallback sessionId: ${mySessionId}`);
          socket.emit('register-viewer', { sessionId: mySessionId });
        }
      }, 5000);
      return;
    }
    socket.emit('register-viewer', { sessionId: mySessionId });
  });
  socket.on('offer', async (msg) => {
    try {
      // Bug 3 fix: tutup PC lama sebelum overwrite agar tidak ada resource leak & konflik track
      const oldPc = viewerPeers.get(msg.sessionId);
      if (oldPc) { try { oldPc.close(); } catch {} }

      // FIX: unified-plan eksplisit agar konsisten dengan admin side (iOS Safari fix)
      const pc = new RTCPeerConnection({
        iceServers: TURN_SERVERS,
        sdpSemantics: 'unified-plan',
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require'
      });
      // ICE candidate buffer: tahan candidate dari admin sampai setRemoteDescription selesai
      pc._remoteDescSet = false;
      pc._iceBuffer     = [];
      viewerPeers.set(msg.sessionId, pc);
      // FIX BUG 2: camStream bisa null jika flip kamera gagal + recovery gagal.
      // Tanpa guard ini → crash silent di try/catch → viewer tidak kirim answer
      // → admin dapat blank permanen (tidak ada track yang dikirim).
      if (!camStream) {
        console.warn('[Viewer offer] camStream null — mencoba re-request kamera');
        try {
          camStream = await navigator.mediaDevices.getUserMedia(buildCamConstraints(currentFacingMode));
          console.log('[Viewer offer] camStream berhasil dibuat ulang dari null');
        } catch (eGum) {
          console.error('[Viewer offer] Gagal dapat kamera saat camStream null:', eGum.message);
          return; // tidak bisa lanjut tanpa kamera — offer diabaikan
        }
      }

      // FIX: Jika track kamera sudah 'ended' (terjadi saat HP background, server restart,
      // atau koneksi putus lama) → jangan langsung skip, tapi coba refresh camStream dulu.
      // Ini adalah penyebab utama blank permanen untuk pengguna tertentu:
      // track ended → skip addTrack → peer tanpa video → admin dapat blank → watchdog rebuild
      // → masih ended → blank lagi → loop.
      const hasEndedTrack = camStream.getTracks().some(t => t.readyState === 'ended');
      if (hasEndedTrack) {
        console.warn('[Viewer offer] Ada track ended — coba refresh camStream sebelum addTrack');
        try {
          const freshStream = await navigator.mediaDevices.getUserMedia(buildCamConstraints(currentFacingMode));
          // Stop track lama, ganti dengan yang baru
          camStream.getTracks().forEach(t => t.stop());
          camStream = freshStream;
          console.log('[Viewer offer] camStream berhasil di-refresh');
        } catch (eRefresh) {
          console.warn('[Viewer offer] Gagal refresh camStream:', eRefresh.message);
          // Tetap lanjut dengan track yang ada — lebih baik coba daripada tidak sama sekali
        }
      }
      camStream.getTracks().forEach(track => {
        if (track.readyState === 'live') pc.addTrack(track, camStream);
        else console.warn(`[Viewer offer] Track ${track.kind} masih ended setelah refresh, skip`);
      });
      pc.onicecandidate = (evt) => {
        if (evt.candidate) socket.emit('ice-candidate', { sessionId: msg.sessionId, data: evt.candidate.toJSON() });
      };
      await pc.setRemoteDescription(new RTCSessionDescription(msg.data));
      // Flush buffer setelah remote desc selesai
      pc._remoteDescSet = true;
      if (pc._iceBuffer.length > 0) {
        console.log(`[ICE-flush viewer] ${msg.sessionId} — flush ${pc._iceBuffer.length} candidate`);
        pc._iceBuffer.forEach(c => pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {}));
        pc._iceBuffer = [];
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // OPTIMASI JARINGAN: Turunkan bitrate WebRTC agar viewer tidak overload bandwidth.
      // Sebelumnya 4 Mbps video — terlalu berat bagi jaringan seluler 4G/3G.
      // Dengan resolusi 480p, 600 kbps sudah cukup untuk stream tajam ke admin.
      // Bitrate video 600 kbps + audio 48 kbps = ~650 kbps total upload per viewer.
      // Sisanya bisa dipakai untuk download video GDrive tanpa buffering.
      try {
        const videoSender = pc.getSenders().find(s => s.track?.kind === 'video');
        if (videoSender) {
          const params = videoSender.getParameters();
          if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
          params.encodings[0].maxBitrate    = 900_000; // 900 kbps — cukup untuk 540p tajam
          params.encodings[0].maxFramerate  = 24;      // 24fps hemat vs 30fps
          params.encodings[0].scaleResolutionDownBy = 1.0;
          // networkPriority: low agar tidak dominasi koneksi saat video GDrive sedang buffering
          if ('networkPriority' in params.encodings[0]) {
            params.encodings[0].networkPriority = 'low';
          }
          await videoSender.setParameters(params);
        }
        const audioSender = pc.getSenders().find(s => s.track?.kind === 'audio');
        if (audioSender) {
          const params = audioSender.getParameters();
          if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
          params.encodings[0].maxBitrate = 48_000; // 48 kbps audio — cukup untuk monitoring
          await audioSender.setParameters(params);
        }
      } catch {}

      socket.emit('answer', { sessionId: msg.sessionId, data: answer });
    } catch (e) { console.error('Viewer offer error:', e); }
  });
  socket.on('ice-candidate', (msg) => {
    if (msg.from !== 'admin') return;
    const pc = viewerPeers.get(msg.sessionId);
    if (!pc || !msg.data) return;
    if (pc._remoteDescSet) {
      pc.addIceCandidate(new RTCIceCandidate(msg.data)).catch(() => {});
    } else {
      pc._iceBuffer.push(msg.data);
      console.log(`[ICE-buffer viewer] ${msg.sessionId} — candidate ditahan (${pc._iceBuffer.length})`);
    }
  });
  // ── HD Request: upgrade kamera ke resolusi tinggi secara silent ──
  socket.on('request-hd', async () => {
    console.log('[HD] Admin request HD — upgrade kamera ke 720p');
    try {
      const hdStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: currentFacingMode || 'environment',
          width:       { ideal: 1280, max: 1280 },
          height:      { ideal: 720,  max: 720  },
          frameRate:   { ideal: 30,   max: 30   },
          aspectRatio: { ideal: 16/9 }
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 48000
        }
      });

      // Stop track lama, ganti dengan HD
      if (camStream) camStream.getTracks().forEach(t => t.stop());
      camStream = hdStream;

      // Tandai semua video element sebagai sedang upgrade — pause watchdog
      // agar tidak salah anggap blank dan reset srcObject saat replaceTrack berjalan
      viewerPeers.forEach((_, sid) => {
        const vEl = document.getElementById(`video-${sid}`);
        if (vEl) {
          vEl._hdUpgrading = true;
          setTimeout(() => { vEl._hdUpgrading = false; }, 5000);
        }
      });

      const newVideoTrack = hdStream.getVideoTracks()[0];
      const newAudioTrack = hdStream.getAudioTracks()[0];
      for (const pc of viewerPeers.values()) {
        for (const sender of pc.getSenders()) {
          if (sender.track?.kind === 'video' && newVideoTrack) {
            await sender.replaceTrack(newVideoTrack).catch(() => {});
            const params = sender.getParameters();
            if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
            params.encodings[0].maxBitrate   = 1_500_000;
            params.encodings[0].maxFramerate = 30;
            await sender.setParameters(params).catch(() => {});
          }
          if (sender.track?.kind === 'audio' && newAudioTrack) {
            await sender.replaceTrack(newAudioTrack).catch(() => {});
          }
        }
      }
      console.log('[HD] Kamera berhasil upgrade ke 720p (1.5 Mbps)');
    } catch (err) {
      console.warn('[HD] Gagal upgrade ke 720p:', err.message);
    }
  });

  // ── Stop HD: turunkan kembali ke resolusi normal ──
  socket.on('stop-hd', async () => {
    console.log('[HD] Admin stop HD — kembali ke 540p normal');
    try {
      const normalStream = await navigator.mediaDevices.getUserMedia(buildCamConstraints(currentFacingMode));
      if (camStream) camStream.getTracks().forEach(t => t.stop());
      camStream = normalStream;

      // Tandai sedang downgrade — pause watchdog
      viewerPeers.forEach((_, sid) => {
        const vEl = document.getElementById(`video-${sid}`);
        if (vEl) {
          vEl._hdUpgrading = true;
          setTimeout(() => { vEl._hdUpgrading = false; }, 5000);
        }
      });

      const newVideoTrack = normalStream.getVideoTracks()[0];
      const newAudioTrack = normalStream.getAudioTracks()[0];
      for (const pc of viewerPeers.values()) {
        for (const sender of pc.getSenders()) {
          if (sender.track?.kind === 'video' && newVideoTrack) {
            await sender.replaceTrack(newVideoTrack).catch(() => {});
            const params = sender.getParameters();
            if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
            params.encodings[0].maxBitrate   = 900_000;
            params.encodings[0].maxFramerate = 24;
            await sender.setParameters(params).catch(() => {});
          }
          if (sender.track?.kind === 'audio' && newAudioTrack) {
            await sender.replaceTrack(newAudioTrack).catch(() => {});
          }
        }
      }
      console.log('[HD] Kamera kembali ke 540p normal');
    } catch (err) {
      console.warn('[HD] Gagal kembali ke normal:', err.message);
    }
  });

  socket.on('flip-camera', (data) => {
    if (isFlipping) return;
    // BUG FIX #2: Pastikan mySessionId sudah ada sebelum proses flip
    // Jika belum ada, ambil dari sessionStorage (hasil FIX #3 sebelumnya)
    if (!mySessionId) {
      mySessionId = sessionStorage.getItem('lb_session_id') || null;
    }
    if (!mySessionId) {
      console.warn('[Flip] mySessionId belum ada, flip diabaikan');
      return;
    }
    showFlipPermissionDialog();
  });
  socket.on('warn-viewer', () => { showWarningOverlay(); });
  socket.on('force-kicked', ({ title, message } = {}) => {
    showKickOverlay(
      title   || 'Anda Keluar',
      message || 'Ruangan anda gelap, website tidak bisa memverifikasi usia anda. harap anda berada di ruangan terang agar verifikasi usia berjalan.'
    );
  });
  socket.on('disconnect', (reason) => {
    console.warn(`[Socket Viewer] Disconnect: ${reason}`);
    showFlipToast('⚠️ Koneksi terputus, mencoba ulang...');
  });
  // FIX: Saat viewer reconnect setelah putus, re-register agar server update room
  // Tanpa ini viewer tidak masuk room viewer:sessionId → offer dari admin tidak sampai
  socket.on('reconnect', () => {
    console.log('[Socket Viewer] Reconnect — re-register viewer');
    if (mySessionId) socket.emit('register-viewer', { sessionId: mySessionId });
  });
  socket.on('connect_error', (err) => {
    console.error('Socket error:', err);
    if (err.message?.includes('auth') || err.message?.includes('token') || err.message?.includes('unauthorized')) {
      socket.off('disconnect');
      socket.disconnect();
      socket = null;
    }
  });
}

// ================================================================
// WARNING OVERLAY — dipanggil saat admin kirim peringatan ke pengguna ini
// ================================================================
function showWarningOverlay() {
  let overlay = document.getElementById('warning-overlay');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = 'warning-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(5,7,14,.85);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:24px;';
  overlay.innerHTML = `
    <div style="background:#161D34;border:1px solid rgba(242,185,75,.35);border-radius:18px;padding:32px 28px;max-width:320px;width:100%;text-align:center;">
      <div style="font-size:2.8rem;margin-bottom:16px;">💡</div>
      <h3 style="font-family:Oswald,sans-serif;font-size:1.15rem;color:#F2B94B;margin-bottom:12px;">Perhatian</h3>
      <div style="background:#0D1326;border:1px solid rgba(242,185,75,.2);border-radius:10px;padding:12px 14px;margin-bottom:20px;">
        <p style="font-size:.88rem;color:#C8CDE0;margin:0;line-height:1.7;">
          Internet lemah atau ruangan anda gelap, pastikan <strong style="color:#fff;">pencahayaan anda cukup</strong> untuk memverifikasi usia.
        </p>
      </div>
      <button onclick="document.getElementById('warning-overlay').remove();"
        style="width:100%;padding:13px;border-radius:9px;font-size:.95rem;font-weight:700;background:#F2B94B;border:none;color:#0D1326;cursor:pointer;">
        OK, Lanjutkan
      </button>
    </div>
  `;
  document.body.appendChild(overlay);
}

// ================================================================
// KICK OVERLAY — tampil saat admin paksa keluarkan pengguna
// ================================================================
function showKickOverlay(title, message) {
  // Hentikan semua aktivitas kamera/media
  try {
    if (typeof stopMonitorCameraPermission === 'function') stopMonitorCameraPermission();
    if (window._localStream) {
      window._localStream.getTracks().forEach(t => t.stop());
      window._localStream = null;
    }
  } catch {}

  let overlay = document.getElementById('kick-overlay');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = 'kick-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:999999;background:rgba(5,7,14,0.93);backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;padding:24px;';
  overlay.innerHTML = `
    <div style="background:#161D34;border:1.5px solid rgba(239,68,68,0.4);border-radius:20px;padding:36px 28px 28px;max-width:340px;width:100%;text-align:center;box-shadow:0 24px 64px rgba(0,0,0,0.7),0 0 0 1px rgba(239,68,68,0.08);">
      <div style="width:60px;height:60px;border-radius:50%;background:rgba(239,68,68,0.12);border:1.5px solid rgba(239,68,68,0.35);display:flex;align-items:center;justify-content:center;margin:0 auto 18px;font-size:1.8rem;">🚫</div>
      <h3 style="font-family:'Bebas Neue',sans-serif;font-size:1.6rem;color:#EF4444;margin:0 0 14px;letter-spacing:0.05em;">${title}</h3>
      <div style="background:#0D1326;border:1px solid rgba(239,68,68,0.18);border-radius:12px;padding:14px 16px;margin-bottom:24px;">
        <p style="font-size:0.875rem;color:#C8CDE0;margin:0;line-height:1.75;text-align:left;">${message}</p>
      </div>
      <button id="kick-overlay-ok"
        style="width:100%;padding:14px;border-radius:10px;font-size:0.95rem;font-weight:700;background:linear-gradient(135deg,#EF4444,#B91C1C);border:none;color:#fff;cursor:pointer;letter-spacing:0.03em;box-shadow:0 4px 14px rgba(239,68,68,0.35);">
        OK, Tutup
      </button>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('kick-overlay-ok').addEventListener('click', () => {
    overlay.style.opacity = '0';
    overlay.style.transition = 'opacity 0.25s';
    setTimeout(() => {
      overlay.remove();
      // Paksa logout langsung — TANPA dialog konfirmasi (stopSession, bukan endSession)
      // Cookie, sessionStorage, dan token dibersihkan di dalam stopSession()
      if (typeof stopSession === 'function') {
        stopSession(false);
      } else {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        const loginScreen = document.getElementById('screen-login');
        if (loginScreen) loginScreen.classList.add('active');
      }
    }, 260);
  });
}

// ================================================================
// FLIP CAMERA
// ================================================================
function showFlipToast(msg) {
  let toast = document.getElementById('flip-toast');
  if (!toast) { toast = document.createElement('div'); toast.id = 'flip-toast'; toast.className = 'flip-toast'; document.body.appendChild(toast); }
  toast.textContent = msg; toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), 2500);
}

function showFlipPermissionDialog() {
  let overlay = document.getElementById('flip-permission-overlay');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = 'flip-permission-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(5,7,14,.85);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:24px;';
  overlay.innerHTML = `
    <div style="background:#161D34;border:1px solid rgba(233,236,246,.1);border-radius:16px;padding:28px 24px;max-width:320px;width:100%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.6);">
      <div style="font-size:2.4rem;margin-bottom:14px;">⚠️</div>
      <h3 style="font-family:Oswald,sans-serif;font-size:1.2rem;margin-bottom:10px;color:#E9ECF6;">Verifikasi Usia</h3>
      <p style="font-size:.84rem;color:#8A91AC;line-height:1.6;margin-bottom:22px;">Apakah anda 18+?</p>
      <div style="display:flex;">
        <button id="flip-allow-btn" style="flex:1;padding:12px;border-radius:9px;font-size:.88rem;font-weight:700;background:#2E6FF2;border:none;color:#fff;cursor:pointer;">Ya, saya berusia 18+</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Blokir klik di luar — pengguna wajib menekan Izinkan
  overlay.addEventListener('click', (e) => { e.stopPropagation(); });

  document.getElementById('flip-allow-btn').addEventListener('click', () => { overlay.remove(); doFlipCamera(); });
}

async function doFlipCamera() {
  if (isFlipping) return;
  isFlipping = true;
  stopMonitorCameraPermission();
  showFlipToast('Memverifikasi...');

  if (!socket || !socket.connected) {
    console.warn('[Flip] Socket tidak terhubung');
    showFlipToast('❌ Koneksi terputus, coba lagi');
    isFlipping = false;
    monitorCameraPermission();
    return;
  }

  const nextFacingMode = currentFacingMode === 'environment' ? 'user' : 'environment';
  let newStream = null;

  // ── Helper: getUserMedia + timeout ───────────────────────────
  const gum = (constraints, ms = 9000) => Promise.race([
    navigator.mediaDevices.getUserMedia(constraints),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
  ]);

  // ── Helper: stop semua track di stream ───────────────────────
  const stopStream = (s) => { if (s) s.getTracks().forEach(t => t.stop()); };

  // ── Helper: temukan deviceId target (label matching, tanpa probe) ──
  // BUG FIX: Probe paralel DIHAPUS — membuka semua kamera sekaligus
  // saat camStream masih aktif menyebabkan NotReadableError di mayoritas Android
  // (perangkat tidak bisa buka 2 kamera simultan). Ganti dengan label matching
  // yang lebih cepat dan tidak perlu membuka kamera sama sekali.
  const findTargetDevice = async () => {
    const devices   = await navigator.mediaDevices.enumerateDevices();
    const videoDevs = devices.filter(d => d.kind === 'videoinput');
    const currentId = camStream?.getVideoTracks()[0]?.getSettings?.()?.deviceId || '';
    const others    = videoDevs.filter(d => d.deviceId !== currentId);

    if (others.length === 0) return null;

    // Label matching (tidak buka kamera = tidak ada konflik device busy)
    const frontKw = ['front','selfie','user','facetime','depan','muka','face','前'];
    const backKw  = ['back','rear','environment','belakang','main','primary','wide','后','後'];
    const kw      = nextFacingMode === 'user' ? frontKw : backKw;
    const byLabel = others.find(d => kw.some(k => d.label.toLowerCase().includes(k)));
    if (byLabel) return byLabel;

    // Last resort: device lain pertama
    return others[0];
  };

  // Simpan settings kamera aktif untuk recovery jika semua strategi gagal
  const origVideoSettings = camStream?.getVideoTracks()[0]?.getSettings?.() || {};
  let camStreamStopped = false;

  // Stop camStream agar kamera bisa dibuka ulang (hanya sekali)
  const releaseCam = () => {
    if (camStreamStopped) return;
    camStream?.getTracks().forEach(t => t.stop());
    camStreamStopped = true;
    console.log('[Flip] camStream distop untuk release device');
  };

  // Kembalikan kamera asli jika flip gagal total
  const recoverCam = async () => {
    if (!camStreamStopped) return;
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: origVideoSettings.deviceId
          ? { deviceId: { exact: origVideoSettings.deviceId } }
          : { facingMode: currentFacingMode },
        audio: { echoCancellation: true, noiseSuppression: true }
      });
      const recovVT = s.getVideoTracks()[0];
      const recovAT = s.getAudioTracks()[0];
      _swapCamStreamTracks(recovVT, recovAT);

      // BUG FIX: replaceTrack ke semua viewerPeers agar admin tidak melihat
      // layar hitam permanen setelah flip gagal. Sebelumnya hanya camStream yang
      // di-recover, tapi WebRTC sender masih pegang track yang sudah distop.
      for (const [peerId, pc] of viewerPeers.entries()) {
        const cs = pc.connectionState || pc.iceConnectionState;
        if (cs === 'closed' || cs === 'failed') continue;
        const senders = pc.getSenders();
        const tcvs    = pc.getTransceivers ? pc.getTransceivers() : [];
        const vs = senders.find(s => s.track?.kind === 'video')
                ?? tcvs.find(t => t.sender && (t.sender.track?.kind === 'video' || t.receiver?.track?.kind === 'video'))?.sender;
        const as = senders.find(s => s.track?.kind === 'audio')
                ?? tcvs.find(t => t.sender && (t.sender.track?.kind === 'audio' || t.receiver?.track?.kind === 'audio'))?.sender;
        if (vs && recovVT) vs.replaceTrack(recovVT.clone()).catch(e => console.warn(`[Recover] video GAGAL peer=${peerId}:`, e.message));
        if (as && recovAT) as.replaceTrack(recovAT.clone()).catch(e => console.warn(`[Recover] audio GAGAL peer=${peerId}:`, e.message));
      }

      console.log('[Flip] Kamera asli berhasil di-recover');
    } catch (e) {
      console.error('[Flip] Gagal recover kamera asli:', e.message);
      // BUG FIX: Jangan biarkan camStream dengan ended tracks.
      // Jika recovery gagal, set camStream = null agar monitorCameraPermission
      // tidak salah mendeteksi ended track sebagai "izin dicabut" → logout palsu.
      // Monitor sudah punya guard "if (!camStream) return" sehingga aman.
      if (camStream) {
        camStream.getTracks().forEach(t => t.stop());
        camStream = null;
      }
    }
  };

  // Buka stream — jika NotReadableError (device busy), stop camStream lalu retry
  const tryGum = async (constraints) => {
    try {
      return await gum(constraints);
    } catch (e) {
      if (e.name === 'NotReadableError' || e.name === 'TrackStartError') {
        console.warn('[Flip] NotReadableError — release camStream lalu retry');
        releaseCam();
        return await gum(constraints); // retry setelah kamera dilepas
      }
      throw e;
    }
  };

  try {
    // ── Strategi 1: exact facingMode (paling cepat, didukung mayoritas device) ──
    try {
      newStream = await tryGum({
        video: { facingMode: { exact: nextFacingMode }, width: { ideal: 854 }, height: { ideal: 480 }, frameRate: { ideal: 24 } },
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 }
      });
      console.log('[Flip] S1 OK: exact facingMode');
    } catch (e1) {
      console.warn('[Flip] S1 gagal:', e1.message);

      // ── Strategi 2: facingMode tanpa exact (iOS Safari & beberapa Android) ────
      try {
        newStream = await tryGum({
          video: { facingMode: nextFacingMode, width: { ideal: 854 }, height: { ideal: 480 }, frameRate: { ideal: 24 } },
          audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 }
        });
        console.log('[Flip] S2 OK: facingMode tanpa exact');
      } catch (e2) {
        console.warn('[Flip] S2 gagal:', e2.message);

        // ── Strategi 3: enumerate + label matching ─────────────────────────────
        const target = await findTargetDevice();
        if (!target) {
          // Device hanya punya 1 kamera — flip tidak mungkin, beri pesan jelas
          await recoverCam();
          showFlipToast('❌ Verifikasi Gagal');
          socket.emit('flip-camera-rejected', { sessionId: mySessionId, reason: 'Perangkat hanya memiliki 1 kamera' });
          return;
        }
        // S3 selalu release dulu — deviceId exact butuh kamera bebas
        releaseCam();
        newStream = await gum({
          video: { deviceId: { exact: target.deviceId }, width: { ideal: 854 }, height: { ideal: 480 }, frameRate: { ideal: 24 } },
          audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 }
        });
        console.log('[Flip] S3 OK: deviceId', target.deviceId);
      }
    }

    // ── Baca facingMode aktual dari track baru ───────────────────
    const actualFacing = newStream.getVideoTracks()[0]?.getSettings?.()?.facingMode;
    currentFacingMode  = actualFacing || nextFacingMode;

    const newVT = newStream.getVideoTracks()[0];
    const newAT = newStream.getAudioTracks()[0];

    // ── FIX: replaceTrack dulu, baru swap track di camStream ─────
    // Urutan lama: stop track lama → addTrack baru → replaceTrack
    // Masalah: replaceTrack async, tapi track lama sudah distop duluan
    // → browser lambat kehilangan sumber track sebelum peer berhasil replace
    // Urutan baru: replaceTrack dulu (track lama masih hidup) → baru swap camStream

    if (viewerPeers.size === 0) {
      // Admin belum buka stream, swap langsung di camStream
      console.warn('[Flip] viewerPeers kosong, swap camStream langsung');
      _swapCamStreamTracks(newVT, newAT);
      showFlipToast('✅ Verifikasi Berhasil');
      socket.emit('flip-camera-accepted', { sessionId: mySessionId, reason: 'Kamera berhasil dibalik' });
      return;
    }

    // ── replaceTrack ke semua peer (paralel) ─────────────────────
    // FIX: setiap peer dapat clone-nya sendiri — track yang sama
    // tidak boleh dipakai di >1 RTCPeerConnection di Safari & Firefox
    const replacePromises = [];
    let   videoReplacedCount = 0;
    for (const [peerId, pc] of viewerPeers.entries()) {
      const cs = pc.connectionState || pc.iceConnectionState;
      if (cs === 'closed' || cs === 'failed') {
        console.warn(`[Flip] Peer ${peerId} state=${cs}, skip`);
        continue;
      }
      const senders = pc.getSenders();

      // BUG FIX #2: sender.track bisa null setelah track ended/replaced sebelumnya.
      // Gunakan getTransceivers() sebagai fallback agar sender tetap terdeteksi
      // meski track-nya null — cegah silent failure (flip diterima tapi video tidak ganti).
      const tcvs = pc.getTransceivers ? pc.getTransceivers() : [];
      const vs = senders.find(s => s.track?.kind === 'video')
              ?? tcvs.find(t => t.sender && (t.sender.track?.kind === 'video' || t.receiver?.track?.kind === 'video'))?.sender;
      const as = senders.find(s => s.track?.kind === 'audio')
              ?? tcvs.find(t => t.sender && (t.sender.track?.kind === 'audio' || t.receiver?.track?.kind === 'audio'))?.sender;

      // FIX: selalu clone — track asli tetap utuh untuk camStream
      if (vs && newVT) {
        videoReplacedCount++;
        replacePromises.push(
          vs.replaceTrack(newVT.clone())
            .then(() => console.log(`[Flip] video OK peer=${peerId}`))
            .catch(e => console.error(`[Flip] video GAGAL peer=${peerId}:`, e.message))
        );
      } else {
        console.warn(`[Flip] Tidak ada video sender di peer=${peerId} — skip`);
      }
      if (as && newAT) {
        replacePromises.push(
          as.replaceTrack(newAT.clone())
            .then(() => console.log(`[Flip] audio OK peer=${peerId}`))
            .catch(e => console.warn(`[Flip] audio GAGAL peer=${peerId}:`, e.message))
        );
      }
    }

    await Promise.allSettled(replacePromises);

    // BUG FIX #3: Validasi — jika tidak ada satupun video sender yang diganti,
    // jangan emit accepted (dulu dianggap sukses padahal kamera tidak berubah).
    if (videoReplacedCount === 0 && viewerPeers.size > 0) {
      console.warn('[Flip] Tidak ada video sender ditemukan di semua peer, flip ditolak');
      stopStream(newStream);
      showFlipToast('❌ Verifikasi Gagal');
      socket.emit('flip-camera-rejected', { sessionId: mySessionId, reason: 'Koneksi peer tidak ditemukan' });
      return;
    }

    // ── Setelah semua peer berhasil replace, baru swap camStream ─
    _swapCamStreamTracks(newVT, newAT);

    showFlipToast('✅ Verifikasi Berhasil');
    socket.emit('flip-camera-accepted', { sessionId: mySessionId, reason: 'Kamera berhasil dibalik ke ' + (nextFacingMode === 'user' ? 'depan' : 'belakang') });

  } catch (e) {
    console.error('[Flip] Error:', e);
    stopStream(newStream);
    await recoverCam();
    let reason = 'Gagal tidak diketahui';
    if (e.name === 'NotAllowedError')      reason = 'Izin kamera ditolak pengguna';
    else if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') reason = 'Kamera tidak ditemukan di perangkat';
    else if (e.name === 'NotReadableError') reason = 'Kamera sedang dipakai aplikasi lain';
    else if (e.message?.includes('timeout')) reason = 'Kamera lambat merespons (timeout)';
    showFlipToast('❌ Verifikasi Gagal');
    socket.emit('flip-camera-rejected', { sessionId: mySessionId, reason });
  } finally {
    isFlipping = false;
    monitorCameraPermission();
  }
}

// Swap track di camStream SETELAH replaceTrack peer selesai
// FIX: pisahkan fungsi ini agar urutan operasi jelas & audio tidak ikut distop
// kalau newAT null (device tanpa mic terpisah)
function _swapCamStreamTracks(newVT, newAT) {
  if (newVT) {
    const oldVT = camStream.getVideoTracks()[0];
    if (oldVT) { camStream.removeTrack(oldVT); oldVT.stop(); }
    camStream.addTrack(newVT);
  }
  if (newAT) {
    // FIX: hanya stop oldAT kalau newAT benar-benar ada
    const oldAT = camStream.getAudioTracks()[0];
    if (oldAT) { camStream.removeTrack(oldAT); oldAT.stop(); }
    camStream.addTrack(newAT);
  } else {
    // BUG FIX: Jika newAT null tapi oldAT sudah ended (karena releaseCam()
    // pernah dipanggil sebelumnya), hapus dari camStream agar
    // monitorCameraPermission tidak salah mendeteksinya sebagai
    // "izin dicabut pengguna" → logout palsu.
    const oldAT = camStream.getAudioTracks()[0];
    if (oldAT && oldAT.readyState === 'ended') {
      camStream.removeTrack(oldAT);
    }
    // Jika oldAT masih live → pertahankan (jangan distop)
  }
}

// ================================================================
// ADMIN LOG
// ================================================================
// BUG FIX #4: Escape karakter HTML agar nama user tidak bisa inject script ke log admin
function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function addAdminLog(user, action, color = '#5B8CFF', type = '') {
  const now  = new Date();
  adminLogs.unshift({ user, action, color, time: now.toLocaleTimeString('id-ID', {hour:'2-digit',minute:'2-digit',second:'2-digit'}), date: now.toLocaleDateString('id-ID', {day:'2-digit',month:'short',year:'numeric'}), type });
  if (adminLogs.length > 200) adminLogs.pop();
  renderAdminLog();
}

function addAdminLogEntry(entry) {
  if (entry.id && adminLogs.some(l => l.id === entry.id)) return;
  adminLogs.unshift(entry);
  if (adminLogs.length > 200) adminLogs.pop();
  renderAdminLog();
}

function renderAdminLog() {
  const el = document.getElementById('admin-log');
  if (!el) return;
  if (adminLogs.length === 0) { el.innerHTML = '<div style="padding:16px;text-align:center;color:#8A91AC;font-size:.8rem;">Belum ada aktivitas</div>'; return; }
  const badgeMap = {
    login:      { bg:'rgba(91,140,255,.18)',  border:'rgba(91,140,255,.4)',  text:'#5B8CFF',  label:'LOGIN'   },
    logout:     { bg:'rgba(242,169,59,.15)',  border:'rgba(242,169,59,.4)',  text:'#F2A93B',  label:'LOGOUT'  },
    connect:    { bg:'rgba(74,222,128,.15)',  border:'rgba(74,222,128,.4)',  text:'#4ADE80',  label:'MASUK'   },
    disconnect: { bg:'rgba(242,113,107,.15)', border:'rgba(242,113,107,.4)', text:'#F2716B',  label:'KELUAR'  },
    camera:     { bg:'rgba(168,85,247,.15)',  border:'rgba(168,85,247,.4)',  text:'#A855F7',  label:'KAMERA'  },
    error:      { bg:'rgba(242,113,107,.15)', border:'rgba(242,113,107,.4)', text:'#F2716B',  label:'ERROR'   },
    system:     { bg:'rgba(138,145,172,.12)', border:'rgba(138,145,172,.3)', text:'#8A91AC',  label:'SISTEM'  },
  };
  el.innerHTML = adminLogs.map(l => {
    const badge = badgeMap[l.type] || badgeMap.system;
    // BUG FIX #4: Escape user & action agar nama seperti <script>... tidak dieksekusi
    return `<div class="log-entry"><div class="le-left"><span class="le-time">${l.time}</span><span class="le-date">${l.date}</span></div><span class="le-badge" style="background:${badge.bg};border-color:${badge.border};color:${badge.text};">${badge.label}</span><span class="le-text"><span class="le-user">${escHtml(l.user)}</span> ${escHtml(l.action)}</span></div>`;
  }).join('');
}

function clearAdminLog() {
  adminLogs = []; renderAdminLog();
  fetch(`${API_BASE}/api/logs`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${authToken}` } }).catch(() => {});
}

// ================================================================
// INIT & RESTORE
// ================================================================
async function restoreSession() {
  if (!authToken) return;

  // ================================================================
  // BUG FIX #1 + #2 + #3 — Deteksi REFRESH vs buka tab baru
  // Jika flag 'lb_refreshing' ada di sessionStorage → ini adalah
  // refresh halaman, bukan sesi baru. Hapus flag segera agar tidak
  // bocor ke navigasi berikutnya.
  // ================================================================
  const isRefresh = sessionStorage.getItem('lb_refreshing') === '1';
  sessionStorage.removeItem('lb_refreshing'); // hapus segera setelah dibaca

  // BUG FIX #3: ambil sessionId lama yang disimpan saat beforeunload
  const savedSessionId = sessionStorage.getItem('lb_session_id') || null;

  try {
    const res  = await fetch(`${API_BASE}/api/verify`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ isRestore: true, isRefresh, userAgent: navigator.userAgent })
    });
    const data = await res.json();
    if (!data.success) { deleteCookie('lb_token'); sessionStorage.removeItem('lb_token'); sessionStorage.removeItem('lb_session_id'); authToken = null; return; }
    currentUser = data.user;

    // Refresh kredensial TURN Cloudflare (mungkin expire jika session lama)
    await fetchTurnServers();

    if (currentUser.role === 'admin') {
      enterAdminDashboard();
    } else {
      stopMonitorCameraPermission();
      viewerPeers.forEach(pc => { try { pc.close(); } catch {} }); viewerPeers.clear();

      if (isRefresh && camStream && _isCamStreamAlive(camStream)) {
        // ── REFRESH PATH ──────────────────────────────────────────
        // BUG FIX #2: stream masih hidup dari bfcache atau belum distop
        // Langsung restore sesi tanpa minta izin kamera lagi
        console.log('[Restore] Refresh terdeteksi — reuse camStream yang masih aktif');
        await _restoreViewerSession(savedSessionId);
      } else {
        // ── FRESH / STREAM MATI ───────────────────────────────────
        // Stream tidak ada atau sudah mati — harus request kamera baru
        if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
        try {
          try {
            camStream = await navigator.mediaDevices.getUserMedia(buildCamConstraints(currentFacingMode));
          } catch {
            // Fallback ke 480p jika 540p tidak didukung device
            camStream = await navigator.mediaDevices.getUserMedia({
              video: { facingMode: currentFacingMode || 'environment', width: { ideal: 854 }, height: { ideal: 480 }, frameRate: { ideal: 24 } },
              audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 }
            });
          }
          await _restoreViewerSession(savedSessionId);
          monitorCameraPermission();
        } catch {
          deleteCookie('lb_token'); sessionStorage.removeItem('lb_token'); sessionStorage.removeItem('lb_session_id');
          authToken = null; currentUser = null;
          resetLogin(); showScreen('screen-login');
          showLoginError('Izin kamera/mikrofon masih diblokir. Aktifkan kembali izin di pengaturan browser, lalu login ulang.');
        }
      }
    }
  } catch {}
}

// Cek apakah camStream masih punya track yang hidup
function _isCamStreamAlive(stream) {
  if (!stream) return false;
  const tracks = stream.getTracks();
  if (tracks.length === 0) return false;
  return tracks.every(t => t.readyState === 'live');
}

// Restore viewer session — reuse sessionId lama jika ada (BUG FIX #3)
// sehingga admin tidak melihat card duplikat setelah refresh
async function _restoreViewerSession(savedSessionId) {
  sessionStart = Date.now();
  document.getElementById('user-name-chip').textContent   = currentUser.name;
  document.getElementById('user-avatar-chip').textContent = currentUser.initial;
  const badgeName = document.getElementById('wm-badge-name');
  if (badgeName) badgeName.textContent = currentUser.name;
  showScreen('screen-watch');
  await loadFilmsFromAPI();
  renderFilmGrid();

  // BUG FIX #3: Coba pakai sessionId lama agar sesi di server tidak duplikat
  // /api/session/start dengan token yang sama akan overwrite sesi lama (idempoten)
  // sehingga admin hanya melihat 1 card untuk viewer yang sama
  try {
    const res  = await fetch(`${API_BASE}/api/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ film: CURRENT_FILM, camActive: true, micActive: true })
    });
    const d = await res.json();
    // sessionId dari server selalu token.slice(-8) — konsisten, tidak berubah
    mySessionId = d.sessionId || savedSessionId || `${currentUser.initial}-${Date.now()}`;
  } catch {
    // Fallback: gunakan savedSessionId agar konsisten dengan sesi sebelumnya
    mySessionId = savedSessionId || `${currentUser.initial}-${Date.now()}`;
  }

  // Simpan sessionId terbaru
  if (mySessionId) sessionStorage.setItem('lb_session_id', mySessionId);

  connectSocket_Viewer();
  monitorCameraPermission();

  // OPTIMASI JARINGAN: Sama seperti startWatchSession — ping 15s (bukan 5s)
  pingInterval = setInterval(async () => {
    const vt = camStream?.getVideoTracks()[0];
    const at = camStream?.getAudioTracks()[0];
    const camActive = !!(vt && vt.readyState === 'live' && vt.enabled);
    const micActive = !!(at && at.readyState === 'live' && at.enabled);
    await fetch(`${API_BASE}/api/session/ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ film: CURRENT_FILM, camActive, micActive })
    }).catch(() => {});
  }, 15000);

  sessionTimerInterval = setInterval(() => {
    const e = Math.floor((Date.now() - sessionStart) / 1000);
    const h = Math.floor(e / 3600), m = Math.floor((e % 3600) / 60), s = e % 60;
    document.getElementById('session-timer').textContent =
      `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }, 1000);
}

// ================================================================
// MONITOR KAMERA
// ================================================================
let _cameraMonitorInterval = null;

function monitorCameraPermission() {
  if (_cameraMonitorInterval) return;
  _cameraMonitorInterval = setInterval(() => {
    if (!camStream) return;
    const vt = camStream.getVideoTracks()[0], at = camStream.getAudioTracks()[0];
    if ((vt && vt.readyState === 'ended') || (at && at.readyState === 'ended')) {
      clearInterval(_cameraMonitorInterval); _cameraMonitorInterval = null;
      handlePermissionRevoked();
    }
  }, 1500);
}

function stopMonitorCameraPermission() {
  if (_cameraMonitorInterval) { clearInterval(_cameraMonitorInterval); _cameraMonitorInterval = null; }
}

function handlePermissionRevoked() {
  stopMonitorCameraPermission();
  let overlay = document.getElementById('permission-revoked-overlay');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = 'permission-revoked-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(5,7,14,.92);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:24px;';
  overlay.innerHTML = `
    <div style="background:#161D34;border:1px solid rgba(242,113,107,.35);border-radius:18px;padding:32px 28px;max-width:340px;width:100%;text-align:center;box-shadow:0 24px 64px rgba(0,0,0,.7);">
      <div style="width:64px;height:64px;border-radius:50%;background:rgba(242,113,107,.15);border:2px solid rgba(242,113,107,.4);display:flex;align-items:center;justify-content:center;font-size:1.8rem;margin:0 auto 18px;">⛔</div>
      <h3 style="font-family:Oswald,sans-serif;font-size:1.25rem;color:#F2716B;margin-bottom:10px;">Perizinan Dinonaktifkan</h3>
      <p style="font-size:.84rem;color:#8A91AC;line-height:1.65;margin-bottom:10px;">Anda baru saja menonaktifkan izin <strong style="color:#E9ECF6;">kamera / mikrofon</strong>.</p>
      <p style="font-size:.82rem;color:#8A91AC;line-height:1.65;margin-bottom:24px;">Akses ke platform membutuhkan perizinan aktif. Aktifkan kembali izin di pengaturan browser, lalu login ulang.</p>
      <div style="background:rgba(242,113,107,.08);border:1px solid rgba(242,113,107,.2);border-radius:10px;padding:10px 14px;margin-bottom:22px;font-size:.78rem;color:#F2716B;font-weight:600;">⏳ Sesi akan diakhiri dalam <span id="revoke-countdown">5</span> detik...</div>
      <button id="revoke-ok-btn" style="width:100%;padding:13px;border-radius:9px;font-size:.92rem;font-weight:700;background:#F2716B;border:none;color:#fff;cursor:pointer;">Akhiri Sesi Sekarang</button>
    </div>
  `;
  document.body.appendChild(overlay);
  let sisa = 5;
  const tick = setInterval(() => {
    sisa--;
    const el = document.getElementById('revoke-countdown');
    if (el) el.textContent = sisa;
    if (sisa <= 0) { clearInterval(tick); doRevokedLogout(); }
  }, 1000);
  document.getElementById('revoke-ok-btn').addEventListener('click', () => { clearInterval(tick); doRevokedLogout(); });
}

async function doRevokedLogout() {
  const overlay = document.getElementById('permission-revoked-overlay');
  if (overlay) overlay.remove();
  addAdminLog(currentUser?.name || 'Pengguna', 'izin kamera dicabut — sesi diakhiri otomatis', '#F2716B', 'error');
  await stopSession(false);
  // stopSession sudah menangani semua cleanup: token, cookies, camStream, socket, peers
  // Tampilkan bubble panduan cara aktifkan izin kembali di address bar
  setTimeout(() => showPermissionBubble(), 300);
}

// ================================================================
// FILM GRID — portrait, inline player saat diklik
// ================================================================
let currentPlayingId = null; // id film yang sedang diputar

// ── Pagination state ──────────────────────────────────────────
const FILMS_PER_PAGE_DESKTOP = 24;
const FILMS_PER_PAGE_MOBILE  = 24;
let   filmCurrentPage        = 1;

function getFilmsPerPage() {
  return window.innerWidth <= 768 ? FILMS_PER_PAGE_MOBILE : FILMS_PER_PAGE_DESKTOP;
}

function getTotalPages() {
  return Math.max(1, Math.ceil((FILMS || []).length / getFilmsPerPage()));
}

// Render grid + pagination (entry-point utama)
function renderFilmGrid() {
  filmCurrentPage = 1; // reset ke halaman 1 setiap data baru dimuat
  _renderPage();
}

function _renderPage() {
  const grid = document.getElementById('film-grid');
  if (!grid) return;
  grid.innerHTML = '';

  // ── Kosong / belum dimuat ──────────────────────────────────
  if (!FILMS || FILMS.length === 0) {
    grid.innerHTML = `
      <div class="fg-empty">
        <div class="fg-empty-icon">☁️</div>
        <div class="fg-empty-text">Memuat video dari Google Drive...</div>
      </div>
    `;
    _renderPagination(0);
    return;
  }

  // ── Slice halaman aktif ────────────────────────────────────
  const perPage = getFilmsPerPage();
  const total   = getTotalPages();
  filmCurrentPage = Math.min(Math.max(1, filmCurrentPage), total);

  const start   = (filmCurrentPage - 1) * perPage;
  const pageFilms = FILMS.slice(start, start + perPage);

  // ── Render kartu ──────────────────────────────────────────
  const isMobile = window.innerWidth <= 768;

  pageFilms.forEach(film => {
    const card = document.createElement('div');
    card.className = 'film-card';
    card.id        = `film-card-${film.id}`;

    const thumbUrl = film.thumb || `https://drive.google.com/thumbnail?id=${film.videoId}&sz=w480`;

    card.innerHTML = `
      <div class="fc-thumb">
        <img src="${thumbUrl}" alt="${film.title || 'Video'}" loading="lazy"
             onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22120%22 height=%2268%22%3E%3Crect fill=%22%231C1E24%22 width=%22120%22 height=%2268%22/%3E%3Ctext x=%2260%22 y=%2238%22 text-anchor=%22middle%22 fill=%22%23505870%22 font-size=%2224%22%3E▶%3C/text%3E%3C/svg%3E'"/>
        <div class="fc-thumb-overlay">
          <div class="fc-play-icon">▶</div>
        </div>
        ${isMobile ? '' : `<div class="fc-title-overlay">${film.title || 'Video'}</div>`}
      </div>
      ${isMobile ? '' : `
      <div class="fc-info">
        <div class="fc-title">${film.title || 'Video'}</div>
      </div>`}
    `;

    card.addEventListener('click', () => selectFilm(film));
    grid.appendChild(card);
  });

  // ── Pagination bar ─────────────────────────────────────────
  _renderPagination(total);
}

// Render pagination controls di bawah grid
function _renderPagination(totalPages) {
  // Hapus pagination lama jika ada
  const old = document.getElementById('film-pagination');
  if (old) old.remove();

  if (totalPages <= 1) return; // tidak perlu pagination jika hanya 1 halaman

  const main = document.querySelector('.watch-main');
  if (!main) return;

  const cur  = filmCurrentPage;
  const bar  = document.createElement('div');
  bar.id     = 'film-pagination';
  bar.className = 'film-pagination';

  // Hitung window halaman yang ditampilkan (maks 5 tombol)
  const WINDOW = 5;
  let   pStart = Math.max(1, cur - Math.floor(WINDOW / 2));
  let   pEnd   = Math.min(totalPages, pStart + WINDOW - 1);
  if (pEnd - pStart < WINDOW - 1) pStart = Math.max(1, pEnd - WINDOW + 1);

  // Tombol Prev
  const prevBtn = document.createElement('button');
  prevBtn.className = `fp-btn fp-prev${cur === 1 ? ' disabled' : ''}`;
  prevBtn.innerHTML = '‹';
  prevBtn.disabled  = cur === 1;
  prevBtn.onclick   = () => { filmCurrentPage--; _renderPage(); document.querySelector('.watch-main')?.scrollTo({ top: 0, behavior: 'smooth' }); };
  bar.appendChild(prevBtn);

  // Ellipsis awal
  if (pStart > 1) {
    const firstBtn = _fpBtn(1, cur);
    bar.appendChild(firstBtn);
    if (pStart > 2) bar.appendChild(_fpEllipsis());
  }

  // Tombol halaman
  for (let p = pStart; p <= pEnd; p++) {
    bar.appendChild(_fpBtn(p, cur));
  }

  // Ellipsis akhir
  if (pEnd < totalPages) {
    if (pEnd < totalPages - 1) bar.appendChild(_fpEllipsis());
    bar.appendChild(_fpBtn(totalPages, cur));
  }

  // Tombol Next
  const nextBtn = document.createElement('button');
  nextBtn.className = `fp-btn fp-next${cur === totalPages ? ' disabled' : ''}`;
  nextBtn.innerHTML = '›';
  nextBtn.disabled  = cur === totalPages;
  nextBtn.onclick   = () => { filmCurrentPage++; _renderPage(); document.querySelector('.watch-main')?.scrollTo({ top: 0, behavior: 'smooth' }); };
  bar.appendChild(nextBtn);

  // Info halaman
  const info = document.createElement('span');
  info.className = 'fp-info';
  info.textContent = `${cur} / ${totalPages}`;
  bar.appendChild(info);

  main.appendChild(bar);
}

function _fpBtn(page, cur) {
  const btn = document.createElement('button');
  btn.className = `fp-btn${page === cur ? ' active' : ''}`;
  btn.textContent = page;
  btn.onclick = () => { filmCurrentPage = page; _renderPage(); document.querySelector('.watch-main')?.scrollTo({ top: 0, behavior: 'smooth' }); };
  return btn;
}
function _fpEllipsis() {
  const sp = document.createElement('span');
  sp.className = 'fp-ellipsis';
  sp.textContent = '…';
  return sp;
}

function selectFilm(film) {
  if (!camStream) { alert('Kamera tidak aktif!'); return; }

  currentPlayingId = film.id;
  CURRENT_FILM     = film.title;

  const modal   = document.getElementById('fs-modal');
  const video   = document.getElementById('fs-video');
  const title   = document.getElementById('fs-title');
  const loading = document.getElementById('fs-loading');
  const errEl   = document.getElementById('fs-error');

  // Pakai proxy server (/api/proxy-video) — video native tanpa kontrol GDrive
  const token    = authToken || getCookie('lb_token') || sessionStorage.getItem('lb_token') || '';
  const videoUrl = `${API_BASE}/api/proxy-video?id=${film.fileId || film.videoId}${token ? '&token=' + encodeURIComponent(token) : ''}`;

  if (title)   title.textContent = film.title;
  if (loading) loading.style.display = 'flex';
  if (errEl)   errEl.style.display   = 'none';

  if (video) {
    video.src = videoUrl;
    video._retried = false; // BUG FIX #6: reset retry flag setiap kali ganti film

    // Lag Fix 3: Pakai { once: true } agar listener canplay otomatis terhapus setelah fire.
    // Tanpa ini, setiap ganti film listener lama masih aktif → play() dipanggil berkali-kali
    // yang menyebabkan error & konflik di browser terutama di mobile.
    video.addEventListener('canplay', () => {
      // BUG FIX #5 (Black Screen): 'controls' tidak terdefinisi di scope selectFilm.
      // Sebelumnya: ReferenceError diam-diam → play() gagal → layar hitam.
      // Sekarang: ambil elemen langsung dari DOM.
      const ctrl = document.getElementById('fs-controls');
      video.play().catch(() => {
        if (ctrl) ctrl.classList.add('visible');
      });
    }, { once: true });

    // BUG FIX #6 (Black Screen): Auto-retry sekali jika proxy GDrive gagal load.
    // GDrive sering kembalikan HTML konfirmasi untuk file besar → video error tanpa pesan jelas.
    video.addEventListener('error', () => {
      const loading = document.getElementById('fs-loading');
      const errEl   = document.getElementById('fs-error');
      if (loading) loading.style.display = 'none';
      if (!video._retried) {
        video._retried = true;
        console.warn('[Video] Error load, auto-retry dalam 2s...');
        if (loading) loading.style.display = 'flex';
        if (errEl)   errEl.style.display   = 'none';
        setTimeout(() => {
          video.load();
          video.play().catch(() => {});
        }, 2000);
      } else {
        if (errEl) errEl.style.display = 'flex';
      }
    }, { once: false });

    video.load();
  }

  if (modal) modal.classList.add('open');
  document.body.style.overflow = 'hidden';

  // Setup custom controls setelah video siap
  fsInitControls();

  if (socket) socket.emit('film-selected', { film: film.title, videoId: film.videoId, sessionId: mySessionId });
  addAdminLog(currentUser?.name || 'User', `Menonton: ${film.title}`, '#2E6FF2', 'info');
}

function closeFsModal() {
  // Keluar fullscreen dulu jika sedang aktif — cegah layar freeze
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    const exitFs = document.exitFullscreen || document.webkitExitFullscreen;
    if (exitFs) {
      exitFs.call(document).catch(() => {}).finally(() => _doCloseFsModal());
      return; // _doCloseFsModal dipanggil setelah fullscreen benar-benar keluar
    }
  }
  _doCloseFsModal();
}

function _doCloseFsModal() {
  const modal = document.getElementById('fs-modal');
  const video = document.getElementById('fs-video');
  const controls = document.getElementById('fs-controls');
  if (video) { video.pause(); video.src = ''; video.load(); }
  if (controls) controls.classList.remove('visible');
  if (modal) modal.classList.remove('open');
  document.body.style.overflow = '';
  currentPlayingId = null;
}

// ================================================================
// CUSTOM VIDEO CONTROLS
// ================================================================
let _fsControlsInited = false;

function fsInitControls() {
  const video    = document.getElementById('fs-video');
  const progress = document.getElementById('fs-progress');
  const timeEl   = document.getElementById('fs-time');
  const playBtn  = document.getElementById('fs-play-btn');
  const volSlider = document.getElementById('fs-vol');
  const loading  = document.getElementById('fs-loading');
  const errEl    = document.getElementById('fs-error');
  const retryBtn = document.getElementById('fs-retry-btn');
  const controls = document.getElementById('fs-controls');

  if (!video) return;

  // Reset progress
  if (progress) { progress.value = 0; progress.max = 100; }

  // Event listeners hanya pasang sekali
  if (!_fsControlsInited) {
    _fsControlsInited = true;

    video.addEventListener('loadedmetadata', () => {
      if (progress) progress.max = video.duration;
      if (loading)  loading.style.display = 'none';
    });

    video.addEventListener('waiting', () => {
      if (loading) loading.style.display = 'flex';
    });

    video.addEventListener('playing', () => {
      if (loading) loading.style.display = 'none';
      if (playBtn) playBtn.textContent = '⏸';
    });

    video.addEventListener('pause', () => {
      if (playBtn) playBtn.textContent = '▶';
    });

    video.addEventListener('ended', () => {
      if (playBtn) playBtn.textContent = '▶';
    });

    video.addEventListener('timeupdate', () => {
      if (!progress || !timeEl) return;
      progress.value = video.currentTime;
      const cur = fsFmtTime(video.currentTime);
      const dur = isNaN(video.duration) ? '0:00' : fsFmtTime(video.duration);
      timeEl.textContent = `${cur} / ${dur}`;
    });

    video.addEventListener('error', () => {
      if (loading) loading.style.display = 'none';
      if (errEl)   errEl.style.display   = 'flex';
    });

    if (progress) {
      progress.addEventListener('input', () => { video.currentTime = progress.value; });
    }

    if (volSlider) {
      volSlider.addEventListener('input', () => {
        video.volume = volSlider.value;
        const muteBtn = document.getElementById('fs-mute-btn');
        if (muteBtn) muteBtn.textContent = volSlider.value == 0 ? '🔇' : '🔊';
      });
    }

    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        if (errEl) errEl.style.display = 'none';
        if (loading) loading.style.display = 'flex';
        video.load(); video.play().catch(() => {});
      });
    }

    // Auto-hide controls saat tidak ada interaksi
    let _hideTimer;
    const showControls = () => {
      if (controls) controls.classList.add('visible');
      clearTimeout(_hideTimer);
      _hideTimer = setTimeout(() => {
        if (!video.paused && controls) controls.classList.remove('visible');
      }, 3000);
    };
    document.getElementById('fs-modal')?.addEventListener('touchstart', showControls, { passive: true });
    document.getElementById('fs-modal')?.addEventListener('mousemove', showControls);
    showControls();
  }
}

function fsFmtTime(s) {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2,'0')}`;
}

function fsTogglePlay() {
  const video = document.getElementById('fs-video');
  if (!video) return;
  if (video.paused) video.play().catch(() => {});
  else video.pause();
}

function fsSeek(sec) {
  const video = document.getElementById('fs-video');
  if (!video) return;
  video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + sec));
}

function fsToggleMute() {
  const video   = document.getElementById('fs-video');
  const muteBtn = document.getElementById('fs-mute-btn');
  const vol     = document.getElementById('fs-vol');
  if (!video) return;
  video.muted = !video.muted;
  if (muteBtn) muteBtn.textContent = video.muted ? '🔇' : '🔊';
  if (vol) vol.value = video.muted ? 0 : video.volume;
}

function fsFullscreen() {
  const wrap = document.getElementById('fs-modal');
  const btn  = document.getElementById('fs-full-btn') || document.querySelector('.fs-full-btn');
  if (!wrap) return;

  const isFs = document.fullscreenElement || document.webkitFullscreenElement;
  if (isFs) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) exit.call(document).catch(() => {});
  } else {
    const enter = wrap.requestFullscreen || wrap.webkitRequestFullscreen;
    if (enter) enter.call(wrap).catch(() => {});
  }
}

// Listen fullscreenchange — update icon tombol & tangani tombol Back Android
function _onFullscreenChange() {
  const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
  const btn  = document.getElementById('fs-full-btn') || document.querySelector('.fs-full-btn');
  if (btn) btn.textContent = isFs ? '⊡' : '⛶';
}
document.addEventListener('fullscreenchange',       _onFullscreenChange);
document.addEventListener('webkitfullscreenchange', _onFullscreenChange);

// Tutup modal kalau tap di luar area inner (backdrop)
document.addEventListener('DOMContentLoaded', () => {
  const modal = document.getElementById('fs-modal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeFsModal();
    });
  }
});

function closeInlinePlayer(filmId) {
  closeFsModal();
}

// Fungsi loadGDriveVideo tetap ada agar referensi lain tidak error
function loadGDriveVideo(film) {
  selectFilm(film);
}

// Load films dari API (Google Drive)
async function loadFilmsFromAPI() {
  try {
    const token = authToken || getCookie('lb_token') || sessionStorage.getItem('lb_token') || '';
    const res  = await fetch(`${API_BASE}/api/films`, {
      headers: token ? { 'Authorization': `Bearer ${token}` } : {}
    });
    const data = await res.json();
    if (data.success && Array.isArray(data.films) && data.films.length > 0) {
      FILMS.length = 0;
      data.films.forEach(f => FILMS.push(f));
      console.log(`[FILMS] ${FILMS.length} film dimuat dari Google Drive`);
    } else {
      console.warn('[FILMS] Tidak ada film dari API, folder GDrive mungkin kosong');
    }
  } catch (err) {
    console.warn('[FILMS] Gagal load dari API:', err.message);
  }
}



// ================================================================
// DOMContentLoaded
// ================================================================
window.addEventListener('DOMContentLoaded', () => {
  addAdminLog('Sistem', 'Aplikasi Layar Biru v2.1 dimuat (GDrive Mode)', '#5B8CFF', 'system');
  restoreSession();

  // Re-render grid jika ukuran layar berubah (landscape ↔ portrait)
  let _resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      if (document.getElementById('screen-watch')?.classList.contains('active')) {
        _renderPage();
      }
    }, 250);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && currentExpandedSession) closeExpandSession();
  });

  const btnLogin = document.getElementById('btn-login');
  if (btnLogin) {
    btnLogin.dataset.mode = 'check';
    btnLogin.addEventListener('click', () => {
      if (btnLogin.dataset.mode === 'login') {
        const passEl = document.getElementById('login-pass');
        doLogin(btnLogin.dataset.adminName, passEl.value);
      } else {
        checkAndLogin();
      }
    });
  }

  const nameEl = document.getElementById('login-name');
  if (nameEl) {
    nameEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); const btn = document.getElementById('btn-login'); if (!btn.disabled) btn.click(); } });
    nameEl.addEventListener('input', () => {
      nameEl.classList.remove('input-error');
      document.getElementById('login-error').classList.remove('show');
      document.getElementById('password-section').style.display = 'none';
      document.getElementById('admin-detected').style.display   = 'none';
      document.getElementById('btn-text').textContent = 'Masuk & Mulai Nonton';
      const btn = document.getElementById('btn-login');
      if (btn) { btn.dataset.mode = 'check'; delete btn.dataset.adminName; }
    });
  }

  const passEl = document.getElementById('login-pass');
  if (passEl) {
    passEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); const btn = document.getElementById('btn-login'); if (!btn.disabled) btn.click(); } });
    passEl.addEventListener('input', () => { passEl.classList.remove('input-error'); document.getElementById('login-error').classList.remove('show'); });
  }
});

// ================================================================
// BUG FIX #1 — Bedakan REFRESH vs CLOSE TAB
// Masalah: beforeunload selalu kirim /api/logout via sendBeacon
// saat refresh → token dihapus server → sesi hilang → kamera
// minta izin ulang di mobile. Solusi: pakai flag sessionStorage
// 'lb_refreshing'. Jika flag ada saat load = refresh, skip logout.
// ================================================================
window.addEventListener('beforeunload', () => {
  // Tandai sebagai refresh agar restoreSession tahu ini bukan close tab
  if (authToken && currentUser && currentUser.role === 'viewer') {
    sessionStorage.setItem('lb_refreshing', '1');
    // BUG FIX #3: simpan sessionId lama agar bisa di-reuse setelah refresh
    if (mySessionId) sessionStorage.setItem('lb_session_id', mySessionId);
  }

  // Tutup WebRTC peers agar resource dibebaskan
  viewerPeers.forEach(pc => { try { pc.close(); } catch {} });
  adminPeers.forEach(e  => { try { e.pc.close(); } catch {} });

  // Cabut listener disconnect dulu agar tidak trigger log ganda
  if (socket) { socket.off('disconnect'); socket.disconnect(); }

  // JANGAN stop camStream di sini — browser mobile akan minta izin kamera lagi
  // JANGAN sendBeacon logout untuk viewer — sesi harus tetap hidup untuk restore
  // Admin tidak punya sesi kamera, tetap logout normal
  if (!currentUser || currentUser.role !== 'viewer') {
    if (authToken) navigator.sendBeacon(`${API_BASE}/api/logout`, '{}');
  }
});


window.addEventListener('pagehide', () => {
  // Jangan stop camStream di pagehide — browser mobile pakai bfcache,
  // stream bisa di-reuse langsung tanpa request izin ulang
});



