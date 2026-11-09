export type TrackRole = "harmony" | "melody" | "drums" | "bass" | "texture" | "balanced";

export type AnalysisCapability =
  | "loudness"
  | "spectral_change"
  | "onset_density"
  | "chroma"
  | "structure"
  | "instrument_activity"
  | "novelty";

export interface BackendDescriptor {
  id: string;
  version: string;
  schemaVersion: 1;
  capabilities: readonly AnalysisCapability[];
}

export type BackendAvailability =
  | { state: "available" }
  | { state: "unsupportedOS"; reason: string }
  | { state: "missingDependency"; reason: string }
  | { state: "unavailable"; reason: string };

export interface TempoContext {
  secondsPerBeat: number;
}

export interface AudioSourceDescriptor {
  id: string;
  name: string;
  filePath: string;
  role: TrackRole;
  startTimeSeconds: number;
  durationSeconds: number;
  tempoContext: TempoContext;
}

export interface FeatureExtractionOptions {
  windowBeats: number;
  hopBeats: number;
  targetSampleRate: number;
}

export interface EvidenceOptions {
  persistenceFrames: number;
}

export interface SegmentationOptions {
  minimumSectionBeats: number;
  sensitivity: number;
  consensus: number;
  snapBeats: number;
  maximumBoundaries: number;
}

export interface AnalysisRequest {
  source: AudioSourceDescriptor;
  requestedCapabilities: readonly AnalysisCapability[];
  extraction: FeatureExtractionOptions;
}

export interface ContinuousSignalPoint {
  timeSeconds: number;
  value: number;
  confidence?: number;
}

export interface ContinuousSignal {
  kind: string;
  sampleIntervalSeconds?: number;
  points: ContinuousSignalPoint[];
}

export const CHROMA_SIGNAL_KINDS = [
  "chroma.c", "chroma.c_sharp", "chroma.d", "chroma.d_sharp",
  "chroma.e", "chroma.f", "chroma.f_sharp", "chroma.g",
  "chroma.g_sharp", "chroma.a", "chroma.a_sharp", "chroma.b",
] as const;

export const STATE_SIGNAL_KINDS = [
  ...CHROMA_SIGNAL_KINDS,
  "level.rms",
  "rhythm.onset_density",
  "spectral.brightness",
  "dynamics.crest",
] as const;

export interface TimedEvent {
  kind: string;
  timeSeconds: number;
  confidence?: number;
  attributes?: Record<string, unknown>;
}

export interface TimedRegion {
  kind: string;
  startSeconds: number;
  durationSeconds: number;
  label?: string;
  confidence?: number;
  attributes?: Record<string, unknown>;
}

export interface AnalysisResult {
  backend: BackendDescriptor;
  sourceId: string;
  sourceName: string;
  durationSeconds: number;
  tempoContext: TempoContext;
  continuousSignals: ContinuousSignal[];
  events: TimedEvent[];
  regions: TimedRegion[];
}

export interface BoundaryEvidence {
  timeSeconds: number;
  beatTime: number;
  source: string;
  strength: number;
  confidence?: number;
  trackId?: string;
  role?: TrackRole;
  metadata?: Record<string, unknown>;
}

export interface BoundaryCandidate {
  timeSeconds: number;
  beatTime: number;
  score: number;
  confidence?: number;
  evidence: BoundaryEvidence[];
  snappedBeatTime?: number;
}

export interface JamAnalysisBackend {
  readonly descriptor: BackendDescriptor;
  availability(): BackendAvailability;
  analyze(request: AnalysisRequest, signal?: AbortSignal): Promise<AnalysisResult>;
}
