/**
 * Web companion to `apps/flowstarter-editor/server/src/workspace/approvalHttp.ts`.
 * Single function — fire-and-forget POST to `/api/clerk/workspace/approve-mockup`,
 * returns the discriminated outcome so the banner can react.
 */

import { withBasePath } from "./basePath";

const APPROVE_MOCKUP_PATH = withBasePath("/api/clerk/workspace/approve-mockup");

export type ApproveMockupResolution =
  | {
      readonly status: "ok";
      readonly approvedAt: string;
      readonly conciergeStage: string;
      readonly workspaceId: string;
    }
  | { readonly status: "already-approved"; readonly approvedAt: string }
  | { readonly status: "no-workspace"; readonly reason: string }
  | { readonly status: "unauthenticated"; readonly reason: string }
  | { readonly status: "forbidden"; readonly reason: string }
  | { readonly status: "config-error"; readonly reason: string }
  | { readonly status: "error"; readonly reason: string };

export async function approveMockup(): Promise<ApproveMockupResolution> {
  let response: Response;
  try {
    response = await fetch(APPROVE_MOCKUP_PATH, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
    });
  } catch (error) {
    return {
      status: "error",
      reason: error instanceof Error ? error.message : "Network error",
    };
  }
  let body: unknown;
  try {
    const text = await response.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!body || typeof body !== "object") {
    return {
      status: "error",
      reason: `Unexpected response (HTTP ${response.status})`,
    };
  }
  const status = (body as { status?: string }).status;
  if (
    status === "ok" ||
    status === "already-approved" ||
    status === "no-workspace" ||
    status === "unauthenticated" ||
    status === "forbidden" ||
    status === "config-error" ||
    status === "error"
  ) {
    return body as ApproveMockupResolution;
  }
  return {
    status: "error",
    reason: `Unexpected /api/clerk/workspace/approve-mockup response`,
  };
}
