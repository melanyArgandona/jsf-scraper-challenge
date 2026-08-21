import { ScraperConfig, ScraperMode } from "./types";

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
}

/**
 * Capa de composición (composition root): resuelve la configuración a
 * partir de variables de entorno y argumentos CLI, aplicando valores por
 * defecto conservadores.
 */
export function resolveScraperConfig(args: CliArgs): ScraperConfig {
  const baseUrl = (process.env.OEFA_BASE_URL ?? "https://repositorio.oefa.gob.pe").replace(/\/+$/, "");

  return {
    mode: parseMode(args.mode ?? process.env.SCRAPER_MODE) ?? "jsf",
    urls: {
      baseUrl,
      startUrl: process.env.OEFA_START_URL ?? baseUrl,
      searchPath: process.env.OEFA_SEARCH_PATH ?? "/search"
    },
    search: {
      query: args.query.trim(),
      inputName: process.env.JSF_SEARCH_INPUT ?? "form:txtSearch",
      buttonName: process.env.JSF_SEARCH_BUTTON ?? "form:btnSearch"
    },
    output: {
      jsonPath: process.env.OUTPUT_JSON ?? "output/documentos-oefa.json",
      pdfDirectory: process.env.PDF_DIR ?? "output/pdfs",
      resultsJsonPath: process.env.OUTPUT_RESULTS_JSON ?? "output/resultados-oefa.json"
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
      timeoutMs: parseIntEnv("TIMEOUT_MS", 30000)
    },
    primeFaces: {
      formSelector: process.env.JSF_FORM_SELECTOR ?? "form",
      tableSelector: process.env.OEFA_TABLE_SELECTOR ?? "table",
      rowSelector: process.env.JSF_ROW_SELECTOR ?? "tr.ui-widget-content",
      rowsPerPage: args.rowsPerPage ?? parseIntEnv("ROWS_PER_PAGE", 10),
      maxPages: args.maxPages ?? parseIntEnv("MAX_PAGES", 3)
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
    courtesyDelayMs: parseIntOptional(flags.get("delay"))
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

const parseIntOptional = (value: string | undefined): number | undefined => {
  if (value === undefined || value === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
};