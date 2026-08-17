import { delay } from "../shared/delay";
import { HtmlParser } from "../services/HtmlParser";
import { HttpClient } from "../services/HttpClient";
import { ScraperConfig, ScraperMode, SearchResult, SearchStrategy } from "../types";
import { enrichWithTfaColumns } from "./tfaMapping";

/**
 * Estrategia para sitios con HTML navegable (sin JSF): construye la URL de
 * búsqueda, recorre las páginas de resultados siguiendo el enlace "next"
 * y aplica tasa de cortesía en cada petición.
 */
export class StaticHtmlSearchStrategy implements SearchStrategy {
  readonly mode: ScraperMode = "static";

  constructor(
    private readonly http: HttpClient,
    private readonly parser: HtmlParser,
    private readonly config: ScraperConfig
  ) {}

  async search(query: string, maxPages: number): Promise<SearchResult[]> {
    let currentUrl = this.buildSearchUrl(query);
    const resultados = new Map<string, SearchResult>();

    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      await delay(this.config.delays.courtesyDelayMs);

      const response = await this.http.getText(currentUrl);
      const pageResults = this.parser.extractStaticResults(
        response.html,
        response.finalUrl,
        this.config.selectors
      );
      const enriched = pageResults.map((result, index) =>
        enrichWithTfaColumns(
          result,
          { titulo: result.titulo, resumen: result.resumen, subjects: [] },
          index
        )
      );

      for (const result of enriched) {
        resultados.set(result.id, result);
      }

      const nextUrl = this.parser.extractNextPageUrl(
        response.html,
        response.finalUrl,
        this.config.selectors.nextSelector
      );
      if (!nextUrl) break;
      currentUrl = nextUrl;
    }

    return Array.from(resultados.values());
  }

  private buildSearchUrl(query: string): string {
    const url = new URL(this.config.urls.searchPath, this.config.urls.baseUrl);
    url.searchParams.set("query", query);
    return url.toString();
  }
}