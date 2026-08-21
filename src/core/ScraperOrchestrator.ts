import { JsfPage } from "../types";
import { HtmlParser } from "../services/HtmlParser";
import { PdfDownloader } from "../services/PdfDownloader";
import { sanitizeFileName } from "../services/PdfDownloader";
import { PrimeFacesClient } from "../jsf/PrimeFacesClient";
import { delay } from "../shared/delay";
import { persistJson } from "../shared/fs";
import { DocumentoOefa, DownloadButton, ScraperConfig } from "../types";

/**
 * El "cerebro" del flujo JSF/PrimeFaces de la tabla del TFA. Coordina la
 * sesión (GET inicial + búsqueda opcional), el bucle principal de
 * paginación, la descarga de cada PDF por fila (POST de PrimeFaces), la
 * tasa de cortesía entre peticiones y la persistencia ordenada del
 * consolidado en JSON.
 *
 * No conoce detalles de red ni de parsing: depende de `PrimeFacesClient`,
 * `HtmlParser` y `PdfDownloader`, cumpliendo el Principio de Inversión de
 * Dependencias.
 */
export class ScraperOrchestrator {
  constructor(
    private readonly config: ScraperConfig,
    private readonly parser: HtmlParser,
    private readonly primeFaces: PrimeFacesClient,
    private readonly pdfDownloader: PdfDownloader
  ) {}

  /**
   * Ejecuta el scraper completo.
   *
   * @param query    término de búsqueda opcional (flujo buscador JSF). Si se
   *                 omite, comienza en el listado de resoluciones del TFA.
   * @param maxPages número máximo de páginas a recorrer.
   */
  async run(query?: string, maxPages?: number): Promise<DocumentoOefa[]> {
    const pageCount = maxPages ?? this.config.primeFaces.maxPages;

    // 1) Inicializa la sesión: GET con persistencia del JSESSIONID.
    let page = await this.primeFaces.startSession(this.config.urls.startUrl);

    // 2) (Opcional) Ejecuta la búsqueda JSF antes de paginar.
    let searched = Boolean(query?.trim());
    if (searched) {
      await delay(this.config.delays.courtesyDelayMs);
      page = await this.primeFaces.submitSearch(
        page,
        query ?? "",
        this.config.search.inputName,
        this.config.search.buttonName
      );
    }

    // Clave compuesta por índice de página para no colisionar los `id` de fila
    // ("0", "1", "2", ...) entre páginas distintas.
    const documentos = new Map<string, DocumentoOefa>();

    // El id del paginador solo aparece en el HTML de la primera página: las
    // respuestas de paginación del DataTable devuelven únicamente las `<tr>` de
    // resultados. Se recuerda aquí para las iteraciones siguientes.
    let rememberedPaginatorId: string | undefined;

    // 3) Bucle principal de paginación.
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      let parsed = this.parser.parseTablePage(
        page.html,
        this.config.primeFaces.tableSelector,
        this.config.primeFaces.rowSelector,
        this.config.primeFaces.columns,
        this.config.primeFaces.download
      );

      // El sitio del TFA inicia con la tabla vacía y solo llena filas tras
      // pulsar "Buscar". Si se omitió el término, se dispara una búsqueda
      // vacía (lista todas las resoluciones) y se re-parsea la tabla.
      if (pageIndex === 0 && !searched && parsed.documentos.length === 0) {
        await delay(this.config.delays.courtesyDelayMs);
        page = await this.primeFaces.submitSearch(
          page,
          query ?? "",
          this.config.search.inputName,
          this.config.search.buttonName
        );
        searched = true;
        parsed = this.parser.parseTablePage(
          page.html,
          this.config.primeFaces.tableSelector,
          this.config.primeFaces.rowSelector,
          this.config.primeFaces.columns,
          this.config.primeFaces.download
        );
      }

      if (parsed.paginatorId) rememberedPaginatorId = parsed.paginatorId;

      for (let index = 0; index < parsed.documentos.length; index += 1) {
        const documento = parsed.documentos[index];
        if (documento === undefined) continue;

        const compositeKey = `${pageIndex}:${documento.id}`;
        if (documentos.has(compositeKey)) continue;
        documentos.set(compositeKey, documento);

        const downloadButton = parsed.downloadButtons[index];
        if (!downloadButton) continue;

        await this.downloadDocumento(documento, page, downloadButton);
      }

      if (!rememberedPaginatorId || parsed.documentos.length === 0) break;

      // 4) Tasa de cortesía: evita abusar del servidor antes del siguiente POST.
      await delay(this.config.delays.courtesyDelayMs);

      page = await this.primeFaces.nextPage(
        page,
        rememberedPaginatorId,
        (pageIndex + 1) * this.config.primeFaces.rowsPerPage,
        this.config.primeFaces.rowsPerPage
      );

      if (!page.html.trim()) break;
    }

    // 5) Persistencia ordenada del consolidado.
    const ordered = Array.from(documentos.values()).sort((a, b) => a.id.localeCompare(b.id));
    await persistJson(this.config.output.jsonPath, ordered);
    return ordered;
  }

  /**
   * Simula el clic en el botón "Descargar" de una fila mediante un POST
   * de formulario completo (equivalente al `mojarra.jsfcljs` del sitio) y
   * guarda el PDF por streaming. Las fallas se registran en el descargador
   * y no interrumpen el resto del flujo.
   */
  private async downloadDocumento(
    documento: DocumentoOefa,
    page: JsfPage,
    downloadButton: DownloadButton
  ): Promise<void> {
    await delay(this.config.delays.courtesyDelayMs);

    const baseName = [documento.nroExpediente, documento.nroResolucionApelacion]
      .filter(Boolean)
      .join("-")
      .trim();
    const fileName = `${sanitizeFileName(baseName || documento.id)}.pdf`;

    const result = await this.pdfDownloader.download(documento, fileName, () => {
      if (downloadButton.href) {
        // Modo "link": el PDF ya es una URL directa; se descarga por GET.
        return this.primeFaces.streamUrl(downloadButton.href);
      }
      // Modo "mojarra": POST de formulario completo con el client ID y el
      // token `param_uuid` de la fila.
      return this.primeFaces.downloadRow(page, downloadButton.id, downloadButton.paramUuid);
    });

    if (result) {
      documento.pdfPath = result.filePath;
    }
  }
}