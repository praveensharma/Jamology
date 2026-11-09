import type {
  AnalysisRequest,
  AnalysisResult,
  BackendDescriptor,
  JamAnalysisBackend,
} from "./analysis-contract.js";
import { extractAiffSignals } from "./streaming-aiff.js";

export const DSP_BACKEND_DESCRIPTOR: BackendDescriptor = {
  id: "dsp",
  version: "1.0.0",
  schemaVersion: 1,
  capabilities: ["loudness", "spectral_change", "onset_density", "chroma", "novelty"],
};

export class DSPAnalysisBackend implements JamAnalysisBackend {
  readonly descriptor = DSP_BACKEND_DESCRIPTOR;

  availability() {
    return { state: "available" as const };
  }

  async analyze(request: AnalysisRequest, signal?: AbortSignal): Promise<AnalysisResult> {
    const extracted = await extractAiffSignals(request.source, request.extraction, signal);
    return {
      backend: this.descriptor,
      sourceId: request.source.id,
      sourceName: request.source.name,
      durationSeconds: extracted.durationSeconds,
      tempoContext: request.source.tempoContext,
      continuousSignals: extracted.continuousSignals,
      events: [],
      regions: [],
    };
  }
}
