# Deploying the VS Code edition

## Supabase

In the Supabase dashboard, select **Connect → Session pooler** and copy the
port 5432 connection string. Add the database password and percent-encode any
reserved characters. The value belongs only on the Python backend:

```text
SUPABASE_DATABASE_URL=postgresql://postgres.PROJECT_REF:PASSWORD@aws-0-REGION.pooler.supabase.com:5432/postgres?sslmode=require
```

The public Supabase project URL and anon key are not needed because the backend
connects directly to Postgres. SQLAlchemy creates the schema during API startup.

## Render

Create a Blueprint from `render.yaml` and enter:

```text
SUPABASE_DATABASE_URL=<Supabase Session pooler URI>
AXIOM_CORS_ORIGINS=["https://YOUR-VERCEL-DOMAIN.vercel.app"]
AXIOM_THETADATA_BASE_URL=https://YOUR-PRIVATE-THETA-HOST/v3
```

The ThetaData secret belongs on the host running Theta Terminal:

```text
THETADATA_API_KEY=<secret>
```

Do not expose Theta Terminal publicly without authentication/private networking.

## Vercel

The root `vercel.json` installs and builds `frontend/`. Add this browser-safe
environment variable in Vercel:

```text
VITE_API_URL=https://YOUR-RENDER-SERVICE.onrender.com
```

Redeploy the frontend after changing a Vite environment variable. Once Vercel
assigns the final domain, make `AXIOM_CORS_ORIGINS` on Render match it exactly.
