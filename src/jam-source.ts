import { AudioClip, type AudioTrack } from "@ableton-extensions/sdk";

export interface JamSource {
  track: AudioTrack<"1.0.0">;
  clip: AudioClip<"1.0.0">;
  sourceStartBeat: number;
  sourceEndBeat: number;
  secondsPerBeat: number;
}

function sourceTiming(clip: AudioClip<"1.0.0">, songTempo: number) {
  const markers = clip.warpMarkers
    .filter((marker) => Number.isFinite(marker.sampleTime) && Number.isFinite(marker.beatTime))
    .sort((a, b) => a.sampleTime - b.sampleTime);
  const origin = markers[0];
  if (!origin) throw new Error(`“${clip.name}” has no readable source-origin marker.`);

  const timingMarker = markers.find(
    (marker) =>
      marker.sampleTime > origin.sampleTime && Math.abs(marker.beatTime - origin.beatTime) > 1e-9,
  );
  const measuredSecondsPerBeat = timingMarker
    ? (timingMarker.sampleTime - origin.sampleTime) /
      (timingMarker.beatTime - origin.beatTime)
    : Number.NaN;
  const secondsPerBeat =
    Number.isFinite(measuredSecondsPerBeat) && measuredSecondsPerBeat > 0
      ? measuredSecondsPerBeat
      : 60 / songTempo;
  return { sourceStartBeat: origin.beatTime, secondsPerBeat };
}

export function jamSourceInSelection(
  track: AudioTrack<"1.0.0">,
  selectionStart: number,
  selectionEnd: number,
  songTempo: number,
): JamSource | undefined {
  const clips = track.arrangementClips.filter(
    (clip): clip is AudioClip<"1.0.0"> =>
      clip instanceof AudioClip &&
      clip.startTime < selectionEnd &&
      clip.endTime > selectionStart,
  );
  if (clips.length !== 1) return undefined;
  const clip = clips[0]!;
  const timing = sourceTiming(clip, songTempo);
  const sourceEndBeat = clip.endMarker;
  if (sourceEndBeat <= timing.sourceStartBeat) {
    throw new Error(`“${track.name}” has no hidden recording history to analyze.`);
  }
  return { track, clip, sourceEndBeat, ...timing };
}

export function commonJamDuration(sources: readonly JamSource[]): number {
  if (sources.length === 0) return 0;
  const durations = sources.map(({ sourceStartBeat, sourceEndBeat }) =>
    sourceEndBeat - sourceStartBeat,
  );
  const shortest = Math.min(...durations);
  const longest = Math.max(...durations);
  if (longest - shortest > 4) {
    throw new Error(
      `Selected recordings do not share a common length (${shortest.toFixed(1)}–${longest.toFixed(1)} beats).`,
    );
  }
  return shortest;
}
