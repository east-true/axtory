import type { DataClassification } from "./records.js";

export interface ClassificationPolicy {
  capture: boolean;
  persist: boolean;
  analyze: boolean;
  export: boolean;
  retentionDays: number | null;
}

export interface CollectionPolicy {
  version: string;
  classifications: Readonly<Record<DataClassification, ClassificationPolicy>>;
}

const localMetadata: ClassificationPolicy = {
  capture: true, persist: true, analyze: true, export: true, retentionDays: null,
};
const localContent: ClassificationPolicy = {
  capture: true, persist: true, analyze: false, export: false, retentionDays: null,
};

export const DEFAULT_LOCAL_COLLECTION_POLICY: CollectionPolicy = {
  version: "local-default/1",
  classifications: {
    PUBLIC_METADATA: localMetadata,
    LOCAL_METADATA: localMetadata,
    IDENTIFYING_METADATA: { ...localContent },
    CONVERSATION_CONTENT: { ...localContent },
    SOURCE_CONTENT: { ...localContent },
    TOOL_CONTENT: { ...localContent },
    SECRET: { ...localContent, analyze: false, export: false },
    PERSONAL_DATA: { ...localContent, analyze: false, export: false },
  },
};

export function policyAllows(
  policy: CollectionPolicy,
  classification: DataClassification,
  action: "capture" | "persist" | "analyze" | "export",
): boolean {
  return policy.classifications[classification][action];
}
