import { createWriteStream } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { AxiosError, AxiosResponse } from "axios";
import { delay } from "../shared/delay";
import { toErrorMessage } from "../shared/error";
import { DocumentoOefa, DocumentoPj, DownloadResult, FailedDownload, ScraperConfig } from "../types";
import { HttpClient } from "./HttpClient";

/**
 * Boundary de almacenamiento: responsable exclusiva de descargar archivos a
 * disco usando streams (`fs.createWriteStream`) para no cargar PDFs pesados
 * en memoria (Evita Out of Memory).
 *
 * Estrategia de reintentos:
 *  - Solo ante HTTP 429 (Too Many Requests) aplica backoff exponencial.
 *  - Cualquier otro error, o agotar los reintentos, se registra en
 *    `failures` y el programa continúa con el siguiente documento.
 *
 * La obtención del PDF puede venir de un GET (modos static/dspace) o de un
 * POST AJAX de PrimeFaces (fila de la tabla TFA); el modo de red se inyecta
 * como `responseProducer` para mantener este boundary ajeno al protocolo.
 */
export class PdfDownloader {
  private readonly failures: FailedDownload[] = [];

  constructor(
    private readonly http: HttpClient,
    private readonly config: ScraperConfig
  ) {}

  /** Registro de descargas fallidas (útil para el reporte final). */
  getFailures(): readonly FailedDownload[] {
    return this.failures;
  }

  /**
   * Descarga el PDF de un documento de la tabla TFA. El contenido se obtiene
   * del `responseProducer` (POST de PrimeFaces) y, si tiene éxito, se
   * registra la ruta local en `documento.pdfPath`.
   */
  async download(
    documento: DocumentoOefa | DocumentoPj,
    fileName: string,
    responseProducer: () => Promise<AxiosResponse>
  ): Promise<DownloadResult | undefined> {
    const result = await this.downloadFile(documento.id, fileName, responseProducer);
    if (result) {
      documento.pdfPath = result.filePath;
    }
    return result;
  }

  /** Descarga una URL arbitraria por GET (modos static/dspace). */
  async downloadUrl(id: string, url: string, fileName?: string): Promise<DownloadResult | undefined> {
    return this.downloadFile(
      id,
      fileName ?? `${sanitizeFileName(id)}.pdf`,
      () => this.http.stream(url),
      url
    );
  }

  private async downloadFile(
    id: string,
    fileName: string,
    responseProducer: () => Promise<AxiosResponse>,
    sourceLabel = fileName
  ): Promise<DownloadResult | undefined> {
    await mkdir(this.config.output.pdfDirectory, { recursive: true });
    const filePath = path.join(this.config.output.pdfDirectory, fileName);

    // Defensa: si el archivo ya existe (ejecuciones repetidas), se reutiliza.
    if (await this.fileExists(filePath)) {
      return { documentoId: id, filePath };
    }

    for (let attempt = 0; attempt <= this.config.retries.maxRetries; attempt += 1) {
      try {
        const response = await responseProducer();
        await this.writeStreamToFile(response, filePath);
        return { documentoId: id, filePath };
      } catch (error) {
        const retryable = isRetryableError(error) && attempt < this.config.retries.maxRetries;
        if (retryable) {
          // Prioriza la cabecera Retry-After del servidor; si no existe,
          // aplica backoff exponencial (base * 2^intento: 1.5s, 3s, 6s...)
          // y le suma jitter para desincronizar reintentos concurrentes.
          const exponentialWait = this.config.retries.backoffMs * 2 ** attempt;
          const waitMs = computeRetryDelay(
            error,
            exponentialWait,
            this.config.retries.maxBackoffMs
          );
          await delay(waitMs);
          continue;
        }

        this.failures.push({
          documentoId: id,
          url: sourceLabel,
          reason: toErrorMessage(error)
        });
        return undefined;
      }
    }

    return undefined;
  }

  /** Escribe el stream de la respuesta al disco usando pipeline (backpressure). */
  private async writeStreamToFile(response: AxiosResponse, filePath: string): Promise<void> {
    const writer = createWriteStream(filePath);
    await pipeline(response.data as NodeJS.ReadableStream, writer);
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

/** Remueve caracteres ilegales de nombre de archivo en Windows/POSIX. */
export const sanitizeFileName = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);

/**
 * Códigos HTTP transitorios que justifican un reintento:
 *  - 429 Too Many Requests (rate limit).
 *  - 5xx errores de servidor (500/502/503/504) habitualmente recuperables.
 * Además, cualquier error de red/timeout (sin respuesta, p.ej. ECONNRESET,
 * ETIMEDOUT) se considera reintentable por ser transitorio.
 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const isRetryableError = (error: unknown): boolean => {
  if (!(error instanceof AxiosError)) return false;
  if (!error.response) return true; // fallo de red/timeout sin respuesta HTTP.
  return RETRYABLE_STATUS.has(error.response.status);
};

/**
 * Calcula el tiempo de espera antes del siguiente reintento:
 *  1. Si el servidor envió `Retry-After`, se respeta (con techo maxBackoffMs).
 *  2. En su defecto, usa el backoff exponencial recibido.
 *  3. Aplica *full jitter* (espera aleatoria en [0, base]) para evitar que
 *     múltiples descargas reintenten sincronizadas (thundering herd).
 */
const computeRetryDelay = (
  error: unknown,
  exponentialWaitMs: number,
  maxBackoffMs: number
): number => {
  const serverWait = parseRetryAfterMs(error);
  const base = Math.min(serverWait ?? exponentialWaitMs, maxBackoffMs);
  return Math.floor(Math.random() * base);
};

/** Interpreta la cabecera `Retry-After`: segundos o fecha HTTP. */
const parseRetryAfterMs = (error: unknown): number | undefined => {
  if (!(error instanceof AxiosError)) return undefined;
  const header = error.response?.headers["retry-after"];
  if (header === undefined) return undefined;

  const asSeconds = Number(header);
  if (Number.isFinite(asSeconds)) return asSeconds * 1000;

  const asDate = Date.parse(String(header));
  if (!Number.isNaN(asDate)) {
    const delta = asDate - Date.now();
    return delta > 0 ? delta : undefined;
  }
  return undefined;
};