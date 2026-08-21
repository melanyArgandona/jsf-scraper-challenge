import { AxiosResponse } from "axios";
import { HtmlParser } from "../services/HtmlParser";
import { HttpClient } from "../services/HttpClient";
import { HttpTextResponse, JsfPage } from "../types";

/**
 * Protocolo JSF/PrimeFaces (wire protocol). Única responsabilidad: traducir
 * las interacciones del usuario en peticiones HTTP válidas para JSF y
 * mantener vigente la instancia `JsfPage` (ViewState, form, action).
 *
 * Puntos críticos de JSF que esta clase resuelve:
 *  1. El `javax.faces.ViewState` es la "memoria" del árbol de componentes
 *     del servidor. Debe reenviarse tal cual en cada POST y refrescarse con
 *     el valor que devuelve cada respuesta parcial.
 *  2. PrimeFaces usa AJAX parcial (cabecera `Faces-Request: partial/ajax`)
 *     y la respuesta es XML con nodos `<update>` que hay que fusionar sobre
 *     el HTML previo para seguir parseando.
 */
export class PrimeFacesClient {
  constructor(
    private readonly http: HttpClient,
    private readonly parser: HtmlParser,
    private readonly formSelector: string
  ) {}

  /** GET inicial: abre la sesión JSF (cookie JSESSIONID) y carga el formulario. */
  async startSession(startUrl: string): Promise<JsfPage> {
    const response = await this.http.getInitialPage(startUrl);
    return this.fromFullHtml(response);
  }

  /**
   * POST AJAX de búsqueda. El `source` es el botón de búsqueda; se ejecuta
   * y renderiza el formulario completo para que PrimeFaces recargue la
   * tabla de resultados y el paginador.
   */
  async submitSearch(
    page: JsfPage,
    term: string,
    inputName: string,
    buttonName: string,
    extraFields: Record<string, string> = {}
  ): Promise<JsfPage> {
    const response = await this.http.postPrimeFacesEvent({
      actionUrl: page.actionUrl,
      formId: page.formId,
      sourceId: buttonName,
      viewState: page.viewState,
      execute: page.formId,
      render: page.formId,
      extraFields: {
        [inputName]: term,
        ...extraFields
      }
    });

    return this.fromPartialResponse(response, page);
  }

  /**
   * POST AJAX de paginación del DataTable PrimeFaces.
   *
   * El paginador no navega con enlaces: emite un AJAX indicando la fila
   * inicial (`_first`), la cantidad de filas (`_rows`) y el componente
   * fuente. `_first` para la página N es `N * rowsPerPage`. El ViewState
   * vigente es obligatorio para que JSF reconstruya el estado del DataTable.
   *
   * El evento lo dispara el widget DataTable (id `<tabla>`, no el div del
   * paginador) como `source`/`process`/`update`, y los parámetros de estado
   * usan el prefijo del id de la tabla. `_skipChildren` y `_encodeFeature`
   * son obligatorios: sin ellos el servidor ignora `_first` y devuelve
   * siempre la página 1.
   */
  async nextPage(
    page: JsfPage,
    paginatorId: string,
    firstRow: number,
    rowsPerPage: number
  ): Promise<JsfPage> {
    // En PrimeFaces el paginador tiene id `<tabla>_paginator_bottom`; el
    // evento de paginación referencia la tabla como `source`/`render`.
    const tableId = paginatorId.replace(/_paginator(?:_(?:bottom|top))?$/, "");

    const response = await this.http.postPrimeFacesEvent({
      actionUrl: page.actionUrl,
      formId: page.formId,
      sourceId: tableId,
      viewState: page.viewState,
      execute: tableId,
      render: tableId,
      extraFields: {
        [`${tableId}_pagination`]: "true",
        [`${tableId}_first`]: String(firstRow),
        [`${tableId}_rows`]: String(rowsPerPage),
        [`${tableId}_skipChildren`]: "true",
        [`${tableId}_encodeFeature`]: "true"
      }
    });

    return this.fromPartialResponse(response, page);
  }

  /**
   * Simula el clic en el botón "Descargar" de la fila del DataTable.
   *
   * En este sitio los botones de descarga no usan AJAX de PrimeFaces sino
   * `h:commandLink` + `mojarra.jsfcljs(...)`: el navegador hace un POST
   * del formulario completo (sin `Faces-Request: partial/ajax`) reenviando
   * el ViewState vigente, el client ID del botón como valor y el token
   * `param_uuid` único de la fila. El servidor responde con el body del PDF
   * (content-type `application/octet-stream`), que se vuelca a disco por
   * streaming en la capa de almacenamiento.
   */
  async downloadRow(
    page: JsfPage,
    downloadButtonId: string,
    paramUuid: string,
    params?: Record<string, string>
  ): Promise<AxiosResponse> {
    const body: Record<string, string> = {
      [page.formId]: page.formId,
      "javax.faces.ViewState": page.viewState,
      [downloadButtonId]: downloadButtonId
    };

    // Todos los pares del `mojarra.jsfcljs(...)` de la fila (reproduce el POST
    // exacto del navegador, incluyendo el token `param_uuid` y cualquier campo
    // oculto adicional que exija el servidor).
    if (params && Object.keys(params).length > 0) {
      Object.assign(body, params);
    } else if (paramUuid.trim() !== "") {
      // Fallback: solo el token param_uuid (sitios mojarra sin pares extra).
      body.param_uuid = paramUuid;
    }

    return this.http.postStream(page.actionUrl, body, {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Referer: page.actionUrl
    });
  }

  /**
   * Descarga directa por GET de una URL de PDF (modo de descarga `link`).
   * Reutiliza el `HttpClient` (cookie jar, cabeceras) para mantener la
   * sesión del sitio.
   */
  async streamUrl(url: string): Promise<AxiosResponse> {
    return this.http.stream(url);
  }

  private fromFullHtml(response: HttpTextResponse): JsfPage {
    const viewState = this.parser.extractViewState(response.html);
    if (!viewState) {
      throw new Error("No se encontro javax.faces.ViewState en la pagina inicial");
    }

    return {
      html: response.html,
      finalUrl: response.finalUrl,
      viewState,
      formId: this.parser.extractFormId(response.html, this.formSelector),
      actionUrl: this.parser.extractFormAction(response.html, response.finalUrl, this.formSelector)
    };
  }

  /**
   * Fusiona una respuesta parcial AJAX: refresca el ViewState con el valor
   * devuelto por el servidor (crítico para la siguiente interacción) y
   * reemplaza el HTML por el markup de los `<update>`.
   */
  private fromPartialResponse(response: HttpTextResponse, previous: JsfPage): JsfPage {
    const viewState = this.parser.extractViewState(response.html) ?? previous.viewState;

    return {
      html: this.parser.extractPartialMarkup(response.html),
      finalUrl: response.finalUrl,
      viewState,
      formId: previous.formId,
      actionUrl: previous.actionUrl
    };
  }
}