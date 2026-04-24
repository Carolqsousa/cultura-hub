# cultura-hub
Internal operations hub for Cultura Inglesa — student, financial, teacher and marketing data from Sponte, RD Station and Google Sheets.

# Cultura Hub

Internal operations dashboard for Cultura Inglesa — a unified view of student, financial, teacher and marketing data across all branches.

## What it does

Pulls data daily from multiple sources and displays it in a management dashboard accessible to branch managers and admins.

**Data sources:**
- **Sponte** — active students, financials, attendance, grades, diary completion
- **RD Station** — leads, pipeline, marketing KPIs
- **Google Sheets** — goals, to-do lists, teacher attendance, NPS, quality feedback

**Dashboard sections:**
- Branch overview — key metrics at a glance
- Students — active count, discounts, ATP, average ticket
- Financial — revenue, delinquency, payment status
- At-risk students — behind on payment + missing classes + below grade
- Teachers — diary completion, attendance, lateness, NPS
- Enrollments — goals vs actual, lead pipeline, cancellations
- To-do list — weekly tasks per branch
- Quality — NPS scores, feedback analysis

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Next.js (hosted on Vercel) |
| Database | BigQuery (Google Cloud) |
| Pipeline | Python scripts |
| Scheduler | GitHub Actions (runs daily at 7am) |
| Auth | Google OAuth |

## Project structure

```
cultura-hub/
├── pipeline/
│   ├── sponte.py          # Pulls data from Sponte API
│   ├── rd_station.py      # Pulls data from RD Station API
│   ├── google_sheets.py   # Pulls data from Google Sheets
│   └── bigquery.py        # Writes data to BigQuery
├── dashboard/
│   ├── pages/             # Next.js pages
│   ├── components/        # UI components
│   └── lib/               # BigQuery queries, auth, utils
├── .github/
│   └── workflows/
│       └── daily_run.yml  # Runs pipeline every day at 7am
└── README.md
```

## Access levels

- **Super admin** — sees all branches
- **Branch manager** — sees only assigned branches

## Setup

Documentation coming as the project is built.

## Status

🚧 In development
