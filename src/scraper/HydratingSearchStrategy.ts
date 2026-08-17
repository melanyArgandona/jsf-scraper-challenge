import { delay } from "../shared/delay";
import { HtmlParser } from "../services/HtmlParser";
import { HttpClient } from "../services/HttpClient";
import { ScraperConfig, ScraperMode, SearchResult, SearchStrategy } from "../types";

/**
 * Decorator (patrón Decorator): envuelve otra `SearchStrategy` y enriquece
 * los resultados que no tienen `downloadUrl` visitando la página de detalle
 * y buscando un enlace PDF. No modifica las estrategias base.
 */
export class HydratingSearchStrategy implements SearchStrategy {
  constructor(
    private readonly inner: SearchStrategy,
    private readonly http: HttpClient,
    private readonly parser: HtmlParser,
    private readonly config: ScraperConfig
  ) {}

  get mode(): ScraperMode {
    return this.inner.mode;
  }

  async search(query: string, maxPages: number): Promise<SearchResult[]> {
    const results = await this.inner.search(query, maxPages);
    const hydrated: SearchResult[] = [];

    for (const result of results) {
      hydrated.push(result.downloadUrl ? result : await this.hydrate(result));
    }

    return hydrated;
  }

  private async hydrate(result: SearchResult): Promise<SearchResult> {
    await delay(this.config.delays.courtesyDelayMs);

    try {
      const response = await this.http.getText(result.url);
      const downloadUrl = this.parser.extractPdfLink(
        response.html,
        response.finalUrl,
        this.config.selectors.pdfLinkSelector
      );
      return downloadUrl ? { ...result, downloadUrl } : result;
    } catch {
      return result;
    }
  }
}