"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import {
  BarChart,
  Bar,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

type Option = { id: string; name: string };

type Issue = {
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

type ViewMode = "created" | "active" | "burndown" | "closed" | "cfd";
type ColorMode = "none" | "project" | "assignee" | "status" | "priority";

const COLORS = [
  "#60A5FA", "#F87171", "#34D399", "#FBBF24", "#A78BFA",
  "#F472B6", "#38BDF8", "#FB923C", "#4ADE80", "#E879F9",
  "#2DD4BF", "#FCA5A1", "#818CF8", "#FDE047", "#67E8F9",
];

function getColorKey(issue: Issue, colorBy: ColorMode): string {
  if (colorBy === "project") return issue.project ?? "No Project";
  if (colorBy === "assignee") return issue.assignee ?? "Unassigned";
  if (colorBy === "status") return issue.stateName;
  if (colorBy === "priority") return issue.priorityLabel;
  return "Issues";
}

const CFD_STATUS_ORDER = ["Completed", "Started", "Unstarted", "Backlog", "Canceled"] as const;
const CFD_COLORS: Record<string, string> = {
  Completed: "#34D399",
  Started: "#60A5FA",
  Unstarted: "#FBBF24",
  Backlog: "#9CA3AF",
  Canceled: "#6B7280",
};

function getDateRange(issues: Issue[], startDate: string, endDate: string) {
  const createdDates = issues.map((i) => i.createdAt.split("T")[0]);
  const doneDates = issues
    .filter((i) => i.completedAt || i.canceledAt)
    .map((i) => (i.completedAt ?? i.canceledAt)!.split("T")[0]);
  const today = new Date().toISOString().split("T")[0];

  const minDate = startDate || createdDates.sort()[0];
  const maxDate = endDate || [...createdDates, ...doneDates, today].sort().pop()!;

  const days: string[] = [];
  const cur = new Date(minDate + "T00:00:00");
  const end = new Date(maxDate + "T00:00:00");
  while (cur <= end) {
    days.push(cur.toISOString().split("T")[0]);
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

function buildCfdData(
  issues: Issue[],
  startDate: string,
  endDate: string,
): { data: Record<string, string | number>[]; keys: string[] } {
  if (issues.length === 0) return { data: [], keys: [] };

  const useEst = issues.some((i) => i.estimate != null && i.estimate > 0);
  const w = (i: Issue) => (useEst ? (i.estimate ?? 1) : 1);
  const days = getDateRange(issues, startDate, endDate);

  const statusMap: Record<string, string> = {
    completed: "Completed",
    started: "Started",
    unstarted: "Unstarted",
    backlog: "Backlog",
    canceled: "Canceled",
  };

  const data: Record<string, string | number>[] = [];
  const keys = CFD_STATUS_ORDER.filter((s) =>
    issues.some((i) => statusMap[i.stateType] === s)
  );

  for (const day of days) {
    const point: Record<string, string | number> = { date: day };
    keys.forEach((key) => (point[key] = 0));

    for (const issue of issues) {
      const created = issue.createdAt.split("T")[0];
      if (created > day) continue;
      const doneDate = (issue.completedAt ?? issue.canceledAt)?.split("T")[0];

      let status: string;
      if (doneDate && doneDate <= day) {
        status = issue.canceledAt && (!issue.completedAt || issue.canceledAt <= issue.completedAt)
          ? "Canceled" : "Completed";
      } else {
        status = statusMap[issue.stateType] ?? "Unstarted";
        // If issue is currently completed/canceled but wasn't done yet on this day, it was active
        if (status === "Completed" || status === "Canceled") {
          status = "Started";
        }
      }

      if (keys.includes(status as typeof keys[number])) {
        point[status] = (point[status] as number) + w(issue);
      }
    }

    data.push(point);
  }

  return { data, keys: [...keys] };
}

function buildChartData(
  issues: Issue[],
  view: ViewMode,
  colorBy: ColorMode,
  startDate: string,
  endDate: string,
): { data: Record<string, string | number>[]; keys: string[] } {
  if (issues.length === 0) return { data: [], keys: [] };

  const useEst = issues.some((i) => i.estimate != null && i.estimate > 0);
  const w = (i: Issue) => (useEst ? (i.estimate ?? 1) : 1);
  const k = (i: Issue) => getColorKey(i, colorBy);

  const days = getDateRange(issues, startDate, endDate);

  const allKeys = new Set<string>();
  issues.forEach((i) => allKeys.add(k(i)));
  const keys = [...allKeys].sort();

  const data: Record<string, string | number>[] = [];

  for (const day of days) {
    const point: Record<string, string | number> = { date: day };
    keys.forEach((key) => (point[key] = 0));

    if (view === "created") {
      for (const issue of issues) {
        if (issue.createdAt.split("T")[0] === day) {
          point[k(issue)] = (point[k(issue)] as number) + w(issue);
        }
      }
    } else if (view === "closed") {
      for (const issue of issues) {
        const doneDate = (issue.completedAt ?? issue.canceledAt)?.split("T")[0];
        if (doneDate === day) {
          point[k(issue)] = (point[k(issue)] as number) + w(issue);
        }
      }
    } else if (view === "active") {
      for (const issue of issues) {
        const created = issue.createdAt.split("T")[0];
        const doneDate = (issue.completedAt ?? issue.canceledAt)?.split("T")[0];
        if (created <= day && (!doneDate || doneDate > day)) {
          point[k(issue)] = (point[k(issue)] as number) + w(issue);
        }
      }
    } else {
      // Burndown
      const totalScope = issues.reduce((s, i) => s + w(i), 0);
      if (colorBy === "none") {
        let completed = 0;
        for (const issue of issues) {
          const doneDate = (issue.completedAt ?? issue.canceledAt)?.split("T")[0];
          if (doneDate && doneDate <= day) {
            completed += w(issue);
          }
        }
        point["Issues"] = totalScope - completed;
      } else {
        const groupTotals: Record<string, number> = {};
        const groupCompleted: Record<string, number> = {};
        keys.forEach((key) => {
          groupTotals[key] = 0;
          groupCompleted[key] = 0;
        });
        for (const issue of issues) {
          const g = k(issue);
          groupTotals[g] += w(issue);
          const doneDate = (issue.completedAt ?? issue.canceledAt)?.split("T")[0];
          if (doneDate && doneDate <= day) {
            groupCompleted[g] += w(issue);
          }
        }
        keys.forEach((key) => {
          point[key] = groupTotals[key] - groupCompleted[key];
        });
      }
    }

    data.push(point);
  }

  return { data, keys };
}

const VIEW_LABELS: Record<ViewMode, string> = {
  created: "Created",
  active: "Active",
  burndown: "Burndown",
  closed: "Closed",
  cfd: "CFD",
};

const COLOR_LABELS: Record<ColorMode, string> = {
  none: "None",
  project: "Project",
  assignee: "Assignee",
  status: "Status",
  priority: "Priority",
};

export default function Home() {
  const [teams, setTeams] = useState<Option[]>([]);
  const [projects, setProjects] = useState<Option[]>([]);
  const [labels, setLabels] = useState<Option[]>([]);

  const [selectedTeam, setSelectedTeam] = useState("");
  const [selectedProject, setSelectedProject] = useState("");
  const [selectedLabel, setSelectedLabel] = useState("");

  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadProgress, setLoadProgress] = useState({ loaded: 0, done: false });
  const [error, setError] = useState("");

  const [viewMode, setViewMode] = useState<ViewMode>("burndown");
  const [colorMode, setColorMode] = useState<ColorMode>("none");
  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return d.toISOString().split("T")[0];
  });
  const [endDate, setEndDate] = useState("");
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [hideBacklog, setHideBacklog] = useState(true);
  const [sortCol, setSortCol] = useState<keyof Issue>("priority");
  const [sortAsc, setSortAsc] = useState(true);
  const [showActiveOnly, setShowActiveOnly] = useState(false);
  const [searchText, setSearchText] = useState("");

  const streamIssues = useCallback(async (params: URLSearchParams) => {
    setError("");
    setLoading(true);
    setLoadProgress({ loaded: 0, done: false });
    setIssues([]);

    try {
      const res = await fetch(`/api/linear?${params}`);
      if (!res.ok) {
        const text = await res.text();
        try {
          const data = JSON.parse(text);
          throw new Error(data.error);
        } catch {
          throw new Error(`Server error (${res.status})`);
        }
      }
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const accumulated: Issue[] = [];

      let streamDone = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop()!;
        for (const line of lines) {
          if (!line) continue;
          const chunk = JSON.parse(line);
          if (chunk.error) throw new Error(chunk.error);
          accumulated.push(...chunk.issues);
          setIssues([...accumulated]);
          streamDone = !chunk.hasMore;
          setLoadProgress({ loaded: accumulated.length, done: streamDone });
        }
      }
      if (!streamDone && accumulated.length > 0) {
        setError("Stream ended unexpectedly — showing partial results");
        setLoadProgress({ loaded: accumulated.length, done: true });
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to fetch issues");
    } finally {
      setLoading(false);
    }
  }, []);

  const initialLoadDone = useRef(false);

  useEffect(() => {
    fetch("/api/linear?action=teams")
      .then((r) => {
        if (!r.ok) throw new Error(`Teams fetch failed (${r.status})`);
        return r.json();
      })
      .then((data: Option[]) => {
        setTeams(data);
        const pe = data.find((t) => t.name === "Product Engineering");
        if (pe) setSelectedTeam(pe.id);
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    setSelectedProject("");
    setSelectedLabel("");
    if (!selectedTeam) {
      setProjects([]);
      setLabels([]);
      return;
    }
    Promise.all([
      fetch(`/api/linear?action=projects&teamId=${selectedTeam}`).then((r) => {
        if (!r.ok) throw new Error(`Projects fetch failed (${r.status})`);
        return r.json();
      }),
      fetch(`/api/linear?action=labels&teamId=${selectedTeam}`).then((r) => {
        if (!r.ok) throw new Error(`Labels fetch failed (${r.status})`);
        return r.json();
      }),
    ]).then(([p, l]: [Option[], Option[]]) => {
      setProjects(p);
      setLabels(l);
      if (!initialLoadDone.current) {
        initialLoadDone.current = true;
        const ga = l.find((lb) => lb.name === "GA");
        if (ga) setSelectedLabel(ga.id);
        const params = new URLSearchParams({ action: "issues", teamId: selectedTeam });
        if (ga) params.set("labelId", ga.id);
        streamIssues(params);
      }
    }).catch((e) => setError(e.message));
  }, [selectedTeam]);

  const fetchIssues = useCallback(async () => {
    if (!selectedTeam) {
      setError("Select a team");
      return;
    }
    const params = new URLSearchParams({ action: "issues", teamId: selectedTeam });
    if (selectedProject) params.set("projectId", selectedProject);
    if (selectedLabel) params.set("labelId", selectedLabel);
    streamIssues(params);
  }, [selectedTeam, selectedProject, selectedLabel, streamIssues]);

  const displayIssues = useMemo(
    () => (hideBacklog ? issues.filter((i) => i.stateType !== "backlog") : issues),
    [issues, hideBacklog],
  );

  const chartData = useMemo(
    () => viewMode === "cfd"
      ? buildCfdData(displayIssues, startDate, endDate)
      : buildChartData(displayIssues, viewMode, colorMode, startDate, endDate),
    [displayIssues, viewMode, colorMode, startDate, endDate],
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleChartClick = (state: any) => {
    if (state?.activeLabel) {
      setSelectedDay((prev) =>
        prev === state.activeLabel ? null : state.activeLabel,
      );
    }
  };

  const filteredIssues = useMemo(() => {
    if (!selectedDay) return displayIssues;
    return displayIssues.filter((issue) => {
      const created = issue.createdAt.split("T")[0];
      const doneDate = (issue.completedAt ?? issue.canceledAt)?.split("T")[0];
      if (viewMode === "created") {
        return created === selectedDay;
      } else if (viewMode === "closed") {
        return doneDate === selectedDay;
      } else if (viewMode === "active") {
        return created <= selectedDay && (!doneDate || doneDate > selectedDay);
      } else {
        // burndown: not yet completed as of that day
        return !doneDate || doneDate > selectedDay;
      }
    });
  }, [displayIssues, selectedDay, viewMode]);

  const tableFilteredIssues = useMemo(() => {
    let result = filteredIssues;
    if (showActiveOnly) {
      result = result.filter(
        (i) => i.stateType !== "completed" && i.stateType !== "canceled",
      );
    }
    if (searchText) {
      const terms = searchText.toLowerCase().split(/\s+/).filter(Boolean);
      result = result.filter((issue) => {
        const haystack = `${issue.identifier} ${issue.title}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
      });
    }
    return result;
  }, [filteredIssues, showActiveOnly, searchText]);

  const sortedIssues = useMemo(() => {
    const STATE_ORDER: Record<string, number> = {
      backlog: 0, unstarted: 1, started: 2, completed: 3, canceled: 4,
    };
    return [...tableFilteredIssues].sort((a, b) => {
      let av: string | number, bv: string | number;
      if (sortCol === "priority") {
        // Move "No priority" (0) to the end, otherwise sort by numeric value
        av = a.priority === 0 ? 999 : a.priority;
        bv = b.priority === 0 ? 999 : b.priority;
      } else if (sortCol === "stateName") {
        av = STATE_ORDER[a.stateType] ?? 99;
        bv = STATE_ORDER[b.stateType] ?? 99;
      } else {
        av = a[sortCol] ?? "";
        bv = b[sortCol] ?? "";
      }
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortAsc ? cmp : -cmp;
    });
  }, [tableFilteredIssues, sortCol, sortAsc]);

  const handleSort = (col: keyof Issue) => {
    if (sortCol === col) {
      setSortAsc((a) => !a);
    } else {
      setSortCol(col);
      setSortAsc(true);
    }
  };

  const totalScope = displayIssues.length;
  const completedCount = displayIssues.filter(
    (i) => i.stateType === "completed" || i.stateType === "canceled",
  ).length;
  const pctDone =
    totalScope > 0 ? Math.round((completedCount / totalScope) * 100) : 0;

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 p-4 sm:p-8">
      <h1 className="text-2xl sm:text-3xl font-bold mb-6 sm:mb-8">Linear Burn Rate</h1>

      <div className="flex flex-wrap gap-4 mb-4">
        <Select
          label="Team"
          options={teams}
          value={selectedTeam}
          onChange={setSelectedTeam}
          placeholder="Select team..."
        />
        {selectedTeam && (
          <>
            <Select
              label="Project"
              options={projects}
              value={selectedProject}
              onChange={setSelectedProject}
            />
            <Select
              label="Label"
              options={labels}
              value={selectedLabel}
              onChange={setSelectedLabel}
            />
          </>
        )}
        <button
          onClick={fetchIssues}
          disabled={loading || !selectedTeam}
          className="self-end px-6 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded font-medium transition"
        >
          {loading ? "Loading..." : "Load"}
        </button>
      </div>

      {error && <p className="text-red-400 mb-4">{error}</p>}

      {loading && (
        <div className="mb-4">
          <div className="flex items-center gap-3 mb-1">
            <div className="text-sm text-gray-400">
              Loading issues... {loadProgress.loaded} fetched
            </div>
          </div>
          <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-indigo-500 rounded-full transition-all duration-300 ease-out animate-pulse"
              style={{ width: loadProgress.loaded > 0 ? "100%" : "30%" }}
            />
          </div>
        </div>
      )}

      {issues.length > 0 && (
        <>
          <div className="flex flex-wrap items-end gap-3 sm:gap-4 mb-6">
            <DateInput
              label="Start"
              value={startDate}
              onChange={setStartDate}
            />
            <DateInput label="End" value={endDate} onChange={setEndDate} />

            <ToggleGroup
              label="View"
              options={VIEW_LABELS}
              value={viewMode}
              onChange={(v) => {
                setViewMode(v);
                setSelectedDay(null);
              }}
            />
            {viewMode !== "cfd" && (
              <ToggleGroup
                label="Color by"
                options={COLOR_LABELS}
                value={colorMode}
                onChange={setColorMode}
              />
            )}
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-400">Backlog</label>
              <button
                onClick={() => setHideBacklog((h) => !h)}
                className={`px-3 py-2 text-sm rounded border transition ${
                  hideBacklog
                    ? "border-gray-700 bg-gray-800 text-gray-300 hover:bg-gray-700"
                    : "border-indigo-500 bg-indigo-600 text-white"
                }`}
              >
                {hideBacklog ? "Hidden" : "Shown"}
              </button>
            </div>
          </div>

          <div className="flex flex-wrap gap-4 sm:gap-8 mb-6 text-sm">
            <Stat label="Total Issues" value={totalScope} />
            <Stat label="Completed" value={completedCount} />
            <Stat label="Remaining" value={totalScope - completedCount} />
            <Stat label="Progress" value={`${pctDone}%`} />
          </div>

          <div className="bg-gray-900 rounded-lg p-6 mb-8 relative">
            {loading && (
              <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-gray-900/70 backdrop-blur-[1px]">
                <div className="text-center">
                  <div className="inline-block h-6 w-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mb-2" />
                  <div className="text-sm text-gray-400">
                    {loadProgress.loaded} issues loaded...
                  </div>
                </div>
              </div>
            )}
            <ResponsiveContainer width="100%" height={400}>
              {viewMode === "cfd" ? (
                <AreaChart
                  data={chartData.data}
                  onClick={handleChartClick}
                  style={{ cursor: "pointer" }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis
                    dataKey="date"
                    stroke="#9CA3AF"
                    fontSize={12}
                    tickFormatter={(v: string) => v.slice(5)}
                  />
                  <YAxis stroke="#9CA3AF" fontSize={12} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#1F2937",
                      border: "1px solid #374151",
                      borderRadius: 8,
                    }}
                  />
                  <Legend />
                  {chartData.keys.map((key) => (
                    <Area
                      key={key}
                      type="monotone"
                      dataKey={key}
                      stackId="a"
                      fill={CFD_COLORS[key] ?? "#60A5FA"}
                      stroke={CFD_COLORS[key] ?? "#60A5FA"}
                      fillOpacity={0.7}
                    />
                  ))}
                </AreaChart>
              ) : (
                <BarChart
                  data={chartData.data}
                  onClick={handleChartClick}
                  style={{ cursor: "pointer" }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis
                    dataKey="date"
                    stroke="#9CA3AF"
                    fontSize={12}
                    tickFormatter={(v: string) => v.slice(5)}
                  />
                  <YAxis stroke="#9CA3AF" fontSize={12} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#1F2937",
                      border: "1px solid #374151",
                      borderRadius: 8,
                    }}
                  />
                  <Legend />
                  {chartData.keys.map((key, i) => (
                    <Bar
                      key={key}
                      dataKey={key}
                      stackId="a"
                      fill={COLORS[i % COLORS.length]}
                    />
                  ))}
                </BarChart>
              )}
            </ResponsiveContainer>
          </div>

          <div className="bg-gray-900 rounded-lg p-3 sm:p-4">
            <div className="font-medium text-gray-300 mb-4">
              Issues ({sortedIssues.length}
              {selectedDay ? ` on ${selectedDay}` : ""})
              {selectedDay && (
                <button
                  onClick={() => setSelectedDay(null)}
                  className="ml-2 text-xs text-gray-400 hover:text-gray-200 underline"
                >
                  clear filter
                </button>
              )}
            </div>
            <div className="overflow-x-auto -mx-3 sm:-mx-4 px-3 sm:px-4">
            <table className="w-full text-sm min-w-[800px]">
              <thead>
                <tr className="text-left text-gray-400">
                  <th className="pb-1"></th>
                  <th className="pb-1">
                    <input
                      type="text"
                      placeholder="Search issues..."
                      value={searchText}
                      onChange={(e) => setSearchText(e.target.value)}
                      className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs w-full placeholder-gray-500 focus:outline-none focus:border-indigo-500 font-normal"
                    />
                  </th>
                  <th className="pb-1"></th>
                  <th className="pb-1"></th>
                  <th className="pb-1">
                    <button
                      onClick={() => setShowActiveOnly((v) => !v)}
                      className={`px-2 py-1 text-xs rounded border transition font-normal ${
                        showActiveOnly
                          ? "border-indigo-500 bg-indigo-600 text-white"
                          : "border-gray-700 bg-gray-800 text-gray-300 hover:bg-gray-700"
                      }`}
                    >
                      Active only
                    </button>
                  </th>
                  <th className="pb-1"></th>
                  <th className="pb-1"></th>
                  <th className="pb-1"></th>
                  <th className="pb-1"></th>
                </tr>
                <tr className="text-left text-gray-400 border-b border-gray-800">
                  <SortTh col="identifier" label="ID" sortCol={sortCol} sortAsc={sortAsc} onSort={handleSort} />
                  <SortTh col="title" label="Title" sortCol={sortCol} sortAsc={sortAsc} onSort={handleSort} />
                  <SortTh col="project" label="Project" sortCol={sortCol} sortAsc={sortAsc} onSort={handleSort} />
                  <SortTh col="assignee" label="Assignee" sortCol={sortCol} sortAsc={sortAsc} onSort={handleSort} />
                  <SortTh col="stateName" label="Status" sortCol={sortCol} sortAsc={sortAsc} onSort={handleSort} />
                  <SortTh col="estimate" label="Est" sortCol={sortCol} sortAsc={sortAsc} onSort={handleSort} />
                  <SortTh col="priority" label="Priority" sortCol={sortCol} sortAsc={sortAsc} onSort={handleSort} />
                  <SortTh col="createdAt" label="Created" sortCol={sortCol} sortAsc={sortAsc} onSort={handleSort} />
                  <SortTh col="completedAt" label="Completed" sortCol={sortCol} sortAsc={sortAsc} onSort={handleSort} />
                </tr>
              </thead>
              <tbody>
                {sortedIssues.map((issue) => (
                  <tr key={issue.id} className="border-b border-gray-800/50">
                    <td className="py-1.5 pr-4">
                      <a
                        href={issue.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-indigo-400 hover:text-indigo-300"
                      >
                        {issue.identifier}
                      </a>
                    </td>
                    <td className="py-1.5 pr-4 truncate max-w-md">
                      <a
                        href={issue.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:text-indigo-300"
                      >
                        {issue.title}
                      </a>
                    </td>
                    <td className="py-1.5 pr-4 text-gray-400">
                      {issue.project ?? "-"}
                    </td>
                    <td className="py-1.5 pr-4 text-gray-400">
                      {issue.assignee ?? "-"}
                    </td>
                    <td className="py-1.5 pr-4">
                      <span
                        className={`px-2 py-0.5 rounded text-xs ${
                          issue.stateType === "completed"
                            ? "bg-green-900/50 text-green-300"
                            : issue.stateType === "canceled"
                              ? "bg-gray-800 text-gray-400"
                              : "bg-yellow-900/50 text-yellow-300"
                        }`}
                      >
                        {issue.stateName}
                      </span>
                    </td>
                    <td className="py-1.5 pr-4">{issue.estimate ?? "-"}</td>
                    <td className="py-1.5 pr-4 text-gray-400">{issue.priorityLabel}</td>
                    <td className="py-1.5 pr-4">
                      {issue.createdAt.split("T")[0]}
                    </td>
                    <td className="py-1.5">
                      {issue.completedAt?.split("T")[0] ?? "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        </>
      )}
    </main>
  );
}

function Select({
  label,
  options,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  options: Option[];
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-gray-400">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm w-full sm:min-w-[200px]"
      >
        <option value="">{placeholder ?? "All"}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function DateInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-gray-400">{label}</label>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
      />
    </div>
  );
}

function ToggleGroup<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Record<T, string>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-gray-400">{label}</label>
      <div className="flex rounded overflow-hidden border border-gray-700">
        {(Object.entries(options) as [T, string][]).map(([k, v]) => (
          <button
            key={k}
            onClick={() => onChange(k)}
            className={`px-3 py-2 text-sm transition ${
              k === value
                ? "bg-indigo-600 text-white"
                : "bg-gray-800 text-gray-300 hover:bg-gray-700"
            }`}
          >
            {v}
          </button>
        ))}
      </div>
    </div>
  );
}

function SortTh({
  col,
  label,
  sortCol,
  sortAsc,
  onSort,
}: {
  col: keyof Issue;
  label: string;
  sortCol: keyof Issue;
  sortAsc: boolean;
  onSort: (col: keyof Issue) => void;
}) {
  const active = sortCol === col;
  return (
    <th
      className="pb-2 cursor-pointer select-none hover:text-gray-200 transition-colors"
      onClick={() => onSort(col)}
    >
      {label}
      {active ? (sortAsc ? " ▲" : " ▼") : ""}
    </th>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="text-gray-400 text-xs">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
    </div>
  );
}
