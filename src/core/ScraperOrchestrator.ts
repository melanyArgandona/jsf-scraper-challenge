import { JsfPage } from "../types";
import { HtmlParser } from "../services/HtmlParser";
import { PdfDownloader } from "../services/PdfDownloader";
import { sanitizeFileName } from "../services/PdfDownloader";
import { PrimeFacesClient } from "../jsf/PrimeFacesClient";
import { SITE_PROFILES } from "../config";
import { delay } from "../shared/delay";
import { persistJson, persistRaw } from "../shared/fs";
import {
  DocumentoOefa,
  DocumentoPj,
  DownloadButton,
  ParsedCardsPage,
  ScraperConfig
} from "../types";

/** Tarea de descarga de una fila: documento + botón (o `undefined` si la fila no tiene PDF). */
type RowTask = { doc: DocumentoOefa | DocumentoPj; btn: DownloadButton | undefined };

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

  /** Estadísticas de progreso (filas procesadas, PDFs, fallidos, inicio). */
  private stats = { processed: 0, downloaded: 0, failed: 0, start: Date.now() };
  /** Total de registros de la consulta (para estimar el ETA). */
  private totalRecords: number | undefined;

  /**
   * Ejecuta el scraper completo.
   *
   * @param query    término de búsqueda opcional (flujo buscador JSF). Si se
   *                 omite, comienza en el listado de resoluciones del TFA.
   * @param maxPages número máximo de páginas a recorrer.
   */
  async run(query?: string, maxPages?: number): Promise<DocumentoOefa[]> {
    const pageCount = maxPages ?? this.config.primeFaces.maxPages;
    this.resetStats();

    // 1) Inicializa la sesión: GET con persistencia del JSESSIONID.
    let page = await this.primeFaces.startSession(this.config.urls.startUrl);
    await this.debugDump("sesion", page.html);

    // 2) (Opcional) Ejecuta la búsqueda JSF antes de paginar.
    const searchFields = this.buildSearchFields(query ?? "");
    let searched = Boolean(query?.trim());
    if (searched) {
      await delay(this.config.delays.courtesyDelayMs);
      page = await this.primeFaces.submitSearch(
        page,
        searchFields.term,
        searchFields.inputName,
        searchFields.buttonName,
        searchFields.extraFields
      );
      await this.debugDump("busqueda", page.html);
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
          searchFields.inputName,
          searchFields.buttonName,
          searchFields.extraFields
        );
        await this.debugDump("busqueda", page.html);
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
      if (pageIndex === 0) {
        this.totalRecords = this.parser.extractTotalRecords(page.html) ?? this.totalRecords;
      }

      if (this.config.debug && pageIndex === 0) {
        await this.debugDump(
          "fila",
          this.parser.debugFirstRowHtml(
            page.html,
            this.config.primeFaces.tableSelector,
            this.config.primeFaces.rowSelector
          )
        );
      }

      const tasks: RowTask[] = [];
      for (let index = 0; index < parsed.documentos.length; index += 1) {
        const documento = parsed.documentos[index];
        if (documento === undefined) continue;
        const compositeKey = `${pageIndex}:${documento.id}`;
        if (documentos.has(compositeKey)) continue;
        documentos.set(compositeKey, documento);
        tasks.push({ doc: documento, btn: parsed.downloadButtons[index] });
      }

      await this.processRows(page, tasks);
      this.logProgress(pageIndex);

      if (!rememberedPaginatorId || parsed.documentos.length === 0) break;

      // 4) Tasa de cortesía: evita abusar del servidor antes del siguiente POST.
      await delay(this.config.delays.courtesyDelayMs);

      page = await this.primeFaces.nextPage(
        page,
        rememberedPaginatorId,
        (pageIndex + 1) * this.config.primeFaces.rowsPerPage,
        this.config.primeFaces.rowsPerPage
      );

      if (this.config.debug && pageIndex >= 1) {
        await this.debugDump(`pagina${pageIndex + 2}`, page.html);
      }

      if (!page.html.trim()) break;
    }

    // 5) Persistencia ordenada del consolidado.
    const ordered = Array.from(documentos.values()).sort((a, b) => a.id.localeCompare(b.id));
    await persistJson(this.config.output.jsonPath, ordered);
    return ordered;
  }

  /**
   * Ejecuta el flujo del sitio de Jurisprudencia del PJ (tarjetas). Espejo de
   * `run` pero usa el parser de tarjetas y la paginación con el `tableId` del
   * perfil PJ. Devuelve `DocumentoPj[]`.
   */
  async runPj(query?: string, maxPages?: number): Promise<DocumentoPj[]> {
    const pageCount = maxPages ?? this.config.primeFaces.maxPages;
    this.resetStats();
    const pj = SITE_PROFILES[this.config.site]?.pj;
    if (!pj) {
      throw new Error("El perfil del sitio PJ no tiene configuracion de tarjetas");
    }

    let page = await this.primeFaces.startSession(this.config.urls.startUrl);
    await this.debugDump("sesion", page.html);

    const searchFields = this.buildSearchFields(query ?? "");
    let searched = Boolean(query?.trim());
    if (searched) {
      await delay(this.config.delays.courtesyDelayMs);
      page = await this.primeFaces.submitSearch(
        page,
        searchFields.term,
        searchFields.inputName,
        searchFields.buttonName,
        searchFields.extraFields
      );
      await this.debugDump("busqueda", page.html);
    }

    const documentos = new Map<string, DocumentoPj>();

    let rememberedPaginatorId: string | undefined;

    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      let parsed: ParsedCardsPage = this.parser.parseCardsPage(page.html, pj);

      if (pageIndex === 0 && !searched && parsed.documentos.length === 0) {
        await delay(this.config.delays.courtesyDelayMs);
        page = await this.primeFaces.submitSearch(
          page,
          query ?? "",
          searchFields.inputName,
          searchFields.buttonName,
          searchFields.extraFields
        );
        await this.debugDump("busqueda", page.html);
        searched = true;
        parsed = this.parser.parseCardsPage(page.html, pj);
      }

      if (parsed.paginatorId) rememberedPaginatorId = parsed.paginatorId;
      if (pageIndex === 0) {
        this.totalRecords = this.parser.extractTotalRecords(page.html) ?? this.totalRecords;
      }

      const tasks: RowTask[] = [];
      for (let index = 0; index < parsed.documentos.length; index += 1) {
        const documento = parsed.documentos[index];
        if (documento === undefined) continue;
        const compositeKey = `${pageIndex}:${documento.id}`;
        if (documentos.has(compositeKey)) continue;
        documentos.set(compositeKey, documento);
        tasks.push({ doc: documento, btn: parsed.downloadButtons[index] });
      }

      await this.processRows(page, tasks);
      this.logProgress(pageIndex);

      if (!rememberedPaginatorId || parsed.documentos.length === 0) break;

      await delay(this.config.delays.courtesyDelayMs);

      page = await this.primeFaces.nextPage(
        page,
        rememberedPaginatorId,
        (pageIndex + 1) * this.config.primeFaces.rowsPerPage,
        this.config.primeFaces.rowsPerPage
      );

      if (this.config.debug && pageIndex >= 1) {
        await this.debugDump(`pagina${pageIndex + 2}`, page.html);
      }

      if (!page.html.trim()) break;
    }

    const ordered = Array.from(documentos.values()).sort((a, b) => a.id.localeCompare(b.id));
    await persistJson(this.config.output.jsonPath, ordered);
    return ordered;
  }

  /**
   * Construye los campos del POST de búsqueda. Si el término coincide con un
   * sector conocido de la TFA (p.ej. "mineria" → idsector=1), el valor se envía
   * **solo** al select de sector (no al input de expediente, que filtraría a 0).
   * Si no, se envía como texto libre en el input de expediente. Un término
   * vacío no agrega filtros (el botón "Buscar" lista todos los registros).
   */
  private buildSearchFields(query: string): {
    inputName: string;
    buttonName: string;
    term: string;
    extraFields: Record<string, string>;
  } {
    const buttonName = this.config.search.buttonName;
    const sectorField = this.config.primeFaces.sectorField;
    const sectorMap = this.config.primeFaces.sectorMap;

    if (query.trim() && sectorField && sectorMap) {
      const code = sectorMap[query.trim().toLowerCase()];
      if (code !== undefined) {
        // Sector: el valor va al select; nada al input de expediente.
        return { inputName: sectorField, buttonName, term: code, extraFields: {} };
      }
    }

    return {
      inputName: this.config.search.inputName,
      buttonName,
      term: query,
      extraFields: {}
    };
  }

  /** Vuelca HTML crudo de diagnóstico cuando `config.debug` está activo. */
  private async debugDump(name: string, html: string): Promise<void> {
    if (!this.config.debug || !html) return;
    await persistRaw(`output/debug-${name}.html`, html);
  }

  /** Reinicia las estadísticas de progreso al inicio de cada corrida. */
  private resetStats(): void {
    this.stats = { processed: 0, downloaded: 0, failed: 0, start: Date.now() };
    this.totalRecords = undefined;
  }

  /**
   * Descarga los PDF de una página con concurrencia acotada (`config.concurrency`).
   * Un pool de `limit` workers reparte las tareas; cada worker duerme la tasa de
   * cortesía y descarga su fila. Con `concurrency=1` es idéntico al flujo
   * secuencial original. El `page` (ViewState/acción) se comparte de solo lectura.
   */
  private async processRows(page: JsfPage, tasks: RowTask[]): Promise<void> {
    if (tasks.length === 0) return;
    const limit = Math.max(1, Math.min(this.config.concurrency, tasks.length));
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < tasks.length) {
        const task = tasks[cursor];
        cursor += 1;
        if (!task) continue;
        const { doc, btn } = task;
        if (!btn) {
          this.stats.processed += 1;
          continue;
        }
        await this.downloadDocumento(doc, page, btn);
        this.stats.processed += 1;
        if (doc.pdfPath) this.stats.downloaded += 1;
        else this.stats.failed += 1;
      }
    };

    await Promise.all(Array.from({ length: limit }, () => worker()));
  }

  /** Imprime progreso/ETA en stderr (no contamina el JSON de salida en stdout). */
  private logProgress(pageIndex: number): void {
    const elapsed = (Date.now() - this.stats.start) / 1000;
    const rate = this.stats.processed / Math.max(elapsed, 0.1);
    let eta = "";
    if (this.totalRecords && this.stats.processed > 0) {
      const remaining = Math.max(0, this.totalRecords - this.stats.processed);
      eta = ` | ETA ~${Math.round(remaining / rate)}s`;
    }
    process.stderr.write(
      `[progreso] pagina ${pageIndex + 1} | filas ${this.stats.processed} | ` +
        `PDFs ${this.stats.downloaded} | fallidos ${this.stats.failed} | ` +
        `${rate.toFixed(2)} pdf/s | ${elapsed.toFixed(0)}s${eta}\n`
    );
  }

  /**
   * Simula el clic en el botón "Descargar" / "Ver Resolución" mediante un POST
   * de formulario completo (o GET directo en modo `link`) y guarda el PDF por
   * streaming. Las fallas se registran en el descargador y no interrumpen el
   * resto del flujo. Funciona para ambos sitios (OEFA tabla / PJ tarjetas).
   */
  private async downloadDocumento(
    documento: DocumentoOefa | DocumentoPj,
    page: JsfPage,
    downloadButton: DownloadButton
  ): Promise<void> {
    await delay(this.config.delays.courtesyDelayMs);

    const fileName = this.buildPdfFileName(documento);

    const result = await this.pdfDownloader.download(documento, fileName, () => {
      if (downloadButton.href) {
        // Modo "link": el PDF ya es una URL directa; se descarga por GET.
        return this.primeFaces.streamUrl(downloadButton.href);
      }
      // Modo "mojarra"/JSF: POST de formulario completo con el client ID y,
      // si existe, el token `param_uuid` (y todos los pares del `jsfcljs`) de la fila.
      return this.primeFaces.downloadRow(
        page,
        downloadButton.id,
        downloadButton.paramUuid,
        downloadButton.params
      );
    });

    if (result) {
      documento.pdfPath = result.filePath;
    }
  }

  /**
   * Nombre de archivo descriptivo y único. Cadena de fallback para no quedar
   * vacío cuando el sitio no provee ciertos campos (ej. PJ sin nroResolución):
   * `nroExpediente-nroResolucionApelacion` → `tipoExpediente-nroExpediente`
   * → `numero-<campo>` → `id-<hash>`.
   */
  private buildPdfFileName(doc: DocumentoOefa | DocumentoPj): string {
    const record = doc as unknown as Record<string, string>;
    const candidates = [
      [record.nroExpediente, record.nroResolucionApelacion],
      [record.tipoExpediente, record.nroExpediente],
      [record.numero, record.administrado],
      [record.nroExpediente],
      [record.id]
    ];
    for (const parts of candidates) {
      const name = parts.filter(Boolean).join("-").trim();
      if (name !== "") return `${sanitizeFileName(name)}.pdf`;
    }
    const hash = Math.abs(hashString(doc.id)).toString(36);
    return `${sanitizeFileName(doc.id)}-${hash}.pdf`;
  }
}

/** Hash determinista simple para generar un sufijo único de archivo. */
const hashString = (value: string): number => {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) {
    h = (h << 5) - h + value.charCodeAt(i);
    h |= 0;
  }
  return h;
};