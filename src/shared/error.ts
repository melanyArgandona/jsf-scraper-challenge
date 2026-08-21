/**
 * Normaliza cualquier excepción a un mensaje legible, útil para registrar
 * fallas sin romper el flujo principal del scraper.
 */
export const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Error lanzado cuando el sitio responde con un bloqueo de WAF (403) a
 * clientes no navegador. No es reintentable: requiere una cookie de sesión
 * capturada (variable `EXTRA_COOKIES`).
 */
export class WafBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WafBlockedError";
  }
}