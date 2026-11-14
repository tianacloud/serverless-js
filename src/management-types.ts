// Public MGR instance and operation DTOs.
export type Engine = string;
export type ProductFamily = "classic" | "agentic";

export interface AppType {
  engine: Engine;
  display_name: string;
  product_family: ProductFamily;
  generation: string;
  updated_at: string;
}

export interface AppTypeCatalog {
  items: AppType[];
}

export type ProductState = "PENDING" | "ACTIVE" | "UNKNOWN" | "FAILED" | "DELETED";

export interface PublicConfig {
  cache_mb?: number;
}

export type Labels = Record<string, string>;

export interface WebIconDescriptor {
  url: string;
  text: string;
  background: string;
  foreground: string;
}

export interface Instance {
  web?: {
    icon: WebIconDescriptor;
    endpoint?: string;
    id: string;
    entry?: string;
    database_instance_id?: string;
    git_instance_id?: string;
  };

  id: string;
  /** Durable project identity for Web instances. */
  web_id?: string;
  display_name: string;
  labels: Labels;
  notes: string;
  engine: Engine;
  product_family: ProductFamily;
  product_display_name: string;
  config: PublicConfig;
  config_revision?: string;
  endpoint_id?: string;
  product_state: ProductState;
  product_revision: string;
  lifecycle_state?: "CREATING" | "AVAILABLE" | "DELETING" | "DELETED";
  enabled?: boolean;
  access?: { admin_blocked: boolean; admin_block_reason?: string; operator: string; changed_at: number };
  root_runtime_state?: string;
  branch_count?: number;
  last_error_code?: string;
  last_error_message?: string;
  creation_operation_id?: string;
  creation_job_id?: number;
  deletion_operation_id?: string;
  deletion_pending: boolean;
  deletion_job_id?: number;
  runtime_status_stale: boolean;
  stale_reason?: string;
  created_at: string;
  updated_at: string;
  group_id?: string;
  group_name?: string;
  group_sync_status?: SyncStatus;
  group_job_id?: number;
}

export interface InstancePage {
  items: Instance[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

export interface CreateInstanceInput {
  source_dir?: string;
  git_instance_id?: string;
  request_id?: string;
  root_branch_name?: string;
  timeline?: boolean;
  display_name: string;
  engine: Engine;
  labels?: Labels;
  notes?: string;
  config?: PublicConfig;
  group_id?: string;
}

export type SyncStatus = "pending" | "running" | "fail" | "complete";

export interface EditInstanceInput {
  display_name?: string;
  labels?: Labels;
  notes?: string;
  config?: PublicConfig;
  expected_config_revision?: string;
}

export interface InstanceBranch {
  timeline?: BranchTimelinePolicy | null;
  actions: Record<"delete" | "create" | "reset" | "reset_history" | "rename" | "protection" | "expiry", { enabled: boolean; reason?: string }>;
  branch_id: string;
  name: string;
  root: boolean;
  parent_branch_id?: string;
  parent_name?: string;
  parent_deleted: boolean;
  logical_parent?: { branch_id: string; name: string; deleted: boolean };
  protected: boolean;
  expires_at?: string;
  endpoint_id?: string;
  lifecycle_state: string;
  runtime_state: string;
  active_instance_config_revision?: string;
  target_instance_config_revision?: string;
  maintenance_operation_id?: string;
  maintenance_kind?: string;
  last_activated_at?: string;
  storage_bytes: string | null;
}

export interface InstanceBranchPage {
  instance_id: string;
  enabled: boolean;
  items: InstanceBranch[];
  next_cursor?: string;
}

export interface InstanceOperationAccepted {
  job_id?: number;
  instance_id: string;
  operation_id: string;
}

export interface InstanceOperationStep {
  sequence: string;
  step: string;
  branch_name?: string;
  attempt: number;
  state: string;
  started_at: string;
  finished_at?: string;
  duration_ms: number | null;
  error_code?: string;
  message?: string;
}

export interface InstanceOperation extends InstanceOperationAccepted {
  branch_id: string;
  parent_branch_id?: string;
  kind: string;
  state: string;
  next_retry_at?: string;
  result?: { history?: BranchHistory; deleted?: boolean; reclaim_operation_id?: string; parent_reclaim_operation_id?: string; old_branch_id?: string; new_branch_id?: string; parent_branch_id?: string; instance_id?: string; branch_name?: string; endpoint_id?: string; timeline?: boolean | BranchTimelinePolicy; status?: string; published_at?: string; code?: string; message?: string; branch_id?: string; name?: string; protected?: boolean; expires_at?: string | null };
  started_at: string;
  finished_at?: string;
  updated_at: string;
  current_step?: InstanceOperationStep;
  queue_duration_ms: number | null;
  total_duration_ms: number | null;
}

export interface InstanceOperationStepsPage extends InstanceOperationAccepted {
  items: InstanceOperationStep[];
  next_cursor?: string;
}

export interface InstanceBranchDetail {
  instance_id: string;
  enabled: boolean;
  branch: InstanceBranch;
}

export interface RecoveryRange { start: number; end: number }
export interface BranchHistory { enabled: boolean; retention_seconds?: number; ranges: RecoveryRange[] }

/* Timeline policy for a branch; retention_seconds omitted means the value
   predates the field and must not be rendered as zero. */
export interface BranchTimelinePolicy { enabled: boolean; retention_seconds?: number }
export interface BranchHistoryResponse {
  instance_id: string;
  branch_id: string;
  branch_name?: string;
  operation_id?: string;
  history?: BranchHistory;
  code?: string;
  message?: string;
}
