'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  closestCorners,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { compactRelative } from '@/lib/format-utils';
import {
  useTeamProjects,
  useUpdateProjectStage,
  type ProjectWithOwner,
} from '@/hooks/useTeamProjects';

// ─── Stage taxonomy ─────────────────────────────────────────────────────────

type DbStage =
  | 'intake'
  | 'brief'
  | 'build'
  | 'internal_review'
  | 'client_review'
  | 'launched'
  | 'care';

const COLUMN_ORDER = ['intake', 'brief', 'build', 'review', 'live'] as const;
type ColumnKey = (typeof COLUMN_ORDER)[number];

const COLUMN_LABEL: Record<ColumnKey, string> = {
  intake: 'Intake',
  brief: 'Brief',
  build: 'Build',
  review: 'Review',
  live: 'Live',
};

// Single-purpose: a tiny status dot per column. Color is the only signal.
const COLUMN_DOT: Record<ColumnKey, string> = {
  intake: 'bg-slate-400 dark:bg-slate-500',
  brief: 'bg-sky-500',
  build: 'bg-amber-500',
  review: 'bg-orange-500',
  live: 'bg-emerald-500',
};

const STAGE_TO_COLUMN: Record<DbStage, ColumnKey> = {
  intake: 'intake',
  brief: 'brief',
  build: 'build',
  internal_review: 'build',
  client_review: 'review',
  launched: 'live',
  care: 'live',
};

const COLUMN_TO_STAGE: Record<ColumnKey, DbStage> = {
  intake: 'intake',
  brief: 'brief',
  build: 'build',
  review: 'client_review',
  live: 'launched',
};

const TIER_LABEL: Record<string, string> = {
  essential: 'ESS',
  pro: 'PRO',
  commerce: 'COM',
  custom: 'CUS',
};

// ─── Component ──────────────────────────────────────────────────────────────

export function KanbanBoard() {
  const router = useRouter();
  const { data: projects, isLoading, error } = useTeamProjects();
  const updateStage = useUpdateProjectStage();
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  );

  const grouped = useMemo(() => {
    const buckets: Record<ColumnKey, ProjectWithOwner[]> = {
      intake: [],
      brief: [],
      build: [],
      review: [],
      live: [],
    };
    for (const p of projects ?? []) {
      const dbStage = (p.concierge_stage as DbStage) || 'intake';
      const col = STAGE_TO_COLUMN[dbStage] ?? 'intake';
      buckets[col].push(p);
    }
    for (const k of COLUMN_ORDER) {
      buckets[k].sort(
        (a, b) =>
          new Date(b.updated_at || b.created_at).getTime() -
          new Date(a.updated_at || a.created_at).getTime()
      );
    }
    return buckets;
  }, [projects]);

  const draggingProject =
    draggingId && projects
      ? projects.find((p) => p.id === draggingId) ?? null
      : null;

  const handleDragStart = (e: DragStartEvent) => {
    setDraggingId(String(e.active.id));
  };

  const handleDragEnd = (e: DragEndEvent) => {
    setDraggingId(null);
    if (!e.over) return;
    const id = String(e.active.id);
    const targetCol = String(e.over.id) as ColumnKey;
    if (!COLUMN_ORDER.includes(targetCol)) return;
    const project = projects?.find((p) => p.id === id);
    if (!project) return;
    const currentCol = STAGE_TO_COLUMN[project.concierge_stage as DbStage];
    if (currentCol === targetCol) return;
    const newDbStage = COLUMN_TO_STAGE[targetCol];
    updateStage.mutate({ id, stage: newDbStage });
  };

  if (error) {
    return (
      <div className="p-6 text-center">
        <p className="text-[13px] text-[var(--ls-ink-dim)]">
          Couldn&apos;t load projects.
        </p>
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setDraggingId(null)}
    >
      <div className="ls-kanban-canvas -mx-px grid grid-cols-1 divide-y divide-[var(--ls-rule)] dark:divide-[var(--ls-rule-strong)] sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-5 [&>*+*]:sm:border-l [&>*+*]:sm:border-[var(--ls-rule)] dark:[&>*+*]:sm:border-[var(--ls-rule-strong)] [&>*]:sm:border-b [&>*]:sm:border-[var(--ls-rule)] dark:[&>*]:sm:border-[var(--ls-rule-strong)] sm:[&>*:nth-last-child(-n+2)]:border-b-0 lg:[&>*]:border-b-0">
        {COLUMN_ORDER.map((col) => (
          <Column
            key={col}
            column={col}
            cards={grouped[col]}
            loading={isLoading}
            isDraggingAnything={draggingId !== null}
            onOpen={(id) => router.push(`/admin/dashboard/projects/${id}`)}
          />
        ))}
      </div>

      <DragOverlay
        dropAnimation={{
          duration: 180,
          easing: 'cubic-bezier(0.19, 1, 0.22, 1)',
        }}
      >
        {draggingProject && (
          <Card project={draggingProject} isOverlay onOpen={() => undefined} />
        )}
      </DragOverlay>
    </DndContext>
  );
}

// ─── Column ─────────────────────────────────────────────────────────────────

function Column({
  column,
  cards,
  loading,
  isDraggingAnything,
  onOpen,
}: {
  column: ColumnKey;
  cards: ProjectWithOwner[];
  loading: boolean;
  isDraggingAnything: boolean;
  onOpen: (id: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column });

  return (
    <div
      ref={setNodeRef}
      className={[
        'flex min-h-[200px] flex-col transition-colors',
        isOver ? 'bg-[var(--ls-accent)]/[0.06]' : '',
      ].join(' ')}
    >
      {/* Tight column header — flush, no card chrome */}
      <div className="flex items-center gap-2 px-3 py-2.5">
        <span
          aria-hidden
          className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${COLUMN_DOT[column]}`}
        />
        <span className="ls-admin-label min-w-0 truncate">
          {COLUMN_LABEL[column]}
        </span>
        <span
          className="ml-auto font-mono text-[10.5px] tabular-nums text-[var(--ls-ink-faint)]"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {loading ? '·' : cards.length}
        </span>
      </div>

      {/* Cards */}
      <div className="flex flex-1 flex-col gap-1.5 px-2 pb-2">
        {loading ? (
          <ColumnSkeleton />
        ) : cards.length === 0 ? (
          <EmptyColumn
            isDraggingAnything={isDraggingAnything}
            isOver={isOver}
          />
        ) : (
          cards.map((p) => <Card key={p.id} project={p} onOpen={onOpen} />)
        )}
      </div>
    </div>
  );
}

// ─── Card ───────────────────────────────────────────────────────────────────

function Card({
  project,
  onOpen,
  isOverlay,
}: {
  project: ProjectWithOwner;
  onOpen: (id: string) => void;
  isOverlay?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: project.id });

  const tier = project.tier_name as keyof typeof TIER_LABEL | null | undefined;
  const updatedAt = project.updated_at || project.created_at;
  const client =
    project.client_business_name || project.client_name || 'Unassigned';

  return (
    <article
      ref={isOverlay ? undefined : setNodeRef}
      {...(!isOverlay ? attributes : {})}
      {...(!isOverlay ? listeners : {})}
      style={
        isOverlay
          ? {
              transform: 'rotate(1.5deg)',
              boxShadow:
                '0 14px 30px rgba(18,10,34,0.18), 0 4px 10px rgba(18,10,34,0.08)',
            }
          : {
              transform: CSS.Translate.toString(transform),
              opacity: isDragging ? 0 : 1,
            }
      }
      className={[
        'group cursor-grab touch-none select-none rounded-[8px] border bg-[var(--ls-bg)] px-3 py-2.5 transition-colors',
        'border-[var(--ls-rule)]',
        'hover:border-[var(--ls-ink-faint)] hover:bg-white dark:hover:bg-white/[0.04]',
        isOverlay ? 'cursor-grabbing' : '',
      ].join(' ')}
      onDoubleClick={() => onOpen(project.id)}
    >
      <h3 className="truncate text-[13px] font-medium leading-tight text-[var(--ls-ink)]">
        {project.name || 'Untitled'}
      </h3>
      <p className="mt-1 truncate text-[11.5px] text-[var(--ls-ink-dim)]">
        {client}
      </p>
      <div className="mt-2.5 flex items-center justify-between">
        {tier && TIER_LABEL[tier] ? (
          <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-[var(--ls-ink-faint)]">
            {TIER_LABEL[tier]}
          </span>
        ) : (
          <span className="font-mono text-[9.5px] text-[var(--ls-ink-faint)]">
            –
          </span>
        )}
        <span
          className="font-mono text-[11px] tabular-nums text-[var(--ls-ink-faint)]"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {updatedAt ? compactRelative(updatedAt) : '–'}
        </span>
      </div>
    </article>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function EmptyColumn({
  isDraggingAnything,
  isOver,
}: {
  isDraggingAnything: boolean;
  isOver: boolean;
}) {
  if (!isDraggingAnything) {
    // Idle: a quiet horizontal hairline so the column has visual presence
    // without screaming "EMPTY".
    return (
      <div className="flex flex-1 items-center justify-center px-2 py-6">
        <span className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-[var(--ls-ink-faint)]/60">
          –
        </span>
      </div>
    );
  }
  return (
    <div
      className={[
        'flex flex-1 items-center justify-center rounded-[8px] border-2 border-dashed py-6 text-center transition-colors',
        isOver
          ? 'border-[var(--ls-accent)] bg-[var(--ls-accent)]/[0.08]'
          : 'border-[var(--ls-rule)]',
      ].join(' ')}
    >
      <span className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-[var(--ls-ink-faint)]">
        Drop
      </span>
    </div>
  );
}

function ColumnSkeleton() {
  return (
    <>
      {[1, 2].map((i) => (
        <div
          key={i}
          className="h-[68px] animate-pulse rounded-[8px] border border-[var(--fs-rule)] bg-[var(--fs-glass-bg)]"
        />
      ))}
    </>
  );
}
