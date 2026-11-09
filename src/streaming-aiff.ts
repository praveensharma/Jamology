import { open } from "node:fs/promises";
import {
  STATE_SIGNAL_KINDS,
  type AudioSourceDescriptor,
  type ContinuousSignal,
  type FeatureExtractionOptions,
} from "./analysis-contract.js";

interface AiffStreamInfo {
  channels: number;
  frames: number;
  sampleRate: number;
  bitsPerSample: number;
  compression: string;
  soundOffset: number;
  soundLength: number;
}

function fourCc(bytes: Uint8Array, offset = 0): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  );
}

function extended80(view: DataView, offset: number): number {
  const exponentAndSign = view.getUint16(offset, false);
  const exponent = exponentAndSign & 0x7fff;
  const sign = exponentAndSign & 0x8000 ? -1 : 1;
  const high = view.getUint32(offset + 2, false);
  const low = view.getUint32(offset + 6, false);
  if (exponent === 0 && high === 0 && low === 0) return 0;
  const mantissa = high * 2 ** 32 + low;
  return sign * mantissa * 2 ** (exponent - 16383 - 63);
}

async function readExactly(
  file: Awaited<ReturnType<typeof open>>,
  length: number,
  position: number,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await file.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new Error("Unexpected end of AIFF file");
  return buffer;
}

async function readAiffInfo(
  file: Awaited<ReturnType<typeof open>>,
): Promise<AiffStreamInfo> {
  const header = await readExactly(file, 12, 0);
  const formType = fourCc(header, 8);
  if (fourCc(header) !== "FORM" || !["AIFF", "AIFC"].includes(formType)) {
    throw new Error("Streaming analysis currently requires an AIFF recording");
  }

  let offset = 12;
  let format: Omit<AiffStreamInfo, "soundOffset" | "soundLength"> | undefined;
  let sound: Pick<AiffStreamInfo, "soundOffset" | "soundLength"> | undefined;
  while (!format || !sound) {
    const chunkHeader = await readExactly(file, 8, offset);
    const chunkType = fourCc(chunkHeader);
    const chunkLength = chunkHeader.readUInt32BE(4);
    const payloadOffset = offset + 8;
    if (chunkType === "COMM") {
      const payload = await readExactly(file, Math.min(chunkLength, 64), payloadOffset);
      if (payload.length < 18) throw new Error("Invalid AIFF COMM chunk");
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      format = {
        channels: view.getUint16(0, false),
        frames: view.getUint32(2, false),
        bitsPerSample: view.getUint16(6, false),
        sampleRate: extended80(view, 8),
        compression: formType === "AIFC" ? fourCc(payload, 18) : "NONE",
      };
    } else if (chunkType === "SSND") {
      const payload = await readExactly(file, 8, payloadOffset);
      const dataOffset = payload.readUInt32BE(0);
      sound = {
        soundOffset: payloadOffset + 8 + dataOffset,
        soundLength: chunkLength - 8 - dataOffset,
      };
    }
    offset = payloadOffset + chunkLength + (chunkLength & 1);
  }
  const info = { ...format, ...sound };
  if (
    info.channels < 1 ||
    info.sampleRate <= 0 ||
    info.bitsPerSample !== 32 ||
    !["fl32", "FL32"].includes(info.compression)
  ) {
    throw new Error(
      `Streaming analysis does not yet support ${info.compression} ${info.bitsPerSample}-bit AIFF`,
    );
  }
  return info;
}

function goertzelEnergy(samples: Float32Array, start: number, length: number, frequency: number, sampleRate: number): number {
  const coefficient = 2 * Math.cos((2 * Math.PI * frequency) / sampleRate);
  let previous = 0;
  let previousPrevious = 0;
  for (let index = start; index < start + length; index += 1) {
    const current = (samples[index] ?? 0) + coefficient * previous - previousPrevious;
    previousPrevious = previous;
    previous = current;
  }
  return Math.max(0, previousPrevious ** 2 + previous ** 2 - coefficient * previous * previousPrevious);
}

function chromaFeatures(samples: Float32Array, sampleRate: number, rms: number): number[] {
  const chroma = Array(12).fill(0) as number[];
  if (samples.length < 256 || rms < 1e-5) return chroma;
  const excerptLength = Math.min(1024, samples.length);
  const excerptCount = Math.min(3, Math.max(1, Math.floor(samples.length / excerptLength)));
  for (let excerpt = 0; excerpt < excerptCount; excerpt += 1) {
    const start = Math.round((samples.length - excerptLength) * (excerpt + 0.5) / excerptCount);
    for (let midi = 36; midi <= 95; midi += 1) {
      const frequency = 440 * 2 ** ((midi - 69) / 12);
      if (frequency >= sampleRate * 0.48) break;
      chroma[midi % 12] = chroma[midi % 12]! + Math.sqrt(goertzelEnergy(samples, start, excerptLength, frequency, sampleRate));
    }
  }
  const total = chroma.reduce((sum, value) => sum + value, 0);
  return total > 0 ? chroma.map((value) => value / total) : chroma;
}

function featuresFromFloat32Window(
  buffer: Buffer,
  frames: number,
  channels: number,
  stride: number,
  sourceSampleRate: number,
): number[] {
  let sumSquares = 0;
  let sumAbsolute = 0;
  let sumDifferenceSquares = 0;
  let peak = 0;
  let zeroCrossings = 0;
  let count = 0;
  let previous = 0;
  let hasPrevious = false;
  const sampled = new Float32Array(Math.ceil(frames / stride));
  const bytesPerFrame = channels * 4;
  for (let frame = 0; frame < frames; frame += stride) {
    let sample = 0;
    const frameOffset = frame * bytesPerFrame;
    for (let channel = 0; channel < channels; channel += 1) {
      sample += buffer.readFloatBE(frameOffset + channel * 4);
    }
    sample /= channels;
    if (!Number.isFinite(sample)) sample = 0;
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
    sampled[count] = sample;
    count += 1;
  }
  if (count === 0) return [...Array(12).fill(0), 0, 0, 0, 0];
  const rms = Math.sqrt(sumSquares / count);
  const differenceRms = Math.sqrt(sumDifferenceSquares / Math.max(1, count - 1));
  const blockSize = Math.max(8, Math.round((sourceSampleRate / stride) * 0.05));
  let previousBlockRms = 0;
  let attacks = 0;
  let blocks = 0;
  for (let start = 0; start + blockSize <= count; start += blockSize) {
    let blockSquares = 0;
    for (let index = start; index < start + blockSize; index += 1) blockSquares += sampled[index]! ** 2;
    const blockRms = Math.sqrt(blockSquares / blockSize);
    if (blocks > 0 && blockRms > previousBlockRms * 1.6 && blockRms - previousBlockRms > rms * 0.12) attacks += 1;
    previousBlockRms = blockRms;
    blocks += 1;
  }
  return [
    ...chromaFeatures(sampled.subarray(0, count), sourceSampleRate / stride, rms),
    Math.log1p(rms * 20),
    attacks / Math.max(1, blocks),
    differenceRms / Math.max(rms, 1e-9),
    peak / Math.max(rms, 1e-9),
  ];
}

export interface ExtractedSignalData {
  durationSeconds: number;
  continuousSignals: ContinuousSignal[];
}

export async function extractAiffSignals(
  source: AudioSourceDescriptor,
  options: FeatureExtractionOptions,
  abortSignal?: AbortSignal,
): Promise<ExtractedSignalData> {
  const file = await open(source.filePath, "r");
  try {
    const info = await readAiffInfo(file);
    const bytesPerFrame = info.channels * 4;
    const startFrame = Math.max(0, Math.round(source.startTimeSeconds * info.sampleRate));
    const availableFrames = Math.min(
      info.frames - startFrame,
      Math.round(source.durationSeconds * info.sampleRate),
    );
    const windowFrames = Math.max(
      1,
      Math.round(options.windowBeats * source.tempoContext.secondsPerBeat * info.sampleRate),
    );
    const hopFrames = Math.max(
      1,
      Math.round(options.hopBeats * source.tempoContext.secondsPerBeat * info.sampleRate),
    );
    const stride = Math.max(1, Math.floor(info.sampleRate / options.targetSampleRate));
    const buffer = Buffer.allocUnsafe(windowFrames * bytesPerFrame);
    const rawFeatures: number[][] = [];
    const frameTimesSeconds: number[] = [];

    for (let relativeFrame = 0; relativeFrame < availableFrames; relativeFrame += hopFrames) {
      if (abortSignal?.aborted) return { durationSeconds: 0, continuousSignals: [] };
      const frames = Math.min(windowFrames, availableFrames - relativeFrame);
      if (frames < windowFrames * 0.5) break;
      const bytes = frames * bytesPerFrame;
      const { bytesRead } = await file.read(
        buffer,
        0,
        bytes,
        info.soundOffset + (startFrame + relativeFrame) * bytesPerFrame,
      );
      const decodedFrames = Math.floor(bytesRead / bytesPerFrame);
      rawFeatures.push(
        featuresFromFloat32Window(buffer, decodedFrames, info.channels, stride, info.sampleRate),
      );
      frameTimesSeconds.push(relativeFrame / info.sampleRate);
    }
    const sampleIntervalSeconds = options.hopBeats * source.tempoContext.secondsPerBeat;
    const continuousSignals = STATE_SIGNAL_KINDS.map((kind, dimension) => ({
      kind,
      sampleIntervalSeconds,
      points: frameTimesSeconds.map((timeSeconds, frameIndex) => ({
        timeSeconds,
        value: rawFeatures[frameIndex]?.[dimension] ?? 0,
      })),
    }));
    return {
      durationSeconds: availableFrames / info.sampleRate,
      continuousSignals,
    };
  } finally {
    await file.close();
  }
}
