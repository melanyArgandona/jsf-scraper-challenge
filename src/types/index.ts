/**
 * Contratos de dominio del scraper OEFA.
 *
 * Este módulo es la única fuente de verdad para las formas de datos que
 * cruzan las capas (red, JSF, parsing, almacenamiento y orquestación).
 * Se mantiene libre de implementaciones para no violar la inversión de
 * dependencias.
 */

/**
 * Documento extraído de la tabla de resoluciones del Tribunal de
 * Fiscalización Ambiental (TFA) de la OEFA.
 *
 * Las columnas 1..6 se mapean en el orden exacto de la tabla de PrimeFaces:
 * Nro., Nro. Expediente, Administrado, Unidad Fiscalizable, Sector y
 * Nro. Resolución de Apelación.
 */
export interface DocumentoOefa {
  /**
   * Identificador de la fila (0, 1, 2, …) usado como clave relacional en el
   * POST de PrimeFaces al simular la descarga del PDF de cada fila.
   */
  id: string;
  /** Columna 1: Nro. correlativo de la fila. */
  numero: string;
  /** Columna 2: Número de expediente. */
  nroExpediente: string;
  /** Columna 3: Nombre de la empresa o administrado. */
  administrado: string;
  /** Columna 4: Unidad fiscalizable. */
  unidadFiscalizable: string;
  /** Columna 5: Sector (ej: Pesquería, Minería). */
  sector: string;
  /** Columna 6: Nro. Resolución de Apelación. */
  nroResolucionApelacion: string;
  /** Ruta local donde se guardará el PDF descargado. */
  pdfPath?: string;
}

/**
 * Resultado de búsqueda normalizado, independiente del mecanismo de
 * extracción (JSF, HTML estático o DSpace REST), sobre el que la capa de
 * almacenamiento no necesita conocer detalles del sitio.
 */
export interface SearchResult {
  id: string;
  titulo: string;
  url: string;
  autores: string[];
  fecha: string;
  resumen: string;
  downloadUrl?: string;
  /** Columna 1 del TFA: Nro. correlativo de la fila. */
  numero?: string;
  /** Columna 2 del TFA: Número de expediente. */
  nroExpediente?: string;
  /** Columna 3 del TFA: Nombre de la empresa o administrado. */
  administrado?: string;
  /** Columna 4 del TFA: Unidad fiscalizable. */
  unidadFiscalizable?: string;
  /** Columna 5 del TFA: Sector (ej: Pesquería, Minería). */
  sector?: string;
  /** Columna 6 del TFA: Nro. Resolución de Apelación. */
  nroResolucionApelacion?: string;
}

/** Modos de extracción soportados por el patrón Strategy. */
export type ScraperMode = "jsf" | "static" | "dspace";

/**
 * Sitios soportados. Se selecciona con la variable `SCRAPER_SITE`; cada uno
 * tiene un perfil de datos (URLs, campos JSF, selectores, mapeo de columnas
 * y mecanismo de descarga) definido en `SITE_PROFILES` (config.ts). Añadir
 * un sitio nuevo es agregar una entrada al mapa, sin tocar el código.
 */
export type ScraperSite = "oefa" | "pj";

/**
 * Mapeo de columnas de la tabla: posición (índice 0-based) → campo de
 * `DocumentoOefa`. `null` descarta la columna. Es data, por sitio, para no
 * hardcodear el orden de columnas en el parser.
 *
 * @example ["numero","nroExpediente","administrado","unidadFiscalizable","sector","nroResolucionApelacion"]
 */
export type ColumnMapping = Array<keyof DocumentoOefa | null>;

/** Mecanismo de descarga de PDF por fila. */
export type DownloadMode = "mojarra" | "link";

/**
 * Perfil de un sitio: agrupa toda la configuración dependiente del sitio
 * (URLs, campos JSF, selectores, mapeo de columnas y descarga). Es pura
 * data; cambiar de sitio es elegir un perfil, no editar el código.
 */
export interface SiteProfile {
  /** Mecanismo de extracción: tabla de columnas (OEFA) o tarjetas (PJ). */
  kind: "table" | "cards";
  urls: {
    baseUrl: string;
    startUrl: string;
    searchPath: string;
  };
  search: {
    inputName: string;
    buttonName: string;
  };
  primeFaces: {
    formSelector: string;
    tableSelector: string;
    rowSelector: string;
    rowsPerPage: number;
    columns: ColumnMapping;
    download: DownloadConfig;
    /** Campo oculto del sector (select) para filtrar por rubro en la TFA. */
    sectorField?: string;
    /** Mapa palabra clave → valor del `<select>` de sector (p.ej. mineria→1). */
    sectorMap?: Record<string, string>;
  };
  /** Solo para `kind: "cards"` (PJ). */
  pj?: PjProfile;
}

/**
 * Configuración del mecanismo de descarga de PDF, específica por sitio.
 * - `mojarra`: botón con `onclick="mojarra.jsfcljs(...)"` que dispara un POST
 *   del formulario completo; requiere un token (`paramKey`, p.ej. param_uuid).
 * - `link`: un `<a href="...">` directo al PDF en cada fila.
 */
export interface DownloadConfig {
  mode: DownloadMode;
  /** Regex (como string) que identifica el botón mojarra dentro del `onclick`. */
  signature: string;
  /** Clave del token que el servidor exige reenviar en el POST (mojarra). */
  paramKey: string;
  /** Selector del enlace al PDF (solo modo `link`). */
  linkSelector?: string;
  /** Atributo de la URL en el enlace (solo modo `link`, por defecto `href`). */
  linkAttr?: string;
}

/**
 * Contrato Strategy. Cada mecanismo de extracción lo implementa, de modo
 * que el caso de uso (`OefaRepositoryScraper`) depende de esta abstracción
 * y no de implementaciones concretas (Principio de Inversión de
 * Dependencias).
 */
export interface SearchStrategy {
  readonly mode: ScraperMode;
  search(query: string, maxPages: number): Promise<SearchResult[]>;
}

export interface ScraperUrls {
  baseUrl: string;
  startUrl: string;
  searchPath: string;
}

export interface ScraperOutput {
  /** Ruta del JSON consolidado de `DocumentoOefa`. */
  jsonPath: string;
  /** Directorio donde se escriben los PDFs descargados. */
  pdfDirectory: string;
  /** Ruta del JSON normalizado (`SearchResult`) de la capa Strategy. */
  resultsJsonPath: string;
}

/** Selectores CSS adaptables sin recompilar (variable `SELECTOR_*`). */
export interface StaticSelectors {
  resultSelector: string;
  detailLinkSelector: string;
  pdfLinkSelector: string;
  nextSelector: string;
}

/** Configuración completa del scraper, resuelta en la capa de composición. */
export interface ScraperConfig {
  /** Sitio activo (seleccionado por `SCRAPER_SITE`). */
  site: ScraperSite;
  mode: ScraperMode;
  urls: ScraperUrls;
  search: {
    query: string;
    /** Client ID y name del input de búsqueda JSF (`form:txtSearch`). */
    inputName: string;
    /** Client ID y name del botón de búsqueda JSF (`form:btnSearch`). */
    buttonName: string;
  };
  output: ScraperOutput & {
    /** Ruta donde se persisten los fallidos para el modo `--resume`. */
    failuresPath: string;
  };
  delays: {
    /** Tasa de cortesía aplicada entre peticiones para mitigar rate limit. */
    courtesyDelayMs: number;
  };
  retries: {
    maxRetries: number;
    /** Base del backoff exponencial (ms) antes del jitter. */
    backoffMs: number;
    /** Techo (ms) para cualquier espera de reintento (Retry-After o backoff). */
    maxBackoffMs: number;
  };
  http: {
    timeoutMs: number;
    /** Cabeceras extra inyectadas en cada request (ej. para bypasear WAF). */
    extraHeaders: Record<string, string>;
    /** Cookies de sesión inyectadas en el jar (ej. JSESSIONID capturada). */
    extraCookies: string;
  };
  primeFaces: {
    formSelector: string;
    tableSelector: string;
    /** Selector de filas de datos de la tabla (`tr.ui-widget-content`). */
    rowSelector: string;
    rowsPerPage: number;
    maxPages: number;
    /** Mapeo de columnas índice→campo, por sitio (data-driven). */
    columns: ColumnMapping;
    /** Mecanismo de descarga de PDF por fila, por sitio. */
    download: DownloadConfig;
    /** Campo oculto del sector (select) para filtrar en la TFA. */
    sectorField?: string;
    /** Mapa palabra clave → valor del `<select>` de sector. */
    sectorMap?: Record<string, string>;
  };
  /** Vuelca HTML crudo de diagnóstico a `output/debug-*.html`. */
  debug: boolean;
  selectors: StaticSelectors;
}

/** Estado de sesión JSF: cookies persistidas y token ViewState vigente. */
export interface JsfSessionState {
  cookies: string;
  viewState: string;
}

/**
 * Opciones para simular un evento AJAX de PrimeFaces mediante un POST
 * `application/x-www-form-urlencoded`.
 */
export interface PrimeFacesPostOptions {
  /** URL de acción del formulario JSF. */
  actionUrl: string;
  /** Client ID del formulario (`javax.faces.source`... o `[formId]`). */
  formId: string;
  /** Client ID del componente que dispara el evento. */
  sourceId: string;
  /** Valor vigente de `javax.faces.ViewState`. */
  viewState: string;
  /** Componentes a ejecutar (`javax.faces.partial.execute`). */
  execute?: string;
  /** Componentes a actualizar (`javax.faces.partial.render`). */
  render?: string;
  /** Campos adicionales del paginador/control (`_first`, `_rows`, etc.). */
  extraFields?: Record<string, string>;
}

/** Registro de una descarga que falló tras agotar los reintentos. */
export interface FailedDownload {
  documentoId: string;
  url: string;
  reason: string;
}

/** Resultado exitoso de una descarga. */
export interface DownloadResult {
  documentoId: string;
  filePath: string;
}

/** Respuesta HTTP convertida a texto (HTML o JSON). */
export interface HttpTextResponse {
  /** URL final tras la cadena de redirecciones. */
  finalUrl: string;
  html: string;
}

/** Resultado de parsear una página de tabla del Repositorio OEFA. */
export interface ParsedTablePage {
  documentos: DocumentoOefa[];
  viewState?: string;
  downloadButtons: (DownloadButton | undefined)[];
  paginatorId?: string;
}

/**
 * Botón de descarga de una fila de la tabla TFA. En este sitio los botones
 * son `h:commandLink` que el navegador dispara con `mojarra.jsfcljs(...)`
 * (POST del formulario completo, no AJAX de PrimeFaces) e incluyen un
 * `param_uuid` único por fila que el servidor exige para devolver el PDF.
 */
export interface DownloadButton {
  /** Client ID del botón (`form:dt:{fila}:j_idtXX`). Modo `mojarra`. */
  id: string;
  /** Token `param_uuid` que debe reenviarse en el POST de descarga. Modo `mojarra`. */
  paramUuid: string;
  /** Todos los pares del `mojarra.jsfcljs(...)` de la fila (POST fiel al navegador). */
  params?: Record<string, string>;
  /** URL directa al PDF cuando la descarga es un enlace. Modo `link`. */
  href?: string;
}

/**
 * Instantánea de una sesión JSF vigente: conviene conservarla entre
 * eventos porque JSF reconstruye el árbol de componentes del servidor a
 * partir del ViewState que se reenvía en cada POST.
 */
export interface JsfPage {
  html: string;
  finalUrl: string;
  viewState: string;
  formId: string;
  actionUrl: string;
}

/** DSpace 7 REST: respuesta de `/api/discover/search/objects`. */
export interface DspaceSearchObjectsResponse {
  _embedded?: {
    searchResult?: {
      _embedded?: {
        objects?: Array<{
          _embedded?: { indexableObject?: DspaceItem };
        }>;
      };
    };
  };
}

/** DSpace 7 REST: item indexable devuelto por el discovery search. */
export interface DspaceItem {
  uuid?: string;
  handle?: string;
  metadata?: Record<string, Array<{ value?: string; language?: string | null }>>;
}

/** DSpace 7 REST: respuesta de `/api/core/items/{uuid}/bitstreams`. */
export interface DspaceBitstreamsResponse {
  _embedded?: {
    bitstreams?: Array<{
      name?: string;
      _links?: { content?: { href?: string } };
    }>;
  };
}

/**
 * Documento extraído del sitio de Jurisprudencia del Poder Judicial (PJ).
 *
 * A diferencia de OEFA (tabla de columnas), el PJ presenta cada resultado
 * como una **tarjeta** (bloque clave-valor). Los campos siguen el diseño de
 * la ficha del PJ; `pdfPath` se completa tras descargar la resolución.
 */
export interface DocumentoPj {
  /** Índice de la tarjeta en la página actual (0, 1, 2…). */
  id: string;
  /** Cabecera de la tarjeta: tipo de expediente (ej. "Casación"). */
  tipoExpediente: string;
  /** Cabecera de la tarjeta: número de expediente (ej. "020705-2025"). */
  nroExpediente: string;
  /** Campo: Pretensión/Delito (ej. Desnaturalización de Contrato). */
  pretensionDelito: string;
  /** Campo: Tipo Resolución (ej. Ejecutoria Suprema). */
  tiporesolucion: string;
  /** Campo: Fecha Resolución (ej. 17/07/2026). */
  fechaResolucion: string;
  /** Campo: Sala Suprema (ej. Segunda Sala de Derecho Constitucional). */
  salaSuprema: string;
  /** Campo: Norma de Derecho Interno (ej. Ley 29497). */
  normaDerechoInterno?: string;
  /** Campo: Sumilla. */
  sumilla?: string;
  /** Campo: Palabras Clave (ej. Pago de beneficios sociales). */
  palabrasClave?: string;
  /** Ruta local donde se guarda el PDF descargado. */
  pdfPath?: string;
}

/** Resultado de parsear la página de tarjetas del PJ. */
export interface ParsedCardsPage {
  documentos: DocumentoPj[];
  viewState?: string;
  downloadButtons: (DownloadButton | undefined)[];
  paginatorId?: string;
}

/** Perfil de extracción específico del layout de tarjetas del PJ. */
export interface PjProfile {
  /** Selector del contenedor de cada tarjeta (ej. `div.ui-panel`). */
  cardSelector: string;
  /**
   * Mapa etiqueta-mostrada → campo de `DocumentoPj`. La etiqueta se busca por
   * proximidad de texto dentro de la tarjeta (insensible a mayúsculas).
   */
  fieldMap: Record<string, keyof DocumentoPj>;
  /** Texto visible del botón de descarga (ej. "Ver Resolución"). */
  buttonText: string;
  /**
   * Plantilla del client ID del botón de descarga; `${index}` se reemplaza
   * por la posición de la tarjeta (ej. `formBusqueda:tablaResultados:${index}:btnVerResolucion`).
   */
  buttonIdTemplate: string;
  /** Client ID de la tabla PrimeFaces usado en la paginación. */
  tableId: string;
}