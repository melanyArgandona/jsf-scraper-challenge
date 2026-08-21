/**
 * Smoke test (sin framework) del scraper. Valida:
 *  - Extracción de tarjetas del PJ (`parseCardsPage`) con HTML mock.
 *  - Lógica de reintentos 429/5xx/red: detección, `Retry-After` y jitter.
 *  - `PdfDownloader`: registro de fallo persistente y continuación.
 *  - `PdfDownloader`: descarga exitosa por streaming a disco (temp).
 *
 * Ejecutar: `npm test`  (ts-node --transpile-only scripts/smoke.ts)
 */
import { Readable } from "node:stream";
import { access, mkdir, rm } from "node:fs/promises";
import { AxiosError } from "axios";
import type { AxiosResponse } from "axios";
import { HtmlParser } from "../src/services/HtmlParser";
import { PdfDownloader } from "../src/services/PdfDownloader";
import { SITE_PROFILES, resolveScraperConfig } from "../src/config";
import type { DocumentoPj } from "../src/types";

let passed = 0;
let failed = 0;

function assert(cond: unknown, message: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ok  - ${message}`);
  } else {
    failed += 1;
    console.error(`  FAIL - ${message}`);
  }
}

/** Construye un AxiosError con el status / headers indicados (o sin respuesta). */
function makeAxios(status?: number, headers: Record<string, string> = {}): AxiosError {
  const error = new AxiosError("boom");
  if (status !== undefined) {
    (error as unknown as { response: unknown }).response = { status, headers };
  }
  return error;
}

const MOCK_PJ_HTML = [
  "<div class='ui-panel'>",
  "<span>Tipo de Expediente</span><span>Casación</span>",
  "<span>Nro. de Expediente</span><span>020705-2025</span>",
  "<span>Pretensión/Delito</span><span>Desnaturalización de Contrato</span>",
  "<span>Tipo Resolución</span><span>Ejecutoria Suprema</span>",
  "<span>Fecha Resolución</span><span>17/07/2026</span>",
  "<span>Sala Suprema</span><span>Segunda Sala Constitucional</span>",
  "<button id='formBusqueda:tablaResultados:0:btnVerResolucion'>Ver Resolución</button>",
  "</div>"
].join("");

async function testParseCards(): Promise<void> {
  console.log("\n[parseCards] extracción de tarjetas PJ");
  const parser = new HtmlParser();
  const page = parser.parseCardsPage(MOCK_PJ_HTML, SITE_PROFILES.pj.pj);
  assert(page.documentos.length === 1, "extrae 1 tarjeta");
  const d = page.documentos[0] as DocumentoPj;
  assert(d.tipoExpediente === "Casación", "tipoExpediente = Casación");
  assert(d.nroExpediente === "020705-2025", "nroExpediente = 020705-2025");
  assert(d.pretensionDelito === "Desnaturalización de Contrato", "pretensionDelito");
  assert(d.tiporesolucion === "Ejecutoria Suprema", "tiporesolucion");
  assert(d.fechaResolucion === "17/07/2026", "fechaResolucion");
  assert(d.salaSuprema === "Segunda Sala Constitucional", "salaSuprema");
  assert(
    page.downloadButtons[0]?.id === "formBusqueda:tablaResultados:0:btnVerResolucion",
    "id del botón calculado por índice"
  );
}

async function testRetryLogic(): Promise<void> {
  console.log("\n[reintentos] detección, Retry-After y jitter");
  const {
    isRetryableError,
    parseRetryAfterMs,
    computeRetryDelay,
    RETRYABLE_STATUS
  } = await import("../src/services/PdfDownloader");

  assert(isRetryableError(makeAxios(429)) === true, "429 es reintentable");
  assert(isRetryableError(makeAxios(503)) === true, "503 es reintentable");
  assert(isRetryableError(makeAxios(400)) === false, "400 NO es reintentable");
  assert(isRetryableError(makeAxios()) === true, "error de red (sin respuesta) es reintentable");
  assert(isRetryableError(new Error("x")) === false, "Error genérico NO es reintentable");
  assert(RETRYABLE_STATUS.has(429) && RETRYABLE_STATUS.has(502), "set incluye 429/5xx");

  assert(parseRetryAfterMs(makeAxios(429, { "retry-after": "5" })) === 5000, "Retry-After=5s -> 5000ms");
  assert(parseRetryAfterMs(makeAxios(429)) === undefined, "sin Retry-After -> undefined");
  const future = parseRetryAfterMs(makeAxios(429, { "retry-after": "Wed, 21 Oct 2099 07:28:00 GMT" }));
  assert(typeof future === "number" && (future as number) > 0, "Retry-After (fecha) -> delta positivo");

  // Sin Retry-After: backoff 1500, jitter en [0,1500).
  for (let i = 0; i < 20; i += 1) {
    const wait = computeRetryDelay(makeAxios(429), 1500, 60000);
    if (wait < 0 || wait >= 1500) {
      assert(false, `jitter fuera de [0,1500): ${wait}`);
      break;
    }
  }
  assert(true, "jitter siempre en [0, backoff) (20 muestras)");

  // Con Retry-After 5s y techo 60s: base=5000, jitter en [0,5000).
  const waitRa = computeRetryDelay(makeAxios(429, { "retry-after": "5" }), 1500, 60000);
  assert(waitRa >= 0 && waitRa < 5000, `Retry-After respeta techo (wait=${waitRa})`);
}

async function testPdfDownloaderFailures(): Promise<void> {
  console.log("\n[PdfDownloader] fallo persistente 429 se registra y continúa");
  process.env.MAX_RETRIES = "1";
  process.env.BACKOFF_MS = "1";
  const config = resolveScraperConfig({
    query: "",
    mode: undefined,
    maxPages: undefined,
    rowsPerPage: undefined,
    courtesyDelayMs: undefined,
    resume: false
  });
  const downloader = new PdfDownloader({} as never, config);

  const doc = { id: "x", numero: "", nroExpediente: "", administrado: "", unidadFiscalizable: "", sector: "", nroResolucionApelacion: "" };
  const result = await downloader.download(doc as never, "x.pdf", () => {
    throw makeAxios(429);
  });

  assert(result === undefined, "retorna undefined tras agotar reintentos");
  const failures = downloader.getFailures();
  assert(failures.length === 1, "registra 1 fallo");
  assert(failures[0]?.documentoId === "x", "fallo tiene el documentoId correcto");
}

async function testPdfDownloaderSuccess(): Promise<void> {
  console.log("\n[PdfDownloader] descarga exitosa por streaming (temp)");
  const tmp = `${process.env.TEMP ?? "/tmp"}/scraper-smoke`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });

  const config = resolveScraperConfig({
    query: "",
    mode: undefined,
    maxPages: undefined,
    rowsPerPage: undefined,
    courtesyDelayMs: undefined,
    resume: false
  });
  config.output.pdfDirectory = tmp;
  const downloader = new PdfDownloader({} as never, config);

  const fakeResponse = {
    status: 200,
    statusText: "OK",
    headers: {},
    config: {},
    data: Readable.from([Buffer.from("%PDF-1.4 mock contenido")])
  } as AxiosResponse;

  const doc = { id: "ok", numero: "", nroExpediente: "", administrado: "", unidadFiscalizable: "", sector: "", nroResolucionApelacion: "" };
  const result = await downloader.download(doc as never, "ok.pdf", () => Promise.resolve(fakeResponse));

  assert(result !== undefined, "retorna un resultado");
  if (result) {
    try {
      await access(result.filePath);
      assert(true, `PDF escrito en ${result.filePath}`);
    } catch {
      assert(false, "el archivo PDF no existe en disco");
    }
  }
  await rm(tmp, { recursive: true, force: true });
}

async function main(): Promise<void> {
  console.log("=== Smoke test del scraper ===");
  await testParseCards();
  await testRetryLogic();
  await testPdfDownloaderFailures();
  await testPdfDownloaderSuccess();

  console.log(`\n=== Resultado: ${passed} ok, ${failed} fallos ===`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error("Error en el smoke test:", error);
  process.exitCode = 1;
});
