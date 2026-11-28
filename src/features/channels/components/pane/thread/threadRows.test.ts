import { expect, test } from "bun:test";
import { channelLead, type ChannelConversationMessage } from "@channels/model";
import { threadRows } from "./ChannelThreadPanel";

const lead = channelLead("channel");
const message = (sequence: number): ChannelConversationMessage => ({
  id: `m${sequence}`,
  sequence,
  sender: { type: "agent", agentId: lead.id },
  content: `Message ${sequence}`,
  timestamp: "2026-11-27T03:00:00.000Z",
});

test("a same-agent reply stays apart from the thread's root", () => {
  const rows = threadRows(
    message(1),
    [
      { ...message(2), threadRootSequence: 1 },
      { ...message(3), threadRootSequence: 1 },
    ],
    { lead, members: [], bookmarks: [] },
  );
  expect(rows.map((row) => (row.type === "agent" ? row.entries.length : 0))).toEqual([1, 2]);
});
