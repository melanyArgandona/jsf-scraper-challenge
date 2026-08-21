# Scraper Challenge — JSF/PrimeFaces sin navegador (TypeScript)

Scraper en **TypeScript** de tipado estricto para extraer resoluciones de
sitios **JavaServer Faces + PrimeFaces** — **sin** Puppeteer, Playwright ni
Selenium (solo `axios` + `cheerio`). El sitio objetivo del reto es la
**Jurisprudencia del Poder Judicial**:

> `https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/resultado.xhtml`

También incluye un perfil secundario para el **TFA de la OEFA** (tabla de
columnas). Conmutar entre sitios es solo cuestión de una variable de entorno
(`SCRAPER_SITE`), sin tocar el código.

## Sitios (perfiles)

Cada sitio es un **perfil de datos** (`SITE_PROFILES` en `src/config.ts`):
URLs, campos JSF, selectores, mapeo de columnas/tarjetas y mecanismo de
descarga. Cualquier valor se sobreescribe por variable de entorno.

| `SCRAPER_SITE` | Sitio | Layout |
| --- | --- | --- |
| `pj` | Jurisprudencia PJ (`jurisprudencia.pj.gob.pe`) | **Tarjetas** (`DocumentoPj`) |
| `oefa` (defecto) | TFA de la OEFA (`publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml`) | Tabla de columnas (`DocumentoOefa`) |

```bash
# Jurisprudencia PJ (sitio del reto)
SCRAPER_SITE=pj npm run scrape -- "casacion" --max-pages=2

# TFA de OEFA (perfil secundario)
SCRAPER_SITE=oefa npm run scrape -- "mineria" --max-pages=2
```

## ⚠️ El sitio PJ bloquea clientes no navegador (WAF 403)

`jurisprudencia.pj.gob.pe` responde **403 Forbidden** (WAF `Server: rdwr`) a
cualquier cliente HTTP plano, aunque le pasemos cabeceras de Chrome completas.
Para sortearlo **sin automatizar un navegador**, el scraper inyecta una
**cookie de sesión capturada** en tu navegador:

1. Abre `resultado.xhtml` en el navegador (debe cargar normalmente).
2. DevTools → Application → Cookies → copia la cookie de sesión
   (p.ej. `JSESSIONID` u otra que el sitio use).
3. Pásala en `EXTRA_COOKIES` (o en tu `.env`):

```bash
EXTRA_COOKIES="JSESSIONID=abc123..." SCRAPER_SITE=pj npm run scrape -- "casacion"
```

Si el sitio sigue respondiendo 403, el scraper lanza `WafBlockedError` con
este mismo mensaje en lugar de reintentar a ciegas. Cabeceras extra
(`EXTRA_HEADERS`, JSON) también se pueden inyectar.

> Nota: el WAF puede exigir un reto JS en algunos despliegues; en ese caso un
> cliente HTTP plano no basta y la única vía dentro de las reglas del reto sería
> capturar la cookie tras el reto en el navegador (como se describió arriba).

## Instalación y configuración (`.env`)

```bash
npm install
cp .env.example .env   # edita .env con tus valores (NO se sube al repo)
```

El `.env` carga automáticamente (`dotenv`). Variables clave: `SCRAPER_SITE`,
`EXTRA_COOKIES`, `MAX_RETRIES`, `BACKOFF_MS`, `COURTESY_DELAY_MS`,
`FAILURES_PATH`. Ver tabla al final.

## Uso

El término de búsqueda es un argumento posicional; flags `--clave=valor`:

```bash
npm run scrape -- "evaluacion ambiental" --max-pages=2
npm run scrape -- "mineria" --mode=dspace --max-pages=1 --rows-per-page=10
SCRAPER_SITE=pj EXTRA_COOKIES="JSESSIONID=..." npm run scrape -- "casacion" --max-pages=3
```

### Reintentar fallidos (`--resume`)

Los PDFs que fallan se registran en `FAILURES_PATH` (`output/fallidas.json`).
Para reintentarlos, re-ejecuta el mismo comando con `--resume`: los PDF ya
descargados se **omitenn** (skip por archivo existente) y solo se reintentan
los faltantes (incluye los que fallaron por 429).

```bash
SCRAPER_SITE=pj EXTRA_COOKIES="..." npm run scrape -- "casacion" --resume
```

## Manejo robusto de errores 429

`PdfDownloader` reintenta con **backoff exponencial + jitter** y respeta la
cabecera `Retry-After` del servidor ante:

- **429** Too Many Requests (rate limit),
- **5xx** (500/502/503/504) y
- **errores de red/timeout** (transitorios).

Si agota los reintentos (`MAX_RETRIES`), registra el fallo y **continúa con el
siguiente documento**; no aborta el scrapeo.

## Salidas

- `output/documentos-oefa.json` (OEFA) / `output/resultados-*.json` (PJ):
  consolidado con `pdfPath` por documento.
- `output/pdfs/`: PDFs descargados por streaming (sin cargar en memoria).
- `output/fallidas.json`: registro de descargas fallidas para `--resume`.

## Arquitectura

Capas separadas (Red / JSF / Parsing / Almacenamiento / Orquestación / Estrategias):

- `src/types/index.ts`: interfaces de dominio (`DocumentoOefa`, `DocumentoPj`, `SearchResult`, `ScraperConfig`, `SiteProfile`, `PjProfile`, …).
- `src/config.ts`: composition root; resuelve la configuración por perfil + entorno + CLI. Define `SITE_PROFILES`.
- `src/services/HttpClient.ts`: boundary de red (`axios-cookiejar-support` + `tough-cookie`), cabeceras de navegador completas, inyección de `EXTRA_HEADERS`/`EXTRA_COOKIES`, y detección de WAF (403).
- `src/services/HtmlParser.ts`: parsing con Cheerio. Tabla OEFA → `DocumentoOefa` (mapeo de columnas configurable) y tarjetas PJ → `DocumentoPj` (clave→valor por proximidad de texto); botón "Ver Resolución" con `id` calculado por índice.
- `src/services/PdfDownloader.ts`: descarga por `fs.createWriteStream`, reintentos 429/5xx/red con backoff+jitter+Retry-After, registro de fallas, nombres descriptivos, reutilización de archivos.
- `src/jsf/PrimeFacesClient.ts`: protocolo JSF/PrimeFaces (sesión, búsqueda, paginación, descarga).
- `src/core/ScraperOrchestrator.ts`: orquesta sesión, paginación y descargas; ramifica OEFA (tabla) / PJ (tarjetas).
- `src/scraper/`: capa Strategy/Factory/Decorator.
- `src/shared/`: utilidades (`delay`, `persistJson`, `toErrorMessage`/`WafBlockedError`, `decodeText`).

## Por qué no usa navegador

JSF mantiene estado en `javax.faces.ViewState`; PrimeFaces usa AJAX parcial
(`Faces-Request: partial/ajax`, respuestas `<partial-response>`). El scraper
replica esos intercambios: GET inicial + cookie `JSESSIONID`, POST de búsqueda
con ViewState, paginación con `_first`/`_rows`, y descarga del PDF por POST del
formulario (mojarra) o enlace directo (`link`).

## Configuración (variables de entorno)

| Variable | Por defecto | Nota |
| --- | --- | --- |
| `SCRAPER_SITE` | `oefa` | `oefa` \| `pj` |
| `BASE_URL` / `OEFA_BASE_URL` | según perfil | override de URL base |
| `START_URL` / `OEFA_START_URL` | según perfil | URL de la página de resultado |
| `SEARCH_PATH` | según perfil | |
| `JSF_SEARCH_INPUT` / `JSF_SEARCH_BUTTON` | `form:txtSearch` / `form:btnSearch` (OEFA); `formBusqueda:txtBusqueda` / `formBusqueda:btnBuscar` (PJ) | |
| `COLUMNS` | mapeo del perfil OEFA | `"numero,nroExpediente,..."` |
| `DOWNLOAD_MODE` | `mojarra` | `mojarra` \| `link` |
| `DOWNLOAD_SIGNATURE` / `DOWNLOAD_PARAM_KEY` | `mojarra\.jsfcljs` / `param_uuid` | |
| `DOWNLOAD_LINK_SELECTOR` / `DOWNLOAD_LINK_ATTR` | `a[href$='.pdf']` / `href` | modo `link` |
| `PJ_CARD_SELECTOR` | `div.ui-panel` | contenedor de tarjeta PJ |
| `PJ_BUTTON_TEXT` | `Ver Resolución` | texto del botón de descarga PJ |
| `PJ_TABLE_ID` | `formBusqueda:tablaResultados` | id de tabla para paginación PJ |
| `PJ_BUTTON_ID` | `formBusqueda:tablaResultados:${index}:btnVerResolucion` | id del botón por índice |
| `EXTRA_HEADERS` | `{}` | JSON de cabeceras a inyectar |
| `EXTRA_COOKIES` | `""` | cookie de sesión para bypasear WAF |
| `MAX_RETRIES` / `BACKOFF_MS` / `MAX_BACKOFF_MS` | `3` / `1500` / `60000` | reintentos 429/5xx/red |
| `COURTESY_DELAY_MS` | `1500` | tasa de cortesía entre requests |
| `MAX_PAGES` / `ROWS_PER_PAGE` | `3` / `10` | |
| `TIMEOUT_MS` | `30000` | |
| `FAILURES_PATH` | `output/fallidas.json` | registro de fallidos (`--resume`) |
| `OUTPUT_JSON` / `OUTPUT_RESULTS_JSON` / `PDF_DIR` | `output/...` | |

## Verificación

```bash
npm run check   # tsc --noEmit
npm run build   # compila a dist/
```
