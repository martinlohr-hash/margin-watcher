# Procurement & Margin Watcher

PWA für iPhone — überwacht Einkaufspreise und Lieferungen automatisch.

## Was es macht

- **Gmail-Scan** (automatisch alle 60 Min.): Liest Rechnungs-PDFs aus, erkennt Preiserhöhungen und berechnet den Margen-Impact auf deine Rezepte
- **Lieferschein-Scan** (Kamera): Foto → Drive OCR → Abgleich mit Preisdatenbank
- **Margin Flags**: CRITICAL wenn Marge unter 30%, WARNING bei Preiserhöhung >2%
- **Produkt-Mapping**: Lernt automatisch welche Lieferanten-Bezeichnung welcher Zutat entspricht

## Einmalige Einrichtung

### 1. Google Apps Script

1. Öffne dein Google Sheet (Rezeptdatenbank)
2. **Erweiterungen → Apps Script**
3. Code aus `gas/Code.gs` einfügen, speichern
4. **Services → Drive API aktivieren** (für OCR)
5. **Projekt-Einstellungen → Script-Eigenschaften → Eigenschaft hinzufügen:**
   - Name: `SECRET_TOKEN`
   - Wert: ein langes, zufälliges Passwort (z.B. `mw_abc123xyz789...`)
6. **Deployen → Neue Deployment → Web-App:**
   - Ausführen als: **Ich**
   - Zugriff hat: **Jeder**
   - → Deployment-URL kopieren
7. `setupTriggers()` einmal manuell ausführen (Gmail-Scan alle 60 Min. aktivieren)

### 2. config.js erstellen

```bash
cp js/config.template.js js/config.js
```

Dann in `js/config.js` eintragen:
- `GAS_URL`: Deployment-URL aus Schritt 1.6
- `TOKEN`: Secret Token aus Schritt 1.5

`config.js` ist in `.gitignore` — wird **nicht** auf GitHub hochgeladen.

### 3. GitHub Pages aktivieren

1. Repository auf GitHub pushen
2. **Settings → Pages → Source: Deploy from branch → main / (root)**
3. URL: `https://DEIN-USERNAME.github.io/REPO-NAME/`
4. Im Safari auf iPhone öffnen → **Teilen → Zum Home-Bildschirm**

### 4. Google Sheets Schema

Die App erstellt diese Tabellenblätter automatisch beim ersten Scan:

| Tabellenblatt | Beschreibung |
|---|---|
| `Zutaten_Preise` | Zutaten mit Basis- und aktuellem Preis |
| `Rezepte` | Gerichte mit Zutaten, Menge, VK-Preis |
| `Produkt_Mapping` | Gelernte Lieferant → Rezept Zuordnungen |
| `Log_Fehler` | Alle Warnungen (offen / gelöst) |
| `Log_Scans` | Scan-Historie |

**Rezepte-Schema** (manuell befüllen):

| RezeptID | GerichtName | ZutatenID | MengeBenoetigt | VerkaufspreisNetto | MindestMarge |
|---|---|---|---|---|---|
| R001 | Club Sandwich | Z001 | 0.15 | 8.50 | 0.30 |

**Zutaten_Preise-Schema**:

| ZutatenID | Name | LieferantSKU | AktuellerPreis | BasisPreis | Einheit | Zeitstempel |
|---|---|---|---|---|---|---|
| Z001 | Toastbrot 750g | ABC-123 | 1.80 | 1.65 | stk | 2026-05-27 |

## Lokales Testen

```bash
cd margin-watcher
python3 -m http.server 8080
# → http://localhost:8080
```

> Kamera-Zugriff funktioniert lokal nur über `localhost`, nicht über IP-Adressen.

## Technologie

- **Frontend**: HTML5 + Tailwind CSS (CDN) + Vanilla JS
- **Backend**: Google Apps Script (serverless, kostenlos)
- **OCR**: Google Drive API (kostenlos, kein externer Key)
- **Hosting**: GitHub Pages (HTTPS, kostenlos)
