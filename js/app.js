// Margin Watcher — Main App Logic
// Requires js/config.js (not committed to git)

let currentImageBase64 = null;
let isProcessing = false;

// ─── INIT ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  if (typeof CONFIG === 'undefined') { showConfigError(); return; }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(console.error);
  }

  loadDashboard();
});

// ─── API ─────────────────────────────────────────────────────────────────────

async function apiCall(action, data = {}) {
  const payload = { token: CONFIG.TOKEN, action, ...data };

  // Use Content-Type: text/plain to skip CORS preflight with GAS
  const res = await fetch(CONFIG.GAS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(payload),
    redirect: 'follow',
  });

  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

// ─── DASHBOARD ───────────────────────────────────────────────────────────────

async function loadDashboard() {
  try {
    const data = await apiCall('getDashboard');
    renderDashboard(data);
  } catch (err) {
    console.error(err);
    renderError('Verbindung zu Google Apps Script fehlgeschlagen.<br>Prüfe die GAS_URL in js/config.js.');
  }
}

function renderDashboard(data) {
  document.getElementById('lastScan').textContent =
    data.lastScan ? `Letzter Scan: ${formatTime(data.lastScan)}` : 'Noch kein Scan';

  document.getElementById('countCritical').textContent = data.countCritical ?? 0;
  document.getElementById('countWarning').textContent  = data.countWarning ?? 0;
  document.getElementById('countOk').textContent       = data.countOk ?? 0;

  renderAlerts(data.alerts || []);
  renderRecentScans(data.recentScans || []);

  if (data.pendingMappings?.length > 0) {
    renderMappings(data.pendingMappings);
  } else {
    document.getElementById('mappingSection').classList.add('hidden');
  }
}

function renderAlerts(alerts) {
  const el = document.getElementById('alertsList');
  if (alerts.length === 0) {
    el.innerHTML = `
      <div class="bg-white border border-gray-200 rounded-xl py-8 text-center">
        <div class="text-3xl mb-2">✅</div>
        <p class="text-sm font-semibold text-gray-600">Alles grün</p>
        <p class="text-xs text-gray-400 mt-1">Keine offenen Warnungen</p>
      </div>`;
    return;
  }

  const cfg = {
    CRITICAL: { bg: 'bg-red-50',    border: 'border-red-200',    badge: 'bg-red-100 text-red-700',    icon: '🔴' },
    WARNING:  { bg: 'bg-yellow-50', border: 'border-yellow-200', badge: 'bg-yellow-100 text-yellow-700', icon: '🟡' },
    DELIVERY: { bg: 'bg-blue-50',   border: 'border-blue-200',   badge: 'bg-blue-100 text-blue-700',   icon: '📦' },
  };

  el.innerHTML = alerts.map(a => {
    const c = cfg[a.typ] || cfg.WARNING;
    const priceChange = a.altPreis && a.neuPreis
      ? `<span class="text-xs text-gray-500 self-center ml-2">${a.altPreis} € → <strong class="text-red-600">${a.neuPreis} €</strong></span>`
      : '';
    const recipes = a.betroffeneRezepte?.length
      ? `<p class="text-xs text-gray-400 mt-1">Gerichte: ${a.betroffeneRezepte.map(r => esc(r)).join(', ')}</p>` : '';

    return `
      <div class="${c.bg} border ${c.border} rounded-xl p-4 mb-2.5 slide-up">
        <div class="flex items-center justify-between mb-1.5">
          <span class="font-semibold text-sm">${c.icon} ${esc(a.produkt)}</span>
          <span class="text-xs ${c.badge} px-2 py-0.5 rounded-full font-semibold">${a.typ}</span>
        </div>
        <p class="text-xs text-gray-600">${esc(a.beschreibung)}</p>
        ${recipes}
        <div class="flex items-center mt-2.5">
          <button onclick="resolveAlert('${esc(a.logId)}')"
            class="text-xs bg-white border border-gray-300 text-gray-600 px-3 py-1 rounded-lg hover:bg-gray-50 active:scale-95 transition-all font-medium">
            ✓ Erledigt
          </button>
          ${priceChange}
        </div>
      </div>`;
  }).join('');
}

function renderMappings(mappings) {
  document.getElementById('mappingSection').classList.remove('hidden');
  document.getElementById('mappingsList').innerHTML = mappings.map(m => `
    <div class="bg-purple-50 border border-purple-200 rounded-xl p-4 mb-2.5">
      <p class="text-xs text-purple-500 font-bold mb-1">Nicht erkannt vom Lieferanten:</p>
      <p class="font-semibold text-sm mb-3 text-gray-800">"${esc(m.lieferantName)}"</p>
      <div class="space-y-1.5">
        ${m.vorschlaege.map(v => `
          <button onclick="confirmMapping('${esc(m.lieferantName)}', '${esc(v)}')"
            class="w-full text-left text-sm bg-white border border-purple-200 rounded-lg px-3 py-2 hover:bg-purple-100 active:scale-95 transition-all">
            → ${esc(v)}
          </button>`).join('')}
        <button onclick="skipMapping(this)"
          class="w-full text-xs text-gray-400 py-1.5 hover:text-gray-600">
          Überspringen
        </button>
      </div>
    </div>`).join('');
}

function renderRecentScans(scans) {
  const el = document.getElementById('recentScans');
  if (scans.length === 0) {
    el.innerHTML = '<p class="text-sm text-gray-400 py-5 text-center">Noch keine Scans</p>';
    return;
  }
  el.innerHTML = scans.map(s => {
    const icon = s.typ === 'gmail' ? '📧' : '📷';
    const badge = parseInt(s.anzahlFlags) > 0
      ? `<span class="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full font-medium">${s.anzahlFlags} Flag${s.anzahlFlags > 1 ? 's' : ''}</span>`
      : `<span class="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">OK</span>`;
    return `
      <div class="flex items-center gap-3 px-4 py-3">
        <span class="text-lg flex-shrink-0">${icon}</span>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-medium text-gray-800 truncate">${esc(s.quelle)}</p>
          <p class="text-xs text-gray-400">${formatTime(s.zeitstempel)} · ${s.positionen} Pos.</p>
        </div>
        ${badge}
      </div>`;
  }).join('');
}

function renderError(msg) {
  document.getElementById('lastScan').textContent = 'Fehler';
  document.getElementById('alertsList').innerHTML = `
    <div class="bg-orange-50 border border-orange-300 rounded-xl p-5">
      <p class="font-bold text-orange-800 mb-1.5">⚙️ Verbindungsfehler</p>
      <p class="text-sm text-orange-700">${msg}</p>
    </div>`;
}

// ─── SYNC ────────────────────────────────────────────────────────────────────

async function manualSync() {
  const icon = document.getElementById('syncIcon');
  icon.classList.add('spin');
  try {
    await apiCall('triggerScan');
    showToast('Gmail wird gescannt…', 'success');
    setTimeout(loadDashboard, 4000);
  } catch {
    showToast('Sync fehlgeschlagen', 'error');
  } finally {
    setTimeout(() => icon.classList.remove('spin'), 1500);
  }
}

// ─── CAMERA ──────────────────────────────────────────────────────────────────

function openCamera() {
  currentImageBase64 = null;
  document.getElementById('processBtn').classList.add('hidden');
  document.getElementById('ocrResult').classList.add('hidden');
  document.getElementById('imagePreview').innerHTML = `
    <div class="text-center text-gray-600 px-6">
      <svg class="w-14 h-14 mx-auto mb-3 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
          d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/>
      </svg>
      <p class="text-sm text-gray-500">Foto aufnehmen oder Datei auswählen</p>
    </div>`;
  document.getElementById('cameraModal').classList.remove('hidden');
}

function closeCameraModal() {
  document.getElementById('cameraModal').classList.add('hidden');
  currentImageBase64 = null;
}

function handleImageCapture(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = e => {
    const dataUrl = e.target.result;
    document.getElementById('imagePreview').innerHTML =
      `<img src="${dataUrl}" class="w-full h-full object-contain rounded-2xl" style="max-height: min(55vh, 400px);">`;
    currentImageBase64 = dataUrl.split(',')[1];
    document.getElementById('processBtn').classList.remove('hidden');
  };
  reader.readAsDataURL(file);
  event.target.value = '';
}

async function processImage() {
  if (!currentImageBase64 || isProcessing) return;
  isProcessing = true;

  document.getElementById('processingText').textContent = 'Analysiere via Google Drive OCR…';
  document.getElementById('processingOverlay').classList.remove('hidden');

  try {
    const result = await apiCall('scanDelivery', { image: currentImageBase64 });

    document.getElementById('processingOverlay').classList.add('hidden');

    if (result.extractedText) {
      document.getElementById('ocrText').textContent = result.extractedText;
      document.getElementById('ocrResult').classList.remove('hidden');
    }

    if (result.flags?.length > 0) {
      showToast(`${result.flags.length} Abweichung(en) gefunden!`, 'warning');
    } else if (result.success) {
      showToast(`Lieferschein OK · ${result.positions ?? 0} Positionen`, 'success');
    } else {
      showToast(result.error || 'Kein Text erkannt', 'error');
    }

    setTimeout(() => { closeCameraModal(); loadDashboard(); }, 2500);
  } catch (err) {
    document.getElementById('processingOverlay').classList.add('hidden');
    showToast('Fehler bei der Verarbeitung', 'error');
    console.error(err);
  } finally {
    isProcessing = false;
  }
}

// ─── ACTIONS ─────────────────────────────────────────────────────────────────

async function resolveAlert(logId) {
  try {
    await apiCall('resolveAlert', { logId });
    showToast('Als erledigt markiert ✓', 'success');
    loadDashboard();
  } catch {
    showToast('Fehler beim Aktualisieren', 'error');
  }
}

async function confirmMapping(lieferantName, rezeptName) {
  try {
    await apiCall('saveMapping', { lieferantName, rezeptName });
    showToast(`Zuordnung gespeichert`, 'success');
    loadDashboard();
  } catch {
    showToast('Fehler beim Speichern', 'error');
  }
}

function skipMapping(btn) {
  btn.closest('.bg-purple-50').remove();
  const remaining = document.querySelectorAll('#mappingsList .bg-purple-50');
  if (remaining.length === 0) document.getElementById('mappingSection').classList.add('hidden');
}

// ─── CONFIG ERROR ─────────────────────────────────────────────────────────────

function showConfigError() {
  document.getElementById('lastScan').textContent = 'Setup erforderlich';
  document.getElementById('countCritical').textContent = '?';
  document.getElementById('countWarning').textContent  = '?';
  document.getElementById('countOk').textContent       = '?';
  document.getElementById('alertsList').innerHTML = `
    <div class="bg-orange-50 border border-orange-300 rounded-xl p-5">
      <h3 class="font-bold text-orange-800 mb-2">⚙️ Einmalige Einrichtung</h3>
      <p class="text-sm text-orange-700 mb-3">
        Erstelle <code class="bg-orange-100 px-1 rounded font-mono text-xs">js/config.js</code>
        aus der Vorlage <code class="bg-orange-100 px-1 rounded font-mono text-xs">js/config.template.js</code>.
      </p>
      <ol class="text-sm text-orange-700 list-decimal list-inside space-y-1.5">
        <li>Google Apps Script deployen (Code aus <code class="font-mono text-xs">gas/Code.gs</code>)</li>
        <li>Deployment-URL und Token in <code class="font-mono text-xs">config.js</code> eintragen</li>
        <li>Seite neu laden</li>
      </ol>
      <p class="text-xs text-orange-500 mt-3">
        ⚠️ <code class="font-mono">config.js</code> niemals committen — steht in <code class="font-mono">.gitignore</code>
      </p>
    </div>`;
}

// ─── UTILS ───────────────────────────────────────────────────────────────────

function showToast(msg, type = 'info') {
  const colors = { success: 'bg-green-600', error: 'bg-red-600', warning: 'bg-yellow-500', info: 'bg-gray-800' };
  const el = document.getElementById('toastContent');
  el.className = `rounded-xl px-4 py-2 text-white text-sm font-medium shadow-xl slide-up ${colors[type] || colors.info}`;
  el.textContent = msg;
  const toast = document.getElementById('toast');
  toast.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.add('hidden'), 3000);
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso), now = new Date();
  const m = Math.floor((now - d) / 60000);
  if (m < 1)    return 'Gerade eben';
  if (m < 60)   return `vor ${m} Min.`;
  if (m < 1440) return `vor ${Math.floor(m / 60)} Std.`;
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
