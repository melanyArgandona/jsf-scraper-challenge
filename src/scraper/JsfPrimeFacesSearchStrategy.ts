import { ScraperOrchestrator } from "../core/ScraperOrchestrator";
import { DocumentoOefa, ScraperMode, SearchResult, SearchStrategy } from "../types";

/**
 * Estrategia JSF/PrimeFaces: delega la extracción al `ScraperOrchestrator`
 * (que ya conoce sesión, ViewState y paginación) y traduce los
 * `DocumentoOefa` al formato normalizado `SearchResult`.
 */
export class JsfPrimeFacesSearchStrategy implements SearchStrategy {
  readonly mode: ScraperMode = "jsf";

  constructor(private readonly orchestrator: ScraperOrchestrator) {}

  async search(query: string, maxPages: number): Promise<SearchResult[]> {
    const documentos = await this.orchestrator.run(query, maxPages);
    return documentos.map(toSearchResult);
  }
}

const toSearchResult = (documento: DocumentoOefa): SearchResult => ({
  id: documento.id,
  titulo:
    [documento.administrado, documento.nroResolucionApelacion].filter(Boolean).join(" - ") ||
    documento.id,
  url: documento.pdfPath ?? "",
  autores: [],
  fecha: "",
  resumen: [documento.numero, documento.nroExpediente, documento.sector, documento.unidadFiscalizable]
    .filter(Boolean)
    .join(" / "),
  numero: documento.numero,
  nroExpediente: documento.nroExpediente,
  administrado: documento.administrado,
  unidadFiscalizable: documento.unidadFiscalizable,
  sector: documento.sector,
  nroResolucionApelacion: documento.nroResolucionApelacion
});