# Instalace fckscrn

fckscrn má dvě části:

| | Kde běží | Co dělá |
|---|---|---|
| **Server** | jeden počítač nebo server, dostupný přes internet nebo místní síť | web pro organizátora a řečníky, ukládá prezentace a smyčku partnerů |
| **Player** | počítač v každém sále (ten, co je připojený k projektoru) | stáhne prezentace, spouští je na správných obrazovkách |

## Možnost A: nechte to udělat AI

Otevřete tuto složku v **Claude Code** nebo **Codexu** a napište:

> Nainstaluj a spusť fckscrn podle INSTALL.md. Server spusť na tomto počítači, pak spusť player a ukaž mi, kde založím první akci.

Agent si přečte tento soubor a provede kroky níže.

## Možnost B: ručně

### 1. Požadavky
- **Node.js 22.13 nebo novější** (`node -v`). Na Macu `brew install node`, jinak https://nodejs.org.
- Volitelně **LibreOffice** pro převod PowerPointu a Keynote do PDF (lepší náhledy a spolehlivější projekce):
  Mac `brew install --cask libreoffice`, Linux `apt install libreoffice-impress`.

### 2. Stažení a instalace
```bash
git clone <adresa-repa> fckscrn
cd fckscrn
npm install
```

### 3. Server
```bash
npm run server
```
Otevřete http://localhost:8080 a založte akci. **Odkaz na správu akce si uložte**, je to jediný přístup k ní.

Aby se řečníci dostali k nahrávání odjinud, musí být server dostupný z internetu. Varianty:
- **Docker na serveru:** `docker build -t fckscrn . && docker run -d -p 8080:8080 -v fckscrn-data:/data fckscrn`, před to HTTPS proxy (Caddy, Traefik).
- **Rychlý test z notebooku:** tunel, např. `cloudflared tunnel --url http://localhost:8080`.

### 4. Player v sále (bez instalace)
Ve správě akce klikněte u sálu na **Připojit projekci** a odkaz otevřete v **Chrome nebo Edge** na počítači u projektoru.
Povolte „obrazovky“ a vyskakovací okna, pak na projektoru jednou stiskněte libovolnou klávesu (celá obrazovka).
Player stáhne prezentace a smyčku partnerů do prohlížeče a pak funguje i bez internetu.

**Volitelně desktopová aplikace** (plně automatický fullscreen, spouští i originál v PowerPointu/Keynote):
`npm run player` a do aplikace vložte stejný odkaz.

### 5. Obrazovky
V playeru vpravo nastavte, která obrazovka je **projekce** a která **monitor řečníka**. Tlačítko **Identifikovat** ukáže na každé obrazovce její číslo. Nastavení si player pamatuje.

## Placená online verze (volitelné)
Bez těchto proměnných je všechno zdarma a bez vodoznaku. S nimi je nová akce ve zkušebním režimu (vodoznak na projekci),
dokud ji organizátor neaktivuje objednávkou. Doklady vystavuje samostatná fakturační služba přes jednoduché HTTP API
(zálohová faktura hned, faktura po úhradě); organizátor si je stáhne ve správě akce v sekci Fakturace.

| Proměnná | Význam |
|---|---|
| `FAKTURACE_URL` | adresa fakturační služby (např. `http://fakturace:8090` ve stejné síti Dockeru) |
| `FAKTURACE_API_TOKEN` nebo `FAKTURACE_API_TOKEN_FILE` | tajný token pro hlavičku `Authorization: Bearer …` |
| `PRICE_SINGLE`, `PRICE_MULTI` | cena za akci v Kč (výchozí 1490 / 4990) |

Služba musí umět `POST /api/proformas` (`{ ref, customer, items, dueDays }` → `{ id, number, … }`, pro stejný `ref` stejný doklad),
`GET /api/documents?ref=…` (seznam dokladů se stavem `unpaid`/`paid`) a `GET /api/documents/:id/pdf`. Úhrada se kontroluje každou hodinu.
Vyzkoušení bez služby: `node tools/dev-billing-server.mjs` (falešné doklady).

## Data a zálohy
Vše je v `server/data/` (při Dockeru ve svazku `/data`): databáze SQLite a nahrané soubory. Zálohujte celou složku.

## Řešení potíží
| Problém | Řešení |
|---|---|
| `node:sqlite` nebo „SQLite is experimental" | varování je v pořádku, Node musí být 22.13+ |
| Řečník vidí „Server nemá převodník do PDF" | nainstalujte LibreOffice a restartujte server |
| Projekce se otevřela v okně | v playeru není obrazovka s rolí „Projekce" (je připojený projektor?) |
| PowerPoint hlásí poškozený soubor | otevřete originál ručně a zkontrolujte ho, případně požádejte řečníka o PDF |
