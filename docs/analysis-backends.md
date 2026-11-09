# Analysis backends

Jamology keeps audio observation separate from musical evidence, segmentation,
and Live mutations.

```text
Live selection and reviewed roles
  -> AnalysisRequest
  -> JamAnalysisBackend
  -> named ContinuousSignal values
  -> role-aware BoundaryEvidence
  -> shared segmentation
  -> Live review canvas and section map
```

The default `dsp` backend incrementally reads the original Live-recorded AIFF
files. It does not ask Live to export clips and it does not mutate the Set.

Backend results identify `backend.id`, `backend.version`, and `schemaVersion`.
They use seconds for source-audio observations and carry an explicit
`secondsPerBeat` mapping. Jamology converts observations to beats before
cross-track fusion, minimum-section filtering, and bar snapping.

The current backend emits role-independent named signals:

- twelve pitch-class (`chroma.*`) signals
- `level.rms`
- `rhythm.onset_density`
- `spectral.brightness`
- `dynamics.crest`

Reviewed track roles are applied after extraction. This is the seam where a
future cache can avoid rereading audio when only roles or segmentation settings
change.

Future analyzers must implement `JamAnalysisBackend` and map their output to the
types in `analysis-contract.ts`. A future Apple Music Understanding adapter is
optional and must not change the macOS 26-compatible DSP default. Do not add a
native helper or a backend-specific result type above this boundary merely for
architectural symmetry.

Live output remains isolated in `live-canvas.ts` and `live-map.ts`. Analysis
backends must never create, delete, split, rename, or color Live clips.

`research-package.ts` provides a versioned JSON-ready container for backend
results plus segmentation output. It is intentionally not exposed as a Live UI
command yet; it exists so evaluation tooling can compare future backends against
the same normalized representation.
