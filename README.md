# Scraper Challenge - JSF/PrimeFaces sin navegador

Solucion TypeScript, tipado estricto, para extraer la tabla de resoluciones del **Tribunal de Fiscalización Ambiental (TFA)** de la OEFA — y sitios con arquitectura JavaServer Faces + PrimeFaces — **sin** Puppeteer, Playwright ni Selenium. La extraccion se hace con HTTP directo, cookies, `javax.faces.ViewState`, formularios JSF y respuestas parciales AJAX de PrimeFaces.

La tabla TFA se mapea columna a columna en `DocumentoOefa`:

| Columna | Campo |
| --- | --- |
| 1 Nro. | `numero` |
| 2 Nro. Expediente | `nroExpediente` |
| 3 Administrado | `administrado` |
| 4 Unidad Fiscalizable | `unidadFiscalizable` |
| 5 Sector | `sector` |
| 6 Nro. Resolucion de Apelacion | `nroResolucionApelacion` |

El `id` de cada fila (0, 1, 2, ...) se usa como indice relacional en el POST de PrimeFaces que simula la descarga del PDF; la ruta local resultante se guarda en `pdfPath`.

## Instalacion

```bash
npm install
```

## Uso

El termino de busqueda se pasa como argumento posicional y se combina con flags `--clave=valor`:

```bash
npm run scrape -- "evaluacion ambiental" --max-pages=2
npm run scrape -- "mineria" --mode=dspace --max-pages=1 --rows-per-page=10
npm run scrape -- "agua" --mode=static --max-pages=3
```

Si no se pasa termino, se recorre el listado del repositorio (modo `jsf`).

### Modos

| Modo | Mecanismo | Uso tipico |
| --- | --- | --- |
| `jsf` | POST AJAX PrimeFaces con `javax.faces.ViewState` y paginacion `_first`/`_rows` | Sitios JSF/PrimeFaces |
| `static` | HTML navegable + enlaces "next" | Sitios con paginacion HTML |
| `dspace` | API REST publica de DSpace 7 (`/server/api/discover/search/objects`) | Repositorio OEFA publico actual (DSpace/Angular) |

### Sitios (perfiles)

El scraper conmuta entre sitios con la variable `SCRAPER_SITE`, sin tocar
codigo. Cada sitio es un **perfil de datos** (`SITE_PROFILES` en `src/config.ts`)
con sus URLs, campos JSF, selectores, mapeo de columnas y mecanismo de
descarga. Cualquier valor del perfil puede sobreescribirse por variable de
entorno.

| `SCRAPER_SITE` | Sitio |
| --- | --- |
| `oefa` (defecto) | TFA de la OEFA — `publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml` |
| `pj` | Jurisprudencia PJ — `jurisprudencia.pj.gob.pe/.../resultado.xhtml` |

```bash
# Sitio OEFA (defecto)
npm run scrape -- "mineria" --max-pages=2

# Sitio PJ
SCRAPER_SITE=pj npm run scrape -- "casacion" --max-pages=2
```

> Nota: `jurisprudencia.pj.gob.pe` aplica proteccion anti-bot (responde 403 a
> clientes no navegador), por lo que el perfil `pj` es un punto de partida: su
> `COLUMNS` y mecanismo de descarga deben ajustarse inspeccionando el DOM real
> de la pagina (ver variables `COLUMNS`, `DOWNLOAD_*`).

Salidas generadas:

- `output/documentos-oefa.json`: consolidado de la tabla del TFA (`DocumentoOefa[]`) con las columnas exactas (`numero`, `nroExpediente`, `administrado`, `unidadFiscalizable`, `sector`, `nroResolucionApelacion`, `pdfPath`). Para el modo `jsf`.
- `output/resultados-oefa.json`: resultados normalizados (`SearchResult`) de los modos `static`/`dspace`. Cada registro incluye ademas las columnas de la tabla TFA (`numero`, `nroExpediente`, `administrado`, `unidadFiscalizable`, `sector`, `nroResolucionApelacion`) derivadas de sus metadatos (materias, titulo y resumen), dejando vacio lo que no aplica.
- `output/pdfs/`: PDFs descargados por streaming.

## Arquitectura

Capas separadas (Red / JSF / Parsing / Almacenamiento / Orquestacion / Estrategias):

- `src/types/index.ts`: unica fuente de las interfaces de dominio (`DocumentoOefa`, `SearchResult`, `ScraperConfig`, `JsfPage`, DTOs de DSpace, etc.).
- `src/config.ts`: composition root; resuelve configuracion por entorno + CLI (`resolveScraperConfig`, `parseCliArgs`).
- `src/http/index.ts`: fachada de red (re-exporta la implementacion).
- `src/services/HttpClient.ts`: boundary de red con `axios-cookiejar-support` + `tough-cookie` (persistencia automatica del `JSESSIONID`), cabeceras realistas, POST AJAX PrimeFaces y stream para PDFs. Decodifica respuestas UTF-8/latin1 de forma defensiva.
- `src/services/HtmlParser.ts`: parsing DOM con Cheerio: filas `<tr>`→`DocumentoOefa`, ViewState (HTML y XML parcial), paginador PrimeFaces, enlaces PDF.
- `src/services/PdfDownloader.ts`: descarga por `fs.createWriteStream` (sin OOM), reintentos con **backoff exponencial + jitter** y respeto de la cabecera `Retry-After` ante HTTP 429, 5xx y errores de red; registro de fallas y continuacion con el siguiente documento; sanitizacion de nombres; reutilizacion de archivos ya descargados.
- `src/jsf/PrimeFacesClient.ts`: protocolo JSF/PrimeFaces: sesion inicial, POST de busqueda y paginacion manteniendo el ViewState vigente y fusionando `<update>`.
- `src/core/ScraperOrchestrator.ts`: cerebro del flujo JSF: sesion (GET), bucle de paginacion, tasa de cortesia (1.5s configurable), persistencia JSON ordenada.
- `src/scraper/`: capa Strategy/Factory/Decorator.
  - `SearchStrategyFactory.ts`: factory que selecciona la estrategia por modo.
  - `JsfPrimeFacesSearchStrategy.ts` / `StaticHtmlSearchStrategy.ts` / `DspaceRepositoryClient.ts`: estrategias concretas.
  - `HydratingSearchStrategy.ts`: decorator que completa enlaces de descarga sin modificar las estrategias base.
  - `OefaRepositoryScraper.ts`: caso de uso principal; no conoce HTTP/JSF/DSpace/parsing.
- `src/shared/`: utilidades (`delay`, `persistJson`, `toErrorMessage`, `decodeText`).

## Diseno

- `SOLID`: Single Responsibility (cada capa solo hace una cosa), Open/Closed (nuevos modos agregan estrategias sin tocar el caso de uso), Dependecy Inversion (el caso de uso depende de `SearchStrategy`, no de implementaciones).
- Patrones: `Strategy`, `Factory` (`SearchStrategyFactory`), `Decorator` (`HydratingSearchStrategy`), inyeccion de dependencias manual en `src/index.ts`.
- Tipado estricto: `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noImplicitOverride`.

## Por que no usa navegador

JSF mantiene estado en campos ocultos, especialmente `javax.faces.ViewState`. PrimeFaces agrega AJAX parcial (`javax.faces.partial.ajax`, `javax.faces.source`, `javax.faces.partial.execute/render`, cabecera `Faces-Request: partial/ajax`, respuesta XML `<partial-response>`). El scraper replica esos intercambios:

1. `GET` de la pagina inicial y guarda cookies (`JSESSIONID`).
2. Extrae formulario, campos ocultos y ViewState.
3. `POST application/x-www-form-urlencoded` con el termino de busqueda y el ViewState vigente.
4. Para paginar, envia el evento del paginador (`_first`/`_rows`) y fusiona los `<update>` recibidos.
5. El ViewState se refresca de cada respuesta parcial antes del siguiente POST (un token vencido rompe la sesion).

## Configuracion

| Variable | Por defecto |
| --- | --- |
| `SCRAPER_SITE` | `oefa` (`oefa` \| `pj`) |
| `BASE_URL` / `OEFA_BASE_URL` | segun perfil (`publico.oefa.gob.pe`) |
| `START_URL` / `OEFA_START_URL` | segun perfil (URL de la pagina de resultado) |
| `SEARCH_PATH` / `OEFA_SEARCH_PATH` | segun perfil (`""`) |
| `SCRAPER_MODE` | `jsf` |
| `JSF_FORM_SELECTOR` | `form` |
| `OEFA_TABLE_SELECTOR` | `table` |
| `JSF_ROW_SELECTOR` | `tr.ui-widget-content` |
| `JSF_SEARCH_INPUT` | `form:txtSearch` |
| `JSF_SEARCH_BUTTON` | `form:btnSearch` |
| `COLUMNS` | mapeo de columnas del perfil (`"numero,nroExpediente,..."`) |
| `DOWNLOAD_MODE` | `mojarra` (`mojarra` \| `link`) |
| `DOWNLOAD_SIGNATURE` | `mojarra\.jsfcljs` |
| `DOWNLOAD_PARAM_KEY` | `param_uuid` |
| `DOWNLOAD_LINK_SELECTOR` | `a[href$='.pdf']` (modo `link`) |
| `DOWNLOAD_LINK_ATTR` | `href` (modo `link`) |
| `MAX_PAGES` / `ROWS_PER_PAGE` | `3` / `10` |
| `COURTESY_DELAY_MS` | `1500` |
| `MAX_RETRIES` / `BACKOFF_MS` / `MAX_BACKOFF_MS` | `3` / `1500` / `60000` |
| `TIMEOUT_MS` | `30000` |
| `OUTPUT_JSON` / `OUTPUT_RESULTS_JSON` / `PDF_DIR` | `output/...` |
| `SELECTOR_RESULT` / `SELECTOR_DETAIL_LINK` / `SELECTOR_PDF_LINK` / `SELECTOR_NEXT` | selectores CSS adaptables |

## Verificacion

```bash
npm run check
npm run build
```