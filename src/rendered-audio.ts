import decodeAudio from "audio-decode";
import type { AudioData } from "./analysis.js";

function fourCc(bytes: Uint8Array, offset: number): string {
  if (offset < 0 || offset + 4 > bytes.byteLength) return "";
  return String.fromCharCode(
    bytes[offset]!,
    bytes[offset + 1]!,
    bytes[offset + 2]!,
    bytes[offset + 3]!,
  );
}

function extended80(view: DataView, offset: number): number {
  const exponentAndSign = view.getUint16(offset, false);
  const exponent = exponentAndSign & 0x7fff;
  const sign = exponentAndSign & 0x8000 ? -1 : 1;
  const high = view.getUint32(offset + 2, false);
  const low = view.getUint32(offset + 6, false);
  if (exponent === 0 && high === 0 && low === 0) return 0;
  if (exponent === 0x7fff) return Number.POSITIVE_INFINITY * sign;
  const mantissa = high * 2 ** 32 + low;
  return sign * mantissa * 2 ** (exponent - 16383 - 63);
}

function signed24(view: DataView, offset: number, littleEndian: boolean): number {
  const value = littleEndian
    ? view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16)
    : (view.getUint8(offset) << 16) | (view.getUint8(offset + 1) << 8) | view.getUint8(offset + 2);
  return value & 0x800000 ? value - 0x1000000 : value;
}

interface AiffFormat {
  channels: number;
  frames: number;
  bitsPerSample: number;
  sampleRate: number;
  compression: string;
}

interface SoundData {
  offset: number;
  length: number;
}

function decodeAiff(bytes: Uint8Array): AudioData {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const formType = fourCc(bytes, 8);
  let format: AiffFormat | undefined;
  let sound: SoundData | undefined;

  for (let chunkOffset = 12; chunkOffset + 8 <= bytes.byteLength; ) {
    const chunkType = fourCc(bytes, chunkOffset);
    const chunkLength = view.getUint32(chunkOffset + 4, false);
    const payloadOffset = chunkOffset + 8;
    const payloadEnd = payloadOffset + chunkLength;
    if (payloadEnd > bytes.byteLength) {
      throw new Error(`Truncated AIFF ${chunkType || "unknown"} chunk`);
    }

    if (chunkType === "COMM") {
      if (chunkLength < 18) throw new Error("Invalid AIFF COMM chunk");
      format = {
        channels: view.getUint16(payloadOffset, false),
        frames: view.getUint32(payloadOffset + 2, false),
        bitsPerSample: view.getUint16(payloadOffset + 6, false),
        sampleRate: extended80(view, payloadOffset + 8),
        compression:
          formType === "AIFC"
            ? chunkLength >= 22
              ? fourCc(bytes, payloadOffset + 18)
              : ""
            : "NONE",
      };
    } else if (chunkType === "SSND") {
      if (chunkLength < 8) throw new Error("Invalid AIFF SSND chunk");
      const dataOffset = view.getUint32(payloadOffset, false);
      const sampleOffset = payloadOffset + 8 + dataOffset;
      if (sampleOffset > payloadEnd) throw new Error("Invalid AIFF sound-data offset");
      sound = { offset: sampleOffset, length: payloadEnd - sampleOffset };
    }

    chunkOffset = payloadEnd + (chunkLength & 1);
  }

  if (!format) throw new Error("AIFF file has no COMM format chunk");
  if (!sound) throw new Error("AIFF file has no SSND audio chunk");
  if (format.channels < 1 || !Number.isFinite(format.sampleRate) || format.sampleRate <= 0) {
    throw new Error("AIFF file has invalid channel or sample-rate metadata");
  }

  const compression = format.compression;
  const isFloat32 = compression === "fl32" || compression === "FL32";
  const isFloat64 = compression === "fl64" || compression === "FL64";
  const isPcm = compression === "NONE" || compression === "twos" || compression === "sowt";
  if (!isFloat32 && !isFloat64 && !isPcm) {
    throw new Error(`Unsupported AIFF compression: ${compression || "unknown"}`);
  }

  const bytesPerSample = isFloat32 ? 4 : isFloat64 ? 8 : Math.ceil(format.bitsPerSample / 8);
  if (![1, 2, 3, 4, 8].includes(bytesPerSample)) {
    throw new Error(`Unsupported AIFF sample size: ${format.bitsPerSample} bits`);
  }
  const bytesPerFrame = bytesPerSample * format.channels;
  const frameCount = Math.min(format.frames, Math.floor(sound.length / bytesPerFrame));
  const channels = Array.from({ length: format.channels }, () => new Float32Array(frameCount));
  const littleEndian = compression === "sowt";

  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < format.channels; channel += 1) {
      const offset = sound.offset + (frame * format.channels + channel) * bytesPerSample;
      let sample: number;
      if (isFloat32) sample = view.getFloat32(offset, false);
      else if (isFloat64) sample = view.getFloat64(offset, false);
      else if (format.bitsPerSample === 8) sample = view.getInt8(offset) / 0x80;
      else if (format.bitsPerSample === 16) sample = view.getInt16(offset, littleEndian) / 0x8000;
      else if (format.bitsPerSample === 24) sample = signed24(view, offset, littleEndian) / 0x800000;
      else if (format.bitsPerSample === 32) sample = view.getInt32(offset, littleEndian) / 0x80000000;
      else throw new Error(`Unsupported AIFF sample size: ${format.bitsPerSample} bits`);
      channels[channel]![frame] = Number.isFinite(sample) ? sample : 0;
    }
  }

  return { channels, sampleRate: format.sampleRate };
}

export async function decodeRenderedAudio(bytes: Uint8Array): Promise<AudioData> {
  if (fourCc(bytes, 0) === "FORM" && ["AIFF", "AIFC"].includes(fourCc(bytes, 8))) {
    return decodeAiff(bytes);
  }

  const decoded = await decodeAudio(bytes);
  return {
    channels: Array.from(
      { length: decoded.numberOfChannels },
      (_, channel) => decoded.getChannelData(channel),
    ),
    sampleRate: decoded.sampleRate,
  };
}
