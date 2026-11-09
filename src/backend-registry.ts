import type { JamAnalysisBackend } from "./analysis-contract.js";
import { DSPAnalysisBackend } from "./dsp-backend.js";

export class AnalysisBackendRegistry {
  private readonly backends = new Map<string, JamAnalysisBackend>();

  register(backend: JamAnalysisBackend): void {
    this.backends.set(backend.descriptor.id, backend);
  }

  get(id: string): JamAnalysisBackend {
    const backend = this.backends.get(id);
    if (!backend) throw new Error(`Analysis backend “${id}” is not registered.`);
    return backend;
  }
}

export const analysisBackends = new AnalysisBackendRegistry();
analysisBackends.register(new DSPAnalysisBackend());
