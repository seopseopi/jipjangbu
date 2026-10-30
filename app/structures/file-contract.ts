export const MAX_PLAN_FILE_BYTES = 32 * 1024 * 1024;
export const PLAN_FILE_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
] as const;
export type PlanFile = {
  revision_id: string;
  file_name: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
};
