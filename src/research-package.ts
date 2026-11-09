import type { AnalysisResult } from "./analysis-contract.js";
import type { SegmentationResult } from "./analysis.js";

export interface JamologyResearchPackage {
  schemaVersion: 1;
  analyses: AnalysisResult[];
  segmentation: SegmentationResult;
}

export function createResearchPackage(
  analyses: readonly AnalysisResult[],
  segmentation: SegmentationResult,
): JamologyResearchPackage {
  return {
    schemaVersion: 1,
    analyses: [...analyses],
    segmentation,
  };
}

export function serializeResearchPackage(value: JamologyResearchPackage): string {
  return JSON.stringify(value, null, 2);
}
