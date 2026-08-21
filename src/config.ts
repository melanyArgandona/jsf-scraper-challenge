import {
  ColumnMapping,
  DocumentoOefa,
  DownloadConfig,
  ScraperConfig,
  ScraperMode,
  ScraperSite,
  SiteProfile
} from "./types";

/**
 * Argumentos de línea de comandos normalizados. Todos los valores son
 * opcionales y se combinan con variables de entorno para construir la
 * configuración final (la CLI tiene prioridad sobre el entorno).
 */
export interface CliArgs {
  query: string;
  mode: ScraperMode | undefined;
  maxPages: number | undefined;
  rowsPerPage: number | undefined;
  courtesyDelayMs: number | undefined;
  /** Reintenta solo los documentos fallidos registrados en `FAILURES_PATH`. */
  resume: boolean;
}

/**
 * Capa de composición (composition root): resuelve la configuración a
 * partir de variables de entorno y argumentos CLI, aplicando valores por
 * defecto conservadores.
 */
export function resolveScraperConfig(args: CliArgs): ScraperConfig {
  const site = (process.env.SCRAPER_SITE as ScraperSite | undefined) ?? "oefa";
  const profile = SITE_PROFILES[site] ?? SITE_PROFILES.oefa;

  const baseUrl = (
    process.env.BASE_URL ?? process.env.OEFA_BASE_URL ?? profile.urls.baseUrl
  ).replace(/\/+$/, "");

  const startUrl = process.env.START_URL ?? process.env.OEFA_START_URL ?? profile.urls.startUrl;
  const searchPath = process.env.SEARCH_PATH ?? process.env.OEFA_SEARCH_PATH ?? profile.urls.searchPath;

  const columns = parseColumnMapping(process.env.COLUMNS) ?? profile.primeFaces.columns;
  const download = parseDownloadConfig(process.env.DOWNLOAD_MODE, profile.primeFaces.download);

  return {
    site,
    mode: parseMode(args.mode ?? process.env.SCRAPER_MODE) ?? "jsf",
    urls: {
      baseUrl,
      startUrl,
      searchPath
    },
    search: {
      query: args.query.trim(),
      inputName: process.env.JSF_SEARCH_INPUT ?? profile.search.inputName,
      buttonName: process.env.JSF_SEARCH_BUTTON ?? profile.search.buttonName
    },
    output: {
      jsonPath: process.env.OUTPUT_JSON ?? "output/documentos-oefa.json",
      pdfDirectory: process.env.PDF_DIR ?? "output/pdfs",
      resultsJsonPath: process.env.OUTPUT_RESULTS_JSON ?? "output/resultados-oefa.json",
      failuresPath: process.env.FAILURES_PATH ?? "output/fallidas.json"
    },
    delays: {
      courtesyDelayMs: args.courtesyDelayMs ?? parseIntEnv("COURTESY_DELAY_MS", 1500)
    },
    retries: {
      maxRetries: parseIntEnv("MAX_RETRIES", 3),
      backoffMs: parseIntEnv("BACKOFF_MS", 1500),
      maxBackoffMs: parseIntEnv("MAX_BACKOFF_MS", 60000)
    },
    http: {
      timeoutMs: parseIntEnv("TIMEOUT_MS", 30000),
      extraHeaders: parseJsonEnv("EXTRA_HEADERS", {}),
      extraCookies: process.env.EXTRA_COOKIES ?? ""
    },
    primeFaces: {
      formSelector: process.env.JSF_FORM_SELECTOR ?? profile.primeFaces.formSelector,
      tableSelector: process.env.OEFA_TABLE_SELECTOR ?? profile.primeFaces.tableSelector,
      rowSelector: process.env.JSF_ROW_SELECTOR ?? profile.primeFaces.rowSelector,
      rowsPerPage: args.rowsPerPage ?? parseIntEnv("ROWS_PER_PAGE", profile.primeFaces.rowsPerPage),
      maxPages: args.maxPages ?? parseIntEnv("MAX_PAGES", 3),
      columns,
      download
    },
    selectors: {
      resultSelector: process.env.SELECTOR_RESULT ?? "article",
      detailLinkSelector: process.env.SELECTOR_DETAIL_LINK ?? "a",
      pdfLinkSelector:
        process.env.SELECTOR_PDF_LINK ?? "a[href*='.pdf'], a[href*='bitstream'], a[href*='download']",
      nextSelector: process.env.SELECTOR_NEXT ?? "a[rel='next']"
    }
  };
}

/**
 * Perfiles de sitio. Solo son data: para soportar un sitio nuevo basta con
 * agregar una entrada aquí (o sobreescribir cualquier valor vía variables de
 * entorno). La columna 0 se usa como `id` de fila; las demás se mapean al
 * campo de `DocumentoOefa` indicado en `columns`.
 *
 * El perfil `pj` es un punto de partida: la URL y el mapeo de columnas deben
 * ajustarse inspeccionando el DOM real de jurisprudencia.pj.gob.pe (el sitio
 * aplica protección anti-bot, por lo que no se pudo auto-descubrir).
 */
export const SITE_PROFILES: Record<ScraperSite, SiteProfile> = {
  oefa: {
    kind: "table",
    urls: {
      baseUrl: "https://publico.oefa.gob.pe",
      startUrl: "https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml",
      searchPath: ""
    },
    search: {
      inputName: "form:txtSearch",
      buttonName: "form:btnSearch"
    },
    primeFaces: {
      formSelector: "form",
      tableSelector: "table",
      rowSelector: "tr.ui-widget-content",
      rowsPerPage: 10,
      columns: [
        "numero",
        "nroExpediente",
        "administrado",
        "unidadFiscalizable",
        "sector",
        "nroResolucionApelacion"
      ],
      download: {
        mode: "mojarra",
        signature: "mojarra\\.jsfcljs",
        paramKey: "param_uuid"
      }
    }
  },
  pj: {
    kind: "cards",
    urls: {
      baseUrl: "https://jurisprudencia.pj.gob.pe",
      startUrl:
        "https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/resultado.xhtml",
      searchPath: ""
    },
    search: {
      inputName: process.env.PJ_SEARCH_INPUT ?? "formBusqueda:txtBusqueda",
      buttonName: process.env.PJ_SEARCH_BUTTON ?? "formBusqueda:btnBuscar"
    },
    primeFaces: {
      formSelector: "form",
      tableSelector: "table",
      rowSelector: "tr.ui-widget-content",
      rowsPerPage: 10,
      columns: [],
      download: {
        mode: "mojarra",
        signature: "mojarra\\.jsfcljs",
        paramKey: "param_uuid"
      }
    },
    pj: {
      cardSelector: process.env.PJ_CARD_SELECTOR ?? "div.ui-panel",
      fieldMap: {
        "tipo de expediente": "tipoExpediente",
        "nro. de expediente": "nroExpediente",
        "nro de expediente": "nroExpediente",
        "pretensión/delito": "pretensionDelito",
        "pretension/delito": "pretensionDelito",
        "tipo resolución": "tiporesolucion",
        "tipo resolucion": "tiporesolucion",
        "fecha resolución": "fechaResolucion",
        "fecha resolucion": "fechaResolucion",
        "sala suprema": "salaSuprema",
        "norma de derecho interno": "normaDerechoInterno",
        sumilla: "sumilla",
        "palabras clave": "palabrasClave"
      },
      buttonText: process.env.PJ_BUTTON_TEXT ?? "Ver Resolución",
      buttonIdTemplate:
        process.env.PJ_BUTTON_ID ?? "formBusqueda:tablaResultados:${index}:btnVerResolucion",
      tableId: process.env.PJ_TABLE_ID ?? "formBusqueda:tablaResultados"
    }
  }
};

/** Parsea `COLUMNS="numero,nroExpediente,..."` (campos vacíos → null). */
const parseColumnMapping = (value: string | undefined): ColumnMapping | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  return value.split(",").map((field) => {
    const key = field.trim();
    return key === "" ? null : (key as keyof DocumentoOefa);
  });
};

/** Construye `DownloadConfig` desde env, cayendo al perfil por defecto. */
const parseDownloadConfig = (
  mode: string | undefined,
  fallback: DownloadConfig
): DownloadConfig => {
  if (mode !== "mojarra" && mode !== "link") return fallback;
  const config: DownloadConfig = {
    mode,
    signature: process.env.DOWNLOAD_SIGNATURE ?? fallback.signature,
    paramKey: process.env.DOWNLOAD_PARAM_KEY ?? fallback.paramKey
  };
  // exactOptionalPropertyTypes: solo se asigna si está definido.
  const linkSelector = process.env.DOWNLOAD_LINK_SELECTOR ?? fallback.linkSelector;
  if (linkSelector !== undefined) config.linkSelector = linkSelector;
  const linkAttr = process.env.DOWNLOAD_LINK_ATTR ?? fallback.linkAttr;
  if (linkAttr !== undefined) config.linkAttr = linkAttr;
  return config;
};

/**
 * Parseo liviano de `process.argv.slice(2)`:
 *  - Posicionales acumulados se interpretan como el término de búsqueda.
 *  - Flags `--clave=valor` o `--clave valor`.
 *
 * Ejemplo usados por `npm run scrape`:
 *   `node dist/index.js "evaluacion ambiental" --max-pages=2`
 */
export function parseCliArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  const flags = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    const match = arg.match(/^--([^=]+)(?:=(.*))?$/);

    if (match?.[1]) {
      const key = match[1];
      const inlineValue = match[2];
      const next = argv[i + 1];
      const value = inlineValue ?? (next !== undefined && !next.startsWith("--") ? next : "");
      flags.set(key, value);
      if (inlineValue === undefined && value !== "") {
        i += 1;
      }
    } else if (arg !== "") {
      positional.push(arg);
    }
  }

  return {
    query: positional.join(" ") || flags.get("query") || "",
    mode: parseMode(flags.get("mode")),
    maxPages: parseIntOptional(flags.get("max-pages")),
    rowsPerPage: parseIntOptional(flags.get("rows-per-page")),
    courtesyDelayMs: parseIntOptional(flags.get("delay")),
    resume: flags.has("resume")
  };
}

const parseMode = (value: string | undefined): ScraperMode | undefined =>
  value === "jsf" || value === "static" || value === "dspace" ? value : undefined;

const parseIntEnv = (name: string, fallback: number): number => {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

/** Parsea un JSON de entorno (p.ej. EXTRA_HEADERS) con fallback seguro. */
const parseJsonEnv = <T>(name: string, fallback: T): T => {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const parseIntOptional = (value: string | undefined): number | undefined => {
  if (value === undefined || value === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
};