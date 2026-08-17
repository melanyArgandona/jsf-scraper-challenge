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
  mode: ScraperMode;
  urls: ScraperUrls;
  search: {
    query: string;
    /** Client ID y name del input de búsqueda JSF (`form:txtSearch`). */
    inputName: string;
    /** Client ID y name del botón de búsqueda JSF (`form:btnSearch`). */
    buttonName: string;
  };
  output: ScraperOutput;
  delays: {
    /** Tasa de cortesía aplicada entre peticiones para mitigar rate limit. */
    courtesyDelayMs: number;
  };
  retries: {
    maxRetries: number;
    /** Base del backoff exponencial (ms) para errores HTTP 429. */
    backoffMs: number;
  };
  http: {
    timeoutMs: number;
  };
  primeFaces: {
    formSelector: string;
    tableSelector: string;
    /** Selector de filas de datos de la tabla TFA (`tr.ui-widget-content`). */
    rowSelector: string;
    rowsPerPage: number;
    maxPages: number;
  };
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
  downloadButtons: DownloadButton[];
  paginatorId?: string;
}

/**
 * Botón de descarga de una fila de la tabla TFA. En este sitio los botones
 * son `h:commandLink` que el navegador dispara con `mojarra.jsfcljs(...)`
 * (POST del formulario completo, no AJAX de PrimeFaces) e incluyen un
 * `param_uuid` único por fila que el servidor exige para devolver el PDF.
 */
export interface DownloadButton {
  /** Client ID del botón (`form:dt:{fila}:j_idtXX`). */
  id: string;
  /** Token `param_uuid` que debe reenviarse en el POST de descarga. */
  paramUuid: string;
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