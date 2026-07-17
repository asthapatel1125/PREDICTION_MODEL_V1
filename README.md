# Axiom Pressure Intelligence — VS Code edition

This is the clean conventional workspace:

```text
axiom-vscode/
├── backend/              Python FastAPI application and tests
├── config/               Strategy thresholds and weights
├── frontend/             Vite + React JavaScript workstation
│   ├── index.html
│   └── src/
│       ├── App.jsx
│       ├── api.js
│       ├── main.jsx
│       └── styles.css
├── .vscode/              Run/debug/tasks configuration
├── pyproject.toml        Python dependencies
├── render.yaml           Render backend deployment
└── vercel.json           Vercel frontend deployment
```

There is no Next.js, TypeScript, Tailwind runtime, Cloudflare worker, or Sites
hosting layer in this edition. The workstation is regular HTML, CSS, and React
JavaScript/JSX, while retaining the same visual design.

## 1. Open and install in VS Code

Open the `axiom-vscode` folder itself in VS Code, then run:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
Copy-Item .env.example .env
Set-Location frontend
pnpm install
Copy-Item .env.example .env
```

Use **Run and Debug → Axiom: Backend + Frontend** to launch both applications,
or start them manually:

```powershell
# Project root
.\.venv\Scripts\python.exe -m uvicorn axiom.api.app:app --reload

# frontend folder
pnpm run dev
```

Open `http://localhost:5173`. API documentation is at
`http://localhost:8000/api/docs`.

## 2. Supabase Postgres

The backend always requires Supabase PostgreSQL; there is no local SQLite
database or fallback. In Supabase, click **Connect**, select **Session pooler**,
copy the port 5432 URI, and add it to the backend `.env` or Render:

```text
SUPABASE_DATABASE_URL=postgresql://postgres.PROJECT_REF:ENCODED_PASSWORD@aws-0-REGION.pooler.supabase.com:5432/postgres?sslmode=require
```

Do not use the public `https://PROJECT.supabase.co` URL. The backend normalizes
the connection for `asyncpg` and creates its tables at startup.

## 3. ThetaData

Put the secret key only on the host that launches Theta Terminal:

```text
THETADATA_API_KEY=your-secret-key
```

Tell the Python backend how to reach that Terminal:

```text
AXIOM_THETADATA_BASE_URL=http://127.0.0.1:25503/v3
```

Render cannot reach a Terminal running on your laptop through localhost. For
production, use an always-on private/restricted Terminal host and configure its
HTTPS `/v3` URL on Render.

## 4. Render backend

Create a Blueprint using `render.yaml` and enter:

```text
SUPABASE_DATABASE_URL=<Supabase Session pooler URI>
AXIOM_CORS_ORIGINS=["https://YOUR-VERCEL-DOMAIN.vercel.app"]
AXIOM_THETADATA_BASE_URL=https://YOUR-PRIVATE-THETA-HOST/v3
```

Verify `https://YOUR-RENDER-SERVICE.onrender.com/api/v1/health`.

## 5. Vercel frontend

Import the repository. `vercel.json` builds the `frontend` directory. Add:

```text
VITE_API_URL=https://YOUR-RENDER-SERVICE.onrender.com
```

`VITE_*` values are browser-visible. Never put database passwords or the
ThetaData key there.

## Engines

Both engines use the same deterministic `DecisionPipeline`.

- Training replay requests historical ThetaData, processes it chronologically,
  stores states/alerts in Supabase, and reports bar count, alert count, and
  latency. It is replay/calibration—not neural-network training.
- Live mode polls Theta Terminal snapshots, runs the same scoring and alert
  gates, stores results, broadcasts WebSocket events, and retries temporary
  feed failures with exponential backoff.

The frontend's API indicator, alert table/logbook, WebSocket updates, and main
live Start/Stop button use the real backend. Other analytical panels retain the
professional visual surface and are ready for subsequent endpoint wiring.

## Validation

```powershell
.\.venv\Scripts\python.exe -m pytest
Set-Location frontend
pnpm run build
```
