/**
 * Normaliza cualquier excepción a un mensaje legible, útil para registrar
 * fallas sin romper el flujo principal del scraper.
 */
export const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);