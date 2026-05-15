# Ground

Ground is a small personal time and intentions tracker. It runs as a Flask app,
serves a vanilla HTML/CSS/JS frontend, and stores data as JSON files on disk.

## Local Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Open http://127.0.0.1:8765.

By default, local data is written to `./data`. To try the sample data:

```bash
DATA_DIR=./data.example APP_ENV=development python app.py
```

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `APP_ENV` | unset | Use `development` locally or `production` on Railway. |
| `APP_TIMEZONE` | `Asia/Kolkata` | Controls day boundaries and logged timestamps. |
| `DATA_DIR` | `./data` | Directory for `todos.json` and daily `YYYY-MM-DD.json` files. |
| `APP_USERNAME` | unset | Required in production for Basic Auth. |
| `APP_PASSWORD` | unset | Required in production for Basic Auth. |
| `PORT` | `8765` | Used by local `python app.py`; Railway provides this automatically. |

When `APP_ENV=production`, requests are protected with HTTP Basic Auth. In local
development, auth is bypassed if `APP_ENV=development` or both auth variables
are absent.

## Railway Deployment

1. Create a Railway project from this GitHub repo.
2. Set the start command from the included `Procfile`.
3. Add a persistent volume mounted at `/app/data`.
4. Set these Railway variables:

```text
APP_ENV=production
APP_TIMEZONE=Asia/Kolkata
DATA_DIR=/app/data
APP_USERNAME=<your username>
APP_PASSWORD=<a long random password>
```

Railway will provide `PORT`. The app includes `X-Robots-Tag: noindex, nofollow`
and `/robots.txt` to discourage indexing, but auth is still required because the
URL is public.

## Data and Backups

Real data files under `data/*.json` are intentionally ignored by git. For a
personal deployment, JSON-on-filesystem persistence is fine as long as the app
runs as a single instance and the Railway volume is backed up.

Before making this repo public:

- confirm no real `data/*.json` files are tracked;
- confirm `.env` and deployment secrets are not tracked;
- review commit history for accidental personal data;
- keep `data.example/` as the public sample dataset.

To back up a Railway volume, download or copy the files under `/app/data`.
