# Jamology

Jamology is an Ableton Live Extension for turning a long multitrack hardware jam
into a shared visual section map. It detects sustained musical changes across
selected audio tracks; it does not attempt to decide which ideas are good.

Jamology is deliberately non-destructive. Ableton Extensions SDK 1.0.0-beta.1
cannot safely split existing Arrangement clips, so **Analyze Jam** reads the
original Live-recorded AIFF sources directly and creates full-length references
plus a synchronized, color-coded `JAMOLOGY SECTION MAP`. The recordings are not edited. See
[`docs/sdk-feasibility.md`](docs/sdk-feasibility.md) for the exact API boundary.

## Install a packaged build

Use Ableton Live 12 Suite Beta 12.4.5b11 or later. Build
`Jamology-0.1.7.ablx` using the steps below, or use a supplied copy, and put it
in `User Library/Extensions/`. Check that Jamology is enabled in Live's
**Settings → Extensions**. In Arrangement View, select time across at least
two Live-recorded audio tracks, then right-click and choose **Analyze Jam**.

## Current analysis

- Track and parent-group name inference for harmony, melody, drums, bass, and texture.
  Including `CHORDS`, `MELODY`, `DRUMS`, or `BASS` in a track name is an
  optional explicit hint. An explicit child-track role wins; otherwise Jamology
  walks outward through its parent groups. Unknown hierarchies use a balanced detector.
- A role-review window appears before analysis. Suggested roles can be changed
  per track, and `Ignore for detection` keeps a recording in the review canvas
  without allowing it to create section boundaries.
- Pitch-class profiles for sustained harmonic and melodic-content changes.
- Level, transient-density, and brightness state for drum entrances, exits,
  and materially different rhythmic activity.
- Long before/after contexts: a brief fill or gesture is not a new section
  unless the changed musical state persists.
- Independent role-group voting, so drums entering can create a boundary while
  harmony remains unchanged, and vice versa.
- A 48-bar minimum region, bar snapping, and a maximum of twelve proposed
  boundaries per analysis pass.
- Map labels and colors show whether harmony, melody, drums, bass, texture, or
  several roles drove the transition.
- Incremental direct analysis of Live's AIFF-C 32-bit-float recordings without
  asking Live to export clips or loading entire files into memory.

The map proposes long-form musical states for audition; it still does not judge
which performance ideas are good.

## Analysis architecture

The Live command calls a versioned, replaceable analysis backend. The current
`dsp` backend returns named, role-independent signals; Jamology then applies the
reviewed track roles, fuses boundary evidence, and creates the Live map. This
keeps future analyzers separate from Live mutations and preserves the direct
AIFF streaming path. See [`docs/analysis-backends.md`](docs/analysis-backends.md).

## Requirements

- Ableton Live 12 Suite Beta 12.4.5b11 or newer.
- Ableton Extensions SDK 1.0.0-beta.1.
- Node.js 24 or newer.

The SDK license does not permit redistributing its packages in this repository.
Before installing dependencies, copy these two files from the official SDK
download into `vendor/`:

```text
ableton-extensions-sdk-1.0.0-beta.1.tgz
ableton-extensions-cli-1.0.0-beta.1.tgz
```

## Build and test

```sh
npm install
npm run check
npm run package
```

## Try in Live

1. Open Live 12.4.5b11 or newer and enable Extension Developer Mode.
2. If your SDK setup requires a custom Extension Host path, configure it locally. Run the
   development host from this repository with Jamology diagnostic output:

   ```sh
   npm run debug
   ```

   After a code change, stop that command with Control-C and run it again. Live
   stays open; the restarted host loads the rebuilt extension.
3. Drag a time selection across the short visible final loop pass on two or
   more recorded audio tracks. Jamology discovers the hidden recording history
   from the clips' source markers; do not expand the clips first.
4. Right-click the selection and choose **Analyze Jam**.
5. Inspect the full-length audio references and aligned `JAMOLOGY SECTION MAP`
   created after the current Arrangement content.

Jamology reads Live-recorded 32-bit float AIFF files incrementally and does not
ask Live to export full-length tracks. It leaves the visible loop clips and
their audio files unchanged. Because Extensions SDK Beta 1 cannot safely split
existing Arrangement clips, Jamology creates one non-looping full-recording
reference per source track plus a lightweight color-coded section map. This
avoids creating thousands of audio clips for a 20-track, 30-minute jam.

For each proposed boundary, classify it as Good, Harmless, Bad, or Missed. That
studio judgment—not an abstract numerical score—drives the next analysis pass.
