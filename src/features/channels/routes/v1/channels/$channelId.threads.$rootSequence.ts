import { createFileRoute } from "@tanstack/react-router";
import { channelThreadIdentitySchema } from "@channels/model";
import { getChannelThread } from "@channels/server";
import { invalidRequest, NotFoundError, respond } from "@/shared/server/http";

/** A thread's root and every reply, which the main transcript's pages leave out. */
export const Route = createFileRoute("/api/v1/channels/$channelId/threads/$rootSequence")({
  server: {
    handlers: {
      GET: ({ params }) => {
        const input = channelThreadIdentitySchema.safeParse({
          channelId: params.channelId,
          rootSequence: Number(params.rootSequence),
        });
        if (!input.success) return invalidRequest();
        return respond("read Channel thread", async () => {
          const thread = await getChannelThread(input.data.channelId, input.data.rootSequence);
          if (!thread) throw new NotFoundError("Thread");
          return thread;
        });
      },
    },
  },
});
