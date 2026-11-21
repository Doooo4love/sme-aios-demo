import { apiFetch } from "@/lib/api-client";
import type {
  EmployeeDirectoryPage,
  EmployeeModulesResponse,
  ModuleAccessCatalog,
  ModuleAssignment,
} from "@/lib/types";

export function fetchModuleAccessCatalog(signal?: AbortSignal) {
  return apiFetch<ModuleAccessCatalog>("/v1/workbench/module-access/catalog", {
    signal,
  });
}

export function fetchModuleAccessEmployees(
  params?: { after?: string; limit?: number },
  signal?: AbortSignal,
) {
  const sp = new URLSearchParams();
  if (params?.limit !== undefined) {
    sp.set("limit", String(params.limit));
  }
  if (params?.after) {
    sp.set("after", params.after);
  }
  const query = sp.toString();
  return apiFetch<EmployeeDirectoryPage>(
    `/v1/workbench/module-access/employees${query ? `?${query}` : ""}`,
    { signal },
  );
}

export function fetchEmployeeModuleAssignments(
  subject: string,
  signal?: AbortSignal,
) {
  return apiFetch<EmployeeModulesResponse>(
    `/v1/workbench/module-access/employees/${encodeURIComponent(subject)}`,
    { signal },
  );
}

export function saveEmployeeModuleAssignment(
  subject: string,
  moduleId: string,
  assignment: ModuleAssignment,
  signal?: AbortSignal,
) {
  const payload: ModuleAssignment = {
    version: assignment.version,
    grants: Array.from(new Set(assignment.grants)),
    warehouses: Array.from(new Set(assignment.warehouses)),
    expires_at:
      assignment.grants.length === 0 ? null : (assignment.expires_at ?? null),
  };

  return apiFetch<ModuleAssignment>(
    `/v1/workbench/module-access/employees/${encodeURIComponent(subject)}/${encodeURIComponent(moduleId)}`,
    {
      method: "PUT",
      body: payload,
      signal,
    },
  );
}
