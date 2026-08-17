import { ScraperOrchestrator } from "../core/ScraperOrchestrator";
import { HtmlParser } from "../services/HtmlParser";
import { HttpClient } from "../services/HttpClient";
import { ScraperConfig, ScraperMode, SearchStrategy } from "../types";
import { DspaceRepositoryClient } from "./DspaceRepositoryClient";
import { HydratingSearchStrategy } from "./HydratingSearchStrategy";
import { JsfPrimeFacesSearchStrategy } from "./JsfPrimeFacesSearchStrategy";
import { StaticHtmlSearchStrategy } from "./StaticHtmlSearchStrategy";

/**
 * Factory de estrategias: centraliza la selección del mecanismo de
 * extracción según el modo sin que el caso de uso conozca las
 * implementaciones concretas. Las estrategias static y dspace se decoran
 * con `HydratingSearchStrategy` para completar enlaces de descarga.
 */
export class SearchStrategyFactory {
  constructor(
    private readonly config: ScraperConfig,
    private readonly http: HttpClient,
    private readonly parser: HtmlParser,
    private readonly orchestrator: ScraperOrchestrator
  ) {}

  create(mode: ScraperMode): SearchStrategy {
    switch (mode) {
      case "jsf":
        return new JsfPrimeFacesSearchStrategy(this.orchestrator);
      case "static":
        return this.decorateWithHydration(
          new StaticHtmlSearchStrategy(this.http, this.parser, this.config)
        );
      case "dspace":
        return this.decorateWithHydration(new DspaceRepositoryClient(this.http, this.config));
    }
  }

  private decorateWithHydration(strategy: SearchStrategy): SearchStrategy {
    return new HydratingSearchStrategy(strategy, this.http, this.parser, this.config);
  }
}