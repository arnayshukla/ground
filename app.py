"""
Minimal daily time + todos. Data lives in DATA_DIR as JSON (default: ./data).
Run: python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && python app.py
"""

from __future__ import annotations

import hmac
import json
import os
import re
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from flask import Flask, Response, jsonify, request, send_from_directory

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DEFAULT_TIMEZONE = "Asia/Kolkata"

DEFAULT_CATEGORIES = [
    {"id": "deep_work", "label": "Deep work", "enabled": True},
    {"id": "meetings", "label": "Meetings & sync", "enabled": True},
    {"id": "review", "label": "Code & design review", "enabled": True},
    {"id": "docs", "label": "Docs & RFCs", "enabled": True},
    {"id": "planning", "label": "Planning & estimation", "enabled": True},
    {"id": "research", "label": "Research & spikes", "enabled": True},
    {"id": "strategy", "label": "Strategy & roadmap", "enabled": True},
    {"id": "mentoring", "label": "Mentoring & 1:1s", "enabled": True},
    {"id": "incident", "label": "Incidents & RCA", "enabled": True},
    {"id": "oncall", "label": "On-call", "enabled": True},
    {"id": "admin", "label": "Admin & comms", "enabled": True},
]

DEFAULT_TASK_CATEGORY = DEFAULT_CATEGORIES[0]["id"]

PRIORITIES = frozenset({"p1", "p2", "p3", "none"})

# Undated backlog bucket in todos.json (not a calendar date key).
FUTURE_KEY = "__future__"
SCRIBBLE_KEY = "__scribbles__"
NO_PROJECT_ID = "__no_project__"

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


def _categories_path() -> Path:
    data = _data_dir()
    data.mkdir(parents=True, exist_ok=True)
    return data / "categories.json"


def _slugify_category_id(label: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")
    return slug[:48] or f"category_{uuid.uuid4().hex[:8]}"


def _normalize_category(obj) -> dict:
    if not isinstance(obj, dict):
        return {}
    label = str(obj.get("label") or "").strip()
    if not label:
        return {}
    cid = str(obj.get("id") or "").strip().lower()
    if not cid:
        cid = _slugify_category_id(label)
    cid = re.sub(r"[^a-z0-9_]+", "_", cid).strip("_")[:64]
    if not cid:
        cid = _slugify_category_id(label)
    return {
        "id": cid,
        "label": label[:80],
        "enabled": bool(obj.get("enabled", True)),
    }


def _dedupe_categories(categories: list[dict]) -> list[dict]:
    out: list[dict] = []
    seen: set[str] = set()
    for raw in categories:
        cat = _normalize_category(raw)
        if not cat:
            continue
        base = cat["id"]
        cid = base
        n = 2
        while cid in seen:
            cid = f"{base}_{n}"
            n += 1
        cat["id"] = cid
        seen.add(cid)
        out.append(cat)
    return out


def _load_categories() -> list[dict]:
    p = _categories_path()
    if not p.exists():
        return [dict(c) for c in DEFAULT_CATEGORIES]
    with open(p, encoding="utf-8") as f:
        raw = json.load(f)
    if not isinstance(raw, list):
        return [dict(c) for c in DEFAULT_CATEGORIES]
    categories = _dedupe_categories(raw)
    return categories or [dict(c) for c in DEFAULT_CATEGORIES]


def _save_categories(categories: list[dict]) -> None:
    with open(_categories_path(), "w", encoding="utf-8") as f:
        json.dump(_dedupe_categories(categories), f, indent=2)


def _category_ids(include_disabled: bool = True) -> set[str]:
    categories = _load_categories()
    if include_disabled:
        return {c["id"] for c in categories}
    return {c["id"] for c in categories if c.get("enabled", True)}


def _default_category_id() -> str:
    categories = _load_categories()
    for cat in categories:
        if cat.get("enabled", True):
            return cat["id"]
    return categories[0]["id"] if categories else DEFAULT_TASK_CATEGORY


def _category_label_by_id() -> dict[str, str]:
    return {c["id"]: c["label"] for c in _load_categories()}


def _projects_path() -> Path:
    data = _data_dir()
    data.mkdir(parents=True, exist_ok=True)
    return data / "projects.json"


def _slugify_project_id(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    return slug[:48] or f"project_{uuid.uuid4().hex[:8]}"


def _parse_iso_date(value, field: str) -> tuple[str | None, str | None]:
    if value in (None, ""):
        return None, None
    try:
        parsed = date.fromisoformat(str(value)[:10])
    except ValueError:
        return None, f"invalid {field}"
    return parsed.isoformat(), None


def _normalize_project(obj) -> dict:
    if not isinstance(obj, dict):
        return {}
    name = str(obj.get("name") or "").strip()
    if not name:
        return {}
    start_date, start_err = _parse_iso_date(obj.get("start_date") or _today().isoformat(), "start_date")
    if start_err or not start_date:
        start_date = _today().isoformat()
    end_date, _ = _parse_iso_date(obj.get("end_date"), "end_date")
    pid = str(obj.get("id") or "").strip().lower()
    if not pid:
        pid = _slugify_project_id(name)
    pid = re.sub(r"[^a-z0-9_]+", "_", pid).strip("_")[:64]
    if not pid:
        pid = _slugify_project_id(name)
    return {
        "id": pid,
        "name": name[:100],
        "start_date": start_date,
        "end_date": end_date,
        "archived": bool(obj.get("archived", False)),
    }


def _dedupe_projects(projects: list[dict]) -> list[dict]:
    out: list[dict] = []
    seen: set[str] = set()
    for raw in projects:
        project = _normalize_project(raw)
        if not project:
            continue
        base = project["id"]
        pid = base
        n = 2
        while pid in seen:
            pid = f"{base}_{n}"
            n += 1
        project["id"] = pid
        seen.add(pid)
        out.append(project)
    return out


def _load_projects() -> list[dict]:
    p = _projects_path()
    if not p.exists():
        return []
    with open(p, encoding="utf-8") as f:
        raw = json.load(f)
    if not isinstance(raw, list):
        return []
    return _dedupe_projects(raw)


def _save_projects(projects: list[dict]) -> None:
    with open(_projects_path(), "w", encoding="utf-8") as f:
        json.dump(_dedupe_projects(projects), f, indent=2)


def _project_label_by_id() -> dict[str, str]:
    return {p["id"]: p["name"] for p in _load_projects()}


def _clean_project_ids(raw) -> list[str]:
    if raw is None:
        return []
    values = raw if isinstance(raw, list) else [raw]
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        pid = str(value or "").strip().lower()
        pid = re.sub(r"[^a-z0-9_]+", "_", pid).strip("_")[:64]
        if not pid or pid in seen:
            continue
        seen.add(pid)
        out.append(pid)
    return out


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
            "note": "",
            "priority": "none",
            "deadline": None,
            "done": False,
            "category": _default_category_id(),
            "project_ids": [],
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
    if not cat:
        cat = _default_category_id()
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
    note = str(obj.get("note", "")).strip()[:500]
    project_ids = _clean_project_ids(obj.get("project_ids") or obj.get("projectIds"))
    return {
        "id": tid,
        "text": text,
        "note": note,
        "priority": pr,
        "deadline": dl,
        "done": done,
        "category": cat,
        "project_ids": project_ids,
    }


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


def _scribble_for_date(store: dict, d: date) -> str:
    raw = store.get(SCRIBBLE_KEY)
    if not isinstance(raw, dict):
        return ""
    return str(raw.get(d.isoformat()) or "")


def _save_scribble_for_date(store: dict, d: date, text: str) -> None:
    raw = store.get(SCRIBBLE_KEY)
    scribbles = raw if isinstance(raw, dict) else {}
    cleaned = str(text or "").strip()[:5000]
    if cleaned:
        scribbles[d.isoformat()] = cleaned
    else:
        scribbles.pop(d.isoformat(), None)
    if scribbles:
        store[SCRIBBLE_KEY] = scribbles
    else:
        store.pop(SCRIBBLE_KEY, None)


def _find_task_by_id(tasks: list[dict], task_id: str) -> tuple[int | None, dict | None]:
    for i, t in enumerate(tasks):
        if t.get("id") == task_id:
            return i, t
    return None, None


def _todo_stats_for_window(store: dict, window_days: int = 30) -> dict:
    label_by_id = _category_label_by_id()
    valid_categories = _category_ids(include_disabled=True)
    default_category = _default_category_id()
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
            cid = str(t.get("category") or default_category)
            if not cid:
                cid = default_category
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
        cid = str(t.get("category") or default_category)
        if not cid:
            cid = default_category
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


def _project_highlights(days_data: list[dict], store: dict, window_days: int = 30) -> list[dict]:
    projects = _load_projects()
    project_by_id = {p["id"]: p for p in projects}
    rows: dict[str, dict] = {}

    def ensure(pid: str) -> dict:
        project = project_by_id.get(pid)
        if pid == NO_PROJECT_ID:
            label = "No project"
            active = True
            start_date = None
            end_date = None
        elif project:
            label = project["name"]
            end_date = project.get("end_date")
            active = not project.get("archived") and not end_date
            start_date = project.get("start_date")
        else:
            label = pid
            active = False
            start_date = None
            end_date = None
        if pid not in rows:
            rows[pid] = {
                "id": pid,
                "label": label,
                "active": active,
                "startDate": start_date,
                "endDate": end_date,
                "totalMinutes": 0,
                "entryCount": 0,
                "openTasks": 0,
                "doneTasks": 0,
                "recentNotes": [],
            }
        return rows[pid]

    for day in days_data:
        for entry in day.get("entries", []):
            pids = _clean_project_ids(entry.get("project_ids") or entry.get("projectIds"))
            if not pids:
                pids = [NO_PROJECT_ID]
            for pid in pids:
                row = ensure(pid)
                row["totalMinutes"] += int(entry.get("minutes", 0) or 0)
                row["entryCount"] += 1
                note = str(entry.get("note") or "").strip()
                if note and len(row["recentNotes"]) < 3:
                    row["recentNotes"].append(
                        {
                            "date": day["date"].isoformat(),
                            "note": note[:160],
                        }
                    )

    today = _today()
    start = today - timedelta(days=window_days - 1)
    d = start
    while d <= today:
        for task in _normalize_day_tasks(store.get(d.isoformat())):
            pids = _clean_project_ids(task.get("project_ids") or task.get("projectIds"))
            if not pids:
                pids = [NO_PROJECT_ID]
            for pid in pids:
                row = ensure(pid)
                if task.get("done"):
                    row["doneTasks"] += 1
                else:
                    row["openTasks"] += 1
        d += timedelta(days=1)

    for task in _normalize_day_tasks(store.get(FUTURE_KEY)):
        pids = _clean_project_ids(task.get("project_ids") or task.get("projectIds"))
        if not pids:
            pids = [NO_PROJECT_ID]
        for pid in pids:
            row = ensure(pid)
            if task.get("done"):
                row["doneTasks"] += 1
            else:
                row["openTasks"] += 1

    return sorted(
        rows.values(),
        key=lambda r: (
            r["id"] == NO_PROJECT_ID,
            not r["active"],
            -(r["totalMinutes"] + r["openTasks"] * 60 + r["doneTasks"] * 20),
            r["label"].lower(),
        ),
    )


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
            "categories": _load_categories(),
            "projects": _load_projects(),
            "today": today.isoformat(),
            "tomorrow": (today + timedelta(days=1)).isoformat(),
        }
    )


@app.route("/api/categories", methods=["GET"])
def get_categories():
    return jsonify({"categories": _load_categories()})


@app.route("/api/categories", methods=["POST"])
def create_category():
    body = request.get_json(force=True, silent=True) or {}
    label = str(body.get("label") or "").strip()
    if not label:
        return jsonify({"error": "label is required"}), 400
    categories = _load_categories()
    existing = {c["id"] for c in categories}
    base = _slugify_category_id(label)
    cid = base
    n = 2
    while cid in existing:
        cid = f"{base}_{n}"
        n += 1
    categories.append({"id": cid, "label": label[:80], "enabled": True})
    _save_categories(categories)
    return jsonify({"ok": True, "categories": _load_categories()}), 201


@app.route("/api/categories/<category_id>", methods=["PUT"])
def update_category(category_id: str):
    body = request.get_json(force=True, silent=True) or {}
    categories = _load_categories()
    for cat in categories:
        if cat["id"] != category_id:
            continue
        if "label" in body:
            label = str(body.get("label") or "").strip()
            if not label:
                return jsonify({"error": "label is required"}), 400
            cat["label"] = label[:80]
        if "enabled" in body:
            cat["enabled"] = bool(body.get("enabled"))
        _save_categories(categories)
        return jsonify({"ok": True, "categories": _load_categories()})
    return jsonify({"error": "not found"}), 404


@app.route("/api/categories/<category_id>", methods=["DELETE"])
def delete_category(category_id: str):
    categories = _load_categories()
    next_categories = [c for c in categories if c["id"] != category_id]
    if len(next_categories) == len(categories):
        return jsonify({"error": "not found"}), 404
    if not next_categories:
        return jsonify({"error": "at least one category is required"}), 400
    _save_categories(next_categories)
    return jsonify({"ok": True, "categories": _load_categories()})


@app.route("/api/projects", methods=["GET"])
def get_projects():
    return jsonify({"projects": _load_projects()})


@app.route("/api/projects", methods=["POST"])
def create_project():
    body = request.get_json(force=True, silent=True) or {}
    name = str(body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name is required"}), 400
    start_date, err = _parse_iso_date(body.get("start_date") or body.get("startDate") or _today().isoformat(), "start_date")
    if err or not start_date:
        return jsonify({"error": err or "start_date is required"}), 400
    end_date, err = _parse_iso_date(body.get("end_date") or body.get("endDate"), "end_date")
    if err:
        return jsonify({"error": err}), 400
    projects = _load_projects()
    existing = {p["id"] for p in projects}
    base = _slugify_project_id(name)
    pid = base
    n = 2
    while pid in existing:
        pid = f"{base}_{n}"
        n += 1
    projects.append(
        {
            "id": pid,
            "name": name[:100],
            "start_date": start_date,
            "end_date": end_date,
            "archived": bool(body.get("archived", False)),
        }
    )
    _save_projects(projects)
    return jsonify({"ok": True, "projects": _load_projects()}), 201


@app.route("/api/projects/<project_id>", methods=["PUT"])
def update_project(project_id: str):
    body = request.get_json(force=True, silent=True) or {}
    projects = _load_projects()
    for project in projects:
        if project["id"] != project_id:
            continue
        if "name" in body:
            name = str(body.get("name") or "").strip()
            if not name:
                return jsonify({"error": "name is required"}), 400
            project["name"] = name[:100]
        if "start_date" in body or "startDate" in body:
            start_date, err = _parse_iso_date(body.get("start_date") or body.get("startDate"), "start_date")
            if err or not start_date:
                return jsonify({"error": err or "start_date is required"}), 400
            project["start_date"] = start_date
        if "end_date" in body or "endDate" in body:
            end_date, err = _parse_iso_date(body.get("end_date") if "end_date" in body else body.get("endDate"), "end_date")
            if err:
                return jsonify({"error": err}), 400
            project["end_date"] = end_date
        if "archived" in body:
            project["archived"] = bool(body.get("archived"))
        _save_projects(projects)
        return jsonify({"ok": True, "projects": _load_projects()})
    return jsonify({"error": "not found"}), 404


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
    project_ids = _clean_project_ids(body.get("project_ids") or body.get("projectIds"))

    valid = _category_ids(include_disabled=True)
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
        "project_ids": project_ids,
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
    valid = _category_ids(include_disabled=True)
    if category not in valid:
        return jsonify({"error": "invalid category"}), 400

    d = _today()
    day = _load_day(d)
    entries = day.get("entries", [])
    if index < 0 or index >= len(entries):
        return jsonify({"error": "not found"}), 404

    prev = entries[index]
    if "project_ids" in body or "projectIds" in body:
        project_ids = _clean_project_ids(body.get("project_ids") or body.get("projectIds"))
    else:
        project_ids = _clean_project_ids(prev.get("project_ids") or prev.get("projectIds"))
    entry: dict = {
        "minutes": total,
        "category": category,
        "note": note,
        "project_ids": project_ids,
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
            "scribble": _scribble_for_date(store, today),
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

    if "today" in body or "tomorrow" in body or "future" in body or "scribble" in body:
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
        if "scribble" in body:
            _save_scribble_for_date(store, today, body.get("scribble") or "")
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
            "note": "",
            "priority": "none",
            "deadline": None,
            "done": False,
            "category": _default_category_id(),
            "project_ids": [],
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
        if p.name in ("todos.json", "categories.json", "projects.json"):
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
    label_by_id = _category_label_by_id()
    days_data = _collect_days_for_analytics(30)
    store = _load_todos()
    todo_stats = _todo_stats_for_window(store, 30)
    project_highlights = _project_highlights(days_data, store, 30)

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
                "projectHighlights": project_highlights,
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
            "projectHighlights": project_highlights,
        }
    )


@app.route("/api/history", methods=["GET"])
def history():
    """Last 14 days of files: totals + breakdown by category."""
    data = _data_dir()
    if not data.exists():
        return jsonify({"days": []})
    files = sorted(data.glob("*.json"), reverse=True)
    label_by_id = _category_label_by_id()
    days = []
    for p in files:
        if p.name in ("todos.json", "categories.json", "projects.json"):
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
