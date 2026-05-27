// ============================================================
// PROCUREMENT & MARGIN WATCHER — Google Apps Script Backend
// ============================================================
// SETUP:
//   1. Öffne dein Google Sheet (Rezeptdatenbank)
//   2. Erweiterungen → Apps Script → diesen Code einfügen
//   3. Projekt-Einstellungen → Script-Eigenschaften → SECRET_TOKEN setzen
//   4. Services → Drive API aktivieren (für OCR)
//   5. Deployen als Web-App:
//      - Ausführen als: Ich (dein Google-Konto)
//      - Zugriff: Jeder (anonym)
//   6. Deployment-URL in js/config.js eintragen
//   7. setupTriggers() einmal manuell ausführen (Gmail-Scan alle 60 Min.)
// ============================================================

// Token wird aus Script Properties gelesen — niemals hardcoden!
function getToken() {
  return PropertiesService.getScriptProperties().getProperty('SECRET_TOKEN');
}

// ─── ENTRY POINTS ────────────────────────────────────────────────────────────

function doPost(e) {
  const out = ContentService.createTextOutput()
    .setMimeType(ContentService.MimeType.JSON);

  try {
    const p = JSON.parse(e.postData.contents);

    if (p.token !== getToken()) {
      out.setContent(JSON.stringify({ error: 'Unauthorized' }));
      return out;
    }

    const actions = {
      getDashboard:  () => getDashboard(),
      scanDelivery:  () => scanDelivery(p.image),
      triggerScan:   () => scanGmail(),
      resolveAlert:  () => resolveAlert(p.logId),
      saveMapping:   () => saveMapping(p.lieferantName, p.rezeptName),
    };

    const fn = actions[p.action];
    out.setContent(JSON.stringify(fn ? fn() : { error: 'Unknown action: ' + p.action }));
  } catch (err) {
    out.setContent(JSON.stringify({ error: err.message }));
  }

  return out;
}

function doGet() {
  return ContentService.createTextOutput(
    JSON.stringify({ status: 'Margin Watcher API aktiv', timestamp: new Date().toISOString() })
  ).setMimeType(ContentService.MimeType.JSON);
}

// ─── DASHBOARD ───────────────────────────────────────────────────────────────

function getDashboard() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const logSheet  = getOrCreateSheet(ss, 'Log_Fehler',
    ['LogID','Datum','Typ','Beschreibung','Produkt','AltPreis','NeuPreis','BetroffeneRezepte','Status','Quelle']);
  const scanSheet = getOrCreateSheet(ss, 'Log_Scans',
    ['ScanID','Zeitstempel','Typ','Quelle','Positionen','AnzahlFlags','Status']);

  const logs  = sheetToObjects(logSheet);
  const scans = sheetToObjects(scanSheet);

  const open     = logs.filter(l => l.Status === 'Offen');
  const critical = open.filter(l => l.Typ === 'CRITICAL');
  const warnings = open.filter(l => l.Typ === 'WARNING' || l.Typ === 'DELIVERY');

  const today     = new Date().toDateString();
  const todayOk   = scans.filter(s =>
    new Date(s.Zeitstempel).toDateString() === today && (s.AnzahlFlags === '0' || s.AnzahlFlags === 0)
  ).length;

  const lastScan = scans.length > 0 ? scans[scans.length - 1].Zeitstempel : null;

  const alerts = [...critical, ...warnings].slice(0, 20).map(l => ({
    logId:            l.LogID,
    typ:              l.Typ,
    produkt:          l.Produkt,
    beschreibung:     l.Beschreibung,
    altPreis:         l.AltPreis  || null,
    neuPreis:         l.NeuPreis  || null,
    betroffeneRezepte: l.BetroffeneRezepte ? String(l.BetroffeneRezepte).split(',').filter(Boolean) : [],
  }));

  return {
    lastScan,
    countCritical:   critical.length,
    countWarning:    warnings.length,
    countOk:         todayOk,
    alerts,
    pendingMappings: getPendingMappings(ss),
    recentScans:     scans.slice(-10).reverse().map(s => ({
      typ:         s.Typ,
      quelle:      s.Quelle,
      zeitstempel: s.Zeitstempel,
      positionen:  s.Positionen,
      anzahlFlags: s.AnzahlFlags,
    })),
  };
}

// ─── GMAIL SCAN ──────────────────────────────────────────────────────────────

function scanGmail() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let processed = 0, flags = 0;

  const queries = [
    'subject:(Rechnung OR Invoice) is:unread has:attachment',
    'subject:(Bestellung OR Order OR Lieferschein) is:unread has:attachment',
  ];

  for (const q of queries) {
    const threads = GmailApp.search(q, 0, 15);
    for (const thread of threads) {
      for (const msg of thread.getMessages()) {
        if (!msg.isUnread()) continue;
        flags += processEmail(ss, msg);
        processed++;
        msg.markRead();
      }
    }
  }

  return { processed, flags };
}

function processEmail(ss, msg) {
  let flagCount = 0;
  for (const att of msg.getAttachments()) {
    const mime = att.getContentType();
    if (!mime.startsWith('application/pdf') && !mime.startsWith('image/')) continue;

    const text = ocrWithDrive(att.copyBlob());
    if (!text || text.trim().length < 10) continue;

    const positions = extractPositions(text);
    flagCount += checkPricesAndLog(ss, positions, msg.getFrom(), 'gmail');
    logScan(ss, 'gmail', msg.getFrom(), positions.length, flagCount);
  }
  return flagCount;
}

// ─── DELIVERY SCAN (Kamera) ───────────────────────────────────────────────────

function scanDelivery(base64Image) {
  if (!base64Image) return { success: false, error: 'Kein Bild übermittelt' };

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  try {
    const bytes = Utilities.base64Decode(base64Image);
    const blob  = Utilities.newBlob(bytes, 'image/jpeg', 'lieferschein_' + Date.now() + '.jpg');
    const text  = ocrWithDrive(blob);

    if (!text || text.trim().length < 5) {
      return { success: false, error: 'Text konnte nicht erkannt werden', extractedText: '' };
    }

    const positions  = extractPositions(text);
    const flagCount  = checkPricesAndLog(ss, positions, 'Kamera-Scan', 'kamera');
    logScan(ss, 'kamera', 'Lieferschein', positions.length, flagCount);

    return {
      success:       true,
      extractedText: text.substring(0, 600),
      positions:     positions.length,
      flags:         flagCount > 0 ? [{ count: flagCount }] : [],
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── OCR VIA GOOGLE DRIVE (kostenlos, kein externer API-Key) ─────────────────

function ocrWithDrive(blob) {
  let fileId = null;
  try {
    // Drive konvertiert beim Upload automatisch in Google Doc → OCR wird angewendet
    const file = Drive.Files.insert(
      { title: 'ocr_temp_' + Date.now(), mimeType: 'application/vnd.google-apps.document' },
      blob,
      { convert: true }
    );
    fileId = file.id;

    const text = DocumentApp.openById(fileId).getBody().getText();
    return text;
  } catch (err) {
    Logger.log('OCR-Fehler: ' + err.message);
    return '';
  } finally {
    if (fileId) {
      try { DriveApp.getFileById(fileId).setTrashed(true); } catch (_) {}
    }
  }
}

// ─── TEXT-PARSING ─────────────────────────────────────────────────────────────

function extractPositions(text) {
  const positions = [];
  const lines = text.split('\n');

  for (const line of lines) {
    const t = line.trim();
    if (t.length < 3) continue;

    // Preis erkennen: z.B. "12,50 €" oder "12.50€"
    const prices = [...t.matchAll(/(\d+)[,.](\d{2})\s*[€E]?(?:\s|$)/g)];
    // Menge erkennen: z.B. "5 kg", "2.5l", "10x"
    const qty = t.match(/(\d+[,.]?\d*)\s*(kg|g|l|ml|st[ück]*|stk|pcs?|x)\b/i);

    if (prices.length === 0 && !qty) continue;

    // Produktname: Text vor den ersten Ziffern
    const nameMatch = t.match(/^([A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß0-9\s\-\.\/]+)/);
    const name = nameMatch ? nameMatch[1].trim() : '';
    if (name.length < 2) continue;

    const preis = prices.length > 0
      ? parseFloat(prices[prices.length - 1][1] + '.' + prices[prices.length - 1][2])
      : null;
    const menge  = qty ? parseFloat(qty[1].replace(',', '.')) : null;
    const einheit = qty ? qty[2].toLowerCase() : null;

    positions.push({ name, menge, einheit, preis, rawLine: t });
  }

  // Deduplizieren
  return positions.filter((p, i, arr) => arr.findIndex(x => x.rawLine === p.rawLine) === i);
}

// ─── PREIS- & MARGENPRÜFUNG ───────────────────────────────────────────────────

function checkPricesAndLog(ss, positions, quelle, typ) {
  const priceSheet = getOrCreateSheet(ss, 'Zutaten_Preise',
    ['ZutatenID','Name','LieferantSKU','AktuellerPreis','BasisPreis','Einheit','Zeitstempel']);
  const mappingSheet = getOrCreateSheet(ss, 'Produkt_Mapping',
    ['LieferantName','RezeptName','Bestaetigt']);

  const preise   = sheetToObjects(priceSheet);
  const mappings = sheetToObjects(mappingSheet);
  let flagCount  = 0;

  for (const pos of positions) {
    if (!pos.preis || pos.preis <= 0) continue;

    const match = findProductMatch(pos.name, preise, mappings);

    if (!match) {
      savePendingMapping(ss, pos.name, preise.map(p => p.Name));
      continue;
    }

    const altPreis = parseFloat(match.AktuellerPreis) || 0;
    const neuPreis = pos.preis;
    const delta    = altPreis > 0 ? (neuPreis - altPreis) / altPreis : 0;

    // Preis aktualisieren
    updateCurrentPrice(priceSheet, match.ZutatenID, neuPreis);

    if (delta > 0.02) { // > 2% Erhöhung
      const betroffene    = getAffectedRecipes(ss, match.ZutatenID);
      const worstMargin   = calculateWorstMargin(ss, match.ZutatenID, neuPreis);
      const mindestMarge  = 0.30; // Fallback; kann aus Sheet-Metadaten gelesen werden
      const flagTyp       = worstMargin < mindestMarge ? 'CRITICAL' : 'WARNING';

      logFlag(ss, {
        typ:              flagTyp,
        beschreibung:     `${match.Name}: +${(delta * 100).toFixed(1)}% (${altPreis.toFixed(2)} → ${neuPreis.toFixed(2)} €)`,
        produkt:          match.Name,
        altPreis:         altPreis.toFixed(2),
        neuPreis:         neuPreis.toFixed(2),
        betroffeneRezepte: betroffene,
        quelle,
      });
      flagCount++;
    }
  }

  return flagCount;
}

// ─── MARGENBERECHNUNG ─────────────────────────────────────────────────────────

function getAffectedRecipes(ss, zutatenId) {
  const rezepte = sheetToObjects(getOrCreateSheet(ss, 'Rezepte',
    ['RezeptID','GerichtName','ZutatenID','MengeBenoetigt','VerkaufspreisNetto','MindestMarge']));
  return rezepte.filter(r => r.ZutatenID === zutatenId).map(r => r.GerichtName);
}

function calculateWorstMargin(ss, zutatenId, neuPreis) {
  const rezepte = sheetToObjects(getOrCreateSheet(ss, 'Rezepte',
    ['RezeptID','GerichtName','ZutatenID','MengeBenoetigt','VerkaufspreisNetto','MindestMarge']));
  const preise  = sheetToObjects(getOrCreateSheet(ss, 'Zutaten_Preise',
    ['ZutatenID','Name','LieferantSKU','AktuellerPreis','BasisPreis','Einheit','Zeitstempel']));

  const priceMap = {};
  preise.forEach(p => { priceMap[p.ZutatenID] = parseFloat(p.AktuellerPreis) || 0; });
  priceMap[zutatenId] = neuPreis;

  const rezeptIds = [...new Set(rezepte.filter(r => r.ZutatenID === zutatenId).map(r => r.RezeptID))];
  if (rezeptIds.length === 0) return 1;

  let worstMargin = 1;

  for (const id of rezeptIds) {
    const zutaten = rezepte.filter(r => r.RezeptID === id);
    const vks = parseFloat(zutaten[0].VerkaufspreisNetto) || 0;
    if (vks === 0) continue;

    const kTotal = zutaten.reduce((sum, z) =>
      sum + (priceMap[z.ZutatenID] || 0) * (parseFloat(z.MengeBenoetigt) || 0), 0);

    const m = (vks - kTotal) / vks;
    if (m < worstMargin) worstMargin = m;
  }

  return worstMargin;
}

// ─── FUZZY MATCHING ───────────────────────────────────────────────────────────
// Strategie: 1) Gelerntes Mapping → 2) Exakt → 3) Token → 4) Levenshtein ≥ 0.75

function findProductMatch(searchName, products, mappings) {
  const norm = normalizeStr(searchName);

  // 1. Gelerntes Mapping
  const learned = mappings.find(m =>
    normalizeStr(m.LieferantName) === norm && m.Bestaetigt === 'TRUE'
  );
  if (learned) return products.find(p => normalizeStr(p.Name) === normalizeStr(learned.RezeptName));

  // 2. Exakte Übereinstimmung
  const exact = products.find(p => normalizeStr(p.Name) === norm);
  if (exact) return exact;

  // 3. Token-Match: alle Wörter aus Suche im Produktnamen enthalten
  const tokens = norm.split(' ').filter(t => t.length > 2);
  if (tokens.length > 0) {
    const tokenMatch = products.find(p => tokens.every(t => normalizeStr(p.Name).includes(t)));
    if (tokenMatch) return tokenMatch;
  }

  // 4. Levenshtein ≥ 0.75
  let best = null, bestScore = 0;
  for (const p of products) {
    const s = similarity(norm, normalizeStr(p.Name));
    if (s > bestScore && s >= 0.75) { bestScore = s; best = p; }
  }
  return best;
}

function normalizeStr(s) {
  if (!s) return '';
  return s.toLowerCase()
    .replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue').replace(/ß/g,'ss')
    .replace(/[^\w\s]/g,' ').replace(/\s+/g,' ').trim();
}

function similarity(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = [];
  for (let i = 0; i <= m; i++) {
    dp[i] = [i];
    for (let j = 1; j <= n; j++) {
      dp[i][j] = i === 0 ? j :
        a[i-1] === b[j-1] ? dp[i-1][j-1] :
        1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

// ─── SHEET HELPERS ────────────────────────────────────────────────────────────

function getOrCreateSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    const range = sheet.getRange(1, 1, 1, headers.length);
    range.setValues([headers]);
    range.setFontWeight('bold');
    range.setBackground('#f3f4f6');
  }
  return sheet;
}

function sheetToObjects(sheet) {
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  const h = data[0];
  return data.slice(1).map(row => {
    const o = {};
    h.forEach((k, i) => { o[k] = row[i]; });
    return o;
  });
}

function logFlag(ss, { typ, beschreibung, produkt, altPreis, neuPreis, betroffeneRezepte, quelle }) {
  const sheet = getOrCreateSheet(ss, 'Log_Fehler',
    ['LogID','Datum','Typ','Beschreibung','Produkt','AltPreis','NeuPreis','BetroffeneRezepte','Status','Quelle']);
  sheet.appendRow([
    'LOG_' + Date.now(), new Date().toISOString(), typ, beschreibung, produkt,
    altPreis, neuPreis, (betroffeneRezepte || []).join(','), 'Offen', quelle,
  ]);
}

function logScan(ss, typ, quelle, positionen, flags) {
  const sheet = getOrCreateSheet(ss, 'Log_Scans',
    ['ScanID','Zeitstempel','Typ','Quelle','Positionen','AnzahlFlags','Status']);
  sheet.appendRow([
    'SCAN_' + Date.now(), new Date().toISOString(), typ, quelle,
    positionen, flags, flags > 0 ? 'flags' : 'ok',
  ]);
}

function updateCurrentPrice(sheet, zutatenId, newPrice) {
  const data    = sheet.getDataRange().getValues();
  const headers = data[0];
  const idCol   = headers.indexOf('ZutatenID');
  const prCol   = headers.indexOf('AktuellerPreis');
  const tsCol   = headers.indexOf('Zeitstempel');

  for (let i = 1; i < data.length; i++) {
    if (data[i][idCol] === zutatenId) {
      sheet.getRange(i + 1, prCol + 1).setValue(newPrice);
      sheet.getRange(i + 1, tsCol + 1).setValue(new Date().toISOString());
      return;
    }
  }
}

function resolveAlert(logId) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Log_Fehler');
  if (!sheet) return { success: false };

  const data  = sheet.getDataRange().getValues();
  const idCol = data[0].indexOf('LogID');
  const stCol = data[0].indexOf('Status');

  for (let i = 1; i < data.length; i++) {
    if (data[i][idCol] === logId) {
      sheet.getRange(i + 1, stCol + 1).setValue('Geloest');
      return { success: true };
    }
  }
  return { success: false, error: 'Nicht gefunden' };
}

// ─── PRODUKT-MAPPING ──────────────────────────────────────────────────────────

function getPendingMappings(ss) {
  const mSheet = getOrCreateSheet(ss, 'Produkt_Mapping',
    ['LieferantName','RezeptName','Bestaetigt']);
  const pSheet = getOrCreateSheet(ss, 'Zutaten_Preise',
    ['ZutatenID','Name','LieferantSKU','AktuellerPreis','BasisPreis','Einheit','Zeitstempel']);
  const allNames = sheetToObjects(pSheet).map(p => p.Name);

  return sheetToObjects(mSheet)
    .filter(m => m.Bestaetigt === 'PENDING')
    .slice(0, 5)
    .map(m => ({
      lieferantName: m.LieferantName,
      vorschlaege:   m.RezeptName
        ? String(m.RezeptName).split('|').filter(Boolean)
        : allNames.slice(0, 3),
    }));
}

function savePendingMapping(ss, lieferantName, allNames) {
  const sheet = getOrCreateSheet(ss, 'Produkt_Mapping',
    ['LieferantName','RezeptName','Bestaetigt']);
  const data  = sheet.getDataRange().getValues();

  // Nicht doppelt speichern
  if (data.slice(1).some(r => r[0] === lieferantName)) return;

  const top3 = allNames
    .map(n => ({ n, s: similarity(normalizeStr(lieferantName), normalizeStr(n)) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 3)
    .map(x => x.n)
    .join('|');

  sheet.appendRow([lieferantName, top3, 'PENDING']);
}

function saveMapping(lieferantName, rezeptName) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getOrCreateSheet(ss, 'Produkt_Mapping',
    ['LieferantName','RezeptName','Bestaetigt']);
  const data  = sheet.getDataRange().getValues();
  const h     = data[0];

  for (let i = 1; i < data.length; i++) {
    if (data[i][h.indexOf('LieferantName')] === lieferantName) {
      sheet.getRange(i + 1, h.indexOf('RezeptName')  + 1).setValue(rezeptName);
      sheet.getRange(i + 1, h.indexOf('Bestaetigt')  + 1).setValue('TRUE');
      return { success: true };
    }
  }

  sheet.appendRow([lieferantName, rezeptName, 'TRUE']);
  return { success: true };
}

// ─── TRIGGER SETUP (einmal manuell ausführen) ─────────────────────────────────

function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('scanGmail').timeBased().everyHours(1).create();
  Logger.log('✓ Trigger gesetzt: Gmail-Scan alle 60 Minuten');
}
