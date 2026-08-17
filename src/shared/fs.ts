import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Escribe un JSON indentado (ordenado y legible) en disco, creando los
 * directorios intermedios si es necesario.
 */
export async function persistJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}