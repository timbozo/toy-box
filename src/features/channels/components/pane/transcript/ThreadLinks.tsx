import { CornerDownRight, MessageSquare } from "lucide-react";
import {
  channelThreadHasUnread,
  isChannelSystemMessage,
  type ChannelConversationMessage,
} from "@channels/model";
import { Button } from "@/shared/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { cn } from "@/shared/utils";
import { useChannelPane } from "../ChannelPaneContext";

export const GOAL_EMOJI = "🎯";

/** The first line of a message, short enough to name its thread. */
export function threadTitle(message: ChannelConversationMessage | undefined): string {
  const line = message?.content.split("\n").find((text) => text.trim() !== "") ?? "";
  const text = line.replace(/^#+\s*/, "").trim();
  return text.length > 60 ? `${text.slice(0, 59)}…` : text || "Thread";
}

/** Marks a goal root above its content. */
export function GoalTag({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-1.5 py-px text-2xs font-medium text-amber-700 dark:text-amber-400",
        className,
      )}
    >
      <span aria-hidden>{GOAL_EMOJI}</span>
      Goal
    </span>
  );
}

/** Under a top-level message: its thread's replies and whether any are new. Under a cross-posted
 *  reply: where it was replied. */
export function ThreadLinks({ message }: { message: ChannelConversationMessage }) {
  const { threads, openThread, inThread, message: find } = useChannelPane();
  if (inThread) {
    return message.alsoPostToChannel ? (
      <p className="mt-1 text-2xs text-muted-foreground">Also sent to channel</p>
    ) : null;
  }
  if (message.threadRootSequence !== undefined) {
    const root = find(message.threadRootSequence);
    const rootMessage = root && !isChannelSystemMessage(root) ? root : undefined;
    return (
      <button
        type="button"
        className="mt-1 inline-flex max-w-full items-center gap-1 text-2xs text-muted-foreground hover:text-foreground"
        onClick={() => openThread(message.threadRootSequence!)}
      >
        <CornerDownRight aria-hidden className="size-3 shrink-0" />
        <span className="shrink-0">Replied in</span>
        <span className="truncate font-medium">
          {rootMessage?.isGoalRoot && `${GOAL_EMOJI} `}
          {rootMessage ? threadTitle(rootMessage) : "a thread"}
        </span>
      </button>
    );
  }
  const thread = threads.find(({ rootSequence }) => rootSequence === message.sequence);
  if (!thread) return null;
  const unread = channelThreadHasUnread(thread);
  return (
    <button
      type="button"
      className="mt-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 -ml-1.5 text-xs hover:bg-muted"
      onClick={() => openThread(message.sequence)}
    >
      <MessageSquare aria-hidden className="size-3.5 text-muted-foreground" />
      <span className="font-medium text-foreground">
        {thread.replyCount} {thread.replyCount === 1 ? "reply" : "replies"}
      </span>
      {unread && <span className="text-2xs font-semibold text-unread">New</span>}
    </button>
  );
}

/** Starts or opens a top-level message's thread from its toolbar. */
export function ReplyInThreadButton({
  message,
  className,
}: {
  message: ChannelConversationMessage;
  className?: string;
}) {
  const { openThread, inThread } = useChannelPane();
  if (inThread || message.threadRootSequence !== undefined) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn("text-muted-foreground hover:text-foreground", className)}
            aria-label="Reply in thread"
            onClick={() => openThread(message.sequence)}
          >
            <MessageSquare aria-hidden />
          </Button>
        }
      />
      <TooltipContent sideOffset={4}>Reply in thread</TooltipContent>
    </Tooltip>
  );
}
