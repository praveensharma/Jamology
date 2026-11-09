import type {
  ExtensionContext,
  MidiClip,
  MidiTrack,
} from "@ableton-extensions/sdk";
import type { Region, SegmentationResult, TrackRole } from "./analysis.js";

const ROLE_COLORS: Record<TrackRole | "multi" | "opening", number> = {
  harmony: 0x5b8ff9,
  melody: 0xa66ee8,
  drums: 0xe89a3f,
  bass: 0x58b86b,
  texture: 0x54b8b0,
  balanced: 0x888888,
  multi: 0xe8d33f,
  opening: 0x3f3f3f,
};

function labelRegion(clip: MidiClip<"1.0.0">, region: Region, index: number): void {
  const reason = region.entryDrivers.length > 0 ? `${region.entryDrivers.join("+")} change` : "opening state";
  const bar = Math.floor(region.sourceStartBeat / 4) + 1;
  clip.name = `SECTION ${String(index + 1).padStart(2, "0")} · ${reason} · bar ${bar}`;
  const colorKey = region.entryDrivers.length === 0 ? "opening" : region.entryDrivers.length > 1 ? "multi" : region.entryDrivers[0]!;
  clip.color = ROLE_COLORS[colorKey];
}

export async function createAnalysisMap(
  context: ExtensionContext<"1.0.0">,
  result: SegmentationResult,
): Promise<MidiTrack<"1.0.0">> {
  const mutation = async () => {
    const mapTrack = await context.application.song.createMidiTrack();
    mapTrack.name = `JAMOLOGY SECTION MAP · ${result.regions.length} regions`;
    const clips = await Promise.all(
      result.regions.map((region) =>
        mapTrack.createMidiClip(region.startBeat, region.endBeat - region.startBeat),
      ),
    );
    clips.forEach((clip, index) => labelRegion(clip, result.regions[index]!, index));
    return mapTrack;
  };

  // The callback itself returns synchronously with one promise, allowing Live
  // to group the track creation, region clips, names, and colors into one undo.
  return await context.withinTransaction(() => mutation());
}
