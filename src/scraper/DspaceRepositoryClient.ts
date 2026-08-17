import { delay } from "../shared/delay";
import { HttpClient } from "../services/HttpClient";
import {
  DspaceBitstreamsResponse,
  DspaceItem,
  DspaceSearchObjectsResponse,
  ScraperConfig,
  ScraperMode,
  SearchResult,
  SearchStrategy
} from "../types";
import { deriveTfaColumns } from "./tfaMapping";

/**
 * Adaptador de la API REST pública de DSpace 7 (el repositorio OEFA actual
 * responde como DSpace/Angular). Implementa `SearchStrategy` consultando
 * `/api/discover/search/objects` y resuelve enlaces de descarga vía
 * `/api/core/items/{uuid}/bitstreams`.
 */
export class DspaceRepositoryClient implements SearchStrategy {
  readonly mode: ScraperMode = "dspace";

  constructor(
    private readonly http: HttpClient,
    private readonly config: ScraperConfig
  ) {}

  async search(query: string, maxPages: number): Promise<SearchResult[]> {
    const items = await this.fetchItems(query, maxPages);
    const results: SearchResult[] = [];

    for (const item of items) {
      const downloadUrl = await this.resolveDownloadUrl(item);
      results.push(toSearchResult(item, this.config.urls.baseUrl, downloadUrl, results.length));
      await delay(this.config.delays.courtesyDelayMs);
    }

    return results;
  }

  private async fetchItems(query: string, maxPages: number): Promise<DspaceItem[]> {
    const size = this.config.primeFaces.rowsPerPage;
    const items: DspaceItem[] = [];

    for (let page = 0; page < maxPages; page += 1) {
      await delay(this.config.delays.courtesyDelayMs);

      const url = this.buildObjectsUrl(query, page, size);
      const response = await this.http.getText(url, { Accept: "application/json" });
      const payload = JSON.parse(response.html) as DspaceSearchObjectsResponse;

      const objects = payload._embedded?.searchResult?._embedded?.objects ?? [];
      const found = objects
        .map((object) => object._embedded?.indexableObject)
        .filter((item): item is DspaceItem => item !== undefined);

      items.push(...found);
      if (found.length === 0 || found.length < size) break;
    }

    return items;
  }

  /**
   * Resuelve el enlace de descarga del primer bitstream (priorizando un PDF).
   * Programación defensiva: si falla la consulta, devuelve undefined y la
   * hidratación genérica intentará completarlo.
   */
  private async resolveDownloadUrl(item: DspaceItem): Promise<string | undefined> {
    if (!item.uuid) return undefined;

    try {
      const url = `${this.config.urls.baseUrl}/server/api/core/items/${item.uuid}/bitstreams`;
      const response = await this.http.getText(url, { Accept: "application/json" });
      const payload = JSON.parse(response.html) as DspaceBitstreamsResponse;
      const streams = payload._embedded?.bitstreams ?? [];

      const pdf = streams.find((stream) => (stream.name ?? "").toLowerCase().endsWith(".pdf")) ?? streams[0];
      return pdf?._links?.content?.href;
    } catch {
      return undefined;
    }
  }

  private buildObjectsUrl(query: string, page: number, size: number): string {
    const url = new URL(`${this.config.urls.baseUrl}/server/api/discover/search/objects`);
    url.searchParams.set("query", query);
    url.searchParams.set("page", String(page));
    url.searchParams.set("size", String(size));
    return url.toString();
  }
}

const toSearchResult = (
  item: DspaceItem,
  baseUrl: string,
  downloadUrl: string | undefined,
  index: number
): SearchResult => {
  const first = (field: string): string => item.metadata?.[field]?.[0]?.value ?? "";

  const titulo = first("dc.title");
  const autores = (item.metadata?.["dc.contributor.author"] ?? [])
    .map((value) => value.value?.trim() ?? "")
    .filter(Boolean);
  const fecha = first("dc.date.issued");
  const resumen = first("dc.description.abstract");
  const subjects = (item.metadata?.["dc.subject"] ?? [])
    .map((value) => value.value?.trim() ?? "")
    .filter(Boolean);
  const handle = item.handle ? `${baseUrl}/handle/${item.handle}` : undefined;
  const url = handle ?? (item.uuid ? `${baseUrl}/server/api/core/items/${item.uuid}` : "");

  return {
    id: item.uuid ?? item.handle ?? url,
    titulo,
    url,
    autores,
    fecha,
    resumen,
    ...(downloadUrl ? { downloadUrl } : {}),
    ...deriveTfaColumns({ titulo, resumen, subjects }, index)
  };
};