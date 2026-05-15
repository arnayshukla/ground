"""
Minimal daily time + todos. Data lives in DATA_DIR as JSON (default: ./data).
Run: python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && python app.py
"""

from __future__ import annotations

import hmac
import json
import os
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from flask import Flask, Response, jsonify, request, send_from_directory

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DEFAULT_TIMEZONE = "Asia/Kolkata"

CATEGORIES = [
    {"id": "deep_work", "label": "Deep work"},
    {"id": "meetings", "label": "Meetings & sync"},
    {"id": "review", "label": "Code & design review"},
    {"id": "docs", "label": "Docs & RFCs"},
    {"id": "planning", "label": "Planning & estimation"},
    {"id": "research", "label": "Research & spikes"},
    {"id": "strategy", "label": "Strategy & roadmap"},
    {"id": "mentoring", "label": "Mentoring & 1:1s"},
    {"id": "incident", "label": "Incidents & RCA"},
    {"id": "oncall", "label": "On-call"},
    {"id": "admin", "label": "Admin & comms"},
]

CATEGORY_IDS = frozenset(c["id"] for c in CATEGORIES)
DEFAULT_TASK_CATEGORY = CATEGORIES[0]["id"]

PRIORITIES = frozenset({"p1", "p2", "p3", "none"})

# Undated backlog bucket in todos.json (not a calendar date key).
FUTURE_KEY = "__future__"

app = Flask(__name__, static_folder=str(STATIC), static_url_path="")


def _data_dir() -> Path:
    configured = os.environ.get("DATA_DIR")
    if configured:
        return Path(configured).expanduser()
    return ROOT / "data"


def _timezone() -> ZoneInfo:
    name = os.environ.get("APP_TIMEZONE", DEFAULT_TIMEZONE)
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        return ZoneInfo(DEFAULT_TIMEZONE)


def _today() -> date:
    return datetime.now(_timezone()).date()


def _now_iso() -> str:
    return datetime.now(_timezone()).replace(microsecond=0).isoformat()


def _auth_credentials() -> tuple[str | None, str | None]:
    return os.environ.get("APP_USERNAME"), os.environ.get("APP_PASSWORD")


def _auth_required() -> bool:
    if os.environ.get("APP_ENV") == "development":
        return False
    username, password = _auth_credentials()
    if username and password:
        return True
    return os.environ.get("APP_ENV") == "production"


def _auth_challenge(message: str = "Authentication required", status: int = 401) -> Response:
    return Response(
        message,
        status,
        {"WWW-Authenticate": 'Basic realm="Ground", charset="UTF-8"'},
    )


@app.before_request
def require_basic_auth():
    if not _auth_required():
        return None

    expected_user, expected_password = _auth_credentials()
    if not expected_user or not expected_password:
        return _auth_challenge("Authentication is not configured", 500)

    auth = request.authorization
    if not auth:
        return _auth_challenge()

    user_ok = hmac.compare_digest(auth.username or "", expected_user)
    password_ok = hmac.compare_digest(auth.password or "", expected_password)
    if not (user_ok and password_ok):
        return _auth_challenge()
    return None


@app.after_request
def add_privacy_headers(response):
    response.headers["X-Robots-Tag"] = "noindex, nofollow"
    return response


def _day_path(d: date) -> Path:
    data = _data_dir()
    data.mkdir(parents=True, exist_ok=True)
    return data / f"{d.isoformat()}.json"


def _load_day(d: date) -> dict:
    p = _day_path(d)
    if not p.exists():
        return {"entries": []}
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def _save_day(d: date, payload: dict) -> None:
    p = _day_path(d)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)


def _todos_path() -> Path:
    data = _data_dir()
    data.mkdir(parents=True, exist_ok=True)
    return data / "todos.json"


def _load_todos() -> dict:
    p = _todos_path()
    if not p.exists():
        return {}
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def _save_todos(data: dict) -> None:
    with open(_todos_path(), "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def _new_task_id() -> str:
    return str(uuid.uuid4())


def _normalize_task(obj) -> dict:
    if isinstance(obj, str):
        t = obj.strip()
        if not t:
            return {}
        return {
            "id": _new_task_id(),
            "text": t,
            "priority": "none",
            "deadline": None,
            "done": False,
            "category": DEFAULT_TASK_CATEGORY,
        }
    if not isinstance(obj, dict):
        return {}
    text = str(obj.get("text", "")).strip()
    if not text:
        return {}
    pr = str(obj.get("priority") or "none").lower()
    if pr not in PRIORITIES:
        pr = "none"
    cat = str(obj.get("category") or "").strip().lower()
    if cat in ("personal", "general"):
        cat = "deep_work" if cat == "personal" else "admin"
    if cat not in CATEGORY_IDS:
        cat = DEFAULT_TASK_CATEGORY
    dl = obj.get("deadline")
    if dl is not None and dl != "":
        try:
            date.fromisoformat(str(dl))
            dl = str(dl)[:10]
        except ValueError:
            dl = None
    else:
        dl = None
    done = bool(obj.get("done"))
    tid = str(obj.get("id") or "").strip()
    if not tid:
        tid = _new_task_id()
    return {"id": tid, "text": text, "priority": pr, "deadline": dl, "done": done, "category": cat}


def _normalize_day_tasks(raw) -> list[dict]:
    """Return a flat list of tasks from legacy or new storage."""
    if raw is None:
        return []
    if isinstance(raw, list):
        tasks = [_normalize_task(x) for x in raw]
        return [t for t in tasks if t]
    if isinstance(raw, dict):
        if "personal" in raw or "general" in raw:
            out: list[dict] = []
            for item in raw.get("personal") or []:
                t = _normalize_task(item)
                if t:
                    out.append(t)
            for item in raw.get("general") or []:
                t = _normalize_task(item)
                if t:
                    out.append(t)
            return out
        return [_normalize_task(raw)] if _normalize_task(raw) else []
    return []


def _priority_rank(p: str) -> int:
    return {"p1": 0, "p2": 1, "p3": 2, "none": 3}.get(p, 3)


def _sort_tasks(tasks: list[dict]) -> list[dict]:
    """Open tasks first (priority → deadline → text), then done tasks in the same order."""

    def key(t: dict) -> tuple:
        done = 1 if t.get("done") else 0
        pr = _priority_rank(str(t.get("priority") or "none"))
        dl = t.get("deadline") or "9999-99-99"
        return (done, pr, dl, t.get("text", ""))

    return sorted(tasks, key=key)


def _tasks_for_date(store: dict, d: date) -> list[dict]:
    key = d.isoformat()
    return _sort_tasks(_normalize_day_tasks(store.get(key)))


def _save_tasks_for_date(store: dict, d: date, tasks: list[dict]) -> None:
    store[d.isoformat()] = _sort_tasks(tasks)


def _tasks_future(store: dict) -> list[dict]:
    return _sort_tasks(_normalize_day_tasks(store.get(FUTURE_KEY)))


def _save_tasks_future(store: dict, tasks: list[dict]) -> None:
    store[FUTURE_KEY] = _clean_task_list(tasks)


def _find_task_by_id(tasks: list[dict], task_id: str) -> tuple[int | None, dict | None]:
    for i, t in enumerate(tasks):
        if t.get("id") == task_id:
            return i, t
    return None, None


def _todo_stats_for_window(store: dict, window_days: int = 30) -> dict:
    label_by_id = {c["id"]: c["label"] for c in CATEGORIES}
    today = _today()
    start = today - timedelta(days=window_days - 1)
    days_out: list[dict] = []
    tasks_recorded = 0
    done_recorded = 0
    task_by_cat: dict[str, int] = {}
    days_with_tasks = 0
    d = start
    while d <= today:
        tasks = _normalize_day_tasks(store.get(d.isoformat()))
        if tasks:
            days_with_tasks += 1
        n = len(tasks)
        dn = sum(1 for t in tasks if t.get("done"))
        tasks_recorded += n
        done_recorded += dn
        for t in tasks:
            cid = str(t.get("category") or DEFAULT_TASK_CATEGORY)
            if cid not in CATEGORY_IDS:
                cid = DEFAULT_TASK_CATEGORY
            task_by_cat[cid] = task_by_cat.get(cid, 0) + 1
        days_out.append(
            {
                "date": d.isoformat(),
                "total": n,
                "done": dn,
                "open": n - dn,
            }
        )
        d += timedelta(days=1)

    for t in _normalize_day_tasks(store.get(FUTURE_KEY)):
        tasks_recorded += 1
        if t.get("done"):
            done_recorded += 1
        cid = str(t.get("category") or DEFAULT_TASK_CATEGORY)
        if cid not in CATEGORY_IDS:
            cid = DEFAULT_TASK_CATEGORY
        task_by_cat[cid] = task_by_cat.get(cid, 0) + 1

    completion = round(100 * done_recorded / tasks_recorded, 1) if tasks_recorded else 0.0
    tbc = sorted(task_by_cat.items(), key=lambda x: -x[1])
    task_cat_rows = []
    for k, v in tbc:
        task_cat_rows.append(
            {
                "id": k,
                "label": label_by_id.get(k, k),
                "count": v,
                "pct": round(100 * v / tasks_recorded, 1) if tasks_recorded else 0.0,
            }
        )

    yest = today - timedelta(days=1)
    carryover_open = sum(
        1 for t in _normalize_day_tasks(store.get(yest.isoformat())) if not t.get("done")
    )

    with_tasks = [row for row in days_out if int(row.get("total", 0) or 0) > 0]

    return {
        "windowDays": window_days,
        "daysWithTasks": days_with_tasks,
        "tasksRecorded": tasks_recorded,
        "doneRecorded": done_recorded,
        "completionRate": completion,
        "taskByCategory": task_cat_rows,
        "carryoverOpenNow": carryover_open,
        "byDay": with_tasks[-14:],
    }


@app.route("/")
def index():
    return send_from_directory(STATIC, "index.html")


@app.route("/robots.txt")
def robots():
    return Response("User-agent: *\nDisallow: /\n", mimetype="text/plain")


@app.route("/api/meta")
def meta():
    today = _today()
    return jsonify(
        {
            "categories": CATEGORIES,
            "today": today.isoformat(),
            "tomorrow": (today + timedelta(days=1)).isoformat(),
        }
    )


@app.route("/api/today", methods=["GET"])
def get_today():
    d = _today()
    day = _load_day(d)
    return jsonify({"date": d.isoformat(), "entries": day.get("entries", [])})


def _parse_duration(body: dict) -> tuple[int | None, str | None]:
    """Total minutes from optional hours + minutes; at least one required."""
    raw_h = body.get("hours")
    raw_m = body.get("minutes")
    try:
        hours = float(raw_h) if raw_h not in (None, "") else 0.0
    except (TypeError, ValueError):
        return None, "invalid hours"
    try:
        minutes = int(raw_m) if raw_m not in (None, "") else 0
    except (TypeError, ValueError):
        return None, "invalid minutes"
    if hours < 0 or hours > 24:
        return None, "hours must be 0–24"
    if minutes < 0 or minutes >= 24 * 60:
        return None, "minutes must be 0–1439"
    total = int(round(hours * 60)) + minutes
    if total <= 0 or total > 24 * 60:
        return None, "total duration must be 1–1440 minutes (use hours and/or minutes)"
    return total, None


@app.route("/api/today/entry", methods=["POST"])
def add_entry():
    body = request.get_json(force=True, silent=True) or {}
    total, err = _parse_duration(body)
    if err:
        return jsonify({"error": err}), 400
    category = (body.get("category") or "").strip()
    note = (body.get("note") or "").strip()

    valid = {c["id"] for c in CATEGORIES}
    if category not in valid:
        return jsonify({"error": "invalid category"}), 400

    d = _today()
    day = _load_day(d)
    entries = day.get("entries", [])
    src = body.get("source_task_id") or body.get("sourceTaskId")
    entry: dict = {
        "minutes": total,
        "category": category,
        "note": note,
        "logged_at": _now_iso(),
    }
    if isinstance(src, str) and src.strip():
        entry["source_task_id"] = src.strip()[:128]
    entries.append(entry)
    _save_day(d, {"entries": entries})
    return jsonify({"ok": True, "entries": entries})


@app.route("/api/today/entry/<int:index>", methods=["PUT"])
def update_entry(index: int):
    body = request.get_json(force=True, silent=True) or {}
    total, err = _parse_duration(body)
    if err:
        return jsonify({"error": err}), 400
    category = (body.get("category") or "").strip()
    note = (body.get("note") or "").strip()
    valid = {c["id"] for c in CATEGORIES}
    if category not in valid:
        return jsonify({"error": "invalid category"}), 400

    d = _today()
    day = _load_day(d)
    entries = day.get("entries", [])
    if index < 0 or index >= len(entries):
        return jsonify({"error": "not found"}), 404

    prev = entries[index]
    entry: dict = {
        "minutes": total,
        "category": category,
        "note": note,
        "logged_at": prev.get("logged_at")
        or _now_iso(),
    }
    src = body.get("source_task_id") or body.get("sourceTaskId")
    if src is None and "source_task_id" in prev:
        entry["source_task_id"] = prev["source_task_id"]
    elif isinstance(src, str) and src.strip():
        entry["source_task_id"] = src.strip()[:128]
    entries[index] = entry
    _save_day(d, {"entries": entries})
    return jsonify({"ok": True, "entries": entries})


@app.route("/api/today/entry/<int:index>", methods=["DELETE"])
def delete_entry(index: int):
    d = _today()
    day = _load_day(d)
    entries = day.get("entries", [])
    if index < 0 or index >= len(entries):
        return jsonify({"error": "not found"}), 404
    entries.pop(index)
    _save_day(d, {"entries": entries})
    return jsonify({"ok": True, "entries": entries})


@app.route("/api/todos", methods=["GET"])
def get_todos():
    today = _today()
    tk = today.isoformat()
    mk = (today + timedelta(days=1)).isoformat()
    yk = (today - timedelta(days=1)).isoformat()
    store = _load_todos()
    yesterday_open: list[dict] = []
    for t in _tasks_for_date(store, today - timedelta(days=1)):
        if not t.get("done"):
            yesterday_open.append(dict(t))
    return jsonify(
        {
            "today": _tasks_for_date(store, today),
            "tomorrow": _tasks_for_date(store, today + timedelta(days=1)),
            "future": _tasks_future(store),
            "carryover": {
                "sourceDate": yk,
                "tasks": yesterday_open,
            },
            "todayKey": tk,
            "tomorrowKey": mk,
            "yesterdayKey": yk,
        }
    )


def _clean_task_list(arr) -> list[dict]:
    out: list[dict] = []
    for x in arr or []:
        t = _normalize_task(x)
        if t:
            out.append(t)
    return _sort_tasks(out)


@app.route("/api/todos", methods=["POST"])
def save_todos():
    body = request.get_json(force=True, silent=True) or {}
    if not isinstance(body, dict):
        return jsonify({"error": "invalid body"}), 400

    today = _today()
    tk = today.isoformat()
    mk = (today + timedelta(days=1)).isoformat()
    store = _load_todos()

    if "today" in body or "tomorrow" in body or "future" in body:
        if "today" in body:
            tlist = body.get("today")
            if not isinstance(tlist, list):
                return jsonify({"error": "today must be an array"}), 400
            _save_tasks_for_date(store, today, _clean_task_list(tlist))
        if "tomorrow" in body:
            tlist = body.get("tomorrow")
            if not isinstance(tlist, list):
                return jsonify({"error": "tomorrow must be an array"}), 400
            _save_tasks_for_date(store, today + timedelta(days=1), _clean_task_list(tlist))
        if "future" in body:
            tlist = body.get("future")
            if not isinstance(tlist, list):
                return jsonify({"error": "future must be an array"}), 400
            _save_tasks_future(store, tlist)
        _save_todos(store)
        return jsonify({"ok": True})

    which = body.get("which")
    items = body.get("items")
    if which not in ("today", "tomorrow") or not isinstance(items, list):
        return jsonify({"error": "invalid body"}), 400
    key_date = today if which == "today" else today + timedelta(days=1)
    cleaned = [str(x).strip() for x in items if str(x).strip()]
    tasks = [
        {
            "id": _new_task_id(),
            "text": t,
            "priority": "none",
            "deadline": None,
            "done": False,
            "category": DEFAULT_TASK_CATEGORY,
        }
        for t in cleaned
    ]
    _save_tasks_for_date(store, key_date, tasks)
    _save_todos(store)
    return jsonify({"ok": True})


@app.route("/api/todos/carryover", methods=["POST"])
def carryover_action():
    """Handle unfinished tasks from yesterday: done, delete, or move into today."""
    body = request.get_json(force=True, silent=True) or {}
    action = (body.get("action") or "").strip()
    source_date_s = (body.get("sourceDate") or "").strip()
    task_id = (body.get("taskId") or "").strip()
    if action not in ("done", "delete", "toToday") or not source_date_s or not task_id:
        return jsonify({"error": "need action, sourceDate, taskId"}), 400
    try:
        source_d = date.fromisoformat(source_date_s)
    except ValueError:
        return jsonify({"error": "invalid sourceDate"}), 400

    today = _today()
    if source_d != today - timedelta(days=1):
        return jsonify({"error": "carryover only supported for yesterday"}), 400

    store = _load_todos()
    ykey = source_d.isoformat()
    tasks = _normalize_day_tasks(store.get(ykey))
    idx, found = _find_task_by_id(tasks, task_id)
    if idx is None or found is None:
        return jsonify({"error": "task not found"}), 404

    if action == "done":
        tasks[idx] = {**found, "done": True}
    elif action == "delete":
        tasks.pop(idx)
    else:
        moved = dict(found)
        moved["done"] = False
        tasks.pop(idx)
        today_tasks = _tasks_for_date(store, today)
        today_tasks.append(moved)
        _save_tasks_for_date(store, today, today_tasks)

    _save_tasks_for_date(store, source_d, tasks)
    _save_todos(store)
    return jsonify({"ok": True})


def _collect_days_for_analytics(max_days: int = 30) -> list[dict]:
    data = _data_dir()
    if not data.exists():
        return []
    files = sorted(data.glob("*.json"), reverse=True)
    days: list[dict] = []
    for p in files:
        if p.name == "todos.json":
            continue
        try:
            d = date.fromisoformat(p.stem)
        except ValueError:
            continue
        with open(p, encoding="utf-8") as f:
            raw = json.load(f)
        days.append({"date": d, "entries": raw.get("entries", [])})
        if len(days) >= max_days:
            break
    return days


@app.route("/api/analytics", methods=["GET"])
def analytics():
    """Time roll-up + todo intentions over the last 30 days."""
    label_by_id = {c["id"]: c["label"] for c in CATEGORIES}
    days_data = _collect_days_for_analytics(30)
    store = _load_todos()
    todo_stats = _todo_stats_for_window(store, 30)

    if not days_data:
        return jsonify(
            {
                "windowDays": 30,
                "daysWithLogs": 0,
                "totalMinutes": 0,
                "avgMinutesOnLoggedDays": 0,
                "byCategory": [],
                "recentDailyTotals": [],
                "todoStats": todo_stats,
            }
        )

    by_cat: dict[str, int] = {}
    total = 0
    recent_daily: list[dict] = []
    days_with = 0
    for row in days_data:
        entries = row["entries"]
        day_total = sum(int(e.get("minutes", 0)) for e in entries)
        recent_daily.append({"date": row["date"].isoformat(), "totalMinutes": day_total})
        if day_total > 0:
            days_with += 1
        total += day_total
        for e in entries:
            cid = e.get("category", "other")
            by_cat[cid] = by_cat.get(cid, 0) + int(e.get("minutes", 0))

    avg = int(round(total / days_with)) if days_with else 0
    by_list = sorted(by_cat.items(), key=lambda x: -x[1])
    by_category = [
        {
            "id": k,
            "label": label_by_id.get(k, k),
            "minutes": v,
            "pctOfTotal": round(100 * v / total, 1) if total else 0,
        }
        for k, v in by_list
    ]

    recent_filtered = [r for r in recent_daily if int(r.get("totalMinutes", 0) or 0) > 0][:14]
    return jsonify(
        {
            "windowDays": 30,
            "daysWithLogs": days_with,
            "totalMinutes": total,
            "avgMinutesOnLoggedDays": avg,
            "byCategory": by_category,
            "recentDailyTotals": recent_filtered,
            "todoStats": todo_stats,
        }
    )


@app.route("/api/history", methods=["GET"])
def history():
    """Last 14 days of files: totals + breakdown by category."""
    data = _data_dir()
    if not data.exists():
        return jsonify({"days": []})
    files = sorted(data.glob("*.json"), reverse=True)
    label_by_id = {c["id"]: c["label"] for c in CATEGORIES}
    days = []
    for p in files:
        if p.name == "todos.json":
            continue
        try:
            d = date.fromisoformat(p.stem)
        except ValueError:
            continue
        with open(p, encoding="utf-8") as f:
            raw = json.load(f)
        entries = raw.get("entries", [])
        total = sum(e.get("minutes", 0) for e in entries)
        by_cat: dict[str, int] = {}
        for e in entries:
            cid = e.get("category", "other")
            by_cat[cid] = by_cat.get(cid, 0) + int(e.get("minutes", 0))
        days.append(
            {
                "date": d.isoformat(),
                "totalMinutes": total,
                "entryCount": len(entries),
                "byCategory": [
                    {
                        "id": k,
                        "label": label_by_id.get(k, k),
                        "minutes": v,
                    }
                    for k, v in sorted(by_cat.items(), key=lambda x: -x[1])
                ],
                "entries": entries,
            }
        )
        if len(days) >= 14:
            break
    return jsonify({"days": days})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8765"))
    host = "0.0.0.0" if os.environ.get("APP_ENV") == "production" else "127.0.0.1"
    app.run(host=host, port=port, debug=False)
