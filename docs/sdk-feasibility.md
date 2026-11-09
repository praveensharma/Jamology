# Ableton Extensions SDK feasibility (1.0.0-beta.1)

Jamology is grounded in the official Beta 1 SDK bundle and examples installed at
`~/Documents/Ableton Extensions SDK 1.0.0 Beta 1`.

## Supported directly

- Arrangement time range and selected lane handles via `ArrangementSelection`.
- Resolution of selected audio tracks through `getObjectFromHandle`.
- Arrangement clips and their start/end/loop metadata (read-only).
- Creating non-looping full-source audio references from existing files.
- Creation and deletion of Arrangement MIDI/audio clips.
- Clearing a time range, which deletes or truncates overlapping clips.
- Clip color assignment.
- One user-facing undo transaction.
- Context-menu commands, progress UI, and cancellation.

The closest official example is `examples/strip-silence`: it resolves an audio
Arrangement selection, discovers each clip's hidden source span, incrementally analyzes the original AIFF recording, and
calls `clearClipsInRange` inside a transaction.

## Blocking gap: safe splitting of existing clips

Beta 1 has no `splitClip` operation. Existing clip `startTime`, `endTime`,
`startMarker`, `endMarker`, `loopStart`, and `loopEnd` values are getters, not
setters. `clearClipsInRange` can create a gap but cannot make a zero-width shared
cut.

It is technically possible to delete a clip and create replacements from its
source file. That is not a faithful split: the API cannot restore every piece of
clip state, including custom warp markers, and the reconstruction becomes more
ambiguous for looped clips. Jamology does not risk valuable recordings this way.

## V0.1 output decision

The first implementation creates a `JAMOLOGY MAP` MIDI track containing empty,
named, color-coded clips at the shared global boundaries. It leaves all source
tracks and audio files untouched, is undoable, and proves whether the
cross-track segmentation is musically useful. The pure analyzer is separated
from this output adapter so a future official split API can replace the map
writer without changing feature extraction or consensus scoring.

## Other current constraints

- `renderPreFxAudio` is audio-track-only; MIDI/instrument tracks must first be
  represented by recorded audio if they should participate.
- The SDK exposes the current tempo but no Arrangement tempo automation curve.
  The prototype maps rendered samples proportionally across the selected beat
  range, which is exact only at constant tempo.
- The SDK exposes no Set path/name for stable per-project identity.
- Clip color is an RGB integer; the current four colors must be visually checked
  against Live's palette before treating them as final product colors.
- Beta 1 requires Node.js 24 or later.
