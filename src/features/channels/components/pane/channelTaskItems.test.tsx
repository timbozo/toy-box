import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Checklist } from "@/shared/ui/checklist";
import { channelTaskGroupItems, channelTaskItems } from "./channelTaskItems";

test.each([
  ["2026-10-23T15:12:30.000Z", "12m / 8m"],
  ["2026-10-23T15:20:01.000Z", "20m / 0m"],
])("task age and check-in countdown use independent timestamps at %s", (now, expected) => {
  const items = channelTaskItems(
    {
      tasks: [
        {
          id: "work",
          title: "Work",
          status: "in_progress",
          startedAt: "2026-10-23T15:00:00.000Z",
          checkInAt: "2026-10-23T15:20:00.000Z",
        },
      ],
      owners: [],
      artifacts: [],
      onArtifactOpen: () => {},
    },
    Date.parse(now),
  );
  expect(renderToStaticMarkup(<Checklist items={items} />)).toContain(expected);
});

test.each([
  { added: 12_345, removed: 0, addedText: "+12.3K", removedText: "\u22120" },
  { added: 0, removed: 12_345, addedText: "+0", removedText: "\u221212.3K" },
])(
  "collapsed parents show compact totals and retain the zero side: %j",
  ({ added, removed, addedText, removedText }) => {
    const items = channelTaskItems({
      tasks: [
        {
          id: "t1",
          title: "Release",
          status: "done",
          children: [{ id: "t2", title: "Build", status: "done", diff: { added, removed } }],
        },
      ],
      owners: [],
      artifacts: [],
      onArtifactOpen: () => {},
    });
    const html = renderToStaticMarkup(<Checklist items={items} />);
    const label = `${added} lines added, ${removed} lines removed`;
    expect(html).toContain(`>${addedText}</span>`);
    expect(html).toContain(`>${removedText}</span>`);
    expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain(`title="${label}"`);
  },
);

test("pending tasks keep their titles without displaying reported diff counts", () => {
  const items = channelTaskItems({
    tasks: [
      { id: "t1", title: "Queued", status: "pending", diff: { added: 0, removed: 0 } },
      { id: "t2", title: "Next", status: "pending", diff: { added: 12, removed: 3 } },
    ],
    owners: [],
    artifacts: [],
    onArtifactOpen: () => {},
  });
  const html = renderToStaticMarkup(<Checklist items={items} />);
  expect(html).toContain("Queued");
  expect(html).toContain("Next");
  expect(html).not.toContain("lines added");
  expect(html).not.toContain("lines removed");
});

test("artifact icons belong to their task, not its parents, and omit visible titles", () => {
  const items = channelTaskItems({
    tasks: [
      {
        id: "t1",
        title: "Release",
        status: "done",
        children: [
          { id: "t2", title: "Plan", status: "done", artifactId: "machine:/project/brief.md" },
        ],
      },
      { id: "t3", title: "Review", status: "done", artifactId: "machine:/missing.md" },
    ],
    owners: [],
    artifacts: [
      {
        id: "machine:/project/brief.md",
        file: { kind: "machine", path: "/project/brief.md" },
        title: "Project brief",
        sharedAt: "2026-10-06T00:00:00Z",
      },
    ],
    onArtifactOpen: () => {},
  });
  const collapsed = renderToStaticMarkup(<Checklist items={items} />);
  expect(collapsed).not.toContain("Project brief");
  expect(collapsed).toContain('aria-label="Artifact unavailable"');
  expect(collapsed).toContain('disabled=""');
  const html = renderToStaticMarkup(<Checklist items={items[0]!.children!} />);
  expect(html).toContain('aria-label="Open Project brief"');
  expect(html).toContain('title="Project brief"');
  expect(html).not.toContain(">Project brief<");
});

const groupOptions = {
  owners: [],
  artifacts: [],
  onArtifactOpen: () => {},
  onOpenThread: () => {},
};

test("ungrouped tasks sit under General before any goal exists", () => {
  const items = channelTaskGroupItems({
    ...groupOptions,
    tasks: [{ id: "t1", title: "Review", status: "pending" }],
    threads: [],
  });
  expect(items.map(({ id }) => id)).toEqual(["general"]);
  expect(items[0]!.children?.map(({ id }) => id)).toEqual(["t1"]);
});

test("goal tasks lead and link their threads, with ungrouped tasks under General", () => {
  const items = channelTaskGroupItems({
    ...groupOptions,
    tasks: [
      { id: "t1", title: "Hourly review", status: "in_progress" },
      {
        id: "t2",
        title: "Threads",
        status: "in_progress",
        goalSequence: 7,
        children: [{ id: "t3", title: "Web panel", status: "pending" }],
      },
    ],
    threads: [{ rootSequence: 7, replyCount: 2, latestSequence: 9, seenThrough: 8 }],
  });
  expect(items.map(({ id, status }) => [id, status])).toEqual([
    ["goal:t2", "in_progress"],
    ["general", "in_progress"],
  ]);
  expect(items[0]!.title).toBe("\u{1F3AF} Threads");
  expect(items[1]!.children?.map(({ id }) => id)).toEqual(["t1"]);
  const markup = renderToStaticMarkup(<Checklist items={items} />);
  expect(markup).toContain("Open thread");
  expect(markup).toContain("New");
});

test.each([
  ["a done parent with unfinished work", "done", "pending", "pending"],
  ["a pending parent with running work", "pending", "in_progress", "in_progress"],
  ["fully done work", "done", "done", "done"],
] as const)("General's status reflects %s beneath it", (_case, parent, child, expected) => {
  const items = channelTaskGroupItems({
    ...groupOptions,
    tasks: [
      { id: "g", title: "Goal", status: "pending", goalSequence: 3 },
      {
        id: "t1",
        title: "Parent",
        status: parent,
        children: [{ id: "t2", title: "Child", status: child }],
      },
    ],
    threads: [],
  });
  expect(items.at(-1)).toMatchObject({ id: "general", status: expected });
});

test("a goal task named general never collides with the General group", () => {
  const items = channelTaskGroupItems({
    ...groupOptions,
    tasks: [
      { id: "general", title: "Goal", status: "pending", goalSequence: 3 },
      { id: "t1", title: "Loose", status: "pending" },
    ],
    threads: [],
  });
  const ids = items.map(({ id }) => id);
  expect(new Set(ids).size).toBe(ids.length);
});
