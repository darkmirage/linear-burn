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
  ReferenceLine,
  ReferenceArea,
  Cell,
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

// --- Date helpers ---

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function toLocalDate(iso: string): string {
  return formatDate(new Date(iso));
}

function todayLocal(): string {
  return formatDate(new Date());
}

// --- Issue helpers ---

function getDoneIso(issue: Issue): string | null {
  return issue.completedAt ?? issue.canceledAt;
}

function getDoneDate(issue: Issue): string | undefined {
  const iso = getDoneIso(issue);
  return iso ? toLocalDate(iso) : undefined;
}

function issueWeight(issues: Issue[]): (i: Issue) => number {
  const useEst = issues.some((i) => i.estimate != null && i.estimate > 0);
  return (i: Issue) => (useEst ? (i.estimate ?? 1) : 1);
}

// --- Chart types & constants ---

type ViewMode = "created" | "active" | "burndown" | "closed" | "cfd";
type ColorMode = "none" | "project" | "assignee" | "status" | "priority";

type ChartResult = {
  data: Record<string, string | number>[];
  keys: string[];
  projectedFrom?: string;
};

const COLORS = [
  "#60A5FA", "#F87171", "#34D399", "#FBBF24", "#A78BFA",
  "#F472B6", "#38BDF8", "#FB923C", "#4ADE80", "#E879F9",
  "#2DD4BF", "#FCA5A1", "#818CF8", "#FDE047", "#67E8F9",
];

const CFD_STATUS_ORDER = ["Completed", "Started", "Unstarted", "Backlog", "Canceled"] as const;
const CFD_COLORS: Record<string, string> = {
  Completed: "#34D399",
  Started: "#60A5FA",
  Unstarted: "#FBBF24",
  Backlog: "#9CA3AF",
  Canceled: "#6B7280",
};

const STATE_ORDER: Record<string, number> = {
  backlog: 0, unstarted: 1, started: 2, completed: 3, canceled: 4,
};

const TOOLTIP_STYLE = {
  backgroundColor: "#1F2937",
  border: "1px solid #374151",
  borderRadius: 8,
};

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

const STATUS_MAP: Record<string, string> = {
  completed: "Completed",
  started: "Started",
  unstarted: "Unstarted",
  backlog: "Backlog",
  canceled: "Canceled",
};

// --- Chart data builders ---

function getColorKey(issue: Issue, colorBy: ColorMode): string {
  if (colorBy === "project") return issue.project ?? "No Project";
  if (colorBy === "assignee") return issue.assignee ?? "Unassigned";
  if (colorBy === "status") return issue.stateName;
  if (colorBy === "priority") return issue.priorityLabel;
  return "Issues";
}

function getDateRange(issues: Issue[], startDate: string, endDate: string) {
  const createdDates = issues.map((i) => toLocalDate(i.createdAt));
  const doneDates = issues
    .filter((i) => getDoneIso(i))
    .map((i) => toLocalDate(getDoneIso(i)!));
  const today = todayLocal();

  const minDate = startDate || createdDates.sort()[0];
  const maxDate = endDate || [...createdDates, ...doneDates, today].sort().pop()!;

  const days: string[] = [];
  const cur = new Date(minDate + "T12:00:00");
  const end = new Date(maxDate + "T12:00:00");
  while (cur <= end) {
    days.push(formatDate(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

function applyProjection(
  data: Record<string, string | number>[],
  keys: string[],
  days: string[],
): string | undefined {
  const today = todayLocal();
  const todayIdx = days.indexOf(today);
  if (todayIdx < 1 || todayIdx >= days.length - 1) return undefined;

  // Use yesterday for rate calculation so a partial (in-progress) day
  // doesn't dilute the rate and make projections jump at day boundaries.
  const yestIdx = todayIdx - 1;
  const lookback = Math.min(7, yestIdx);
  if (lookback < 1) return undefined;
  const refIdx = yestIdx - lookback;

  // Compute aggregate rate across all keys so the total is consistent
  // regardless of how many keys (color groups) there are.
  let totalNow = 0, totalYest = 0, totalRef = 0;
  for (const key of keys) {
    totalNow += data[todayIdx][key] as number;
    totalYest += data[yestIdx][key] as number;
    totalRef += data[refIdx][key] as number;
  }
  const aggRate = (totalYest - totalRef) / lookback;

  // Each key's share of the current total (for proportional distribution)
  const shares: Record<string, number> = {};
  for (const key of keys) {
    shares[key] = totalNow > 0 ? (data[todayIdx][key] as number) / totalNow : 1 / keys.length;
  }

  for (let i = todayIdx + 1; i < data.length; i++) {
    const ahead = i - todayIdx;
    data[i]._projected = 1;
    const projectedTotal = Math.max(0, totalNow + aggRate * ahead);
    for (const key of keys) {
      data[i][key] = Math.max(0, Math.round(projectedTotal * shares[key]));
    }
  }

  return today;
}

// Flow-based projection for CFD: models issues flowing through the pipeline
// Backlog → Unstarted → Started → Completed/Canceled
function applyCfdProjection(
  data: Record<string, string | number>[],
  keys: string[],
  days: string[],
): string | undefined {
  const today = todayLocal();
  const todayIdx = days.indexOf(today);
  if (todayIdx < 1 || todayIdx >= days.length - 1) return undefined;

  // Use yesterday for rate calculation so a partial day doesn't dilute the rate.
  const yestIdx = todayIdx - 1;
  const lookback = Math.min(7, yestIdx);
  if (lookback < 1) return undefined;
  const refIdx = yestIdx - lookback;

  // Calculate the daily completion rate (how many issues move to done states)
  const doneKeys = ["Completed", "Canceled"];
  const pipelineKeys = ["Backlog", "Unstarted", "Started"];

  let doneRate = 0;
  for (const key of doneKeys) {
    if (keys.includes(key)) {
      doneRate += ((data[yestIdx][key] as number) - (data[refIdx][key] as number)) / lookback;
    }
  }

  // If nothing is being completed, fall back to independent projection
  if (doneRate <= 0) {
    return applyProjection(data, keys, days);
  }

  // Determine which done category is growing (split proportionally)
  const doneRates: Record<string, number> = {};
  for (const key of doneKeys) {
    if (keys.includes(key)) {
      const rate = ((data[yestIdx][key] as number) - (data[refIdx][key] as number)) / lookback;
      doneRates[key] = Math.max(0, rate);
    }
  }
  const totalDoneRate = Object.values(doneRates).reduce((a, b) => a + b, 0);

  for (let i = todayIdx + 1; i < data.length; i++) {
    const ahead = i - todayIdx;
    const prev = data[i - 1];
    data[i]._projected = 1;

    // Start from previous day's values
    const vals: Record<string, number> = {};
    for (const key of keys) {
      vals[key] = prev[key] as number;
    }

    // Flow: move doneRate units through the pipeline each day
    let remaining = doneRate;

    // Pull from Started first, then Unstarted, then Backlog
    for (const src of ["Started", "Unstarted", "Backlog"]) {
      if (!keys.includes(src) || remaining <= 0) continue;
      const take = Math.min(remaining, vals[src]);
      vals[src] -= take;
      remaining -= take;
    }

    // Add to done categories proportionally
    if (totalDoneRate > 0) {
      for (const key of doneKeys) {
        if (keys.includes(key) && doneRates[key] > 0) {
          vals[key] += doneRate * (doneRates[key] / totalDoneRate);
        }
      }
    }

    // Replenish Started from Unstarted/Backlog (keep Started stable)
    const startedToday = data[todayIdx]["Started"] as number | undefined;
    if (keys.includes("Started") && startedToday != null) {
      const deficit = startedToday - vals["Started"];
      if (deficit > 0) {
        for (const src of ["Unstarted", "Backlog"]) {
          if (!keys.includes(src)) continue;
          const take = Math.min(deficit, vals[src]);
          vals[src] -= take;
          vals["Started"] += take;
          if (vals["Started"] >= startedToday) break;
        }
      }
    }

    for (const key of keys) {
      data[i][key] = Math.max(0, Math.round(vals[key]));
    }
  }

  return today;
}

function buildCfdData(issues: Issue[], startDate: string, endDate: string): ChartResult {
  if (issues.length === 0) return { data: [], keys: [] };

  const w = issueWeight(issues);
  const days = getDateRange(issues, startDate, endDate);

  const data: Record<string, string | number>[] = [];
  const keys = CFD_STATUS_ORDER.filter((s) =>
    issues.some((i) => STATUS_MAP[i.stateType] === s)
  );

  for (const day of days) {
    const point: Record<string, string | number> = { date: day };
    keys.forEach((key) => (point[key] = 0));

    for (const issue of issues) {
      const created = toLocalDate(issue.createdAt);
      if (created > day) continue;
      const doneDate = getDoneDate(issue);

      let status: string;
      if (doneDate && doneDate <= day) {
        status = issue.canceledAt && (!issue.completedAt || issue.canceledAt <= issue.completedAt)
          ? "Canceled" : "Completed";
      } else {
        status = STATUS_MAP[issue.stateType] ?? "Unstarted";
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

  const keysArr = [...keys];
  const projectedFrom = applyCfdProjection(data, keysArr, days);

  return { data, keys: keysArr, projectedFrom };
}

function buildChartData(
  issues: Issue[],
  view: ViewMode,
  colorBy: ColorMode,
  startDate: string,
  endDate: string,
): ChartResult {
  if (issues.length === 0) return { data: [], keys: [] };

  const w = issueWeight(issues);
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
        if (toLocalDate(issue.createdAt) === day) {
          point[k(issue)] = (point[k(issue)] as number) + w(issue);
        }
      }
    } else if (view === "closed") {
      for (const issue of issues) {
        const doneDate = getDoneDate(issue);
        if (doneDate === day) {
          point[k(issue)] = (point[k(issue)] as number) + w(issue);
        }
      }
    } else if (view === "active") {
      for (const issue of issues) {
        const created = toLocalDate(issue.createdAt);
        const doneDate = getDoneDate(issue);
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
          const doneDate = getDoneDate(issue);
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
          const doneDate = getDoneDate(issue);
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

  const projectedFrom = (view === "active" || view === "burndown")
    ? applyProjection(data, keys, days)
    : undefined;
  return { data, keys, projectedFrom };
}

// --- API helpers ---

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Fetch failed (${r.status})`);
  return r.json();
}

// --- Main component ---

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
    return formatDate(d);
  });
  const [endDate, setEndDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 14);
    return formatDate(d);
  });
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
    fetchJson<Option[]>("/api/linear?action=teams")
      .then((data) => {
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
      fetchJson<Option[]>(`/api/linear?action=projects&teamId=${selectedTeam}`),
      fetchJson<Option[]>(`/api/linear?action=labels&teamId=${selectedTeam}`),
    ]).then(([p, l]) => {
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
      const created = toLocalDate(issue.createdAt);
      const doneDate = getDoneDate(issue);
      if (viewMode === "created") return created === selectedDay;
      if (viewMode === "closed") return doneDate === selectedDay;
      if (viewMode === "active") return created <= selectedDay && (!doneDate || doneDate > selectedDay);
      return !doneDate || doneDate > selectedDay;
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
    return [...tableFilteredIssues].sort((a, b) => {
      let av: string | number, bv: string | number;
      if (sortCol === "priority") {
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
            <DateInput label="Start" value={startDate} onChange={setStartDate} />
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
                <AreaChart data={chartData.data} onClick={handleChartClick} style={{ cursor: "pointer" }}>
                  <defs>
                    {chartData.keys.map((key) => (
                      <linearGradient key={key} id={`cfd-${key}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={CFD_COLORS[key] ?? "#60A5FA"} stopOpacity={0.7} />
                        <stop offset="100%" stopColor={CFD_COLORS[key] ?? "#60A5FA"} stopOpacity={0.5} />
                      </linearGradient>
                    ))}
                    <pattern id="cfd-projected-stripes" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                      <rect width="2" height="6" fill="white" fillOpacity="0.18" />
                    </pattern>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis dataKey="date" stroke="#9CA3AF" fontSize={12} tickFormatter={(v: string) => v.slice(5)} />
                  <YAxis stroke="#9CA3AF" fontSize={12} />
                  {chartData.projectedFrom && (
                    <ReferenceLine x={chartData.projectedFrom} stroke="#6366F1" strokeDasharray="4 4" label={{ value: "Today", fill: "#9CA3AF", fontSize: 11, position: "top" }} />
                  )}
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                  <Legend />
                  {chartData.keys.map((key) => (
                    <Area key={key} type="monotone" dataKey={key} stackId="a" fill={`url(#cfd-${key})`} stroke={CFD_COLORS[key] ?? "#60A5FA"} fillOpacity={1} />
                  ))}
                  {chartData.projectedFrom && (
                    <>
                      <ReferenceArea x1={chartData.projectedFrom} fill="#000000" fillOpacity={0.3} strokeOpacity={0} />
                      <ReferenceArea x1={chartData.projectedFrom} fill="url(#cfd-projected-stripes)" fillOpacity={1} strokeOpacity={0} />
                    </>
                  )}
                </AreaChart>
              ) : (
                <BarChart data={chartData.data} onClick={handleChartClick} style={{ cursor: "pointer" }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis dataKey="date" stroke="#9CA3AF" fontSize={12} tickFormatter={(v: string) => v.slice(5)} />
                  <YAxis stroke="#9CA3AF" fontSize={12} />
                  {chartData.projectedFrom && (
                    <ReferenceLine x={chartData.projectedFrom} stroke="#6366F1" strokeDasharray="4 4" label={{ value: "Today", fill: "#9CA3AF", fontSize: 11, position: "top" }} />
                  )}
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                  <Legend />
                  {chartData.keys.map((key, i) => (
                    <Bar key={key} dataKey={key} stackId="a" fill={COLORS[i % COLORS.length]}>
                      {chartData.projectedFrom && chartData.data.map((entry, idx) => (
                        <Cell key={idx} fillOpacity={entry._projected ? 0.35 : 1} />
                      ))}
                    </Bar>
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
                  <IssueRow key={issue.id} issue={issue} />
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

// --- Shared UI components ---

function IssueRow({ issue }: { issue: Issue }) {
  return (
    <tr className="border-b border-gray-800/50">
      <td className="py-1.5 pr-4">
        <a href={issue.url} target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:text-indigo-300">
          {issue.identifier}
        </a>
      </td>
      <td className="py-1.5 pr-4 truncate max-w-md">
        <a href={issue.url} target="_blank" rel="noopener noreferrer" className="hover:text-indigo-300">
          {issue.title}
        </a>
      </td>
      <td className="py-1.5 pr-4 text-gray-400">{issue.project ?? "-"}</td>
      <td className="py-1.5 pr-4 text-gray-400">{issue.assignee ?? "-"}</td>
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
      <td className="py-1.5 pr-4">{toLocalDate(issue.createdAt)}</td>
      <td className="py-1.5">{issue.completedAt ? toLocalDate(issue.completedAt) : "-"}</td>
    </tr>
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
