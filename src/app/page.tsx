"use client";

import { useEffect, useState, useCallback } from "react";
import {
  LineChart,
  Line,
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
  state: string;
  assignee: string | null;
};

type ChartPoint = {
  date: string;
  scope: number;
  remaining: number;
  ideal: number;
};

function buildBurndown(issues: Issue[]): ChartPoint[] {
  if (issues.length === 0) return [];

  const allDates = issues.map((i) => new Date(i.createdAt).getTime());
  const completionDates = issues
    .filter((i) => i.completedAt || i.canceledAt)
    .map((i) => new Date((i.completedAt ?? i.canceledAt)!).getTime());

  const start = new Date(Math.min(...allDates));
  const end =
    completionDates.length > 0
      ? new Date(Math.max(Date.now(), ...completionDates))
      : new Date();

  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);

  const useEstimates = issues.some((i) => i.estimate != null && i.estimate > 0);
  const weight = (i: Issue) => (useEstimates ? (i.estimate ?? 1) : 1);

  const points: ChartPoint[] = [];
  const dayMs = 86400000;
  const totalDays = Math.max(
    1,
    Math.ceil((end.getTime() - start.getTime()) / dayMs)
  );
  const finalScope = issues.reduce((s, i) => s + weight(i), 0);

  const step = Math.max(1, Math.floor(totalDays / 90));

  for (let d = 0; d <= totalDays; d += step) {
    const current = new Date(start.getTime() + d * dayMs);
    const currentEnd = current.getTime() + dayMs;

    let scope = 0;
    let completed = 0;
    for (const issue of issues) {
      if (new Date(issue.createdAt).getTime() < currentEnd) {
        scope += weight(issue);
      }
      const doneAt = issue.completedAt ?? issue.canceledAt;
      if (doneAt && new Date(doneAt).getTime() < currentEnd) {
        completed += weight(issue);
      }
    }

    const ideal = finalScope * (d / totalDays);

    points.push({
      date: current.toISOString().split("T")[0],
      scope,
      remaining: scope - completed,
      ideal: Math.round((finalScope - ideal) * 10) / 10,
    });
  }

  return points;
}

export default function Home() {
  const [teams, setTeams] = useState<Option[]>([]);
  const [projects, setProjects] = useState<Option[]>([]);
  const [labels, setLabels] = useState<Option[]>([]);

  const [selectedTeam, setSelectedTeam] = useState("");
  const [selectedProject, setSelectedProject] = useState("");
  const [selectedLabel, setSelectedLabel] = useState("");

  const [issues, setIssues] = useState<Issue[]>([]);
  const [chartData, setChartData] = useState<ChartPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Load teams on mount
  useEffect(() => {
    fetch("/api/linear?action=teams")
      .then((r) => r.json())
      .then(setTeams);
  }, []);

  // Load projects and labels when team changes
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
        r.json()
      ),
      fetch(`/api/linear?action=labels&teamId=${selectedTeam}`).then((r) =>
        r.json()
      ),
    ]).then(([p, l]) => {
      setProjects(p);
      setLabels(l);
    });
  }, [selectedTeam]);

  const fetchIssues = useCallback(async () => {
    if (!selectedTeam) {
      setError("Select a team");
      return;
    }
    setError("");
    setLoading(true);

    const params = new URLSearchParams({ action: "issues", teamId: selectedTeam });
    if (selectedProject) params.set("projectId", selectedProject);
    if (selectedLabel) params.set("labelId", selectedLabel);

    try {
      const res = await fetch(`/api/linear?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setIssues(data);
      setChartData(buildBurndown(data));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to fetch issues");
    } finally {
      setLoading(false);
    }
  }, [selectedTeam, selectedProject, selectedLabel]);

  const totalScope = issues.length;
  const completedCount = issues.filter(
    (i) => i.state === "completed" || i.state === "canceled"
  ).length;
  const pctDone =
    totalScope > 0 ? Math.round((completedCount / totalScope) * 100) : 0;

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 p-8">
      <h1 className="text-3xl font-bold mb-8">Linear Burn Rate</h1>

      <div className="flex flex-wrap gap-4 mb-6">
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

      {chartData.length > 0 && (
        <>
          <div className="flex gap-8 mb-6 text-sm">
            <Stat label="Total Issues" value={totalScope} />
            <Stat label="Completed" value={completedCount} />
            <Stat label="Remaining" value={totalScope - completedCount} />
            <Stat label="Progress" value={`${pctDone}%`} />
          </div>

          <div className="bg-gray-900 rounded-lg p-6 mb-8">
            <ResponsiveContainer width="100%" height={400}>
              <LineChart data={chartData}>
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
                <Line
                  type="stepAfter"
                  dataKey="scope"
                  stroke="#60A5FA"
                  strokeWidth={1}
                  strokeDasharray="4 2"
                  dot={false}
                  name="Scope"
                />
                <Line
                  type="monotone"
                  dataKey="remaining"
                  stroke="#F87171"
                  strokeWidth={2}
                  dot={false}
                  name="Remaining"
                />
                <Line
                  type="monotone"
                  dataKey="ideal"
                  stroke="#6B7280"
                  strokeWidth={1}
                  strokeDasharray="5 5"
                  dot={false}
                  name="Ideal"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <details className="bg-gray-900 rounded-lg p-4">
            <summary className="cursor-pointer font-medium text-gray-300">
              Issues ({issues.length})
            </summary>
            <table className="w-full mt-4 text-sm">
              <thead>
                <tr className="text-left text-gray-400 border-b border-gray-800">
                  <th className="pb-2">ID</th>
                  <th className="pb-2">Title</th>
                  <th className="pb-2">Assignee</th>
                  <th className="pb-2">State</th>
                  <th className="pb-2">Est</th>
                  <th className="pb-2">Created</th>
                  <th className="pb-2">Completed</th>
                </tr>
              </thead>
              <tbody>
                {issues.map((issue) => (
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
                      {issue.assignee ?? "-"}
                    </td>
                    <td className="py-1.5 pr-4">
                      <span
                        className={`px-2 py-0.5 rounded text-xs ${
                          issue.state === "completed"
                            ? "bg-green-900/50 text-green-300"
                            : issue.state === "canceled"
                              ? "bg-gray-800 text-gray-400"
                              : "bg-yellow-900/50 text-yellow-300"
                        }`}
                      >
                        {issue.state}
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

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="text-gray-400 text-xs">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
    </div>
  );
}
