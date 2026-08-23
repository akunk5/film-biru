// OFFLINE GUARD — blokir layar saat internet mati
(function() {
  function setupOfflineGuard() {
    const overlay = document.createElement('div');
    overlay.id = 'offline-overlay';
    overlay.style.cssText = [
      'display:none', 'position:fixed', 'inset:0', 'z-index:9999999',
      'background:rgba(10,10,20,0.97)',
      'flex-direction:column', 'align-items:center', 'justify-content:center',
      'font-family:Inter,sans-serif', 'text-align:center', 'padding:32px'
    ].join(';');
    overlay.innerHTML =
      '<div style="font-size:3.5rem;margin-bottom:16px;">📡</div>' +
      '<div style="font-size:1.3rem;font-weight:700;color:#fff;margin-bottom:10px;">Koneksi Terputus</div>' +
      '<div style="font-size:0.9rem;color:#8A91AC;margin-bottom:28px;line-height:1.6;">' +
        'Internet kamu terputus.<br>Sambungkan kembali untuk melanjutkan.' +
      '</div>' +
      '<div id="offline-checking" style="display:none;font-size:0.82rem;color:#4ADE80;">⏳ Memeriksa koneksi...</div>';
    document.body.appendChild(overlay);

    function showOffline() {
      overlay.style.display = 'flex';
    }

    function hideOffline() {
      var el = document.getElementById('offline-checking');
      if (el) el.style.display = 'block';
      setTimeout(function() {
        overlay.style.display = 'none';
        if (el) el.style.display = 'none';
      }, 1000);
    }

    window.addEventListener('offline', showOffline);
    window.addEventListener('online', hideOffline);
    if (!navigator.onLine) showOffline();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupOfflineGuard);
  } else {
    setupOfflineGuard();
  }
})();
