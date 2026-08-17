import { SearchResult } from "../types";

/**
 * Derivación de las columnas de la tabla del TFA (Nro., Nro. Expediente,
 * Administrado, Unidad Fiscalizable, Sector y Nro. Resolución de Apelación)
 * a partir de los metadatos genéricos de un resultado (título, resumen y
 * materias). Función pura, sin red ni parsing, reutilizada por las
 * estrategias static/dspace para que `SearchResult` exponga el mismo esquema
 * que la consulta JSF del Tribunal.
 */
export interface TfaColumns {
  numero: string;
  nroExpediente: string;
  administrado: string;
  unidadFiscalizable: string;
  sector: string;
  nroResolucionApelacion: string;
}

/**
 * Fuente de datos genérica sobre la que se derivan las columnas TFA.
 */
export interface TfaColumnSource {
  titulo: string;
  resumen: string;
  subjects: string[];
}

export function deriveTfaColumns(source: TfaColumnSource, index: number): TfaColumns {
  const titulo = normalize(source.titulo);
  const resumen = normalize(source.resumen);
  const texto = `${titulo} ${resumen}`;

  const nroResolucionApelacion =
    firstMatch(titulo, RESOLUCION_APELACION) ?? firstMatch(resumen, RESOLUCION_APELACION) ?? "";

  // El expediente es distinto del Nro. de resolución: se quita el número de
  // apelación antes de buscar el patrón de expediente y se descartan las
  // resoluciones de Consejo Directivo (OEFA/CD) para no falsear la columna.
  const textoSinResolucion = nroResolucionApelacion
    ? texto.replace(nroResolucionApelacion, "")
    : texto;
  const candidatoExpediente =
    firstMatch(textoSinResolucion, EXPEDIENTE_SLASH) ?? firstMatch(textoSinResolucion, EXPEDIENTE_GUION) ?? "";
  const nroExpediente = candidatoExpediente && !EXCLUIR_CD_TFA.test(candidatoExpediente) ? candidatoExpediente : "";

  return {
    numero: String(index + 1),
    nroExpediente,
    administrado: extractAdministrado(titulo, resumen),
    unidadFiscalizable: extractUnidadFiscalizable(titulo, resumen),
    sector: extractSector(source.subjects, titulo, resumen),
    nroResolucionApelacion
  };
}

/** Aplica las columnas TFA sobre un resultado genérico. */
export const enrichWithTfaColumns = (
  result: SearchResult,
  source: TfaColumnSource,
  index: number
): SearchResult => ({
  ...result,
  ...deriveTfaColumns(source, index)
});

const RESOLUCION_APELACION = /(\d{1,4}-\d{4}-OEFA\/TFA(?:-[A-Z]+)?)/i;
const EXPEDIENTE_SLASH = /(\d{2,4}-\d{4}-[A-Z]{2,6}(?:\/[A-Z]{2,6})+)/;
const EXPEDIENTE_GUION = /(\d{2,4}-\d{4}-[A-Z]{2,6}-[A-Z]{2,6})/;
const EXCLUIR_CD_TFA = /(\/TFA|\/CD|-CD)\b/;

const RAZON_SOCIAL =
  "S\\.?\\s*A\\.?\\s*C\\.?|S\\.?\\s*A\\.?|S\\.?\\s*R\\.?\\s*L\\.?|E\\.?\\s*I\\.?\\s*R\\.?\\s*L\\.?";

function extractAdministrado(titulo: string, resumen: string): string {
  // "…de Minera Yanacocha S.R.L." (título) → Minera Yanacocha S.R.L.
  const delTitulo = firstMatch(
    titulo,
    new RegExp(`de\\s+([A-ZÁÉÍÓÚÑ][^.,;"“”]*?\\s+(?:${RAZON_SOCIAL}))`, "i")
  );
  if (delTitulo) return cleanLeading(delTitulo);

  // "…de propiedad de Aruntani S.A.,…" → Aruntani S.A.
  const dePropiedad = firstMatch(resumen, /de propiedad de ([^,;]+)/i);
  if (dePropiedad) return cleanLeading(dePropiedad);

  // "…impuesta a la Empresa de Generación Eléctrica del Sur S.A. (Egesur)"
  const impuesta = firstMatch(
    resumen,
    new RegExp(`(?:impuesta|imputada)\\s+a\\s+(?:la\\s+)?([A-ZÁÉÍÓÚÑ][^.,;]*?\\s+(?:${RAZON_SOCIAL}))`, "i")
  );
  if (impuesta) return cleanLeading(impuesta);

  return "";
}

function extractUnidadFiscalizable(titulo: string, resumen: string): string {
  const uea =
    firstMatch(titulo, /UEA\s*(?:"([^"]+)"|([A-ZÁÉÍÓÚÑ][^.,;]*))/i) ??
    firstMatch(resumen, /UEA\s*(?:"([^"]+)"|([A-ZÁÉÍÓÚÑ][^.,;]*))/i);
  if (uea) return `UEA ${uea}`;

  const central = firstMatch(resumen, /centrales hidroeléctricas [^.,;]+/i);
  if (central) return capitalize(central);

  const unidadMinera = firstMatch(resumen, /unidad minera [^.,;]+/i);
  if (unidadMinera) return capitalize(unidadMinera);

  return "";
}

const REGLAS_SECTOR: ReadonlyArray<[RegExp, string]> = [
  [/pesquer/i, "Pesquería"],
  [/hidrocarburo/i, "Hidrocarburos"],
  [/hidroelectr|elé?ctr/i, "Electricidad"],
  [/miner/i, "Minería"],
  [/industria/i, "Industria"]
];

function extractSector(subjects: string[], titulo: string, resumen: string): string {
  const texto = [...subjects, titulo, resumen].join(" ").toLowerCase();
  for (const [regex, sector] of REGLAS_SECTOR) {
    if (regex.test(texto)) return sector;
  }
  return "";
}

const firstMatch = (text: string, regex: RegExp): string | undefined => {
  const match = text.match(regex);
  return match?.[1] ?? match?.[0];
};

const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();

const cleanLeading = (value: string): string => value.replace(/^(?:la\s+|de\s+|el\s+)/i, "").trim();

const capitalize = (value: string): string =>
  value.length > 0 ? value.charAt(0).toUpperCase() + value.slice(1) : value;