/**
 * Pausa asíncrona utilizada como tasa de cortesía entre peticiones HTTP
 * para mitigar proactivamente el rate limiting del servidor.
 */
export const delay = async (delayMs: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, delayMs));