import { TextDecoder } from "node:util";

/**
 * Decodifica los bytes de una respuesta HTTP como texto.
 *
 * Defensa ante un caso habitual en servidores de América Latina: muchos
 * responden con ISO-8859-1 sin cabecera charset correcta, y decodificarlos
 * como UTF-8 produce caracteres de reemplazo ("�"). Por eso se prueba UTF-8
 * en modo estricto y, si la secuencia es inválida, se cae a latin1.
 */
export const decodeText = (buffer: ArrayBuffer): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder("iso-8859-1").decode(buffer);
  }
};