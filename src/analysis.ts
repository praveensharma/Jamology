import {
  STATE_SIGNAL_KINDS,
  type AnalysisResult,
  type BoundaryEvidence,
  type EvidenceOptions,
  type FeatureExtractionOptions,
  type SegmentationOptions,
  type TrackRole,
} from "./analysis-contract.js";

export type { TrackRole } from "./analysis-contract.js";

export interface AudioData {
  channels: readonly Float32Array[];
  sampleRate: number;
}

export interface AnalysisOptions extends FeatureExtractionOptions, EvidenceOptions, SegmentationOptions {}

export interface TrackAnalysis {
  name: string;
  role?: TrackRole;
  evidence: BoundaryEvidence[];
}

export interface Boundary {
  beat: number;
  score: number;
  drivers: TrackRole[];
}

export interface Region {
  startBeat: number;
  endBeat: number;
  entryScore: number;
  entryDrivers: TrackRole[];
  sourceStartBeat: number;
}

export interface SegmentationResult {
  boundaries: Boundary[];
  regions: Region[];
  globalCurve: Array<{ beat: number; score: number; drivers: TrackRole[] }>;
}

export const DEFAULT_FEATURE_EXTRACTION_OPTIONS: FeatureExtractionOptions = {
  windowBeats: 16,
  hopBeats: 8,
  targetSampleRate: 4_000,
};

export const DEFAULT_EVIDENCE_OPTIONS: EvidenceOptions = {
  persistenceFrames: 3,
};

export const DEFAULT_SEGMENTATION_OPTIONS: SegmentationOptions = {
  minimumSectionBeats: 192,
  sensitivity: 0.35,
  consensus: 0.7,
  snapBeats: 4,
  maximumBoundaries: 12,
};

export const DEFAULT_ANALYSIS_OPTIONS: AnalysisOptions = {
  ...DEFAULT_FEATURE_EXTRACTION_OPTIONS,
  ...DEFAULT_EVIDENCE_OPTIONS,
  ...DEFAULT_SEGMENTATION_OPTIONS,
};

const EPSILON = 1e-9;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = clamp01(q) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;
  return sorted[lower]! * (1 - fraction) + sorted[upper]! * fraction;
}

function normalizeFeatures(features: readonly number[][]): number[][] {
  if (features.length === 0) return [];
  const dimensions = features[0]!.length;
  const means = Array(dimensions).fill(0) as number[];
  const deviations = Array(dimensions).fill(0) as number[];

  for (const frame of features) {
    frame.forEach((value, index) => {
      means[index] = means[index]! + value;
    });
  }
  means.forEach((value, index) => {
    means[index] = value / features.length;
  });

  for (const frame of features) {
    frame.forEach((value, index) => {
      deviations[index] = deviations[index]! + (value - means[index]!) ** 2;
    });
  }
  deviations.forEach((_, index) => {
    deviations[index] = Math.sqrt(deviations[index]! / features.length) || 1;
  });

  return features.map((frame) =>
    frame.map((value, index) => (value - means[index]!) / deviations[index]!),
  );
}

function windowFeatures(
  channels: readonly Float32Array[],
  start: number,
  end: number,
  stride: number,
): number[] {
  let sumSquares = 0;
  let sumAbsolute = 0;
  let sumDifferenceSquares = 0;
  let peak = 0;
  let zeroCrossings = 0;
  let count = 0;
  let previous = 0;
  let hasPrevious = false;

  for (let sampleIndex = start; sampleIndex < end; sampleIndex += stride) {
    let sample = 0;
    for (const channel of channels) sample += channel[sampleIndex] ?? 0;
    sample /= channels.length;

    const absolute = Math.abs(sample);
    sumSquares += sample * sample;
    sumAbsolute += absolute;
    peak = Math.max(peak, absolute);
    if (hasPrevious) {
      const difference = sample - previous;
      sumDifferenceSquares += difference * difference;
      if ((sample >= 0) !== (previous >= 0)) zeroCrossings += 1;
    }
    previous = sample;
    hasPrevious = true;
    count += 1;
  }

  if (count === 0) return [0, 0, 0, 0, 0];
  const rms = Math.sqrt(sumSquares / count);
  const differenceRms = Math.sqrt(sumDifferenceSquares / Math.max(1, count - 1));
  return [
    Math.log1p(rms * 20),
    sumAbsolute / count,
    differenceRms,
    zeroCrossings / Math.max(1, count - 1),
    peak / Math.max(rms, EPSILON),
  ];
}

function normalizeChanges(changes: readonly number[]): number[] {
  const low = quantile(changes, 0.1);
  const high = quantile(changes, 0.9);
  const span = high - low;
  if (span <= EPSILON) return changes.map(() => 0);
  // Keep exceptional changes above 1 instead of flattening every upper-tail
  // event to the same score. Boundary ranking needs to distinguish the few
  // truly large state changes from ordinary local peaks.
  return changes.map((value) => Math.max(0, (value - low) / span));
}

export function inferTrackRole(name: string): TrackRole {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  if (/\b(drum|drums|kick|snare|hat|hihat|hi hat|perc|percussion|rhythm|rytm|808|break)\b/.test(normalized)) return "drums";
  if (/\b(chord|chords|harmony|harmonic|keys|piano|organ|poly|pad)\b/.test(normalized)) return "harmony";
  if (/\b(melody|lead|solo|arp|arpeggio|voice|vocal)\b/.test(normalized)) return "melody";
  if (/\b(bass|sub)\b/.test(normalized)) return "bass";
  if (/\b(texture|fx|noise|atmos|atmosphere|drone)\b/.test(normalized)) return "texture";
  return "balanced";
}

export function inferTrackRoleFromHierarchy(trackName: string, groupNames: readonly string[]): TrackRole {
  const directRole = inferTrackRole(trackName);
  if (directRole !== "balanced") return directRole;
  for (const groupName of groupNames) {
    const groupRole = inferTrackRole(groupName);
    if (groupRole !== "balanced") return groupRole;
  }
  return "balanced";
}

function meanFrames(features: readonly number[][], start: number, end: number): number[] {
  const width = features[0]?.length ?? 0;
  const mean = Array(width).fill(0) as number[];
  const count = Math.max(1, end - start);
  for (let frame = start; frame < end; frame += 1) {
    for (let dimension = 0; dimension < width; dimension += 1) {
      mean[dimension] = mean[dimension]! + (features[frame]?.[dimension] ?? 0) / count;
    }
  }
  return mean;
}

function cosineDistance(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * (right[index] ?? 0);
    leftMagnitude += left[index]! ** 2;
    rightMagnitude += (right[index] ?? 0) ** 2;
  }
  if (leftMagnitude <= EPSILON && rightMagnitude <= EPSILON) return 0;
  if (leftMagnitude <= EPSILON || rightMagnitude <= EPSILON) return 1;
  return clamp01(1 - dot / Math.sqrt(leftMagnitude * rightMagnitude));
}

function musicalStateDistance(before: readonly number[], after: readonly number[], role: TrackRole): number {
  const chroma = cosineDistance(before.slice(0, 12), after.slice(0, 12));
  const level = Math.min(1, Math.abs((before[12] ?? 0) - (after[12] ?? 0)) / 0.7);
  const transients = Math.min(1, Math.abs((before[13] ?? 0) - (after[13] ?? 0)) / 0.08);
  const brightness = Math.min(1, Math.abs((before[14] ?? 0) - (after[14] ?? 0)) / 0.12);
  const activity = Math.min(1, Math.abs((before[15] ?? 0) - (after[15] ?? 0)) / 1.5);
  switch (role) {
    case "harmony": return 0.82 * chroma + 0.10 * level + 0.05 * brightness + 0.03 * activity;
    case "melody": return 0.68 * chroma + 0.12 * level + 0.10 * brightness + 0.10 * activity;
    case "drums": return 0.10 * chroma + 0.30 * level + 0.40 * transients + 0.20 * brightness;
    case "bass": return 0.58 * chroma + 0.22 * level + 0.10 * transients + 0.10 * activity;
    case "texture": return 0.10 * chroma + 0.30 * level + 0.20 * transients + 0.40 * brightness;
    default: return 0.42 * chroma + 0.22 * level + 0.20 * transients + 0.16 * brightness;
  }
}

export function trackAnalysisFromMusicalFeatures(
  name: string,
  rawFeatures: readonly number[][],
  changeTimes: readonly number[],
  options: AnalysisOptions = DEFAULT_ANALYSIS_OPTIONS,
  roleOverride?: TrackRole,
  sourceId = name,
  backendId = "dsp",
): TrackAnalysis {
  const role = roleOverride ?? inferTrackRole(name);
  const context = Math.max(1, options.persistenceFrames ?? DEFAULT_ANALYSIS_OPTIONS.persistenceFrames ?? 1);
  const rawChanges = rawFeatures.map((_, index) => {
    if (index < context || index + context > rawFeatures.length) return 0;
    const before = meanFrames(rawFeatures, index - context, index);
    const after = meanFrames(rawFeatures, index, index + context);
    return musicalStateDistance(before, after, role);
  });
  const changes = normalizeChanges(rawChanges);
  return {
    name,
    role,
    evidence: changeTimes.map((beatTime, index) => ({
      timeSeconds: beatTime,
      beatTime,
      source: backendId,
      strength: changes[index] ?? 0,
      trackId: sourceId,
      role,
    })),
  };
}

export function trackAnalysisFromAnalysisResult(
  result: AnalysisResult,
  role: TrackRole,
  options: EvidenceOptions = DEFAULT_EVIDENCE_OPTIONS,
): TrackAnalysis {
  const byKind = new Map(result.continuousSignals.map((signal) => [signal.kind, signal]));
  const reference = byKind.get(STATE_SIGNAL_KINDS[0]);
  if (!reference) {
    throw new Error(`${result.backend.id} did not return the required ${STATE_SIGNAL_KINDS[0]} signal.`);
  }
  const rawFeatures = reference.points.map((_, frameIndex) =>
    STATE_SIGNAL_KINDS.map((kind) => byKind.get(kind)?.points[frameIndex]?.value ?? 0),
  );
  const secondsPerBeat = result.tempoContext.secondsPerBeat;
  if (!Number.isFinite(secondsPerBeat) || secondsPerBeat <= 0) {
    throw new Error(`${result.backend.id} returned an invalid tempo mapping.`);
  }
  const changeTimes = reference.points.map(({ timeSeconds }) => timeSeconds / secondsPerBeat);
  const track = trackAnalysisFromMusicalFeatures(
    result.sourceName,
    rawFeatures,
    changeTimes,
    { ...DEFAULT_ANALYSIS_OPTIONS, persistenceFrames: options.persistenceFrames },
    role,
    result.sourceId,
    result.backend.id,
  );
  track.evidence.forEach((evidence, index) => {
    evidence.timeSeconds = reference.points[index]?.timeSeconds ?? 0;
  });
  return track;
}

export function trackAnalysisFromFeatures(
  name: string,
  rawFeatures: readonly number[][],
  changeTimes: readonly number[],
): TrackAnalysis {
  const features = normalizeFeatures(rawFeatures);
  const rawChanges = features.map((frame, index) => {
    if (index === 0) return 0;
    const previous = features[index - 1]!;
    const sum = frame.reduce((total, value, dimension) => {
      const delta = value - previous[dimension]!;
      return total + delta * delta;
    }, 0);
    return Math.sqrt(sum / Math.max(1, frame.length));
  });
  const changes = normalizeChanges(rawChanges);
  return {
    name,
    evidence: changeTimes.map((beatTime, index) => ({
      timeSeconds: beatTime,
      beatTime,
      source: "legacy-dsp",
      strength: changes[index] ?? 0,
      trackId: name,
    })),
  };
}

export function analyzeTrack(
  name: string,
  audio: AudioData,
  selectionStartBeat: number,
  selectionEndBeat: number,
  options: AnalysisOptions = DEFAULT_ANALYSIS_OPTIONS,
): TrackAnalysis {
  const sampleCount = Math.min(...audio.channels.map((channel) => channel.length));
  const selectionBeats = selectionEndBeat - selectionStartBeat;
  if (audio.channels.length === 0 || sampleCount === 0 || selectionBeats <= 0) {
    return { name, evidence: [] };
  }

  // renderPreFxAudio does not expose a beat-to-sample map. This proportional
  // mapping is exact at constant tempo and preserves both selection endpoints.
  const samplesPerBeat = sampleCount / selectionBeats;
  const windowSamples = Math.max(1, Math.round(options.windowBeats * samplesPerBeat));
  const hopSamples = Math.max(1, Math.round(options.hopBeats * samplesPerBeat));
  const stride = Math.max(1, Math.floor(audio.sampleRate / options.targetSampleRate));
  const rawFeatures: number[][] = [];
  const changeTimes: number[] = [];

  for (let start = 0; start < sampleCount; start += hopSamples) {
    const end = Math.min(sampleCount, start + windowSamples);
    if (end - start < windowSamples * 0.5) break;
    rawFeatures.push(windowFeatures(audio.channels, start, end, stride));
    changeTimes.push(selectionStartBeat + start / samplesPerBeat);
  }

  return trackAnalysisFromFeatures(name, rawFeatures, changeTimes);
}

export function aggregateTrackChanges(
  trackValues: readonly number[],
  consensus: number,
): number {
  if (trackValues.length === 0) return 0;
  const boundedConsensus = clamp01(consensus);
  const mean = trackValues.reduce((sum, value) => sum + value, 0) / trackValues.length;
  const maximum = Math.max(...trackValues);
  const voteRatio = trackValues.filter((value) => value >= 0.45).length / trackValues.length;
  const magnitude = maximum * (1 - boundedConsensus) + mean * boundedConsensus;
  const consensusEvidence = 1 - boundedConsensus + boundedConsensus * Math.pow(voteRatio, 0.75);
  return clamp01(magnitude * consensusEvidence);
}

function selectBoundaries(
  curve: readonly { beat: number; score: number; drivers: TrackRole[] }[],
  selectionStartBeat: number,
  selectionEndBeat: number,
  options: SegmentationOptions,
): Boundary[] {
  if (curve.length < 3 || Math.max(...curve.map(({ score }) => score)) <= EPSILON) return [];
  const thresholdQuantile = 0.9 - clamp01(options.sensitivity) * 0.35;
  const threshold = quantile(
    curve.map(({ score }) => score),
    thresholdQuantile,
  );
  const candidates = curve
    .filter(({ score }, index) => {
      if (index === 0 || index === curve.length - 1 || score <= EPSILON || score < threshold) return false;
      return score >= curve[index - 1]!.score && score >= curve[index + 1]!.score;
    })
    .sort((a, b) => b.score - a.score);

  const accepted: Boundary[] = [];
  for (const candidate of candidates) {
    if (accepted.length >= options.maximumBoundaries) break;
    const snapped = Math.round(candidate.beat / options.snapBeats) * options.snapBeats;
    if (snapped <= selectionStartBeat || snapped >= selectionEndBeat) continue;
    if (
      snapped - selectionStartBeat < options.minimumSectionBeats ||
      selectionEndBeat - snapped < options.minimumSectionBeats
    ) {
      continue;
    }
    if (accepted.some(({ beat }) => Math.abs(beat - snapped) < options.minimumSectionBeats)) continue;
    accepted.push({ beat: snapped, score: candidate.score, drivers: candidate.drivers });
  }
  return accepted.sort((a, b) => a.beat - b.beat);
}

export function segmentJam(
  tracks: readonly TrackAnalysis[],
  selectionStartBeat: number,
  selectionEndBeat: number,
  options: SegmentationOptions = DEFAULT_SEGMENTATION_OPTIONS,
): SegmentationResult {
  const frameCount = Math.min(...tracks.map((track) => track.evidence.length));
  const globalCurve = Number.isFinite(frameCount)
    ? Array.from({ length: frameCount }, (_, index) => {
        const roleValues = new Map<TrackRole, number[]>();
        for (const track of tracks) {
          const role = track.role ?? "balanced";
          const values = roleValues.get(role) ?? [];
          values.push(track.evidence[index]?.strength ?? 0);
          roleValues.set(role, values);
        }
        const roleScores = [...roleValues.entries()].map(([role, values]) => {
          const descending = [...values].sort((a, b) => b - a);
          const strongest = descending[0] ?? 0;
          const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
          // A deliberately assigned bus or featured instrument may define a
          // real arrangement state by itself. Persistence and long spacing
          // protect against one-off fills; role averaging must not erase it.
          return { role, score: strongest * 0.65 + mean * 0.35 };
        }).sort((a, b) => b.score - a.score);
        const strongest = roleScores[0]?.score ?? 0;
        const supportingRoles = roleScores.filter(({ score }) => score >= 0.65);
        const support = roleScores.length <= 1 ? 0 : (supportingRoles.length - 1) / (roleScores.length - 1);
        return {
          beat: tracks[0]!.evidence[index]!.beatTime,
          score: strongest * (0.85 + 0.15 * Math.max(0, support)),
          drivers: (supportingRoles.length > 0 ? supportingRoles : roleScores.slice(0, 1)).map(({ role }) => role),
        };
      })
    : [];
  const boundaries = selectBoundaries(
    globalCurve,
    selectionStartBeat,
    selectionEndBeat,
    options,
  );
  const edges = [selectionStartBeat, ...boundaries.map(({ beat }) => beat), selectionEndBeat];
  const regions = edges.slice(0, -1).map((startBeat, index) => ({
    startBeat,
    endBeat: edges[index + 1]!,
    entryScore: index === 0 ? 0 : boundaries[index - 1]!.score,
    entryDrivers: index === 0 ? [] : boundaries[index - 1]!.drivers,
    sourceStartBeat: startBeat - selectionStartBeat,
  }));
  return { boundaries, regions, globalCurve };
}
