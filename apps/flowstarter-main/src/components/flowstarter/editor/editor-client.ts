/**
 * The shapes the editor panel and the client-site API agree on, and the one
 * place a response is turned into either data or a message a person can read.
 *
 * Every mutating route can refuse on policy grounds, and the refusal carries
 * the policy's own reason. `requestEditor` keeps that reason intact rather than
 * flattening it into "something went wrong": a client whose subscription
 * lapsed needs to be told that, not shown a broken button.
 */
import type { EditCreditPosition } from '@/lib/flowstarter/edit-credits';

export interface EditorTarget {
  id: string;
  key: string;
  section: string;
  content: string;
  file: string;
  line: number;
}

export interface EditorVersion {
  version: number;
  summary: string | null;
  createdBy: string;
  createdAt: string;
  publishedAt: string | null;
}

export interface PolicyDecision {
  action:
    | 'inline_content_agent'
    | 'client_media_upload'
    | 'operator_workbench'
    | 'maintenance_request'
    | 'deny';
  reason: string;
}

export interface EditorState {
  site: {
    name: string;
    version: number;
    templateSlug: string | null;
    rendersBuiltHtml: boolean;
  };
  targets: EditorTarget[];
  versions: EditorVersion[];
  allowance: {
    /** Proposals today, against the burst cap. */
    used: number;
    cap: number;
    maxInstructionChars: number;
    /** The monthly plan allowance, which is the one the client bought. */
    credits: EditCreditPosition;
  };
  policy: {
    content: PolicyDecision;
    image: PolicyDecision;
    /** The 'layout' capability's verdict — what "Bigger changes" renders. */
    structural: PolicyDecision;
  };
}

export interface ImageSlot {
  id: string;
  file: string;
  line: number;
  currentPath: string;
  section: string;
  key: string;
  alt?: string;
}

export interface EditorAsset {
  id: string;
  kind: string | null;
  mime: string | null;
  width: number | null;
  height: number | null;
  usable: boolean;
  url: string | null;
}

/** A refusal that should be shown as written, with its policy action if any. */
export class EditorRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly policy?: PolicyDecision
  ) {
    super(message);
    this.name = 'EditorRequestError';
  }
}

export async function requestEditor<T>(
  url: string,
  init?: RequestInit
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  let payload: Record<string, unknown> = {};
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  if (!response.ok) {
    throw new EditorRequestError(
      typeof payload['error'] === 'string'
        ? payload['error']
        : 'That did not work. Please try again.',
      response.status,
      typeof payload['code'] === 'string' ? payload['code'] : undefined,
      payload['policy'] as PolicyDecision | undefined
    );
  }
  return payload as T;
}

export function editorApiBase(workspaceId: string): string {
  return `/api/client/site/${encodeURIComponent(workspaceId)}`;
}

/**
 * Word-level difference between the current text and what the agent proposes,
 * so a client can see that "we open Saturdays" is the only thing that changed
 * rather than re-reading a paragraph and hoping.
 */
export interface DiffPart {
  kind: 'same' | 'removed' | 'added';
  text: string;
}

export function diffWords(before: string, after: string): DiffPart[] {
  const left = before.split(/(\s+)/);
  const right = after.split(/(\s+)/);
  let head = 0;
  while (
    head < left.length &&
    head < right.length &&
    left[head] === right[head]
  )
    head += 1;
  let tail = 0;
  while (
    tail < left.length - head &&
    tail < right.length - head &&
    left[left.length - 1 - tail] === right[right.length - 1 - tail]
  )
    tail += 1;

  const parts: DiffPart[] = [];
  const prefix = left.slice(0, head).join('');
  if (prefix) parts.push({ kind: 'same', text: prefix });
  const removed = left.slice(head, left.length - tail).join('');
  if (removed) parts.push({ kind: 'removed', text: removed });
  const added = right.slice(head, right.length - tail).join('');
  if (added) parts.push({ kind: 'added', text: added });
  const suffix = left.slice(left.length - tail).join('');
  if (suffix) parts.push({ kind: 'same', text: suffix });
  return parts;
}
