# Linear Burn

A burn rate dashboard for [Linear](https://linear.app). Visualize issue creation, completion, active count, and burndown over time with interactive charts and a sortable issues table.

## Features

- **Multiple chart views** - Created, Active, Burndown, and Closed per day
- **Color grouping** - Color bars by project, assignee, status, or priority
- **Click-to-filter** - Click a chart bar to filter the issues table to that day
- **Streaming load** - Issues stream in batches of 20 with a live progress bar
- **Sortable table** - Click any column header to sort (default: priority descending)
- **Backlog toggle** - Hide backlog issues by default, toggle to show
- **Smart defaults** - Auto-selects Product Engineering team and GA label on load

## Setup

1. Clone the repo
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a `.env` file with your Linear API key:
   ```
   LINEAR_API_KEY=lin_api_xxxxx
   ```
4. Run the dev server:
   ```bash
   npm run dev
   ```
5. Open [http://localhost:3000](http://localhost:3000)

## Deploy

Deploy to Vercel with the `LINEAR_API_KEY` environment variable set:

```bash
vercel --prod
```

## Tech Stack

- Next.js 16 (App Router)
- Recharts
- Tailwind CSS
- Linear SDK
