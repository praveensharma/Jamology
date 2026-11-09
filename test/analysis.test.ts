import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateTrackChanges,
  analyzeTrack,
  DEFAULT_ANALYSIS_OPTIONS,
  inferTrackRole,
  inferTrackRoleFromHierarchy,
  segmentJam,
  type TrackAnalysis,
} from "../src/analysis.js";
import { createResearchPackage, serializeResearchPackage } from "../src/research-package.js";

function sineAudio(
  segments: Array<{ seconds: number; amplitude: number; frequency: number }>,
  sampleRate = 2_000,
) {
  const samples: number[] = [];
  let offset = 0;
  for (const segment of segments) {
    const length = Math.round(segment.seconds * sampleRate);
    for (let index = 0; index < length; index += 1) {
      samples.push(
        segment.amplitude * Math.sin((2 * Math.PI * segment.frequency * (offset + index)) / sampleRate),
      );
    }
    offset += length;
  }
  return { channels: [Float32Array.from(samples)], sampleRate };
}

function evidence(changes: number[], hopBeats: number, role?: TrackAnalysis["role"]) {
  return changes.map((strength, index) => ({
    timeSeconds: index * hopBeats,
    beatTime: index * hopBeats,
    source: "test",
    strength,
    trackId: "test-track",
    role,
  }));
}

test("consensus penalizes a change isolated to one track", () => {
  const isolated = [1, 0, 0, 0];
  const coordinated = [0.8, 0.75, 0.7, 0.65];
  assert.ok(aggregateTrackChanges(coordinated, 0.8) > aggregateTrackChanges(isolated, 0.8));
  assert.equal(aggregateTrackChanges(isolated, 0), 1);
});

test("track names select musical detector roles without requiring setup", () => {
  assert.equal(inferTrackRole("RAW CHORDS 93"), "harmony");
  assert.equal(inferTrackRole("STUDIO DRUMS"), "drums");
  assert.equal(inferTrackRole("Lead Melody"), "melody");
  assert.equal(inferTrackRole("ZPO 93"), "balanced");
  assert.equal(inferTrackRoleFromHierarchy("ZPO 93", ["MODULAR DRUM", "STUDIO"]), "drums");
  assert.equal(inferTrackRoleFromHierarchy("Lead Melody", ["STUDIO DRUMS"]), "melody");
  assert.equal(inferTrackRoleFromHierarchy("Unknown", ["Nested", "RAW CHORDS"]), "harmony");
});

test("analyzeTrack reacts to a sustained timbral and level change", () => {
  const audio = sineAudio([
    { seconds: 8, amplitude: 0.1, frequency: 80 },
    { seconds: 8, amplitude: 0.8, frequency: 600 },
  ]);
  const options = {
    ...DEFAULT_ANALYSIS_OPTIONS,
    windowBeats: 4,
    hopBeats: 2,
    targetSampleRate: 2_000,
  };
  const analysis = analyzeTrack("test", audio, 0, 32, options);
  assert.ok(analysis.evidence.length > 3);
  assert.ok(Math.max(...analysis.evidence.map(({ strength }) => strength)) > 0.9);
});

test("segmentJam produces one shared snapped boundary and aligned regions", () => {
  const makeTrack = (changes: number[]): TrackAnalysis => ({
    name: "track",
    evidence: evidence(changes, 4),
  });
  const tracks = [
    makeTrack([0, 0.1, 0.15, 0.95, 0.2, 0.1, 0.12, 0.1]),
    makeTrack([0, 0.12, 0.1, 0.9, 0.18, 0.09, 0.1, 0.08]),
    makeTrack([0, 0.08, 0.12, 0.85, 0.15, 0.11, 0.09, 0.1]),
  ];
  const result = segmentJam(tracks, 0, 32, {
    ...DEFAULT_ANALYSIS_OPTIONS,
    minimumSectionBeats: 8,
    sensitivity: 0.7,
  });
  assert.deepEqual(result.boundaries.map(({ beat }) => beat), [12]);
  assert.deepEqual(
    result.regions.map(({ startBeat, endBeat }) => [startBeat, endBeat]),
    [
      [0, 12],
      [12, 32],
    ],
  );
});

test("constant material remains a single region", () => {
  const track: TrackAnalysis = {
    name: "constant",
    evidence: evidence([0, 0, 0, 0], 4),
  };
  const result = segmentJam([track], 0, 16);
  assert.deepEqual(result.boundaries, []);
  assert.equal(result.regions.length, 1);
});

test("boundary selection obeys the long-form candidate budget", () => {
  const changes = Array.from({ length: 80 }, (_, index) => index % 4 === 2 ? 1 + index / 100 : 0.05);
  const track: TrackAnalysis = {
    name: "CHORDS",
    role: "harmony",
    evidence: evidence(changes, 8, "harmony"),
  };
  const result = segmentJam([track], 0, 640, {
    ...DEFAULT_ANALYSIS_OPTIONS,
    minimumSectionBeats: 32,
    maximumBoundaries: 4,
  });
  assert.equal(result.boundaries.length, 4);
  assert.ok(result.regions.every((region) => region.endBeat - region.startBeat >= 32));
});

test("one persistent explicitly classified track is not averaged out of its role", () => {
  const times = Array.from({ length: 24 }, (_, index) => index * 8);
  const quiet = times.map(() => 0);
  const featured = [...quiet];
  featured[12] = 2.5;
  const tracks: TrackAnalysis[] = [
    { name: "BREAKS BUS", role: "drums", evidence: evidence(featured, 8, "drums") },
    ...Array.from({ length: 7 }, (_, index) => ({
      name: `drum ${index}`,
      role: "drums" as const,
      evidence: evidence(quiet, 8, "drums"),
    })),
  ];
  const result = segmentJam(tracks, 0, 192, {
    ...DEFAULT_ANALYSIS_OPTIONS,
    minimumSectionBeats: 32,
  });
  assert.deepEqual(result.boundaries.map(({ beat }) => beat), [96]);
  assert.deepEqual(result.boundaries[0]?.drivers, ["drums"]);
});

test("research packages preserve backend-neutral segmentation output", () => {
  const segmentation = segmentJam([], 0, 16);
  const research = createResearchPackage([], segmentation);
  const decoded = JSON.parse(serializeResearchPackage(research)) as typeof research;
  assert.equal(decoded.schemaVersion, 1);
  assert.equal(decoded.segmentation.regions.length, 1);
});
