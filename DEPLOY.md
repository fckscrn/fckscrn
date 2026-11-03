# Nasazení na VPS

Jeden server: aplikace + Caddy (HTTPS zdarma, automaticky). Testováno na Ubuntu/Debian s Dockerem.

## 1. DNS (u registrátora domény)
| Záznam | Typ | Hodnota |
|---|---|---|
| `fckscrn.com` | A | IP adresa VPS |
| `www.fckscrn.com` | A | IP adresa VPS |
| `fckscrn.cz`, `www.fckscrn.cz` (pokud máte) | A | IP adresa VPS |

Než se DNS rozšíří, může to trvat od minut po pár hodin. Caddy certifikát vystaví až pak.

## 1b. Rychlá cesta (rsync z vašeho počítače)
```bash
ssh-copy-id -i ~/.ssh/id_ed25519_fckscrn.pub root@<IP>      # jednou, zadá se heslo z panelu poskytovatele
ssh root@<IP> 'sh -s' < tools/server-setup.sh               # jednou: aktualizace, Docker, firewall, swap
tools/deploy.sh root@<IP> <doména>                          # pokaždé: nahraje kód a spustí (data a .env zůstanou)
```
Po ověření klíče vypnout hesla: `/etc/ssh/sshd_config.d/00-fckscrn.conf` s `PasswordAuthentication no`, `PermitRootLogin prohibit-password`.
Testovací server spusťte se `SEARCH_INDEX=off`: skryje se před vyhledávači a neměří se.

## 2. Server
```bash
ssh root@<IP>
# Docker (pokud už není):  curl -fsSL https://get.docker.com | sh
git clone https://github.com/fckscrn/fckscrn.git /opt/fckscrn
cd /opt/fckscrn
cp server/.env.example server/.env.local && nano server/.env.local   # volitelné: GTM, fakturace
chmod 600 server/.env.local
cd deploy && DOMAIN=<doména> docker compose up -d --build
```
Kontrola: `docker compose logs -f fckscrn`, pak otevřít https://<doména>.

## 3. Fakturoid webhook (jen hostovaná verze s fakturací)
Ve Fakturoidu povolit webhooky (Nastavení → Uživatelský účet) a založit webhook:
- URL `https://<doména>/api/billing/fakturoid`
- auth header `Bearer <FAKTUROID_WEBHOOK_TOKEN z .env.local>`
- události `invoice_paid`, `invoice_payment_removed`

## 4. Nová verze
```bash
cd /opt/fckscrn && git pull && cd deploy && DOMAIN=<doména> docker compose up -d --build
```
Před aktualizací udělat snapshot VPS u poskytovatele.

## Data
Databáze a soubory jsou v Docker svazku `fckscrn-data`. Akce se po 14 dnech od konání mažou samy.
