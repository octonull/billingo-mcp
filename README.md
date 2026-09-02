<p align="center"><a href="https://billingo.hu" target="_blank"><img src="https://app.billingo.hu/v3/images_accelerate/billingo-logo-2025.svg" width="250"></a></p>

<p align="center">
<!--<a href="https://github.com/octonull/billingo-mcp/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/octonull/billingo-mcp/ci.yml?branch=master&label=CI&logo=github" alt="CI"></a>-->
<!--<a href="https://github.com/octonull/billingo-mcp/actions/workflows/codeql.yml"><img src="https://img.shields.io/github/actions/workflow/status/octonull/billingo-mcp/codeql.yml?branch=master&label=CodeQL&logo=github" alt="CodeQL"></a>-->
<a href="https://www.npmjs.com/package/@billingo/billingo-mcp"><img src="https://img.shields.io/npm/v/@billingo/billingo-mcp?logo=npm&label=npm" alt="npm version"></a>
<a href="https://github.com/octonull/billingo-mcp/pkgs/container/billingo-mcp"><img src="https://img.shields.io/badge/ghcr.io-image-blue?logo=docker&logoColor=white" alt="Docker image on ghcr.io"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/licence-MIT-blue" alt="Licence: MIT"></a>
<br>
<a href="#-telepítés--futtatás-stdio-val"><img src="https://img.shields.io/badge/node-%3E%3D22-5FA04E?logo=node.js&logoColor=white" alt="Node >=22"></a>
<a href="#-fejlesztés"><img src="https://img.shields.io/badge/TypeScript-5.9.3%20(pinned)-3178C6?logo=typescript&logoColor=white" alt="TypeScript 5.9.3, pinned"></a>
<a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-stdio%20%2B%20HTTP-234232" alt="MCP: stdio and Streamable HTTP"></a>
<br>
<a href="#-eszközök"><img src="https://img.shields.io/badge/tools-22%20read%20%2F%2027%20write-blue" alt="49 tools: 22 read, 27 write"></a>
<a href="#-biztonság"><img src="https://img.shields.io/badge/default-read--only-success" alt="Read-only by default"></a>
</p>

<p align="center"><a href="#english">🇬🇧 English</a> · 🇭🇺 Magyarul</p>

A **hivatalos** [Billingo](https://billingo.hu) [MCP](https://modelcontextprotocol.io)
szerver — 49 eszköz (tool) a Billingo v3 számlázási API felett, stdio (asztali) és
Streamable HTTP (önállóan üzemeltethető) kliensekhez. MIT licenc alatt, önállóan
üzemeltethető. Ez az első hivatalos Billingo SDK vagy MCP szerver — korábban nem
létezett ilyen.

A legtöbb felhasználónak nincs szükség telepítésre — használd a
[hosztolt szervert](#-használat-a-hosztolt-szerverrel-ajánlott) a `mcp.billingo.hu`
címen. Inkább saját magad futtatnád? Publikálva van npm-en is
[`@billingo/billingo-mcp`](https://www.npmjs.com/package/@billingo/billingo-mcp)
néven (`npx`, build nélkül), és [Docker image](#-futtatás-dockerrel-http) formájában is —
lásd a [Válassz futtatási módot](#-válassz-futtatási-módot) szakaszt lentebb.

Olvasd [angolul](#english) is — az angol szakasz egy teljes fordítás, nem összefoglaló.

## Tartalomjegyzék

- 🧭 [Válassz futtatási módot](#-válassz-futtatási-módot)
- 🌐 [Használat a hosztolt szerverrel](#-használat-a-hosztolt-szerverrel-ajánlott)
- 💻 [Telepítés / futtatás stdio-val](#-telepítés--futtatás-stdio-val)
- 🐳 [Futtatás Dockerrel (HTTP)](#-futtatás-dockerrel-http)
- ⚙️ [Konfiguráció](#-konfiguráció)
- 🔒 [Biztonság](#-biztonság)
- 🛠️ [Eszközök](#-eszközök)
- 🧑‍💻 [Fejlesztés](#-fejlesztés)
- 🤝 [Közreműködés](#-közreműködés)
- 📜 [Licenc](#-licenc)
- 🇬🇧 [English](#english)

## 🧭 Válassz futtatási módot

|                                                                       | Beállítás                                   | Kinek ajánlott                                                |
| --------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------- |
| 🌐 **[Hosztolt szerver](#-használat-a-hosztolt-szerverrel-ajánlott)** | Semmi — csak add meg a kliensedben az URL-t | A legtöbb felhasználónak: nulla telepítés, nulla karbantartás |
| 💻 **[stdio npx-szel](#-telepítés--futtatás-stdio-val)**              | `npx`, build nélkül                         | Asztali MCP kliensek (Claude Desktop, Claude Code)            |
| 🐳 **[Docker (önálló üzemeltetés, HTTP)](#-futtatás-dockerrel-http)** | `docker run`                                | Ha saját infrastruktúrán akarod futtatni                      |

⬆️ [Ugrás az elejére](#tartalomjegyzék)

## 🌐 Használat a hosztolt szerverrel (ajánlott)

Nincs telepítés, nincs önálló üzemeltetés — csak állítsd be a klienst a
`https://mcp.billingo.hu` címre, és minden kéréssel küldd el a Billingo API
kulcsodat. Ez a leggyorsabb módja a kezdésnek; csak akkor nyúlj a
[stdio](#-telepítés--futtatás-stdio-val) vagy [Docker](#-futtatás-dockerrel-http)
módokhoz lentebb, ha kifejezetten önálló üzemeltetésre van szükséged.

### Claude Code CLI

```bash
claude mcp add --transport http billingo https://mcp.billingo.hu \
  -s user \
  -H "X-Billingo-Api-Key: your-api-key" \
  -H "X-Billingo-Allow-Write: true"
```

A `-s user` az összes projekteden át regisztrálja, nem csak az aktuálisban; az
(alapértelmezett) `-s local`-lal csak az aktuális projektre korlátozod. Hagyd el az
`X-Billingo-Allow-Write` fejlécet, vagy állítsd `"false"`-ra, csak-olvasás
hozzáféréshez.

### Más HTTP-kompatibilis MCP kliensek

Bármelyik kliens, amely támogatja a Streamable HTTP protokollt, ugyanígy működik:
állítsd be rá a `https://mcp.billingo.hu` címet, az `X-Billingo-Api-Key` fejléccel
(kötelező), opcionálisan az `X-Billingo-Allow-Write`-tal — a teljes fejléc-referenciáért
lásd a [Konfiguráció](#-konfiguráció) szakaszt.

Az API kulcsot ugyanúgy szerezd be, mint az [API kulcs](#api-kulcs) szakaszban lentebb
leírtak szerint.

⬆️ [Ugrás az elejére](#tartalomjegyzék)

## 💻 Telepítés / futtatás stdio-val

Nincs telepítési lépés — az `npx` igény szerint letölti és futtatja a csomagot.

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "billingo": {
      "command": "npx",
      "args": ["-y", "@billingo/billingo-mcp"],
      "env": {
        "BILLINGO_API_KEY": "your-api-key",
        "BILLINGO_ALLOW_WRITE": "false"
      }
    }
  }
}
```

Utána **indítsd újra teljesen a klienst** — a Claude Desktop csak induláskor olvassa ezt
a fájlt, tehát az ablak bezárása nem elég (macOS-en ⌘Q).

### Claude Code CLI

```bash
claude mcp add billingo -s user \
  -e BILLINGO_API_KEY=your-api-key \
  -e BILLINGO_ALLOW_WRITE=false \
  -- npx -y @billingo/billingo-mcp
```

A `-s user` a felhasználódhoz köti a szervert az összes projekteden át, nem csak az
aktuálishoz, és semmit nem ír a repóba. Az (alapértelmezett) `-s local`-lal csak az
aktuális projektre korlátozod. Ellenőrzés: `claude mcp list`, illetve a mentett
konfiguráció megtekintése: `claude mcp get billingo`.

### Más MCP kliensek

Bármelyik kliens, amely elfogadja a szabványos `mcpServers` JSON formátumot (pl.
Cursor, Windsurf), változtatás nélkül újrahasznosíthatja a fenti Claude Desktop blokkot
— a `command`, `args` és `env` nem Claude-specifikus, csak a befoglaló konfigurációs
fájl és annak helye tér el klienstől függően.

### API kulcs

Az API kulcsot a Billingóban a **Beállítások → API kulcsok → Új API kulcs** menüpont
alatt hozod létre. Az űrlapon:

- **Hozzátartozó összekötés**: _Egyedi fejlesztés_.
- **API hatásköre**: _Olvasás_, ha csak listázni/lekérdezni akarsz, vagy _Írás_, ha
  dokumentumokat is szeretnél létrehozni, módosítani, küldeni vagy stornózni.

Ez egy második, a lenti `BILLINGO_ALLOW_WRITE`-tól független kapu: egy csak-olvasás
hatáskörű kulcs minden író hívásnál közvetlenül a Billingo API-tól kap jogosultsági
hibát, még akkor is, ha itt a `BILLINGO_ALLOW_WRITE` `"true"`-ra van állítva — mindkettőnek
engedélyeznie kell. Hagyd a `BILLINGO_ALLOW_WRITE`-ot `"false"`-on (vagy hagyd el),
hacsak nem szeretnéd, hogy a modell dokumentumokat hozhasson létre, módosíthasson,
küldhessen el vagy storno­zhasson — lásd a [Biztonság](#-biztonság) szakaszt. Fontos: az
olyan konfigurációs fájlok, mint a `claude_desktop_config.json`, sima szövegként
tárolódnak, tehát a kulcs titkosítatlanul áll a lemezen.

Ellenőrzés: a kliensnek read-only módban **22 eszközt** kell listáznia, `"true"`-ra
állított `BILLINGO_ALLOW_WRITE` mellett pedig **49-et**. Ha nem talál eszközt, nézd meg a
kliens naplóját (macOS-en `~/Library/Logs/Claude/mcp-server-billingo.log`) — a szerver
`{"name":"billingo","version":"0.1.0"}` néven mutatkozik be. Ha ott más név szerepel,
akkor a kliens egy másik, ugyanezen a néven regisztrált szerverhez beszél.

⬆️ [Ugrás az elejére](#tartalomjegyzék)

## 🐳 Futtatás Dockerrel (HTTP)

```bash
docker run -p 3000:3000 ghcr.io/octonull/billingo-mcp:latest
```

A image **nem tartalmaz beégetett API kulcsot**. A HTTP mód állapotmentes (stateless) és
kérésenkénti: minden hívás egy fejlécben (header) viszi a Billingo API kulcsot, a
szerver soha nem tárolja azt. Példahívás, a két Billingo-specifikus fejléccel:

```bash
curl -X POST http://localhost:3000 \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'X-Billingo-Api-Key: your-api-key' \
  -H 'X-Billingo-Allow-Write: true' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

A `GET /health` `{"status":"ok"}`-kal válaszol, fejléc nélkül is — ez a konténer
health checkekhez van. A `GET /build_version` a futó image build-idejű verzióját adja
vissza, pl. `{"buildVer":"fcc756d@0.1.0"}` — vagy csak a commit SHA-t
(`{"buildVer":"fcc756d"}`), ha az adott build nem tartozik release tag-hez.

Magát az API kulcsot ugyanúgy hozd létre, mint stdio-nál — lásd az
[API kulcs](#api-kulcs) szakaszt fentebb —, és adj neki Írás hatáskört a Billingo
oldalán, ha küldeni akarod az `X-Billingo-Allow-Write` fejlécet.

### Claude Code CLI

```bash
claude mcp add --transport http billingo http://localhost:3000 \
  -s user \
  -H "X-Billingo-Api-Key: your-api-key" \
  -H "X-Billingo-Allow-Write: true"
```

A `-s user` itt is az összes projekteden át regisztrálja, nem csak az aktuálisban; az
(alapértelmezett) `-s local`-lal csak az aktuális projektre korlátozod. Hagyd el
az `X-Billingo-Allow-Write` fejlécet, vagy állítsd `"false"`-ra, csak-olvasás
hozzáféréshez.

⬆️ [Ugrás az elejére](#tartalomjegyzék)

## ⚙️ Konfiguráció

| Változó                  | Transport  | Kötelező | Alapérték                             | Jelentés                                                                                                                                                           |
| ------------------------ | ---------- | -------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BILLINGO_API_KEY`       | csak stdio | igen     | —                                     | A Billingo API kulcsod. HTTP módban nem ezt olvassa a szerver — lásd lent.                                                                                         |
| `BILLINGO_ALLOW_WRITE`   | csak stdio | nem      | `false`                               | `"true"` vagy `"1"` érték engedélyezi az író (write) eszközöket ennél a stdio folyamatnál. Bármi más érték (elgépelést is beleértve) `false`-nak számít.           |
| `BILLINGO_BASE_URL`      | mindkettő  | nem      | `https://api.billingo.hu/v3`          | Az API alap URL felülírása, pl. proxy mögé állításhoz.                                                                                                             |
| `PORT`                   | csak HTTP  | nem      | `3000`                                | A HTTP szerver figyelési portja.                                                                                                                                   |
| `BILLINGO_ALLOWED_HOSTS` | csak HTTP  | nem      | nincs beállítva (védelem kikapcsolva) | Vesszővel elválasztott lista az elfogadott `Host` fejléc-értékekről — DNS-rebinding védelem. **Mindig állítsd be, ha a szerver localhoston kívülről is elérhető.** |

HTTP módban a hitelesítés és a jogosultsági kör (scope) **kérésenként**, fejlécben
érkezik:

| Fejléc                   | Kötelező | Jelentés                                                                        |
| ------------------------ | -------- | ------------------------------------------------------------------------------- |
| `X-Billingo-Api-Key`     | igen     | A kérésnél használandó Billingo API kulcs. Soha nem kerül tárolásra.            |
| `X-Billingo-Allow-Write` | nem      | `"true"` vagy `"1"` engedélyezi az író eszközöket, de csak erre az egy kérésre. |

⬆️ [Ugrás az elejére](#tartalomjegyzék)

## 🔒 Biztonság

Ezt a szakaszt olvasd el, mielőtt bárkinek elérhetővé teszed a szervert.

- **Alapértelmezetten csak olvasható (read-only).** Az író eszközök (létrehozás,
  módosítás, törlés, küldés, storno) teljesen ki vannak szűrve a `tools/list`-ből,
  hacsak explicit be nem kapcsolod a `BILLINGO_ALLOW_WRITE`-tal (stdio) vagy az
  `X-Billingo-Allow-Write` fejléccel (HTTP). Egy modell, amely soha nem lát egy író
  eszközt, nem is tudja meghívni. Ez az elsődleges biztonsági mechanizmus — hagyd
  kikapcsolva az írást, hacsak kifejezetten nem szükséges.
- **A kiállított számlák automatikusan a NAV felé jelentésre kerülnek, és ez nem
  vonható vissza.** Amint egy dokumentum véglegesítésre (finalize) kerül és számlává
  válik, a NAV Online Számla jelentés azonnal megtörténik, és nem visszafordítható.
  Egy hibás számla egyetlen orvoslása a storno (érvénytelenítés) — de **a storno maga
  is végleges**: örökre érvényteleníti a számlát, és ez is jelentésre kerül a NAV felé.
  Egy már kiállított számlára nincs "törlés".
- **A HTTP mód TLS-t igényel.** Az API kulcs minden kérésnél az `X-Billingo-Api-Key`
  fejlécben utazik. Zárd le a TLS-t a konténer előtt (reverse proxy, load balancer,
  vagy a platform ingressze) — soha ne futtasd a HTTP módot titkosítatlan HTTP-n,
  megbízható helyi hálózaton kívül.
- **A HTTP mód szándékosan nem tárol API kulcsot.** Ne "javítsd ki" ezt egy
  konténerszintű környezeti változóval beállított API kulccsal — ez a telepítést
  egyfelhasználóssá tenné, és **bárki, aki eléri a konténert, a te fiókodra tudna
  számlázni**, mivel semmi nem különböztetné meg a kéréseket egymástól. A
  kérésenkénti fejléc pont ezért létezik.
- **Mindig állítsd be a `BILLINGO_ALLOWED_HOSTS`-t, ha a HTTP szerver publikusan
  elérhető.** Enélkül a DNS-rebinding védelem ki van kapcsolva.

⬆️ [Ugrás az elejére](#tartalomjegyzék)

## 🛠️ Eszközök

Összesen 49 eszköz: 22 olvasó (mindig látható), 27 író (csak akkor látható, ha az
írás engedélyezve van).

**Szervezet (Organization)** (3 olvasó)

- `billingo_get_organization` — Szervezeti adatok lekérése (adószám, előfizetés, NAV-kapcsolat állapota).
- `billingo_check_tax_number` — Magyar adószám ellenőrzése.
- `billingo_get_conversion_rate` — Hivatalos árfolyam lekérése, opcionálisan egy múltbeli dátumra.

**Partnerek** (2 olvasó, 4 író)

- `billingo_list_partners` — Partnerek listázása.
- `billingo_get_partner` — Egy partner lekérése.
- `billingo_create_partner` — Partner létrehozása. _(író)_
- `billingo_update_partner` — Partner módosítása (teljes felülírás). _(író)_
- `billingo_guess_partner` — Partner keresése adószám/email alapján, vagy létrehozása. _(író)_
- `billingo_delete_partner` — Partner törlése. _(író)_

**Termékek** (3 olvasó, 3 író)

- `billingo_list_products` — Termékek listázása.
- `billingo_get_product` — Egy termék lekérése.
- `billingo_get_product_quantity` — Egy termék készletmennyiségének lekérése.
- `billingo_create_product` — Termék létrehozása. _(író)_
- `billingo_update_product` — Termék módosítása (teljes felülírás). _(író)_
- `billingo_delete_product` — Termék törlése. _(író)_

**Kiadások (Spendings)** (2 olvasó, 3 író)

- `billingo_list_spendings` — Kiadások listázása.
- `billingo_get_spending` — Egy kiadás lekérése.
- `billingo_create_spending` — Kiadás létrehozása. _(író)_
- `billingo_update_spending` — Kiadás módosítása (teljes felülírás). _(író)_
- `billingo_delete_spending` — Kiadás törlése. _(író)_

**Bankszámlák** (2 olvasó, 3 író)

- `billingo_list_bank_accounts` — Bankszámlák listázása.
- `billingo_get_bank_account` — Egy bankszámla lekérése.
- `billingo_create_bank_account` — Bankszámla létrehozása. _(író)_
- `billingo_update_bank_account` — Bankszámla módosítása (teljes felülírás). _(író)_
- `billingo_delete_bank_account` — Bankszámla törlése. _(író)_

**Dokumentumblokkok** (1 olvasó, 1 író)

- `billingo_list_document_blocks` — Dokumentumblokkok (számlaszám-tartományok) listázása.
- `billingo_create_document_block` — Dokumentumblokk létrehozása. _(író)_

**Dokumentumok — olvasás** (8)

- `billingo_list_documents` — Dokumentumok listázása (számlák, nyugták, díjbekérők, piszkozatok és mások).
- `billingo_get_document` — Egy dokumentum lekérése id vagy külső azonosító (vendor id) alapján.
- `billingo_download_document` — A dokumentum PDF-jének lekérése (publikus URL, vagy base64 bájtok).
- `billingo_get_document_public_url` — Megosztható publikus URL lekérése egy dokumentumhoz.
- `billingo_get_online_szamla_status` — Egy dokumentum NAV Online Számla jelentési állapotának lekérése. Hibát ad, ha a dokumentumnak nincs NAV rekordja — pl. ha a szervezet nincs csatlakoztatva a NAV Online Számlához, vagy a dokumentum nem tartozik jelentési kötelezettség alá.
- `billingo_get_document_payments` — Egy dokumentumhoz rögzített kifizetések lekérése.
- `billingo_get_document_reminders` — Egy dokumentumhoz küldött fizetési emlékeztetők lekérése.
- `billingo_pos_print` — POS hőnyomtatóhoz méretezett PDF nyugta lekérése egy dokumentumhoz.

**Dokumentumok — írás** (9)

- `billingo_create_document` — Dokumentum létrehozása (számla, díjbekérő, piszkozat vagy előlegszámla). _(író)_
- `billingo_create_receipt` — Nyugta létrehozása. _(író)_
- `billingo_finalize_draft` — Piszkozat véglegesítése számlává — kiállítja és jelenti a NAV felé. _(író)_
- `billingo_finalize_receipt_draft` — Piszkozat véglegesítése nyugtává. _(író)_
- `billingo_create_document_from_proforma` — Számla létrehozása díjbekérőből. _(író)_
- `billingo_copy_document` — Dokumentum másolása. _(író)_
- `billingo_create_modification_document` — Módosító (helyesbítő) dokumentum létrehozása. _(író)_
- `billingo_update_payment` — Egy dokumentum rögzített kifizetéseinek módosítása. _(író)_
- `billingo_archive_document` — Proforma dokumentum archiválása. _(író)_

**Dokumentumok — export** (1 olvasó)

- `billingo_export_documents` — Dokumentumok exportálása.

**Dokumentumok — destruktív** (4 író)

- `billingo_cancel_document` — Dokumentum érvénytelenítése (storno) — visszavonhatatlan. _(író)_
- `billingo_send_document` — Dokumentum küldése emailben. _(író)_
- `billingo_delete_document` — Dokumentum törlése (csak piszkozat/ki nem állított dokumentumoknál; egy kiállított számlát stornózni kell helyette). _(író)_
- `billingo_delete_payment` — Egy dokumentum rögzített kifizetéseinek törlése. _(író)_

⬆️ [Ugrás az elejére](#tartalomjegyzék)

## 🧑‍💻 Fejlesztés

```bash
git clone https://github.com/octonull/billingo-mcp.git
cd billingo-mcp
npm ci
npm test
```

**A TypeScript verziója rögzítve van 5.9.3-ra**, és jelenleg nem frissíthető: az
`openapi-typescript` a `typescript@^5.x`-et igényli, a `typescript-eslint` pedig
`<6.1.0`-t — a kettő metszete 5.9.3. Egy újabb TypeScript telepítése `ERESOLVE`
konfliktussal buktatja el az `npm install`-t.

További hasznos parancsok: `npm run typecheck`, `npm run lint`, `npm run format`,
`npm run test:coverage`, `npm run build`.

**Élő smoke teszt csomag:** az `npm run test:live` egy kis tesztcsomagot futtat a
valódi Billingo sandbox ellen (valódi, de ártalmatlan sandbox adatokat hoz létre és
takarít el). Ehhez szükséges a `BILLINGO_SANDBOX_API_KEY` beállítása egy sandbox API
kulcsra; enélkül a csomag tisztán kihagyásra (skip) kerül — így futtatja biztonságosan
a CI és minden hozzájáruló, akinek nincs sandbox hozzáférése.

⬆️ [Ugrás az elejére](#tartalomjegyzék)

## 🤝 Közreműködés

Issue-kat és pull requesteket szívesen fogadunk. PR nyitása előtt futtasd le az
`npm run format:check`, `npm run lint`, `npm run typecheck` és `npm run test:coverage`
parancsokat — a CI mind a négyet megköveteli. Az architektúráért és a kódból nem
nyilvánvaló megkötésekért lásd a [CLAUDE.md](CLAUDE.md) fájlt.

⬆️ [Ugrás az elejére](#tartalomjegyzék)

## 📜 Licenc

MIT — lásd a [LICENSE](LICENSE) fájlt. Copyright (c) 2026 Billingo Technologies Zrt.

⬆️ [Ugrás az elejére](#tartalomjegyzék)

---

# English

The **official** [Billingo](https://billingo.hu) [MCP](https://modelcontextprotocol.io)
server — 49 tools over the Billingo invoicing API v3, for stdio (desktop) and
Streamable HTTP (self-hosted) clients. MIT-licensed and self-hostable. There was no
official Billingo SDK or MCP server before this — it is the first.

No install needed for most people — use the
[hosted server](#-use-the-hosted-server-recommended) at `mcp.billingo.hu`. Prefer to run
it yourself? It's also published on npm as
[`@billingo/billingo-mcp`](https://www.npmjs.com/package/@billingo/billingo-mcp)
(`npx`, no build) and as a [Docker image](#-run-with-docker-http) — see
[Choose how to run it](#-choose-how-to-run-it) below.

## 🧭 Choose how to run it

|                                                             | Setup                             | Best for                                              |
| ----------------------------------------------------------- | --------------------------------- | ----------------------------------------------------- |
| 🌐 **[Hosted server](#-use-the-hosted-server-recommended)** | None — point your client at a URL | Most people: zero install, zero maintenance           |
| 💻 **[stdio via npx](#-install--run-with-stdio)**           | `npx`, no build                   | Desktop MCP clients (Claude Desktop, Claude Code)     |
| 🐳 **[Docker (self-hosted HTTP)](#-run-with-docker-http)**  | `docker run`                      | Running your own instance, on your own infrastructure |

⬆️ [Back to top](#tartalomjegyzék)

## 🌐 Use the hosted server (recommended)

No install, no self-hosting — point your MCP client at `https://mcp.billingo.hu` and
send your Billingo API key with every request. This is the fastest way to get started;
reach for [stdio](#-install--run-with-stdio) or [Docker](#-run-with-docker-http) below only
if you specifically need to self-host.

### Claude Code CLI

```bash
claude mcp add --transport http billingo https://mcp.billingo.hu \
  -s user \
  -H "X-Billingo-Api-Key: your-api-key" \
  -H "X-Billingo-Allow-Write: true"
```

`-s user` registers it across every project instead of just the current one; use
`-s local` (the default) to scope it to just this project. Drop the
`X-Billingo-Allow-Write` header, or set it to `"false"`, for read-only access.

### Other HTTP-capable MCP clients

Any client that speaks Streamable HTTP works the same way: point it at
`https://mcp.billingo.hu` with the `X-Billingo-Api-Key` header (required) and
optionally `X-Billingo-Allow-Write` — see [Configuration](#-configuration) for the full
header reference.

Get your API key the same way as described under [API key](#api-key) below.

⬆️ [Back to top](#tartalomjegyzék)

## 💻 Install / run with stdio

No install step — `npx` fetches and runs the package on demand.

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "billingo": {
      "command": "npx",
      "args": ["-y", "@billingo/billingo-mcp"],
      "env": {
        "BILLINGO_API_KEY": "your-api-key",
        "BILLINGO_ALLOW_WRITE": "false"
      }
    }
  }
}
```

**Restart the client fully** afterwards — Claude Desktop reads this file only at startup,
so quitting the window is not enough (use ⌘Q on macOS).

### Claude Code CLI

```bash
claude mcp add billingo -s user \
  -e BILLINGO_API_KEY=your-api-key \
  -e BILLINGO_ALLOW_WRITE=false \
  -- npx -y @billingo/billingo-mcp
```

`-s user` registers the server for you across every project, not just the one you're
currently in, without committing anything to a repo. Use `-s local` (the default)
instead to scope it to the current project only. Verify with `claude mcp list`, or
inspect the saved config with `claude mcp get billingo`.

### Other MCP clients

Any client that accepts the standard `mcpServers` JSON shape (Cursor, Windsurf, and
others) can reuse the Claude Desktop block above as-is — `command`, `args`, and `env`
are not Claude-specific, only the surrounding config file and its location differ.

### API key

Get your API key from Billingo under **Settings → API keys → New API key**. On the
creation form:

- **Associated connection**: _Custom development_.
- **API scope**: _Read_ if you only need to list or fetch data, or _Write_ if you also
  want to create, modify, send, or cancel documents.

This is a second, independent gate from `BILLINGO_ALLOW_WRITE` below: a Read-scoped key
still gets a permission error straight from the Billingo API on any write call, even if
`BILLINGO_ALLOW_WRITE` is `"true"` here — both have to allow it. Leave
`BILLINGO_ALLOW_WRITE` at `"false"` (or omit it) unless you actually want the model to
be able to create, modify, send, or cancel documents — see [Security](#-security). Note
that config files like `claude_desktop_config.json` are stored in plain text, so the key
sits unencrypted on disk.

To check it worked: the client should list **22 tools** in read-only mode, or **49** with
`BILLINGO_ALLOW_WRITE` set to `"true"`. If it reports no tools, check the client's log
(on macOS, `~/Library/Logs/Claude/mcp-server-billingo.log`) — the server identifies
itself as `{"name":"billingo","version":"0.1.0"}`. A different name there means the
client is talking to some other server registered under the same name.

⬆️ [Back to top](#tartalomjegyzék)

## 🐳 Run with Docker (HTTP)

```bash
docker run -p 3000:3000 ghcr.io/octonull/billingo-mcp:latest
```

The image ships with **no API key baked in**. HTTP mode is stateless and per-request:
every call carries the Billingo API key in a header, and the server never stores it.
Example call, showing the two Billingo-specific headers:

```bash
curl -X POST http://localhost:3000 \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'X-Billingo-Api-Key: your-api-key' \
  -H 'X-Billingo-Allow-Write: true' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

`GET /health` returns `{"status":"ok"}` and needs no headers, for container health checks.
`GET /build_version` returns the running image's build-time version, e.g.
`{"buildVer":"fcc756d@0.1.0"}` — or just the commit SHA (`{"buildVer":"fcc756d"}`) if that
build isn't from a release tag.

Get the API key itself the same way as for stdio — see [API key](#api-key) above — and
give it Write scope on Billingo's side if you intend to send `X-Billingo-Allow-Write`.

### Claude Code CLI

```bash
claude mcp add --transport http billingo http://localhost:3000 \
  -s user \
  -H "X-Billingo-Api-Key: your-api-key" \
  -H "X-Billingo-Allow-Write: true"
```

`-s user` registers it across every project instead of just the current one; use
`-s local` (the default) to scope it to just this project. Drop the
`X-Billingo-Allow-Write` header, or set it to `"false"`, for read-only access.

⬆️ [Back to top](#tartalomjegyzék)

## ⚙️ Configuration

| Variable                 | Transport  | Required | Default                      | Meaning                                                                                                                                                               |
| ------------------------ | ---------- | -------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BILLINGO_API_KEY`       | stdio only | yes      | —                            | Your Billingo API key. Not read in HTTP mode — see below.                                                                                                             |
| `BILLINGO_ALLOW_WRITE`   | stdio only | no       | `false`                      | `"true"` or `"1"` enables write tools for this stdio process. Any other value (including a typo) is treated as `false`.                                               |
| `BILLINGO_BASE_URL`      | both       | no       | `https://api.billingo.hu/v3` | Override the API base URL, e.g. to point at a proxy.                                                                                                                  |
| `PORT`                   | HTTP only  | no       | `3000`                       | Port the HTTP server listens on.                                                                                                                                      |
| `BILLINGO_ALLOWED_HOSTS` | HTTP only  | no       | unset (protection disabled)  | Comma-separated list of `Host` header values the server will accept — DNS-rebinding protection. **Set this whenever the server is reachable from outside localhost.** |

HTTP mode takes credentials and scope **per request**, as headers, instead:

| Header                   | Required | Meaning                                                      |
| ------------------------ | -------- | ------------------------------------------------------------ |
| `X-Billingo-Api-Key`     | yes      | The Billingo API key to use for this request. Never stored.  |
| `X-Billingo-Allow-Write` | no       | `"true"` or `"1"` enables write tools for this request only. |

⬆️ [Back to top](#tartalomjegyzék)

## 🔒 Security

Read this section before exposing the server to anything.

- **Read-only by default.** Write tools (create, update, delete, send, cancel) are
  filtered out of `tools/list` entirely unless `BILLINGO_ALLOW_WRITE` (stdio) or
  `X-Billingo-Allow-Write` (HTTP) is explicitly set. A model that never sees a write
  tool cannot call it. This is the primary safety mechanism — leave writes off unless
  you specifically need them.
- **Issued invoices are reported to NAV automatically and cannot be undone.** Once a
  document is finalized into an invoice, Hungary's NAV Online Számla reporting happens
  immediately and is not reversible. The only remedy for a wrong invoice is a storno
  (cancellation) — and **a storno is itself irreversible**: it voids the invoice
  permanently and is also reported to NAV. There is no "delete" for an issued invoice.
- **HTTP mode requires TLS.** The API key travels in the `X-Billingo-Api-Key` header on
  every request. Terminate TLS in front of the container (a reverse proxy, load
  balancer, or platform ingress) — never run HTTP mode over plain HTTP outside a
  trusted local network.
- **HTTP mode stores no API key, by design.** Do not "fix" this by setting an API key
  via a container-wide environment variable — that turns the deployment single-tenant
  and lets **every caller who can reach the container bill your account**, since there
  would be nothing left to distinguish requests. The per-request header is the point.
- **Set `BILLINGO_ALLOWED_HOSTS` whenever the HTTP server is exposed publicly.** Without
  it, DNS-rebinding protection is disabled.

⬆️ [Back to top](#tartalomjegyzék)

## 🛠️ Tools

49 tools total: 22 read (always visible), 27 write (visible only with writes enabled).

**Organization** (3 read)

- `billingo_get_organization` — Get organization details (tax code, subscription, NAV connection status).
- `billingo_check_tax_number` — Validate a Hungarian tax number.
- `billingo_get_conversion_rate` — Get an official currency conversion rate, optionally for a past date.

**Partners** (2 read, 4 write)

- `billingo_list_partners` — List partners.
- `billingo_get_partner` — Get a single partner.
- `billingo_create_partner` — Create a partner. _(write)_
- `billingo_update_partner` — Update a partner (full replace). _(write)_
- `billingo_guess_partner` — Find a partner by tax number/email, or create one. _(write)_
- `billingo_delete_partner` — Delete a partner. _(write)_

**Products** (3 read, 3 write)

- `billingo_list_products` — List products.
- `billingo_get_product` — Get a single product.
- `billingo_get_product_quantity` — Get a product's stock quantity.
- `billingo_create_product` — Create a product. _(write)_
- `billingo_update_product` — Update a product (full replace). _(write)_
- `billingo_delete_product` — Delete a product. _(write)_

**Spendings** (2 read, 3 write)

- `billingo_list_spendings` — List spendings.
- `billingo_get_spending` — Get a single spending.
- `billingo_create_spending` — Create a spending. _(write)_
- `billingo_update_spending` — Update a spending (full replace). _(write)_
- `billingo_delete_spending` — Delete a spending. _(write)_

**Bank accounts** (2 read, 3 write)

- `billingo_list_bank_accounts` — List bank accounts.
- `billingo_get_bank_account` — Get a single bank account.
- `billingo_create_bank_account` — Create a bank account. _(write)_
- `billingo_update_bank_account` — Update a bank account (full replace). _(write)_
- `billingo_delete_bank_account` — Delete a bank account. _(write)_

**Document blocks** (1 read, 1 write)

- `billingo_list_document_blocks` — List document blocks (invoice number ranges).
- `billingo_create_document_block` — Create a document block. _(write)_

**Documents — read** (8)

- `billingo_list_documents` — List documents (invoices, receipts, proformas, drafts, and more).
- `billingo_get_document` — Get a single document by id or vendor id.
- `billingo_download_document` — Get the document PDF (public URL, or base64 bytes).
- `billingo_get_document_public_url` — Get a shareable public URL for a document.
- `billingo_get_online_szamla_status` — Get a document's NAV Online Számla reporting status. Errors when the document has no NAV record — e.g. the organization is not connected to NAV Online Számla, or the document isn't subject to reporting.
- `billingo_get_document_payments` — Get the payments recorded against a document.
- `billingo_get_document_reminders` — Get the reminder events sent for a document.
- `billingo_pos_print` — Get a POS-thermal-printer-sized PDF receipt for a document.

**Documents — write** (9)

- `billingo_create_document` — Create a document (invoice, proforma, draft, or advance). _(write)_
- `billingo_create_receipt` — Create a receipt. _(write)_
- `billingo_finalize_draft` — Finalize a draft into an invoice — issues it and reports it to NAV. _(write)_
- `billingo_finalize_receipt_draft` — Finalize a draft into a receipt. _(write)_
- `billingo_create_document_from_proforma` — Create an invoice from a proforma. _(write)_
- `billingo_copy_document` — Copy a document. _(write)_
- `billingo_create_modification_document` — Create a modification (correction) document. _(write)_
- `billingo_update_payment` — Update a document's recorded payments. _(write)_
- `billingo_archive_document` — Archive a proforma document. _(write)_

**Documents — export** (1 read)

- `billingo_export_documents` — Export documents.

**Documents — destructive** (4 write)

- `billingo_cancel_document` — Cancel (storno) a document — irreversible. _(write)_
- `billingo_send_document` — Send a document by email. _(write)_
- `billingo_delete_document` — Delete a document (only drafts/unissued documents; an issued invoice must be cancelled instead). _(write)_
- `billingo_delete_payment` — Delete a document's recorded payments. _(write)_

⬆️ [Back to top](#tartalomjegyzék)

## 🧑‍💻 Development

```bash
git clone https://github.com/octonull/billingo-mcp.git
cd billingo-mcp
npm ci
npm test
```

**TypeScript is pinned to 5.9.3** and cannot currently be upgraded: `openapi-typescript`
requires `typescript@^5.x`, and `typescript-eslint` requires `<6.1.0` — their
intersection is 5.9.3. Installing a newer TypeScript fails `npm install` with an
`ERESOLVE` conflict.

Other useful commands: `npm run typecheck`, `npm run lint`, `npm run format`,
`npm run test:coverage`, `npm run build`.

**Live smoke suite:** `npm run test:live` runs a small suite against the real Billingo
sandbox (creating and cleaning up real, if harmless, sandbox data). It needs
`BILLINGO_SANDBOX_API_KEY` set to a sandbox API key; without it, the suite skips
cleanly (this is also how CI and contributors without sandbox access run it safely).

⬆️ [Back to top](#tartalomjegyzék)

## 🤝 Contributing

Issues and pull requests are welcome. Please run `npm run format:check`, `npm run lint`,
`npm run typecheck`, and `npm run test:coverage` before opening a PR — CI enforces all
four. See [CLAUDE.md](CLAUDE.md) for the architecture and the constraints that aren't
obvious from the code alone.

⬆️ [Back to top](#tartalomjegyzék)

## 📜 Licence

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Billingo Technologies Zrt.

⬆️ [Back to top](#tartalomjegyzék)
