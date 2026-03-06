import { NextRequest, NextResponse } from "next/server";
import { LinearClient } from "@linear/sdk";

const linear = new LinearClient({ apiKey: process.env.LINEAR_API_KEY! });

const CACHE_TTL_ISSUES = 30 * 60 * 1000; // 30 minutes
const CACHE_TTL_META = 4 * 60 * 60 * 1000; // 4 hours (teams, projects, labels)
const cache = new Map<string, { data: unknown; ts: number; ttl: number }>();

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < entry.ttl) return entry.data as T;
  cache.delete(key);
  return null;
}

function setCache(key: string, data: unknown, ttl: number) {
  cache.set(key, { data, ts: Date.now(), ttl });
}

export async function GET(req: NextRequest) {
  const action = req.nextUrl.searchParams.get("action");

  if (action === "teams") {
    const cacheKey = "teams";
    const cached = getCached<{ id: string; name: string }[]>(cacheKey);
    if (cached) return NextResponse.json(cached);

    const teams = await linear.teams({ first: 100 });
    const data = teams.nodes.map((t) => ({ id: t.id, name: t.name }));
    setCache(cacheKey, data, CACHE_TTL_META);
    return NextResponse.json(data);
  }

  if (action === "projects") {
    const teamId = req.nextUrl.searchParams.get("teamId");
    const cacheKey = `projects:${teamId}`;
    const cached = getCached<{ id: string; name: string }[]>(cacheKey);
    if (cached) return NextResponse.json(cached);

    const filter: Record<string, unknown> = {};
    if (teamId) {
      filter.accessibleTeams = { some: { id: { eq: teamId } } };
    }
    const projects = await linear.projects({
      first: 100,
      filter,
      orderBy: "updatedAt" as never,
    });
    const data = projects.nodes.map((p) => ({ id: p.id, name: p.name }));
    setCache(cacheKey, data, CACHE_TTL_META);
    return NextResponse.json(data);
  }

  if (action === "labels") {
    const teamId = req.nextUrl.searchParams.get("teamId");
    const cacheKey = `labels:${teamId}`;
    const cached = getCached<{ id: string; name: string }[]>(cacheKey);
    if (cached) return NextResponse.json(cached);

    const teamFilter: Record<string, unknown> = teamId
      ? { team: { id: { eq: teamId } } }
      : {};
    const [teamLabels, workspaceLabels] = await Promise.all([
      linear.issueLabels({ first: 100, filter: teamFilter }),
      linear.issueLabels({ first: 100, filter: { team: { null: true } } }),
    ]);

    const seen = new Set<string>();
    const data: { id: string; name: string }[] = [];
    for (const l of [...teamLabels.nodes, ...workspaceLabels.nodes]) {
      if (!seen.has(l.id)) {
        seen.add(l.id);
        data.push({ id: l.id, name: l.name });
      }
    }
    data.sort((a, b) => a.name.localeCompare(b.name));
    setCache(cacheKey, data, CACHE_TTL_META);
    return NextResponse.json(data);
  }

  if (action === "issues") {
    const projectId = req.nextUrl.searchParams.get("projectId");
    const labelId = req.nextUrl.searchParams.get("labelId");
    const teamId = req.nextUrl.searchParams.get("teamId");

    if (!projectId && !labelId && !teamId) {
      return NextResponse.json(
        { error: "At least one filter is required" },
        { status: 400 }
      );
    }

    const cacheKey = `issues:${teamId}:${projectId}:${labelId}`;
    type IssueData = { id: string; identifier: string; title: string; url: string; createdAt: string; completedAt: string | null; canceledAt: string | null; estimate: number | null; stateType: string; stateName: string; assignee: string | null; project: string | null; priority: number; priorityLabel: string };
    const cached = getCached<IssueData[]>(cacheKey);

    if (cached) {
      // Serve cached data as a single NDJSON line
      const line = JSON.stringify({ loaded: cached.length, hasMore: false, issues: cached }) + "\n";
      return new Response(line, {
        headers: { "Content-Type": "application/x-ndjson" },
      });
    }

    const filter: Record<string, unknown> = {};
    if (projectId) filter.project = { id: { eq: projectId } };
    if (labelId) filter.labels = { some: { id: { eq: labelId } } };
    if (teamId) filter.team = { id: { eq: teamId } };

    const BATCH_SIZE = 20;
    const allIssues: IssueData[] = [];

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        let loaded = 0;
        let hasMore = true;
        let cursor: string | undefined;
        let completed = false;

        try {
          while (hasMore) {
            const page = await linear.issues({
              first: 100,
              after: cursor,
              filter,
            });

            hasMore = page.pageInfo.hasNextPage;
            cursor = page.pageInfo.endCursor ?? undefined;
            const nodes = page.nodes;

            for (let i = 0; i < nodes.length; i += BATCH_SIZE) {
              const slice = nodes.slice(i, i + BATCH_SIZE);
              const issues = await Promise.all(
                slice.map(async (issue) => {
                  const issueCacheKey = `issue:${issue.id}`;
                  const cachedIssue = getCached<IssueData>(issueCacheKey);
                  if (cachedIssue) return cachedIssue;

                  const [state, assignee, project] = await Promise.all([
                    issue.state,
                    issue.assignee,
                    issue.project,
                  ]);
                  const data: IssueData = {
                    id: issue.id,
                    identifier: issue.identifier,
                    title: issue.title,
                    url: issue.url,
                    createdAt: issue.createdAt.toISOString(),
                    completedAt: issue.completedAt?.toISOString() ?? null,
                    canceledAt: issue.canceledAt?.toISOString() ?? null,
                    estimate: issue.estimate ?? null,
                    stateType: state?.type ?? "unknown",
                    stateName: state?.name ?? "Unknown",
                    assignee: assignee?.name ?? null,
                    project: project?.name ?? null,
                    priority: issue.priority,
                    priorityLabel: issue.priorityLabel,
                  };
                  setCache(issueCacheKey, data, CACHE_TTL_ISSUES);
                  return data;
                })
              );

              allIssues.push(...issues);
              loaded += issues.length;
              const done = !hasMore && i + BATCH_SIZE >= nodes.length;

              controller.enqueue(
                encoder.encode(JSON.stringify({ loaded, hasMore: !done, issues }) + "\n")
              );
            }
          }
          completed = true;
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Unknown error";
          controller.enqueue(
            encoder.encode(JSON.stringify({ error: msg }) + "\n")
          );
        } finally {
          // Only cache the full list if we loaded everything successfully
          if (completed) {
            setCache(cacheKey, allIssues, CACHE_TTL_ISSUES);
          }
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: { "Content-Type": "application/x-ndjson" },
    });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
