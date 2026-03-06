"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import {
  BarChart,
  Bar,
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

type ViewMode = "created" | "active" | "burndown" | "closed";
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

  const createdDates = issues.map((i) => i.createdAt.split("T")[0]);
  const doneDates = issues
    .filter((i) => i.completedAt || i.canceledAt)
    .map((i) => (i.completedAt ?? i.canceledAt)!.split("T")[0]);
  const today = new Date().toISOString().split("T")[0];

  const minDate = startDate || createdDates.sort()[0];
  const maxDate =
    endDate || [...createdDates, ...doneDates, today].sort().pop()!;

  const days: string[] = [];
  const cur = new Date(minDate + "T00:00:00");
  const end = new Date(maxDate + "T00:00:00");
  while (cur <= end) {
    days.push(cur.toISOString().split("T")[0]);
    cur.setDate(cur.getDate() + 1);
  }

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
      // Active issues on each day: created on or before, not yet done
      for (const issue of issues) {
        const created = issue.createdAt.split("T")[0];
        const doneDate = (issue.completedAt ?? issue.canceledAt)?.split("T")[0];
        if (created <= day && (!doneDate || doneDate > day)) {
          point[k(issue)] = (point[k(issue)] as number) + w(issue);
        }
      }
    } else {
      // Burndown: total scope fixed from day 1, minus cumulative completions
      const totalScope = issues.reduce((s, i) => s + w(i), 0);
      // For color mode, we need per-group remaining
      // Each group starts with its full count and decreases
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
        // Per-group: each group's total minus its completions
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
  closed: "Closed / Day",
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

  const streamIssues = useCallback(async (params: URLSearchParams) => {
    setError("");
    setLoading(true);
    setLoadProgress({ loaded: 0, done: false });
    setIssues([]);

    try {
      const res = await fetch(`/api/linear?${params}`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error);
      }
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const accumulated: Issue[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop()!;
        for (const line of lines) {
          if (!line) continue;
          const chunk = JSON.parse(line);
          accumulated.push(...chunk.issues);
          setIssues([...accumulated]);
          setLoadProgress({ loaded: accumulated.length, done: !chunk.hasMore });
        }
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
      .then((r) => r.json())
      .then((data: Option[]) => {
        setTeams(data);
        const pe = data.find((t) => t.name === "Product Engineering");
        if (pe) setSelectedTeam(pe.id);
      });
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
      fetch(`/api/linear?action=projects&teamId=${selectedTeam}`).then((r) =>
        r.json(),
      ),
      fetch(`/api/linear?action=labels&teamId=${selectedTeam}`).then((r) =>
        r.json(),
      ),
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
    });
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
    () => buildChartData(displayIssues, viewMode, colorMode, startDate, endDate),
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

  const totalScope = displayIssues.length;
  const completedCount = displayIssues.filter(
    (i) => i.stateType === "completed" || i.stateType === "canceled",
  ).length;
  const pctDone =
    totalScope > 0 ? Math.round((completedCount / totalScope) * 100) : 0;

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 p-8">
      <h1 className="text-3xl font-bold mb-8">Linear Burn Rate</h1>

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
          <div className="flex flex-wrap items-end gap-4 mb-6">
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
            <ToggleGroup
              label="Color by"
              options={COLOR_LABELS}
              value={colorMode}
              onChange={setColorMode}
            />
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

          <div className="flex gap-8 mb-6 text-sm">
            <Stat label="Total Issues" value={totalScope} />
            <Stat label="Completed" value={completedCount} />
            <Stat label="Remaining" value={totalScope - completedCount} />
            <Stat label="Progress" value={`${pctDone}%`} />
          </div>

          <div className="bg-gray-900 rounded-lg p-6 mb-8">
            <ResponsiveContainer width="100%" height={400}>
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
            </ResponsiveContainer>
          </div>

          <details className="bg-gray-900 rounded-lg p-4" open={!!selectedDay}>
            <summary className="cursor-pointer font-medium text-gray-300">
              Issues ({filteredIssues.length}
              {selectedDay ? ` on ${selectedDay}` : ""})
              {selectedDay && (
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    setSelectedDay(null);
                  }}
                  className="ml-2 text-xs text-gray-400 hover:text-gray-200 underline"
                >
                  clear filter
                </button>
              )}
            </summary>
            <table className="w-full mt-4 text-sm">
              <thead>
                <tr className="text-left text-gray-400 border-b border-gray-800">
                  <th className="pb-2">ID</th>
                  <th className="pb-2">Title</th>
                  <th className="pb-2">Project</th>
                  <th className="pb-2">Assignee</th>
                  <th className="pb-2">State</th>
                  <th className="pb-2">Est</th>
                  <th className="pb-2">Created</th>
                  <th className="pb-2">Completed</th>
                </tr>
              </thead>
              <tbody>
                {filteredIssues.map((issue) => (
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
          </details>
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
        className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm min-w-[200px]"
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

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="text-gray-400 text-xs">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
    </div>
  );
}
