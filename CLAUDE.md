# CLAUDE.md — fckscrn (kód)

Open-source nástroj pro prezentace na akcích. Pokud tě uživatel požádá o instalaci, postupuj podle [INSTALL.md](INSTALL.md).

## Příkazy
```bash
npm install
npm run server   # http://localhost:8080 (PORT, DATA_DIR, SOFFICE_PATH=off)
npm run player   # Electron aplikace pro sál
npm test         # server (node:test, API end-to-end) + player (logika)
```

## Architektura
- `server/src/app.js`: všechny routy. Bez frameworku, `node:http` + `node:sqlite`. Přístup řídí tajné tokeny v URL, bez účtů:
  - `/e/<adminToken>` = organizátor
  - `/s/<speakerToken>` = řečník
  - `/p/<playerToken>` = párování sálu
- `server/src/analyze.js`: rozbor nahraného souboru (PPTX: poznámky, poměr stran, videa; PDF: počet stran) a převod přes LibreOffice.
- `server/public/`: web bez buildu (ES moduly). `preview.js` = náhled slidů a poznámek přes pdf.js z `/vendor/pdfjs/`.
- `player/src/main.js`: stav, okna, obrazovky, příkazy (`fck.cmd(...)`). `library.js` = offline kopie sálu. `renderer/roles.mjs` = přiřazení obrazovek (včetně „ovládání + monitor řečníka“ při dvou obrazovkách).
- `player/renderer/videos.mjs`: videa na slidech v PDF režimu (sdílí main, web player i okna): „další" nejdřív spustí video čekající na kliknutí, výběr zvukového výstupu. Server je vytáhne z PPTX (`analyze.js`, pozice + start), odkazovaná/YouTube/WMV může řečník nahradit souborem (`PUT …/videos/<i>`).
- `player/renderer/`: `control` (technik), `projection` (publikum, smyčka partnerů), `presenter` (řečník; pohled je v `presenter-view.mjs`, sdílí ho i spojené okno ovládání). Komunikace jen přes stav z main procesu. Web player: `web-shim.js` + `web-engine.js`.

## Invarianty
- Projekce nesmí nikdy ukázat plochu počítače. Mezi přednáškami je černá nebo smyčka.
- Výstupní okna mají `backgroundThrottling: false`, jinak se zasekne smyčka a odpočet.
- UI: jen černá a bílá, stav tvarem, české texty s vykáním, žádné `alert/confirm` (mazání = druhé kliknutí).
- Uvedení autora (patička, player, README, NOTICE) neodstraňovat.
- Tokeny se nikdy nevrací v API řečníka ani playeru (testy to hlídají).

## Ověření naživo
`tools/cdp.mjs` ovládá Chrome nebo Electron spuštěný s `--remote-debugging-port=9222` (eval, screenshot). Testovací PDF vyrobí `tools/make-sample-pdf.mjs`.
