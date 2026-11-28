import { ChevronRight, Clock3, FileText, UserRound } from "lucide-react";
import { AgentAvatar } from "@channels/components/agents/AgentAvatar";
import {
  channelAgentIdentity,
  channelTaskElapsedMinutes,
  channelTasksDiff,
  channelThreadHasUnread,
  type ChannelActor,
  type ChannelThread,
  type ChannelAgent,
  type ChannelArtifact,
  type ChannelTask,
} from "@channels/model";
import type { DiffStats } from "@/shared/diffStats";
import { useMinuteClock } from "@/shared/hooks/useMinuteClock";
import { Button } from "@/shared/ui/button";
import type { ChecklistItem } from "@/shared/ui/checklist";
import { PopoverClose } from "@/shared/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";

const DIFF_COUNT_FORMATTER = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function useChannelTaskItems(options: Parameters<typeof channelTaskItems>[0]) {
  return channelTaskItems(options, useMinuteClock(channelTasksStarted(options.tasks)));
}

export function useChannelTaskGroupItems(options: Parameters<typeof channelTaskGroupItems>[0]) {
  return channelTaskGroupItems(options, useMinuteClock(channelTasksStarted(options.tasks)));
}

/** Whether any task at any depth has started, so its elapsed time needs a clock. */
export function channelTasksStarted(tasks: readonly ChannelTask[]): boolean {
  return tasks.some((task) => Boolean(task.startedAt) || channelTasksStarted(task.children ?? []));
}

/** The Overview's one task tree, grouped: each goal's task first, linked to its thread, then the
 *  tasks no goal groups under General. */
export function channelTaskGroupItems(
  options: Parameters<typeof channelTaskItems>[0] & {
    threads: readonly ChannelThread[];
    onOpenThread: (rootSequence: number) => void;
  },
  now = Date.now(),
): ChecklistItem[] {
  const { tasks, threads, onOpenThread } = options;
  const items = channelTaskItems(options, now);
  const goals: ChecklistItem[] = [];
  const general: ChecklistItem[] = [];
  tasks.forEach((task, index) => {
    const item = items[index]!;
    const goalSequence = task.goalSequence;
    if (goalSequence === undefined) {
      general.push(item);
      return;
    }
    const thread = threads.find(({ rootSequence }) => rootSequence === goalSequence);
    goals.push({
      ...item,
      // Prefixed, so no task ID can collide with General among the groups.
      id: `goal:${item.id}`,
      title: `\u{1F3AF} ${item.title}`,
      detail: (
        <span className="inline-flex items-center gap-[9px]">
          {item.detail}
          <GoalThreadLink
            unread={thread ? channelThreadHasUnread(thread) : false}
            onOpen={() => onOpenThread(goalSequence)}
          />
        </span>
      ),
    });
  });
  if (general.length === 0) return goals;
  return [
    ...goals,
    { id: "general", title: "General", status: groupStatus(general), children: general },
  ];
}

/** A group's status follows every task beneath it: running while any runs, done once all are. */
function groupStatus(items: readonly ChecklistItem[]): ChecklistItem["status"] {
  const all = (items: readonly ChecklistItem[]): ChecklistItem[] =>
    items.flatMap((item) => [item, ...all(item.children ?? [])]);
  const statuses = all(items).map(({ status }) => status);
  if (statuses.includes("in_progress")) return "in_progress";
  if (statuses.every((status) => status === "done")) return "done";
  if (statuses.includes("blocked")) return "blocked";
  return "pending";
}

function GoalThreadLink({ unread, onOpen }: { unread: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground"
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
    >
      {unread && <span className="font-semibold text-unread">New</span>}
      Open thread
      <ChevronRight aria-hidden className="size-3" />
    </button>
  );
}

/** Both Channel checklists present the same task identities, owners, and linked outcomes. */
export function channelTaskItems(
  {
    tasks,
    owners,
    artifacts,
    onArtifactOpen,
    closeOnArtifactOpen = false,
  }: {
    tasks: readonly ChannelTask[];
    owners: readonly ChannelAgent[];
    artifacts: readonly ChannelArtifact[];
    onArtifactOpen: (artifact: ChannelArtifact) => void;
    closeOnArtifactOpen?: boolean;
  },
  now = Date.now(),
): ChecklistItem[] {
  return tasks.map((task) => {
    const elapsed = channelTaskElapsedMinutes(task, now);
    const remaining =
      task.status === "in_progress" && task.checkInAt
        ? Math.max(0, Math.ceil((Date.parse(task.checkInAt) - now) / 60_000))
        : undefined;
    const ageLabel =
      elapsed === undefined
        ? undefined
        : `${elapsed} ${elapsed === 1 ? "minute" : "minutes"} elapsed${remaining === undefined ? "" : `, check-in in ${remaining}m`}`;
    const diff = task.status === "pending" ? undefined : channelTasksDiff([task]);
    const artifact = task.artifactId
      ? artifacts.find(({ id }) => id === task.artifactId)
      : undefined;
    return {
      id: task.id,
      title: task.title,
      status: task.status,
      detail:
        diff || task.owner || task.artifactId || elapsed !== undefined ? (
          <span className="inline-flex items-center gap-[9px]">
            {elapsed !== undefined && (
              <time
                dateTime={task.startedAt}
                aria-label={ageLabel}
                title={ageLabel}
                suppressHydrationWarning
                className="inline-flex items-center gap-1 font-mono text-2xs tabular-nums italic text-muted-foreground"
              >
                <Clock3 aria-hidden className="size-3 shrink-0" />
                {elapsed}m{remaining === undefined ? "" : ` / ${remaining}m`}
              </time>
            )}
            {diff && <TaskDiff diff={diff} />}
            {task.artifactId && (
              <TaskArtifact
                artifact={artifact}
                onOpen={onArtifactOpen}
                closeOnOpen={closeOnArtifactOpen}
              />
            )}
            {task.owner && <TaskOwner owner={task.owner} owners={owners} />}
          </span>
        ) : undefined,
      children:
        task.children &&
        channelTaskItems(
          {
            tasks: task.children,
            owners,
            artifacts,
            onArtifactOpen,
            closeOnArtifactOpen,
          },
          now,
        ),
    };
  });
}

export function TaskDiff({ diff }: { diff: DiffStats }) {
  const label = `${diff.added} lines added, ${diff.removed} lines removed`;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="inline-flex gap-[5px] font-mono text-2xs tabular-nums in-data-[slot=checklist-popup]:text-[10.5px]"
    >
      <span aria-hidden className="text-diff-added">
        +{DIFF_COUNT_FORMATTER.format(diff.added)}
      </span>
      <span aria-hidden className="text-diff-removed">
        {`\u2212${DIFF_COUNT_FORMATTER.format(diff.removed)}`}
      </span>
    </span>
  );
}

function TaskArtifact({
  artifact,
  onOpen,
  closeOnOpen,
}: {
  artifact?: ChannelArtifact;
  onOpen: (artifact: ChannelArtifact) => void;
  closeOnOpen: boolean;
}) {
  const label = artifact ? `Open ${artifact.title}` : "Artifact unavailable";
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="-m-1 text-muted-foreground"
      aria-label={label}
      title={artifact?.title ?? label}
      disabled={!artifact}
      onClick={artifact ? () => onOpen(artifact) : undefined}
    >
      <FileText aria-hidden className="size-3.5" />
    </Button>
  );
  return closeOnOpen ? <PopoverClose render={button} /> : button;
}

/** A task's owner: an agent by its avatar, or the user as You. */
function TaskOwner({ owner, owners }: { owner: ChannelActor; owners: readonly ChannelAgent[] }) {
  const agent = owner.type === "agent" ? channelAgentIdentity(owners, owner.agentId) : undefined;
  const name = agent?.name ?? "You";
  return (
    <Tooltip>
      <TooltipTrigger render={<span role="img" aria-label={name} className="inline-flex" />}>
        {agent ? (
          <AgentAvatar agent={agent} className="size-4 in-data-[slot=checklist-popup]:size-3.5" />
        ) : (
          <UserRound className="size-4 text-muted-foreground in-data-[slot=checklist-popup]:size-3.5" />
        )}
      </TooltipTrigger>
      <TooltipContent sideOffset={4}>{name}</TooltipContent>
    </Tooltip>
  );
}
