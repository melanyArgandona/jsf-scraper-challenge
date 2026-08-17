import { delay } from "../shared/delay";
import { persistJson } from "../shared/fs";
import { PdfDownloader } from "../services/PdfDownloader";
import { DownloadResult, ScraperConfig, SearchResult, SearchStrategy } from "../types";

/**
 * Caso de uso principal de mayor nivel: coordina la estrategia de búsqueda
 * seleccionada, descarga los PDFs de los resultados con enlace y persiste
 * el JSON normalizado. No conoce HTTP, JSF, DSpace ni parsing.
 */
export class OefaRepositoryScraper {
  constructor(
    private readonly config: ScraperConfig,
    private readonly strategy: SearchStrategy,
    private readonly pdfDownloader: PdfDownloader
  ) {}

  async run(): Promise<{ results: SearchResult[]; downloaded: DownloadResult[] }> {
    const results = await this.strategy.search(
      this.config.search.query,
      this.config.primeFaces.maxPages
    );

    const downloaded: DownloadResult[] = [];
    for (const result of results) {
      if (!result.downloadUrl) continue;

      await delay(this.config.delays.courtesyDelayMs);
      const download = await this.pdfDownloader.downloadUrl(result.id, result.downloadUrl);
      if (download) downloaded.push(download);
    }

    await persistJson(this.config.output.resultsJsonPath, results);
    return { results, downloaded };
  }
}