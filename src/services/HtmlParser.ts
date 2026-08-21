import * as cheerio from "cheerio";
import {
  ColumnMapping,
  DocumentoOefa,
  DownloadButton,
  DownloadConfig,
  ParsedTablePage,
  SearchResult,
  StaticSelectors
} from "../types";

const DEFAULT_ROW_SELECTOR = "tr.ui-widget-content";

/** Mapeo por defecto (OEFA TFA) si no se provee uno por sitio. */
const DEFAULT_COLUMNS: ColumnMapping = [
  "numero",
  "nroExpediente",
  "administrado",
  "unidadFiscalizable",
  "sector",
  "nroResolucionApelacion"
];

/**
 * Límite de parsing DOM (via [cheerio]). Única responsabilidad: convertir
 * HTML/XML parcial en estructuras de dominio. No efectúa peticiones HTTP ni
 * conoce reglas de negocio.
 */
export class HtmlParser {
  /**
   * Parsea una página de la tabla del TFA: filas de datos, botones de
   * descarga, ViewState vigente e ID del paginador PrimeFaces.
   */
  parseTablePage(
    html: string,
    tableSelector?: string,
    rowSelector?: string,
    columns?: ColumnMapping,
    download?: DownloadConfig
  ): ParsedTablePage {
    const page: ParsedTablePage = {
      documentos: this.parseDocumentos(html, tableSelector, rowSelector, columns),
      downloadButtons: this.extractDownloadButtons(html, download)
    };

    const viewState = this.extractViewState(html);
    const paginatorId = this.extractPaginatorId(html);
    if (viewState) page.viewState = viewState;
    if (paginatorId) page.paginatorId = paginatorId;

    return page;
  }

  /**
   * Extrae las filas de la tabla y mapea cada columna según `columns`
   * (índice → campo de `DocumentoOefa`), configurado por sitio. Las columnas
   * marcadas `null` se descartan. Usa el selector de filas del sitio o, si se
   * agota, cualquier `<tr>` con celdas. El `id` de cada documento es el índice
   * de fila (0, 1, 2…), requerido en el POST de PrimeFaces.
   */
  parseDocumentos(
    html: string,
    tableSelector?: string,
    rowSelector?: string,
    columns: ColumnMapping = DEFAULT_COLUMNS
  ): DocumentoOefa[] {
    // cheerio descarta los `<tr>` sueltos (sin `<table>`), que es exactamente
    // lo que devuelve PrimeFaces en las respuestas de paginación. Se envuelven
    // en una `<table>` sintética antes de parsear.
    const wrapped = /^\s*<tr\b/i.test(html) && !/<table/i.test(html) ? `<table>${html}</table>` : html;
    const $ = cheerio.load(wrapped);
    const scope = tableSelector ? `${tableSelector} ` : "";
    let rows = $(`${scope}${rowSelector ?? DEFAULT_ROW_SELECTOR}`);
    if (rows.length === 0) {
      // Las respuestas de paginación de PrimeFaces devuelven `<tr>` sueltos
      // (solo el body de la tabla, sin `<table>`), por lo que el fallback debe
      // barrer filas globalmente en vez de ceñirse al `tableSelector`.
      rows = $("tr").filter(":has(td)");
    }

    const documentos: DocumentoOefa[] = [];

    rows.each((index, row) => {
      const cells = $(row).find("td");
      const id = String(index);
      const documento: DocumentoOefa = {
        id,
        numero: "",
        nroExpediente: "",
        administrado: "",
        unidadFiscalizable: "",
        sector: "",
        nroResolucionApelacion: ""
      };

      columns.forEach((field, colIndex) => {
        if (field === null || field === undefined) return;
        const value = normalize(cells.eq(colIndex).text());
        // Solo asigna si el campo existe en el modelo (defensa ante perfiles mal configurados).
        if (field in documento) {
          (documento as unknown as Record<string, string>)[field] = value;
        }
      });

      // Descarta filas que no aporten ninguna columna mapeada.
      const hasData = columns.some(
        (field) => field !== null && (documento as unknown as Record<string, string>)[field] !== ""
      );
      if (!hasData) return;

      documentos.push(documento);
    });

    return documentos;
  }

  /**
   * Extrae el token de estado de JSF.
   *
   * En respuestas HTML completas vive como input oculto
   * `<input name="javax.faces.ViewState">`; en respuestas AJAX de
   * PrimeFaces llega dentro de `<update id="javax.faces.ViewState">…`.
   * El ViewState debe refrescarse tras cada POST: reenviar uno vencido hace
   * que JSF responda con error de sesión expirada o que ignore el evento.
   */
  extractViewState(html: string): string | undefined {
    const $html = cheerio.load(html, { xmlMode: false });
    const inputValue = $html("input[name='javax.faces.ViewState']").attr("value");
    if (inputValue) return inputValue;

    const $xml = cheerio.load(html, { xmlMode: true });
    // El id real del update puede venir prefijado por el id de la vista y con
    // sufijo de índice: `j_id1:javax.faces.ViewState:0`.
    const viewStateUpdate = $xml("update")
      .toArray()
      .find((node) => (($xml(node).attr("id") ?? "") as string).includes("javax.faces.ViewState"));
    return viewStateUpdate ? $xml(viewStateUpdate).text() : undefined;
  }

  /** Devuelve el client ID del formulario JSF (soporta `id` o `name`). */
  extractFormId(html: string, formSelector: string): string {
    const $ = cheerio.load(html);
    const form = $(formSelector).first();
    const id = form.attr("id") ?? form.attr("name");

    if (!id) {
      throw new Error(`No se encontro form JSF con selector ${formSelector}`);
    }

    return id;
  }

  /** Resuelve el atributo `action` del formulario contra la URL actual. */
  extractFormAction(html: string, currentUrl: string, formSelector: string): string {
    const $ = cheerio.load(html);
    const action = $(formSelector).first().attr("action") ?? currentUrl;
    return new URL(action, currentUrl).toString();
  }

  /**
   * Identifica los botones/enlaces de descarga de PDF según la configuración
   * del sitio (`download`):
   *
   * - Modo `mojarra`: botones con `onclick` que coincide con `signature`
   *   (p.ej. `mojarra.jsfcljs`). Se extrae el client ID del botón y el token
   *   `paramKey` (p.ej. `param_uuid`) del objeto literal del onclick.
   * - Modo `link`: enlaces que cumplen `linkSelector`; se usa el atributo
   *   `linkAttr` (por defecto `href`) como URL directa del PDF.
   */
  extractDownloadButtons(html: string, download?: DownloadConfig): DownloadButton[] {
    const $ = cheerio.load(html);
    const buttons: DownloadButton[] = [];
    const config = download ?? { mode: "mojarra" as const, signature: "mojarra\\.jsfcljs", paramKey: "param_uuid" };

    if (config.mode === "link") {
      const linkSelector = config.linkSelector ?? "a[href$='.pdf']";
      const linkAttr = config.linkAttr ?? "href";
      $(linkSelector).each((_, element) => {
        const href = $(element).attr(linkAttr);
        if (href) buttons.push({ id: "", paramUuid: "", href });
      });
      return buttons;
    }

    const signature = new RegExp(config.signature);
    const paramKey = config.paramKey;
    $("a[onclick], button[onclick]").each((_, element) => {
      const onclick = $(element).attr("onclick") ?? "";
      if (!signature.test(onclick)) return;

      // Dentro de `mojarra.jsfcljs(form, { 'a':'a', 'param_uuid':'uuid' }, '')`
      // se parsean los pares `'clave':'valor'` del objeto literal.
      const pairs = [...onclick.matchAll(/'([^']+)':'([^']*)'/g)].map((m) => [m[1], m[2]] as const);
      const id = pairs.find(([key]) => key !== paramKey)?.[0];
      const paramUuid = pairs.find(([key]) => key === paramKey)?.[1];

      if (id && paramUuid) {
        buttons.push({ id, paramUuid });
      }
    });

    return buttons;
  }

  /**
   * Compatibilidad con selectores nada convencionales: mantiene la firma
   * histórica `extractDownloadButtonIds` que solo le interesaba el id.
   * @deprecated Usar `extractDownloadButtons`.
   */
  extractDownloadButtonIds(html: string): string[] {
    return this.extractDownloadButtons(html).map((button) => button.id);
  }

  /**
   * Extrae el client ID del paginador de un DataTable PrimeFaces. El
   * paginador suele anunciarse en el `PrimeFaces.cw('DataTable', …)` o en el
   * atributo `id` del propio nodo con clase `ui-paginator`.
   */
  extractPaginatorId(html: string): string | undefined {
    const patterns = [
      // El paginador real es un nodo con clase `ui-paginator`; su `id` suele
      // ser `<tableId>_paginator_bottom`. Se prioriza porque los otros
      // patrones capturarían el `id` del propio DataTable (`...:dt`).
      /id="([^"]+)"[^>]*class="[^"]*ui-paginator/,
      // Fallback: DataTable PrimeFaces (comillas simples o dobles en `cw`).
      /PrimeFaces\.cw\('DataTable','[^']+',\{id:'([^']+)'/,
      /PrimeFaces\.cw\("DataTable","[^"]+",\{id:"([^"]+)"[^"}]*\}\}/,
      /id="([^"]+)"[^>]*class="[^"]*ui-datatable/
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) return match[1];
    }

    return undefined;
  }

  /**
   * Fusiona el markup de una respuesta parcial de PrimeFaces. Descarta el
   * update del ViewState (consumido aparte) y concatena el **HTML interno**
   * (`.html()`) de los `<update>` restantes para poder re-parsear la tabla
   * luego de una búsqueda o paginación AJAX.
   */
  extractPartialMarkup(html: string): string {
    if (!html.includes("<partial-response")) return html;

    const $ = cheerio.load(html, { xmlMode: true });
    return $("update")
      .toArray()
      .filter((node) => !(($(node).attr("id") ?? "") as string).includes("javax.faces.ViewState"))
      .map((node) => unwrapCdata($(node).html() ?? ""))
      .join("\n");
  }

  /**
   * Parsea tarjetas de resultados en HTML navegable (modo static) usando
   * selectores CSS configurables.
   */
  extractStaticResults(html: string, baseUrl: string, selectors: StaticSelectors): SearchResult[] {
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];

    $(selectors.resultSelector).each((_, element) => {
      const node = $(element);
      const link = node.find(selectors.detailLinkSelector).first();
      const url = link.attr("href");
      const titulo =
        normalize(link.text()) || normalize(node.find("h1, h2, h3, h4, h5, h6").first().text());

      if (!url || !titulo) return;

      const autores = node
        .find("[class*='author'], [class*='creator'], [rel='author']")
        .toArray()
        .map((author) => normalize($(author).text()))
        .filter(Boolean);
      const fecha = normalize(node.find("[class*='date'], [class*='issued']").first().text());
      const resumen = normalize(
        node.find("[class*='abstract'], [class*='summary'], [class*='description']").first().text()
      );
      const pdfHref = node.find(selectors.pdfLinkSelector).first().attr("href");

      results.push({
        id: stableResultId(url, titulo),
        titulo,
        url: new URL(url, baseUrl).toString(),
        autores,
        fecha,
        resumen,
        ...(pdfHref ? { downloadUrl: new URL(pdfHref, baseUrl).toString() } : {})
      });
    });

    return results;
  }

  /** Resuelve el enlace "siguiente página" del modo static. */
  extractNextPageUrl(html: string, currentUrl: string, nextSelector: string): string | undefined {
    const $ = cheerio.load(html);
    const href = $(nextSelector).first().attr("href");
    if (!href) return undefined;
    return new URL(href, currentUrl).toString();
  }

  /** Encuentra un enlace directo de descarga PDF dentro de una página. */
  extractPdfLink(html: string, baseUrl: string, pdfSelector: string): string | undefined {
    const $ = cheerio.load(html);
    const href = $(pdfSelector).first().attr("href");
    if (!href) return undefined;
    return new URL(href, baseUrl).toString();
  }
}

const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();

/** Quita los marcadores `<![CDATA[...]]>` que envuelven el markup de los updates AJAX de JSF. */
const unwrapCdata = (value: string): string =>
  value.replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "");

const stableResultId = (url: string, titulo: string): string =>
  `${url}|${titulo}`.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 140);