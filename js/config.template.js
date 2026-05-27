// ============================================================
// MARGIN WATCHER — Konfiguration
// ============================================================
// ANLEITUNG:
//   1. Diese Datei als "config.js" im selben Ordner (js/) speichern
//   2. Werte unten eintragen
//   3. config.js wird NICHT auf GitHub hochgeladen (.gitignore)
// ============================================================

const CONFIG = {
  // URL deines Google Apps Script Deployments
  // Zu finden unter: Apps Script → Deployen → Deployment verwalten
  GAS_URL: 'https://script.google.com/macros/s/DEINE_DEPLOYMENT_ID/exec',

  // Geheimer Token — muss exakt mit dem Wert in Code.gs übereinstimmen
  // Script Properties in GAS: Projekt-Einstellungen → Script-Eigenschaften
  TOKEN: 'DEIN_GEHEIMES_PASSWORT_HIER',

  // Mindest-Bruttomarge (Standard: 30% = 0.30)
  MINDEST_MARGE: 0.30,
};
