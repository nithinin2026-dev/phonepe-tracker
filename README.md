# SpendScope — PhonePe Statement Analyzer

Upload your PhonePe transaction PDF (any date range) and get detailed spending analysis with charts, category breakdowns, and insights.

## Features
- PDF parsing with auto-categorization (Food, Groceries, Investments, Transport, etc.)
- Overview dashboard with stat cards, pie chart, category bars, daily/weekly charts
- Searchable & filterable transaction log
- Trends: cumulative spending, day-of-week, time-of-day analysis, quick insights

## Deploy on Vercel

1. Push this repo to GitHub
2. Go to [vercel.com](https://vercel.com) → Import → select this repo
3. Framework: **Vite** (auto-detected)
4. Click **Deploy**

## Local Development

```bash
npm install
npm run dev
```

## Stack
Vite + React + Recharts + PDF.js (loaded via CDN at runtime)
