import { createStoredChannel } from "@channels/server/testFixtures";
import { describe, expect, onTestFinished, test } from "bun:test";
import type { ChannelConversationMessage, ChannelState } from "@channels/model";
import { reduceChannelState } from "@channels/model/reducer";
import { createTestDatabase } from "@/server/database";
import { RefusalError } from "@/shared/server/http";
import { ChannelDatabase } from "./database";

const CHANNEL_DEFAULTS = {
  purpose: "Ship threads.",
  model: { provider: "copilot", name: "gpt-5.5" },
} as const;

async function setup() {
  const database = await createTestDatabase();
  onTestFinished(() => database.close());
  const channels = new ChannelDatabase(database);
  const channel = await createStoredChannel(channels, { name: "Threads", ...CHANNEL_DEFAULTS });
  const lead = { type: "agent", agentId: channel.id } as const;
  const post = async (
    content: string,
    thread: { threadRootSequence?: number; alsoPostToChannel?: boolean } = {},
    sender: { type: "user" } | typeof lead = lead,
  ) => {
    const { events } = await channels.appendMessage({
      id: crypto.randomUUID(),
      channelId: channel.id,
      sender,
      content,
      ...thread,
    });
    return events[0]!.message as ChannelConversationMessage;
  };
  const snapshot = async () => {
    const value = await channels.getSnapshot(channel.id, 100);
    return value!;
  };
  return { channels, channel, post, snapshot };
}

describe("channel threads", () => {
  test("a reply names its root and stays out of the main transcript", async () => {
    const { post, snapshot } = await setup();
    const root = await post("Plan the release");
    const reply = await post("Draft is ready", { threadRootSequence: root.sequence });
    expect(reply.threadRootSequence).toBe(root.sequence);
    const state = await snapshot();
    expect(state.messages.map(({ sequence }) => sequence)).toEqual([root.sequence]);
    expect(state.threads).toEqual([
      {
        rootSequence: root.sequence,
        replyCount: 1,
        latestSequence: reply.sequence,
        seenThrough: root.sequence,
      },
    ]);
  });

  test("a cross-posted reply is one message in both its thread and the transcript", async () => {
    const { channels, channel, post, snapshot } = await setup();
    const root = await post("Plan the release");
    const reply = await post("Need your call", {
      threadRootSequence: root.sequence,
      alsoPostToChannel: true,
    });
    expect(reply.alsoPostToChannel).toBe(true);
    expect((await snapshot()).messages.map(({ id }) => id)).toEqual([root.id, reply.id]);
    const thread = await channels.getThread(channel.id, root.sequence);
    expect(thread?.replies.map(({ id }) => id)).toEqual([reply.id]);
    const page = await channels.getHistory(channel.id, reply.sequence + 1);
    expect(page?.messages.map(({ id }) => id)).toEqual([root.id, reply.id]);
  });

  test("thread history excludes thread-only replies from transcript pages", async () => {
    const { channels, channel, post } = await setup();
    const root = await post("Root");
    await post("Thread only", { threadRootSequence: root.sequence });
    const after = await post("Next topic");
    const page = await channels.getHistory(channel.id, after.sequence + 1);
    expect(page?.messages.map(({ content }) => content)).toEqual(["Root", "Next topic"]);
  });

  test("replies cannot nest, target system messages, or leave the channel", async () => {
    const { channels, channel, post } = await setup();
    const root = await post("Root");
    const reply = await post("Reply", { threadRootSequence: root.sequence });
    const other = await createStoredChannel(channels, { name: "Other", ...CHANNEL_DEFAULTS });
    const { events } = await channels.shareArtifact({
      channelId: channel.id,
      file: { kind: "machine", path: "/tmp/notes.md" },
      title: "Notes",
      actor: { type: "user" },
    });
    const system = events[0]!.message;
    for (const threadRootSequence of [reply.sequence, system.sequence, 999]) {
      await expect(post("Nope", { threadRootSequence })).rejects.toBeInstanceOf(RefusalError);
    }
    await expect(
      channels.appendMessage({
        id: crypto.randomUUID(),
        channelId: other.id,
        sender: { type: "user" },
        content: "Elsewhere",
        threadRootSequence: root.sequence,
      }),
    ).rejects.toBeInstanceOf(RefusalError);
  });

  test("a rejected reply allocates no sequence", async () => {
    const { channels, channel, post } = await setup();
    await post("Root");
    const before = (await channels.getChannel(channel.id))!.latestSequence;
    await expect(post("Nope", { threadRootSequence: 42 })).rejects.toThrow();
    expect((await channels.getChannel(channel.id))!.latestSequence).toBe(before);
  });
});

describe("goal roots", () => {
  test("a leading :goal: marks a top-level message and is not kept in its content", async () => {
    const { post, snapshot } = await setup();
    const goal = await post(":goal: Ship threads to every client");
    expect(goal).toMatchObject({ isGoalRoot: true, content: "Ship threads to every client" });
    expect((await snapshot()).messages[0]).toMatchObject({ isGoalRoot: true });
    const plain = await post("Not a :goal: in the middle");
    expect(plain.isGoalRoot).toBeUndefined();
  });

  test("a reply cannot be a goal, and a goal needs a description", async () => {
    const { post } = await setup();
    const root = await post("Root");
    await expect(post(":goal: Nested", { threadRootSequence: root.sequence })).rejects.toThrow(
      "Only a top-level message can be a goal.",
    );
    await expect(post(":goal:   ")).rejects.toBeInstanceOf(RefusalError);
  });
});

describe("thread read positions", () => {
  test("reading the channel never reads a thread, and a thread read is monotonic", async () => {
    const { channels, channel, post, snapshot } = await setup();
    const root = await post("Root");
    const first = await post("One", { threadRootSequence: root.sequence });
    const second = await post("Two", { threadRootSequence: root.sequence });
    await channels.markUserSeen(channel.id, second.sequence);
    expect((await snapshot()).threads[0]!.seenThrough).toBe(root.sequence);

    const read = await channels.markThreadSeen(channel.id, root.sequence, first.sequence);
    expect(read?.thread.seenThrough).toBe(first.sequence);
    expect(read?.change?.events).toEqual([
      expect.objectContaining({
        type: "thread_read",
        rootSequence: root.sequence,
        seenThrough: first.sequence,
      }),
    ]);
    expect((await channels.markThreadSeen(channel.id, root.sequence, root.sequence))?.change).toBe(
      undefined,
    );
    const clamped = await channels.markThreadSeen(channel.id, root.sequence, 10_000);
    expect(clamped?.thread.seenThrough).toBe(second.sequence);
    expect((await snapshot()).threads[0]!.seenThrough).toBe(second.sequence);
  });

  test("the user's own reply reads its thread, and an agent's does not", async () => {
    const { post, snapshot } = await setup();
    const root = await post("Root");
    const mine = await post("Mine", { threadRootSequence: root.sequence }, { type: "user" });
    expect((await snapshot()).threads[0]!.seenThrough).toBe(mine.sequence);
    await post("Theirs", { threadRootSequence: root.sequence });
    expect((await snapshot()).threads[0]!.seenThrough).toBe(mine.sequence);
  });

  test("reading a thread that isn't one returns null", async () => {
    const { channels, channel } = await setup();
    expect(await channels.markThreadSeen(channel.id, 5, 5)).toBeNull();
    expect(await channels.getThread(channel.id, 5)).toBeNull();
  });

  test("the shared reducer derives the same threads the database persists", async () => {
    const { channels, channel, post, snapshot } = await setup();
    const initial: ChannelState = { ...(await snapshot()), threads: [] };
    const root = await post("Root");
    const events = [
      (
        await channels.appendMessage({
          id: crypto.randomUUID(),
          channelId: channel.id,
          sender: { type: "agent", agentId: channel.id },
          content: "Agent reply",
          threadRootSequence: root.sequence,
        })
      ).events,
      (
        await channels.appendMessage({
          id: crypto.randomUUID(),
          channelId: channel.id,
          sender: { type: "user" },
          content: "User reply",
          threadRootSequence: root.sequence,
        })
      ).events,
    ].flat();
    const rootEvent = {
      type: "message" as const,
      message: root,
      revision: initial.revision + 1,
    };
    const reduced = [rootEvent, ...events].reduce(reduceChannelState, initial);
    const stored = await snapshot();
    expect(reduced.threads).toEqual(stored.threads);
    expect(reduced.messages.map(({ id }) => id)).toEqual(stored.messages.map(({ id }) => id));
  });
});

describe("goal task groups", () => {
  async function withGoal() {
    const context = await setup();
    const goal = await context.post(":goal: Ship threads");
    const plain = await context.post("Just chat");
    return { ...context, goal, plain };
  }

  test("a top-level task groups a goal, its children are the goal's tasks", async () => {
    const { channels, channel, goal } = await withGoal();
    await channels.editTasks(channel.id, {
      operations: [
        {
          type: "add",
          task: {
            id: "g1",
            title: "Ship threads",
            status: "in_progress",
            goalSequence: goal.sequence,
            children: [{ id: "t1", title: "Protocol", status: "pending" }],
          },
        },
        { type: "add", task: { id: "t2", title: "Legacy", status: "pending" } },
      ],
    });
    const { tasks } = (await channels.getChannel(channel.id))!;
    expect(tasks.map(({ id, goalSequence }) => [id, goalSequence])).toEqual([
      ["g1", goal.sequence],
      ["t2", undefined],
    ]);
  });

  test("goal links must be top-level, unique, and name a goal root", async () => {
    const { channels, channel, goal, plain } = await withGoal();
    const add = (task: object, parentId?: string) =>
      channels.editTasks(channel.id, {
        operations: [{ type: "add", ...(parentId ? { parentId } : {}), task } as never],
      });
    await expect(
      add({ id: "x", title: "X", status: "pending", goalSequence: plain.sequence }),
    ).rejects.toThrow(":goal:");
    await add({ id: "g1", title: "G", status: "pending", goalSequence: goal.sequence });
    await expect(
      add({ id: "g2", title: "G2", status: "pending", goalSequence: goal.sequence }),
    ).rejects.toThrow("already has a task group");
    await expect(
      add({ id: "c", title: "C", status: "pending", goalSequence: goal.sequence }, "g1"),
    ).rejects.toThrow("Only a top-level task");
    await expect(
      channels.editTasks(channel.id, {
        operations: [
          { type: "add", task: { id: "p", title: "P", status: "pending" } },
          { type: "move", taskId: "g1", parentId: "p" },
        ],
      }),
    ).rejects.toThrow("Only a top-level task");
  });

  test("goal groups keep whole-list completion attention", async () => {
    const { channels, channel, goal } = await withGoal();
    const { events } = await channels.editTasks(channel.id, {
      operations: [
        {
          type: "add",
          task: {
            id: "g1",
            title: "Ship threads",
            status: "done",
            goalSequence: goal.sequence,
            children: [{ id: "t1", title: "Protocol", status: "done" }],
          },
        },
      ],
    });
    expect(events.some((event) => event.type === "message")).toBe(true);
    await channels.editTasks(channel.id, {
      operations: [{ type: "update", taskId: "g1", patch: { goalSequence: null } }],
    });
    expect((await channels.getChannel(channel.id))!.tasks[0]!.goalSequence).toBeUndefined();
  });
});
