import { NextRequest, NextResponse } from "next/server";
import { LinearClient } from "@linear/sdk";

const linear = new LinearClient({ apiKey: process.env.LINEAR_API_KEY! });

// --- Cache ---

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

// --- Types ---

type NameId = { id: string; name: string };

type IssueData = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  createdAt: string;
  completedAt: string | null;
  canceledAt: string | null;
  estimate: number | null;
  stateType: string;
  stateName: string;
  assignee: string | null;
  project: string | null;
  priority: number;
  priorityLabel: string;
};

// --- Helpers ---

function cachedJsonResponse<T>(cacheKey: string, ttl: number, fetcher: () => Promise<T>) {
  const cached = getCached<T>(cacheKey);
  if (cached) return NextResponse.json(cached);
  return fetcher().then((data) => {
    setCache(cacheKey, data, ttl);
    return NextResponse.json(data);
  });
}

function mapIssueNode(node: Record<string, unknown>): IssueData {
  const state = node.state as { name: string; type: string } | null;
  const assignee = node.assignee as { name: string } | null;
  const project = node.project as { name: string } | null;
  return {
    id: node.id as string,
    identifier: node.identifier as string,
    title: node.title as string,
    url: node.url as string,
    createdAt: node.createdAt as string,
    completedAt: (node.completedAt as string) ?? null,
    canceledAt: (node.canceledAt as string) ?? null,
    estimate: (node.estimate as number) ?? null,
    stateType: state?.type ?? "unknown",
    stateName: state?.name ?? "Unknown",
    assignee: assignee?.name ?? null,
    project: project?.name ?? null,
    priority: node.priority as number,
    priorityLabel: node.priorityLabel as string,
  };
}

// --- Route handler ---

export async function GET(req: NextRequest) {
  const action = req.nextUrl.searchParams.get("action");

  if (action === "teams") {
    return cachedJsonResponse("teams", CACHE_TTL_META, async () => {
      const teams = await linear.teams({ first: 100 });
      return teams.nodes.map((t): NameId => ({ id: t.id, name: t.name }));
    });
  }

  if (action === "projects") {
    const teamId = req.nextUrl.searchParams.get("teamId");
    return cachedJsonResponse(`projects:${teamId}`, CACHE_TTL_META, async () => {
      const filter: Record<string, unknown> = {};
      if (teamId) filter.accessibleTeams = { some: { id: { eq: teamId } } };
      const projects = await linear.projects({
        first: 100,
        filter,
        orderBy: "updatedAt" as never,
      });
      return projects.nodes.map((p): NameId => ({ id: p.id, name: p.name }));
    });
  }

  if (action === "labels") {
    const teamId = req.nextUrl.searchParams.get("teamId");
    return cachedJsonResponse(`labels:${teamId}`, CACHE_TTL_META, async () => {
      const teamFilter: Record<string, unknown> = teamId
        ? { team: { id: { eq: teamId } } }
        : {};
      const [teamLabels, workspaceLabels] = await Promise.all([
        linear.issueLabels({ first: 100, filter: teamFilter }),
        linear.issueLabels({ first: 100, filter: { team: { null: true } } }),
      ]);
      const seen = new Set<string>();
      const data: NameId[] = [];
      for (const l of [...teamLabels.nodes, ...workspaceLabels.nodes]) {
        if (!seen.has(l.id)) {
          seen.add(l.id);
          data.push({ id: l.id, name: l.name });
        }
      }
      data.sort((a, b) => a.name.localeCompare(b.name));
      return data;
    });
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
    const cached = getCached<IssueData[]>(cacheKey);

    if (cached) {
      const line = JSON.stringify({ loaded: cached.length, hasMore: false, issues: cached }) + "\n";
      return new Response(line, {
        headers: { "Content-Type": "application/x-ndjson" },
      });
    }

    // Build GraphQL filter using variables to prevent injection
    const filterFields: string[] = [];
    const variables: Record<string, string> = {};
    if (projectId) {
      filterFields.push(`project: { id: { eq: $projectId } }`);
      variables.projectId = projectId;
    }
    if (labelId) {
      filterFields.push(`labels: { some: { id: { eq: $labelId } } }`);
      variables.labelId = labelId;
    }
    if (teamId) {
      filterFields.push(`team: { id: { eq: $teamId } }`);
      variables.teamId = teamId;
    }
    const filterStr = filterFields.length ? `filter: { ${filterFields.join(", ")} }` : "";
    const varDefs = Object.keys(variables).map((k) => `$${k}: ID!`).join(", ");
    const varDefsStr = varDefs ? `(${varDefs})` : "";

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
            const afterClause = cursor ? `after: $after` : "";
            const queryVars = { ...variables, ...(cursor ? { after: cursor } : {}) };
            const afterVarDef = cursor ? ", $after: String!" : "";

            const query = `query${varDefsStr.replace(")", `${afterVarDef})`)} {
              issues(first: 100 ${afterClause} ${filterStr}) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  id identifier title url
                  createdAt completedAt canceledAt
                  estimate priority priorityLabel
                  state { name type }
                  assignee { name }
                  project { name }
                }
              }
            }`;

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const result = await linear.client.rawRequest<any, Record<string, string>>(query, queryVars);
            const page = result.data.issues;

            hasMore = page.pageInfo.hasNextPage;
            cursor = page.pageInfo.endCursor ?? undefined;

            const issues: IssueData[] = page.nodes.map((node: Record<string, unknown>) => {
              const data = mapIssueNode(node);
              setCache(`issue:${data.id}`, data, CACHE_TTL_ISSUES);
              return data;
            });

            allIssues.push(...issues);
            loaded += issues.length;

            controller.enqueue(
              encoder.encode(JSON.stringify({ loaded, hasMore, issues }) + "\n")
            );
          }
          completed = true;
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Unknown error";
          controller.enqueue(
            encoder.encode(JSON.stringify({ error: msg }) + "\n")
          );
        } finally {
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
