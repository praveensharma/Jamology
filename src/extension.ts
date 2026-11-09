import {
  AudioClip,
  AudioTrack,
  DataModelObject,
  initialize,
  type ActivationContext,
  type ArrangementSelection,
  type ExtensionContext,
  type Handle,
} from "@ableton-extensions/sdk";
import {
  DEFAULT_EVIDENCE_OPTIONS,
  DEFAULT_FEATURE_EXTRACTION_OPTIONS,
  DEFAULT_SEGMENTATION_OPTIONS,
  segmentJam,
  trackAnalysisFromAnalysisResult,
  type TrackAnalysis,
  type TrackRole,
} from "./analysis.js";
import { commonJamDuration, jamSourceInSelection, type JamSource } from "./jam-source.js";
import { createArchaeologyCanvas } from "./live-canvas.js";
import { reviewTrackRoles } from "./role-review.js";
import { analysisBackends } from "./backend-registry.js";

const API_VERSION = "1.0.0" as const;
const EXTENSION_VERSION = "0.1.7";
const COMMAND_ID = "jamology.analyzeJam";
const INSPECT_COMMAND_ID = "jamology.inspectJamSource";

function errorDetail(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Live returned no additional error details";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character]!;
  });
}

function showTextDialog(
  context: ExtensionContext<"1.0.0">,
  title: string,
  message: string,
): void {
  const html = `<!doctype html><meta charset="utf-8"><style>body{font:14px system-ui;margin:24px;background:#202020;color:#eee;line-height:1.45}h2{margin-top:0}pre{white-space:pre-wrap;color:#c9e1ff}button{margin-top:18px;padding:7px 18px}</style><h2>${escapeHtml(title)}</h2><pre>${escapeHtml(message)}</pre><button onclick="window.webkit?.messageHandlers?.live?.postMessage({method:'close_and_send',params:['ok']});window.chrome?.webview?.postMessage({method:'close_and_send',params:['ok']})">Close</button>`;
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  void context.ui.showModalDialog(url, 640, 390).catch((error: unknown) => {
    console.error("Jamology: could not show dialog", errorDetail(error));
  });
}

function archaeologyDestination(context: ExtensionContext<"1.0.0">): number {
  const lastClipEnd = Math.max(
    0,
    ...context.application.song.tracks.flatMap((track) =>
      track.arrangementClips.map((clip) => clip.endTime),
    ),
  );
  return Math.ceil((lastClipEnd + 8) / 4) * 4;
}

function selectedJamSources(
  context: ExtensionContext<"1.0.0">,
  selection: ArrangementSelection,
): JamSource[] {
  const tracks = selection.selected_lanes
    .map((handle) => context.getObjectFromHandle(handle, DataModelObject))
    .filter((object): object is AudioTrack<"1.0.0"> => object instanceof AudioTrack);
  const uniqueTracks = [...new Map(tracks.map((track) => [track.handle.id, track])).values()];
  const tempo = context.application.song.tempo;
  const sources = uniqueTracks
    .map((track) =>
      jamSourceInSelection(
        track,
        selection.time_selection_start,
        selection.time_selection_end,
        tempo,
      ),
    )
    .filter((source): source is JamSource => source !== undefined);
  const sourceTrackIds = new Set(sources.map(({ track }) => track.handle.id));
  uniqueTracks
    .filter((track) => !sourceTrackIds.has(track.handle.id))
    .forEach((track) =>
      console.warn(`Jamology: skipping “${track.name}”; no single audio clip intersects the selection.`),
    );
  return sources;
}

export function activate(activation: ActivationContext): void {
  console.log(`Jamology: activating development build ${EXTENSION_VERSION}.`);
  const context = initialize(activation, API_VERSION);

  context.commands.registerCommand(COMMAND_ID, (argument: unknown) => {
    void (async (selection: ArrangementSelection) => {
      if (selection.time_selection_end <= selection.time_selection_start) {
        throw new Error("The Arrangement time selection is empty.");
      }
      const sources = selectedJamSources(context, selection);
      if (sources.length < 2) {
        throw new Error("Select the visible final loop pass across at least two recorded audio tracks.");
      }
      const duration = commonJamDuration(sources);
      console.log(
        `Jamology: discovered ${sources.length} source recordings spanning ${duration.toFixed(1)} beats.`,
      );
      const reviewed = await reviewTrackRoles(context, sources);
      if (!reviewed) {
        console.log("Jamology: role review was cancelled.");
        return;
      }
      const active = reviewed.filter(
        (assignment): assignment is typeof assignment & { role: TrackRole } => assignment.role !== "ignore",
      );
      if (active.length < 2) {
        throw new Error("Assign an analysis role to at least two selected tracks.");
      }
      const backend = analysisBackends.get("dsp");
      const availability = backend.availability();
      if (availability.state !== "available") {
        throw new Error(`The ${backend.descriptor.id} analysis backend is unavailable: ${availability.reason}`);
      }

      let capturedError: unknown;
      let completed = false;
      try {
        await context.ui.withinProgressDialog(
          "Analyzing original jam recordings…",
          { progress: 0 },
          async (update, abortSignal) => {
            try {
              const analyses: TrackAnalysis[] = [];
              for (let index = 0; index < active.length; index += 1) {
                if (abortSignal.aborted) return;
                const assignment = active[index]!;
                const source = assignment.source;
                await update(
                  `Reading ${index + 1}/${active.length}: ${source.track.name}`,
                  (index / active.length) * 82,
                );
                try {
                  const backendResult = await backend.analyze(
                    {
                      source: {
                        id: source.track.handle.id.toString(),
                        name: source.track.name,
                        filePath: source.clip.filePath,
                        role: assignment.role,
                        startTimeSeconds: 0,
                        durationSeconds: duration * source.secondsPerBeat,
                        tempoContext: { secondsPerBeat: source.secondsPerBeat },
                      },
                      requestedCapabilities: backend.descriptor.capabilities,
                      extraction: DEFAULT_FEATURE_EXTRACTION_OPTIONS,
                    },
                    abortSignal,
                  );
                  if (!abortSignal.aborted) {
                    const analysis = trackAnalysisFromAnalysisResult(
                      backendResult,
                      assignment.role,
                      DEFAULT_EVIDENCE_OPTIONS,
                    );
                    analyses.push(analysis);
                  const groupDescription = assignment.groupNames.length > 0 ? ` via ${assignment.groupNames.join(" > ")}` : "";
                  console.log(`Jamology: analyzed “${source.track.name}” as ${analysis.role ?? "balanced"}${groupDescription} directly from source.`);
                  }
                } catch (error: unknown) {
                  console.warn(`Jamology: skipped “${source.track.name}”: ${errorDetail(error)}`);
                }
              }
              if (abortSignal.aborted) return;
              if (analyses.length < 2) {
                throw new Error("Fewer than two source recordings could be analyzed.");
              }

              await update("Finding shared musical changes…", 86);
              const result = segmentJam(analyses, 0, duration, DEFAULT_SEGMENTATION_OPTIONS);
              const destination = archaeologyDestination(context);
              await update("Creating the full-jam review canvas…", 94);
              const created = await createArchaeologyCanvas(
                context,
                reviewed.map(({ source }) => source),
                duration,
                result,
                destination,
              );
              await update(
                `Created ${created.audioClips} full recordings and ${created.mapRegions} map regions.`,
                100,
              );
              console.log(
                `Jamology: created ${created.audioClips} full recordings and ${created.mapRegions} map regions at beat ${destination}.`,
              );
              completed = true;
            } catch (error: unknown) {
              capturedError = error;
            }
          },
        );
      } catch (error: unknown) {
        capturedError ??= error;
      }
      if (capturedError) throw capturedError;
      if (!completed) console.log("Jamology: analysis was cancelled.");
    })(argument as ArrangementSelection).catch((error: unknown) => {
      console.error("Jamology analysis failed", errorDetail(error));
      showTextDialog(
        context,
        "Jamology could not analyze this selection",
        `${errorDetail(error)}\n\nYour source recordings were not changed. If partial generated audio sections appeared, undo them before retrying.`,
      );
    });
  });

  context.commands.registerCommand(INSPECT_COMMAND_ID, (argument: unknown) => {
    const clip = context.getObjectFromHandle(argument as Handle, AudioClip);
    const parent = clip.parent;
    if (!(parent instanceof AudioTrack)) return;
    const source = jamSourceInSelection(
      parent,
      clip.startTime,
      clip.endTime,
      context.application.song.tempo,
    );
    if (!source) return;
    const details = [
      `Visible Arrangement: ${clip.startTime.toFixed(3)} → ${clip.endTime.toFixed(3)} beats`,
      `Visible source pass: ${clip.startMarker.toFixed(3)} → ${clip.endMarker.toFixed(3)} beats`,
      `Full recording source: ${source.sourceStartBeat.toFixed(3)} → ${source.sourceEndBeat.toFixed(3)} beats`,
      `Recoverable duration: ${(source.sourceEndBeat - source.sourceStartBeat).toFixed(3)} beats`,
      `File: ${clip.filePath}`,
    ].join("\n");
    console.log("Jamology source inspection:", details.replaceAll("\n", " | "));
    showTextDialog(context, `Jamology source: ${clip.name}`, details);
  });

  void context.ui
    .registerContextMenuAction("AudioTrack.ArrangementSelection", "Analyze Jam", COMMAND_ID)
    .then(() => console.log("Jamology: Analyze Jam context menu registered."))
    .catch((error: unknown) =>
      console.error("Jamology: context menu registration failed", errorDetail(error)),
    );
  void context.ui
    .registerContextMenuAction("AudioClip", "Inspect Jam Source (Debug)", INSPECT_COMMAND_ID)
    .then(() => console.log("Jamology: source inspection context menu registered."))
    .catch((error: unknown) =>
      console.error("Jamology: inspection registration failed", errorDetail(error)),
    );
}
