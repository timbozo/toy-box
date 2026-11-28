import { createFileRoute } from "@tanstack/react-router";
import { markChannelThreadReadInputSchema } from "@channels/model";
import { markChannelThreadRead } from "@channels/server";
import { invalidRequest, NotFoundError, readInput, respond } from "@/shared/server/http";

/** Accepts `{ sequence }`, like the Channel's read, and returns the thread's `{ seenThrough }`. */
export const Route = createFileRoute("/api/v1/channels/$channelId/threads/$rootSequence/read")({
  server: {
    handlers: {
      POST: ({ params, request }) =>
        respond("mark Channel thread read", async () => {
          const schema = markChannelThreadReadInputSchema.omit({ rootSequence: true });
          const { channelId, sequence } = await readInput(request, schema, {
            channelId: params.channelId,
          });
          const rootSequence = Number(params.rootSequence);
          if (!Number.isSafeInteger(rootSequence) || rootSequence <= 0) throw invalidRequest();
          const thread = await markChannelThreadRead(channelId, rootSequence, sequence);
          if (!thread) throw new NotFoundError("Thread");
          return { seenThrough: thread.seenThrough };
        }),
    },
  },
});
