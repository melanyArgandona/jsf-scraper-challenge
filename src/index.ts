import { parseCliArgs, resolveScraperConfig } from "./config";
import { ScraperOrchestrator } from "./core/ScraperOrchestrator";
import { PrimeFacesClient } from "./jsf/PrimeFacesClient";
import { OefaRepositoryScraper } from "./scraper/OefaRepositoryScraper";
import { SearchStrategyFactory } from "./scraper/SearchStrategyFactory";
import { HtmlParser } from "./services/HtmlParser";
import { HttpClient } from "./services/HttpClient";
import { PdfDownloader } from "./services/PdfDownloader";
import { toErrorMessage } from "./shared/error";
import { DocumentoOefa, ScraperConfig } from "./types";

/**
 * Punto de entrada de la aplicación. Construye el grafo de dependencias
 * (DI manual / composition root) y ejecuta el proceso, capturando cualquier
 * excepción global catastrófica para finalizar con código de salida 1.
 *
 * - Modo `jsf` (tabla del TFA): el orquestador extrae la tabla de
 *   PrimeFaces y el documento de resultados generado es el `DocumentoOefa`
 *   con las columnas exactas (Nro., Nro. Expediente, Administrado, Unidad
 *   Fiscalizable, Sector, Nro. Resolución de Apelación y pdfPath).
 * - Modos `static`/`dspace`: repostorio genérico vía Strategy/Factory.
 */
async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const config = resolveScraperConfig(args);

  // Composición del grafo de dependencias (inyección de dependencias).
  const httpClient = new HttpClient(config.urls.baseUrl, config.http.timeoutMs);
  const htmlParser = new HtmlParser();
  const pdfDownloader = new PdfDownloader(httpClient, config);
  const primeFacesClient = new PrimeFacesClient(
    httpClient,
    htmlParser,
    config.primeFaces.formSelector
  );
  const orchestrator = new ScraperOrchestrator(config, htmlParser, primeFacesClient, pdfDownloader);

  if (config.mode === "jsf") {
    await runTfaTable(config, orchestrator, pdfDownloader);
    return;
  }

  await runGenericRepository(config, httpClient, htmlParser, orchestrator, pdfDownloader);
}

/**
 * Flujo de la tabla del Tribunal de Fiscalización Ambiental (TFA).
 * El consolidado (`DocumentoOefa[]`) se persiste en `output/documentos-oefa.json`
 * y el resumen de consola evidencia el mapeo columna a columna.
 */
async function runTfaTable(
  config: ScraperConfig,
  orchestrator: ScraperOrchestrator,
  pdfDownloader: PdfDownloader
): Promise<void> {
  const documentos: DocumentoOefa[] = await orchestrator.run(
    config.search.query,
    config.primeFaces.maxPages
  );

  process.stdout.write(
    JSON.stringify(
      {
        mode: "jsf",
        tabla: "Tribunal de Fiscalizacion Ambiental (TFA)",
        query: config.search.query,
        registros: documentos.length,
        output: config.output.jsonPath,
        pdfDirectory: config.output.pdfDirectory,
        fallasDeDescarga: pdfDownloader.getFailures(),
        ejemploFila: documentos[0] ?? null
      },
      null,
      2
    ) + "\n"
  );
}

/**
 * Flujo de repositorio genérico (modos `static`/`dspace`): usa la
 * estrategia seleccionada por la factory y normaliza a `SearchResult`.
 */
async function runGenericRepository(
  config: ScraperConfig,
  httpClient: HttpClient,
  htmlParser: HtmlParser,
  orchestrator: ScraperOrchestrator,
  pdfDownloader: PdfDownloader
): Promise<void> {
  const strategy = new SearchStrategyFactory(config, httpClient, htmlParser, orchestrator).create(
    config.mode
  );
  const scraper = new OefaRepositoryScraper(config, strategy, pdfDownloader);

  const { results, downloaded } = await scraper.run();

  process.stdout.write(
    JSON.stringify(
      {
        mode: config.mode,
        query: config.search.query,
        resultados: results.length,
        descargados: downloaded.length,
        output: config.output.resultsJsonPath,
        fallasDeDescarga: pdfDownloader.getFailures()
      },
      null,
      2
    ) + "\n"
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`Error catastrofico del scraper: ${toErrorMessage(error)}\n`);
  process.exitCode = 1;
});