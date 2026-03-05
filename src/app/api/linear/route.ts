import { NextRequest, NextResponse } from "next/server";
import { LinearClient } from "@linear/sdk";

const linear = new LinearClient({ apiKey: process.env.LINEAR_API_KEY! });

export async function GET(req: NextRequest) {
  const action = req.nextUrl.searchParams.get("action");

  if (action === "teams") {
    const teams = await linear.teams({ first: 100 });
    const data = teams.nodes.map((t) => ({ id: t.id, name: t.name }));
    return NextResponse.json(data);
  }

  if (action === "projects") {
    const teamId = req.nextUrl.searchParams.get("teamId");
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
    return NextResponse.json(data);
  }

  if (action === "labels") {
    const teamId = req.nextUrl.searchParams.get("teamId");

    // Fetch team-specific labels and workspace (global) labels separately
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

    const filter: Record<string, unknown> = {};
    if (projectId) filter.project = { id: { eq: projectId } };
    if (labelId) filter.labels = { some: { id: { eq: labelId } } };
    if (teamId) filter.team = { id: { eq: teamId } };

    const allIssues: Array<{
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
    }> = [];

    let hasMore = true;
    let cursor: string | undefined;

    while (hasMore) {
      const issues = await linear.issues({
        first: 100,
        after: cursor,
        filter,
      });

      for (const issue of issues.nodes) {
        const [state, assignee, project] = await Promise.all([
          issue.state,
          issue.assignee,
          issue.project,
        ]);
        allIssues.push({
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
        });
      }

      hasMore = issues.pageInfo.hasNextPage;
      cursor = issues.pageInfo.endCursor ?? undefined;
    }

    return NextResponse.json(allIssues);
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
