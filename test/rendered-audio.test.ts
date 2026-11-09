import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decodeRenderedAudio } from "../src/rendered-audio.js";
import { DSPAnalysisBackend } from "../src/dsp-backend.js";
import { analysisBackends } from "../src/backend-registry.js";
import {
  DEFAULT_EVIDENCE_OPTIONS,
  trackAnalysisFromAnalysisResult,
} from "../src/analysis.js";

function extended80For48k(): Buffer {
  return Buffer.from([0x40, 0x0e, 0xbb, 0x80, 0, 0, 0, 0, 0, 0]);
}

function chunk(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, "ascii");
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload, payload.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function aiffFloat32(samples: readonly number[], channels = 1): Buffer {
  const comm = Buffer.alloc(23);
  comm.writeUInt16BE(channels, 0);
  comm.writeUInt32BE(samples.length / channels, 2);
  comm.writeUInt16BE(32, 6);
  extended80For48k().copy(comm, 8);
  comm.write("fl32", 18, 4, "ascii");
  comm.writeUInt8(0, 22);

  const sound = Buffer.alloc(8 + samples.length * 4);
  samples.forEach((sample, index) => sound.writeFloatBE(sample, 8 + index * 4));
  const body = Buffer.concat([Buffer.from("AIFC"), chunk("COMM", comm), chunk("SSND", sound)]);
  const form = Buffer.alloc(8);
  form.write("FORM", 0, 4, "ascii");
  form.writeUInt32BE(body.length, 4);
  return Buffer.concat([form, body]);
}

function aiffPcm16(samples: readonly number[]): Buffer {
  const comm = Buffer.alloc(18);
  comm.writeUInt16BE(1, 0);
  comm.writeUInt32BE(samples.length, 2);
  comm.writeUInt16BE(16, 6);
  extended80For48k().copy(comm, 8);
  const sound = Buffer.alloc(8 + samples.length * 2);
  samples.forEach((sample, index) => sound.writeInt16BE(sample, 8 + index * 2));
  const body = Buffer.concat([Buffer.from("AIFF"), chunk("COMM", comm), chunk("SSND", sound)]);
  const form = Buffer.alloc(8);
  form.write("FORM", 0, 4, "ascii");
  form.writeUInt32BE(body.length, 4);
  return Buffer.concat([form, body]);
}

function wavPcm16(samples: readonly number[]): Buffer {
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write("RIFF", 0, 4, "ascii");
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8, 8, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(48_000, 24);
  buffer.writeUInt32LE(96_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, 4, "ascii");
  buffer.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, 44 + index * 2));
  return buffer;
}

test("registers the versioned DSP backend behind the common contract", () => {
  const backend = analysisBackends.get("dsp");
  assert.equal(backend.descriptor.schemaVersion, 1);
  assert.equal(backend.availability().state, "available");
  assert.throws(() => analysisBackends.get("missing"), /not registered/);
});

test("decodes Live-style AIFC fl32 audio", async () => {
  const decoded = await decodeRenderedAudio(aiffFloat32([0.25, -0.5, 1, -1]));
  assert.equal(decoded.sampleRate, 48_000);
  assert.equal(decoded.channels.length, 1);
  assert.deepEqual(Array.from(decoded.channels[0]!), [0.25, -0.5, 1, -1]);
});

test("deinterleaves stereo AIFC fl32 audio", async () => {
  const decoded = await decodeRenderedAudio(aiffFloat32([0.1, -0.1, 0.2, -0.2], 2));
  assert.equal(decoded.channels.length, 2);
  assert.ok(Math.abs(decoded.channels[0]![1]! - 0.2) < 1e-6);
  assert.ok(Math.abs(decoded.channels[1]![1]! + 0.2) < 1e-6);
});

test("decodes standard big-endian AIFF PCM", async () => {
  const decoded = await decodeRenderedAudio(aiffPcm16([0, 16_384, -16_384, 32_767]));
  assert.deepEqual(Array.from(decoded.channels[0]!).slice(0, 3), [0, 0.5, -0.5]);
  assert.ok(decoded.channels[0]![3]! > 0.999);
});

test("retains WAV decoding", async () => {
  const decoded = await decodeRenderedAudio(wavPcm16([0, 16_384, -16_384]));
  assert.equal(decoded.sampleRate, 48_000);
  assert.equal(decoded.channels[0]![0], 0);
  assert.ok(Math.abs(decoded.channels[0]![1]! - 0.5) < 1e-4);
  assert.ok(Math.abs(decoded.channels[0]![2]! + 0.5) < 1e-4);
});

test("streams a long-form AIFC recording without full-file decoding", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jamology-stream-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "recording.aif");
  const frames = 48_000 * 4;
  const samples: number[] = [];
  for (let frame = 0; frame < frames; frame += 1) {
    const changed = frame >= frames / 2;
    const sample =
      (changed ? 0.8 : 0.1) *
      Math.sin((2 * Math.PI * (changed ? 600 : 80) * frame) / 48_000);
    samples.push(sample, sample);
  }
  await writeFile(filePath, aiffFloat32(samples, 2));
  const backend = new DSPAnalysisBackend();
  const result = await backend.analyze(
    {
      source: {
        id: "stream-source",
        name: "stream",
        filePath,
        role: "balanced",
        startTimeSeconds: 0,
        durationSeconds: 4,
        tempoContext: { secondsPerBeat: 0.5 },
      },
      requestedCapabilities: backend.descriptor.capabilities,
      extraction: {
        windowBeats: 1,
        hopBeats: 0.5,
        targetSampleRate: 4_000,
      },
    },
  );
  assert.equal(result.backend.id, "dsp");
  assert.ok(result.continuousSignals.some(({ kind }) => kind === "chroma.c"));
  assert.ok(result.continuousSignals.some(({ kind }) => kind === "rhythm.onset_density"));
  const evidence = trackAnalysisFromAnalysisResult(result, "balanced", {
    ...DEFAULT_EVIDENCE_OPTIONS,
    persistenceFrames: 1,
  });
  assert.ok(evidence.evidence.length > 4);
  assert.ok(Math.max(...evidence.evidence.map(({ strength }) => strength)) > 0.9);
});
