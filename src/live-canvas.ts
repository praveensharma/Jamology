import type { ExtensionContext } from "@ableton-extensions/sdk";
import type { SegmentationResult } from "./analysis.js";
import type { JamSource } from "./jam-source.js";
import { createAnalysisMap } from "./live-map.js";

function shiftedResult(
  result: SegmentationResult,
  destinationStart: number,
): SegmentationResult {
  return {
    boundaries: result.boundaries.map(({ beat, score, drivers }) => ({
      beat: destinationStart + beat,
      score,
      drivers,
    })),
    regions: result.regions.map(({ startBeat, endBeat, entryScore, entryDrivers, sourceStartBeat }) => ({
      startBeat: destinationStart + startBeat,
      endBeat: destinationStart + endBeat,
      entryScore,
      entryDrivers,
      sourceStartBeat,
    })),
    globalCurve: result.globalCurve.map(({ beat, score, drivers }) => ({
      beat: destinationStart + beat,
      score,
      drivers,
    })),
  };
}

export async function createArchaeologyCanvas(
  context: ExtensionContext<"1.0.0">,
  sources: readonly JamSource[],
  durationBeats: number,
  result: SegmentationResult,
  destinationStart: number,
): Promise<{ audioClips: number; mapRegions: number }> {
  for (const { track, clip: source, sourceStartBeat } of sources) {
    const sourceEndBeat = sourceStartBeat + durationBeats;
    const clip = await track.createAudioClip({
      filePath: source.filePath,
      startTime: destinationStart,
      duration: durationBeats,
      isWarped: source.warping,
      loopSettings: {
        looping: false,
        startMarker: sourceStartBeat,
        endMarker: sourceEndBeat,
        loopStart: sourceStartBeat,
        loopEnd: sourceEndBeat,
      },
    });
    if (source.warping) clip.warpMode = source.warpMode;
    clip.name = `JAMOLOGY FULL · ${source.name}`;
    clip.color = source.color;
  }
  await createAnalysisMap(context, shiftedResult(result, destinationStart));
  return { audioClips: sources.length, mapRegions: result.regions.length };
}
