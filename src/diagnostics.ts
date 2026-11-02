import { invoke } from "@tauri-apps/api/core";
export function recordDiagnostic(event: string, data: Record<string, unknown> = {}): void {
  void invoke("diagnostic_event", { event, data }).catch(() => { /* Logging must not interrupt the pet. */ });
}
export function installErrorDiagnostics(): void {
  window.addEventListener("error", () => recordDiagnostic("frontend_error", { code: "unknown" }));
  window.addEventListener("unhandledrejection", () => recordDiagnostic("frontend_error", { code: "unknown" }));
}
