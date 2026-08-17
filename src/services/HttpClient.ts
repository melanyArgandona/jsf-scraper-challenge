import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import { decodeText } from "../shared/text";
import { HttpTextResponse, JsfSessionState, PrimeFacesPostOptions } from "../types";

/**
 * Cabeceras conservadoras que imitan a un navegador real para evitar
 * bloqueos por firma HTTP inusual.
 */
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "es-PE,es;q=0.9,en;q=0.7",
  "Accept-Encoding": "gzip, deflate, br",
  Connection: "keep-alive"
};

/**
 * Límite de red (boundary). Única responsabilidad: emitir peticiones HTTP
 * conservando la sesión JSF mediante un `CookieJar` raíz (persistencia
 * automática de `JSESSIONID`). No conoce DOM, JSF ni reglas de negocio.
 *
 * Se compone con `axios-cookiejar-support` + `tough-cookie` para que las
 * cookies devueltas por el servidor (especialmente `JSESSIONID`) se
 * reenvíen automáticamente en cada request, igual que haría un navegador.
 */
export class HttpClient {
  private readonly jar = new CookieJar();
  private readonly client: AxiosInstance;

  constructor(
    private readonly baseUrl: string,
    timeoutMs = 30000
  ) {
    /*
     * Nota de tipado: la definición de tipos de axios-cookiejar-support v7
     * (compilada contra axios 1.16) no extiende compatibilidad con los
     * genéricos de axios 1.19, por lo que `jar` no se reconoce en
     * `AxiosRequestConfig`. El cast aislado aquí es intencional y no
     * afecta al comportamiento en runtime.
     */
    const axiosConfig = {
      baseURL: baseUrl,
      jar: this.jar,
      timeout: timeoutMs,
      maxRedirects: 5,
      headers: BROWSER_HEADERS
    } as unknown as AxiosRequestConfig;

    this.client = wrapper(axios.create(axiosConfig) as never) as unknown as AxiosInstance;
  }

  /**
   * GET inicial que abre la sesión JSF. El servidor emite el
   * `JSESSIONID` (guardado por el `CookieJar`) y devuelve el HTML con el
   * formulario JSF y el token `javax.faces.ViewState`.
   */
  async getInitialPage(url: string, headers: Record<string, string> = {}): Promise<HttpTextResponse> {
    return this.getText(url, headers);
  }

  /** GET genérico a texto, usado por las estrategias static y dspace. */
  async getText(url: string, headers: Record<string, string> = {}): Promise<HttpTextResponse> {
    const response = await this.client.get<ArrayBuffer>(url, {
      responseType: "arraybuffer",
      headers,
      validateStatus: (status) => status >= 200 && status < 400
    });

    return {
      finalUrl: this.extractFinalUrl(url, response),
      html: decodeText(response.data)
    };
  }

  /**
   * POST genérico `application/x-www-form-urlencoded`.
   */
  async postForm(url: string, body: Record<string, string>, referer?: string): Promise<HttpTextResponse> {
    const payload = new URLSearchParams(body);
    const response = await this.client.post<ArrayBuffer>(url, payload.toString(), {
      responseType: "arraybuffer",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        ...(referer ? { Referer: referer } : {})
      },
      validateStatus: (status) => status >= 200 && status < 400
    });

    return {
      finalUrl: this.extractFinalUrl(url, response),
      html: decodeText(response.data)
    };
  }

  /**
   * Simula un evento AJAX de PrimeFaces sin navegador.
   *
   * JSF exige reenviar `javax.faces.ViewState` en cada POST: el token es la
   * "memoria" del árbol de componentes del servidor. PrimeFaces agrega los
   * campos `javax.faces.partial.*` y la cabecera `Faces-Request:
   * partial/ajax` para que la respuesta sea XML parcial
   * (`<partial-response><changes><update ...>`). El orquestador lee el
   * nuevo ViewState de esa respuesta antes del siguiente evento; usar un
   * token viejo provoca errores de sesión expirada.
   */
  async postPrimeFacesEvent(options: PrimeFacesPostOptions): Promise<HttpTextResponse> {
    const payload = new URLSearchParams({
      [options.formId]: options.formId,
      "javax.faces.ViewState": options.viewState,
      "javax.faces.partial.ajax": "true",
      "javax.faces.source": options.sourceId,
      // Si no se especifica, JSF asume `@all`: se ejecuta el formulario.
      "javax.faces.partial.execute": options.execute ?? options.sourceId,
      "javax.faces.partial.render": options.render ?? options.sourceId,
      [options.sourceId]: options.sourceId,
      ...(options.extraFields ?? {})
    });

    const response = await this.client.post<ArrayBuffer>(options.actionUrl, payload.toString(), {
      responseType: "arraybuffer",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Faces-Request": "partial/ajax",
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/xml, text/xml, */*; q=0.01",
        Referer: options.actionUrl
      },
      validateStatus: (status) => status >= 200 && status < 400
    });

    return {
      finalUrl: this.extractFinalUrl(options.actionUrl, response),
      html: decodeText(response.data)
    };
  }

  /**
   * GET con `responseType: "stream"` para las descargas de PDF. Solo
   * valida respuestas exitosas (2xx); cualquier otro código lanza un
   * `AxiosError`, que el descargador usa para reintentar ante 429.
   */
  async stream(url: string, config: AxiosRequestConfig = {}): Promise<AxiosResponse> {
    return this.client.get(url, {
      ...config,
      responseType: "stream",
      validateStatus: (status) => status >= 200 && status < 300
    });
  }

  /**
   * POST `application/x-www-form-urlencoded` con `responseType: "stream"`,
   * usado para simular el clic en el botón de descarga de una fila del
   * DataTable PrimeFaces. Devuelve el body binario (el PDF) para volcarlo a
   * disco sin cargarlo en memoria.
   */
  async postStream(
    url: string,
    body: Record<string, string>,
    headers: Record<string, string> = {}
  ): Promise<AxiosResponse> {
    return this.client.post(url, new URLSearchParams(body).toString(), {
      responseType: "stream",
      headers,
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 300
    });
  }

  /** Serializa las cookies de sesión vigentes como string. */
  async getSessionState(viewState: string): Promise<JsfSessionState> {
    return {
      cookies: await this.jar.getCookieString(this.baseUrl),
      viewState
    };
  }

  resolveUrl(url: string): string {
    return new URL(url, this.baseUrl).toString();
  }

  /** URL final real tras redirecciones (respeta el `responseUrl` de follow-redirects). */
  private extractFinalUrl(fallbackUrl: string, response: AxiosResponse): string {
    const responseUrl = response.request?.res?.responseUrl as string | undefined;
    return responseUrl ?? this.resolveUrl(fallbackUrl);
  }
}