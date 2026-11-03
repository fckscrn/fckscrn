# FckScrn

> *because „sorry, it doesn't work" is not an option*

**Prezentace na akcích, které prostě fungují.** Řečníci nahrají prezentaci přes vlastní odkaz, počítač v sále si ji stáhne dopředu a jedním kliknutím ji spustí na správných obrazovkách: slidy pro publikum, poznámky, čas a další slide pro řečníka.

Žádné flashky, žádné „počkejte, já si to jen přepnu“, žádný presenter view na projektoru.

**Online verze:** [fckscrn.com](https://fckscrn.com) · **Nápověda:** [fckscrn.com/napoveda](https://fckscrn.com/napoveda) · [English](#english)

## Proč to vzniklo

Mluvil jsem na řadě konferencí. Všude slibovali, že je všechno připravené a že pro řečníky dělají maximum. Pak jsem přišel na pódium a slyšel: „Sorry, ono to nefunguje.“ Prezentace se nenačetla, presenter view skončil na projektoru, poznámky nikde. FckScrn je odpověď na tuhle větu.

## Co to umí

- **Organizátor** založí akci bez registrace (tajný odkaz), jeden sál nebo víc, a poskládá program: přednášky, přestávky, panely. Program jde vložit i z Excelu nebo Google Sheets.
- **Řečník** nahraje PowerPoint, Keynote, PDF, OpenOffice nebo odkaz na Google Slides. Server zkontroluje formát, videa a poznámky, vytvoří PDF a řečník hned vidí náhled. Poznámky jde dopsat ke každému slidu.
- **Počítač v sále** otevře odkaz sálu v Chrome nebo Edge (nic se neinstaluje). Všechno si stáhne dopředu, takže přednáška jede i bez internetu.
  - **Projekce** ukazuje jen slide, nikdy plochu počítače. Mezi přednáškami běží smyčka partnerů nebo černá s názvem další přednášky.
  - **Monitor řečníka**: velké vlastní poznámky (vždy se vejdou celé), odpočet, aktuální, předchozí a další slide.
  - **Jen notebook a projektor?** Notebook je ovládání i monitor řečníka v jednom okně.
  - **Videa z PowerPointu** hrají přímo na slidu, i offline. Zvuk jde do projektoru přes HDMI nebo do vybraného výstupu.
- **Telefon řečníka** jako monitor a klikr (QR kód): poznámky, čas, slidy, velká tlačítka, tlačítko Pomoc pro technika.
- **Dotazy a hlasování** z publika přes QR kód, bez registrace. Řečníka během přednášky neruší, na konci jdou na plátno a odškrtávají se.
- **Zprávy řečníkovi** („Ještě 5 minut“), posun programu při zpoždění, **cedulka u dveří** s „Teď / Další“, veřejná stránka akce.
- **Ovládání přes AI**: MCP server pro Claude, ChatGPT a další asistenty. REST API.
- **Po akci** si vše stáhnete v jednom ZIPu a akce se sama smaže.

Volitelná **desktopová aplikace** (Electron) se na celou obrazovku přepne sama a umí spustit i originál v PowerPointu nebo Keynote.

## Instalace

Podrobný návod je v [INSTALL.md](INSTALL.md). Nejrychlejší cesta: otevřete repo v Claude Code nebo Codexu a napište „Nainstaluj a spusť FckScrn podle INSTALL.md“.

### Vývoj

Potřebujete Node.js 22.13+.

```bash
npm install
npm run server          # http://localhost:8080
npm run player          # volitelná desktopová aplikace (web player je na /p/<odkaz sálu>)
npm test
```

Převod PPTX a Keynote do PDF potřebuje LibreOffice (`brew install --cask libreoffice`). Bez něj server soubory přijme a desktopová aplikace je spustí nativně.

### Vlastní server

```bash
docker build -t fckscrn .
docker run -p 8080:8080 -v fckscrn-data:/data fckscrn
```

Data (SQLite a soubory) leží v `/data`. Před server dejte HTTPS proxy (Caddy, Traefik…). Hotové nasazení s Caddy je v [DEPLOY.md](DEPLOY.md).

## Ovládání přes AI (MCP)

Akci jde spravovat hlasem nebo textem: „Přidej přednášku Jany Dvořákové v 10:30 na 25 minut“, „Dej po ní kafe na 15 minut“, „Komu ještě chybí prezentace?“.

- **Hostovaný MCP server:** `https://<server>/mcp` s klíčem v hlavičce `Authorization: Bearer <klíč>`, nebo `https://<server>/mcp/<klíč>` pro aplikace, které berou jen adresu konektoru. Klíč je poslední část odkazu na správu akce.
- **Lokálně přes stdio:**
  ```bash
  claude mcp add fckscrn -e FCKSCRN_URL=https://fckscrn.com -e FCKSCRN_EVENT=<odkaz na správu akce> -- node /cesta/k/fckscrn/mcp/fckscrn-mcp.mjs
  ```

Nástroje: `create_event`, `use_event`, `get_program`, `add_talk`, `add_break`, `update_talk`, `delete_talk`, `add_room`, `rename_room`, `speaker_links`, `event_status`.

## Struktura

| | |
|---|---|
| `server/` | Node.js (`node:http`, `node:sqlite`, jediná závislost pdf.js), API, web pro organizátora, řečníka a publikum, rozbor PPTX |
| `player/` | player pro sál: web (Chrome/Edge) i Electron, projekce, monitor řečníka, synchronizace, obrazovky |
| `mcp/` | MCP server pro AI asistenty (stdio) |
| `deploy/` | Docker Compose + Caddy pro nasazení na VPS ([DEPLOY.md](DEPLOY.md)) |
| `tools/` | vývojářské nástroje: ovládání přes DevTools protokol, testovací PDF, zátěžový test, server s falešnou fakturací |

## Roadmapa

- [ ] Nahrávání přednášky (mikrofon, se souhlasem řečníka)
- [ ] Řečník na dálku (WebRTC)
- [ ] Ovládání sálu přes MCP (spustit přednášku, další slide)
- [ ] Poznámky z Keynote
- [ ] Podepsané a notarizované buildy desktopové aplikace
- [ ] Další jazyky (SK, PL)

## Kdo za tím stojí

FckScrn vytvořil **Tomáš Foltas**, autor [Domee.app](https://domee.app), aplikace pro správu nemovitostí.

## Licence

[AGPL-3.0](LICENSE) s doplňující podmínkou podle §7(b) v [NOTICE](NOTICE). Můžete to volně používat, upravovat a provozovat. Pokud upravenou verzi nabízíte jako službu, musíte zveřejnit její zdrojový kód a ponechat v rozhraní uvedení autora.

---

## English

**FckScrn** makes presentations at conferences, meetups and company events just work. Speakers upload their slides via a personal link; the computer in the room downloads everything in advance and starts each talk in one click on the right screens: slides for the audience, notes, timer and next slide for the speaker. Runs in Chrome or Edge with no install, works offline, plays PowerPoint videos, turns the speaker's phone into a monitor and clicker, and replaces Slido for audience Q&A. Laptop + projector only? The laptop is both the controls and the speaker monitor. Control it with AI assistants over MCP.

Hosted version at [fckscrn.com/en](https://fckscrn.com/en), help at [fckscrn.com/en/help](https://fckscrn.com/en/help). Self-hosting: see [INSTALL.md](INSTALL.md) and [DEPLOY.md](DEPLOY.md). Licensed under AGPL-3.0 with an attribution notice (see [NOTICE](NOTICE)). Made by Tomáš Foltas.
