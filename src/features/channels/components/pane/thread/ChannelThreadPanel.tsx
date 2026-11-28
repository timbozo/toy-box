import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { AgentCompletionMenu } from "@channels/components/agents/AgentCompletionMenu";
import { agentCompletionSource } from "@channels/components/agents/agentCompletionSource";
import {
  channelGoalTask,
  isChannelSystemMessage,
  type ChannelConversationMessage,
  type ChannelState,
  type PostChannelMessageInput,
} from "@channels/model";
import { channelMutations } from "@channels/mutations";
import { channelQueries } from "@channels/queries";
import { useRevealFile } from "@files/useRevealFile";
import { useSavedDraft } from "@workspace/hooks/useSavedDraft";
import { Composer, ComposerSendButton } from "@/shared/composers/Composer";
import { useComposerDraft } from "@/shared/composers/useComposerDraft";
import { TranscriptSkeleton } from "@/shared/messages/TranscriptSkeleton";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import { Checklist } from "@/shared/ui/checklist";
import { ScrollableFade } from "@/shared/ui/scrollable-fade";
import { CollapsibleSection } from "@/shared/ui/section-heading";
import { ChannelPaneProvider, useChannelPane } from "../ChannelPaneContext";
import { useChannelTaskItems } from "../channelTaskItems";
import { TranscriptRowContent } from "../transcript/ChannelTranscript";
import { GoalTag } from "../transcript/ThreadLinks";
import { transcriptRows } from "../transcript/transcriptRows";

type ThreadPost = Pick<
  PostChannelMessageInput,
  "content" | "attachments" | "threadRootSequence" | "alsoPostToChannel"
>;

/** One thread beside the transcript: its root, a goal's slice of the task tree, its replies, and
 *  a composer that replies there. Reading it reads the thread, never the Channel. */
export function ChannelThreadPanel({
  state,
  rootSequence,
  isVisible,
  onClose,
  onPost,
}: {
  state: ChannelState;
  rootSequence: number;
  isVisible: boolean;
  onClose: () => void;
  onPost: (message: ThreadPost) => Promise<unknown>;
}) {
  const pane = useChannelPane();
  const channelId = state.channel.id;
  const summary = state.threads.find((thread) => thread.rootSequence === rootSequence);
  const { data, refetch, isError } = useQuery(channelQueries.thread(channelId, rootSequence));
  const latestSequence = summary?.latestSequence;
  // Each new reply advances the summary, so the thread refetches to include it.
  useEffect(() => {
    if (latestSequence !== undefined) void refetch();
  }, [latestSequence, refetch]);

  const { mutate: markRead } = useMutation(channelMutations.markThreadRead());
  const loadedThrough = data?.replies.at(-1)?.sequence;
  const seenThrough = summary?.seenThrough;
  useEffect(() => {
    if (!isVisible || loadedThrough === undefined || seenThrough === undefined) return;
    if (seenThrough >= loadedThrough) return;
    markRead({ channelId, rootSequence, sequence: loadedThrough });
  }, [channelId, isVisible, loadedThrough, markRead, rootSequence, seenThrough]);

  const root =
    data?.root ??
    (() => {
      const message = pane.message(rootSequence);
      return message && !isChannelSystemMessage(message) ? message : undefined;
    })();
  const rows = threadRows(root, data?.replies ?? [], {
    ...pane,
    requestSequence: state.channel.requestSequence,
  });
  const goalTask = root?.isGoalRoot
    ? channelGoalTask(state.channel.tasks, rootSequence)
    : undefined;

  return (
    <ChannelPaneProvider value={{ ...pane, inThread: true }}>
      <div className="flex h-full min-h-0 flex-col border-l bg-background">
        <div className="flex items-center gap-2 border-b px-3 py-3">
          <h2 className="font-semibold text-foreground">Thread</h2>
          {root?.isGoalRoot && <GoalTag />}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label="Close thread"
            title="Close thread"
            onClick={onClose}
          >
            <X />
          </Button>
        </div>
        <ScrollableFade axis="vertical" rootClassName="min-h-0 flex-1 bg-panel">
          <div className="@container space-y-5 px-4 py-4">
            {rows.length === 0 ? (
              isError ? (
                <p className="text-sm text-muted-foreground">This thread couldn't be loaded.</p>
              ) : (
                <TranscriptSkeleton />
              )
            ) : (
              <>
                <TranscriptRowContent row={rows[0]!} />
                {goalTask && <GoalTasks state={state} task={goalTask} />}
                {rows.length > 1 && (
                  <div className="flex items-center gap-2">
                    <span className="text-2xs text-muted-foreground">
                      {summary?.replyCount ?? rows.length - 1}{" "}
                      {summary?.replyCount === 1 ? "reply" : "replies"}
                    </span>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                )}
                {rows.slice(1).map((row) => (
                  <TranscriptRowContent key={row.key} row={row} />
                ))}
              </>
            )}
          </div>
        </ScrollableFade>
        <div className="shrink-0 border-t bg-background px-3 pt-3 md:pb-3">
          <ThreadComposer channelId={channelId} rootSequence={rootSequence} onPost={onPost} />
        </div>
      </div>
    </ChannelPaneProvider>
  );
}

/** The root's row, then the replies' rows, formed apart so a same-agent reply never joins the
 *  root's run. */
export function threadRows(
  root: ChannelConversationMessage | undefined,
  replies: readonly ChannelConversationMessage[],
  context: Pick<
    Parameters<typeof transcriptRows>[1],
    "lead" | "members" | "bookmarks" | "requestSequence"
  >,
) {
  if (!root) return [];
  return [...transcriptRows([root], context), ...transcriptRows(replies, context)];
}

/** A goal's tasks: the subtasks of the top-level task that groups its thread. */
function GoalTasks({
  state,
  task,
}: {
  state: ChannelState;
  task: NonNullable<ReturnType<typeof channelGoalTask>>;
}) {
  const { agents } = useChannelPane();
  const revealFile = useRevealFile();
  const tasks = task.children ?? [];
  const items = useChannelTaskItems({
    tasks,
    owners: agents,
    artifacts: state.artifacts,
    onArtifactOpen: ({ file }) => revealFile(file),
  });
  const done = tasks.filter(({ status }) => status === "done").length;
  return (
    <div className="rounded-lg border bg-background p-3">
      <CollapsibleSection title="Tasks" badge={`${done}/${tasks.length}`}>
        <Checklist items={items} className="text-sm" emptyMessage="No tasks yet." />
      </CollapsibleSection>
    </div>
  );
}

function ThreadComposer({
  channelId,
  rootSequence,
  onPost,
}: {
  channelId: string;
  rootSequence: number;
  onPost: (message: ThreadPost) => Promise<unknown>;
}) {
  const { lead, members } = useChannelPane();
  const [alsoPostToChannel, setAlsoPostToChannel] = useState(false);
  const createMember = useMutation(channelMutations.createMember());
  const draft = useComposerDraft({
    ...useSavedDraft(`channel:${channelId}:thread:${rootSequence}`),
    onSend: async (message) => {
      await onPost({
        ...message,
        threadRootSequence: rootSequence,
        ...(alsoPostToChannel ? { alsoPostToChannel: true } : {}),
      });
      setAlsoPostToChannel(false);
    },
  });
  return (
    <Composer
      draft={draft}
      completions={{
        sources: [
          agentCompletionSource({
            lead,
            members,
            createMember: (name) => createMember.mutateAsync({ channelId, name }),
          }),
        ],
        menu: (completions) => <AgentCompletionMenu completions={completions} />,
      }}
      controls={
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Checkbox
            checked={alsoPostToChannel}
            onCheckedChange={(checked) => setAlsoPostToChannel(checked === true)}
          />
          Also send to channel
        </label>
      }
      actions={<ComposerSendButton draft={draft} label="Send reply" />}
      label="Thread reply"
      placeholder="Reply…"
    />
  );
}
