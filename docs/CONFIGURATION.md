# Configuration guide

`config/strategy.yaml` is validated by Pydantic before either engine starts. Profiles
contain base thresholds; `AdaptiveThresholdManager` derives bounded runtime thresholds
from realized volatility, regime, precision, false-positive rate, and calibration
error. A tuning run always creates a new semantic version—never mutates an active
version in place.

Most environment variables use the `AXIOM_` prefix. Copy `.env.example` to
`.env`, set `SUPABASE_DATABASE_URL` to the Supabase Session pooler URI for
production, and point `AXIOM_THETADATA_BASE_URL` at the machine running Theta
Terminal v3. The frontend independently reads `VITE_API_URL` from
`frontend/.env`.
