const $ = (id) => document.getElementById(id);

let categories = [];
let labelById = {};
let todayIso = "";
let tomorrowIso = "";

let draggingTodoRow = null;

function newTaskId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `t-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function fmtDate(iso) {
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function fmtDuration(minutes) {
  const n = Number(minutes) || 0;
  const h = Math.floor(n / 60);
  const m = n % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

function fmtClock(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function fmtGapBetween(prevIso, curIso) {
  if (!prevIso || !curIso) return "";
  const a = new Date(prevIso);
  const b = new Date(curIso);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return "";
  const mins = Math.round((b - a) / 60000);
  if (mins < 0) return "";
  if (mins < 60) return `${mins}m since last`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h${m ? ` ${m}m` : ""} since last`;
}

function daysFromTodayTo(deadlineIso) {
  const a = new Date();
  a.setHours(0, 0, 0, 0);
  const b = new Date(deadlineIso + "T12:00:00");
  b.setHours(0, 0, 0, 0);
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function fmtDeadlineLabel(iso) {
  if (!iso) return "None";
  return new Date(iso + "T12:00:00").toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function fmtDeadlineRemaining(iso) {
  if (!iso) return "—";
  return `${daysFromTodayTo(iso)}d`;
}

function openDatePicker(input) {
  if (typeof input.showPicker === "function") {
    input.showPicker();
  } else {
    input.click();
  }
}

function calendarIconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;
}

function buildDeadlineRow(task, rowForReorder) {
  const dueRow = document.createElement("div");
  dueRow.className = "chip-row deadline-row";
  const hint = document.createElement("span");
  hint.className = "chip-hint";
  hint.textContent = "Deadline";
  dueRow.appendChild(hint);

  const cluster = document.createElement("div");
  cluster.className = "deadline-cluster";

  const display = document.createElement("button");
  display.type = "button";
  display.className = "deadline-display";

  const calBtn = document.createElement("button");
  calBtn.type = "button";
  calBtn.className = "btn-calendar";
  calBtn.setAttribute("aria-label", "Open calendar");
  calBtn.innerHTML = calendarIconSvg();

  const countdown = document.createElement("span");
  countdown.className = "deadline-countdown";

  const dateInp = document.createElement("input");
  dateInp.type = "date";
  dateInp.className = "due-date sr-picker";
  dateInp.setAttribute("aria-label", "Deadline date");
  dateInp.value = task.deadline || "";

  function sync() {
    const v = dateInp.value;
    display.textContent = fmtDeadlineLabel(v);
    display.classList.toggle("is-placeholder", !v);
    countdown.textContent = fmtDeadlineRemaining(v);
  }

  display.title =
    "Empty: open calendar. When a date is set: click to clear.";
  display.addEventListener("click", () => {
    if (dateInp.value) {
      dateInp.value = "";
      sync();
      if (rowForReorder) reorderTodoPaneFromRow(rowForReorder);
      scheduleTodoSave();
    } else {
      openDatePicker(dateInp);
    }
  });
  calBtn.addEventListener("click", (e) => {
    e.preventDefault();
    openDatePicker(dateInp);
  });
  dateInp.addEventListener("change", () => {
    sync();
    scheduleTodoSave();
    if (rowForReorder) reorderTodoPaneFromRow(rowForReorder);
  });

  cluster.appendChild(display);
  cluster.appendChild(calBtn);
  cluster.appendChild(countdown);
  dueRow.appendChild(cluster);
  dueRow.appendChild(dateInp);
  sync();
  return dueRow;
}

function totalMinutes(entries) {
  return entries.reduce((s, e) => s + (e.minutes || 0), 0);
}

async function api(path, opts) {
  const r = await fetch(path, {
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    ...opts,
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(t || r.statusText);
  }
  if (r.status === 204) return null;
  return r.json();
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function categoryOptions() {
  return categories.map((c) => ({ id: c.id, label: c.label }));
}

function defaultCategoryId() {
  return categories[0]?.id || "deep_work";
}

function closeAllCustomDd() {
  document.querySelectorAll(".custom-dd.is-open").forEach((wrap) => {
    wrap.classList.remove("is-open");
    const btn = wrap.querySelector(".custom-dd-btn");
    if (btn) btn.setAttribute("aria-expanded", "false");
    const list = wrap.querySelector(".custom-dd-list");
    if (list) list.classList.add("hidden");
  });
}

function mountCustomDd(container, { hiddenId, hiddenClass, initialValue, compact, onChange }) {
  const opts = categoryOptions();
  if (!opts.length || !container) return;
  const val = opts.some((o) => o.id === initialValue) ? initialValue : opts[0].id;
  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "custom-dd" + (compact ? " custom-dd-compact" : "");
  wrap.addEventListener("click", (e) => e.stopPropagation());

  const hid = document.createElement("input");
  hid.type = "hidden";
  if (hiddenId) hid.id = hiddenId;
  hid.className = ["custom-dd-value", hiddenClass || ""].filter(Boolean).join(" ");
  hid.value = val;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "custom-dd-btn";
  btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("aria-expanded", "false");
  const labEl = document.createElement("span");
  labEl.className = "custom-dd-label";
  const caret = document.createElement("span");
  caret.className = "custom-dd-caret";
  caret.setAttribute("aria-hidden", "true");
  caret.textContent = "▾";
  btn.appendChild(labEl);
  btn.appendChild(caret);

  const ul = document.createElement("ul");
  ul.className = "custom-dd-list hidden";
  ul.setAttribute("role", "listbox");

  function syncLabel() {
    const cur = opts.find((o) => o.id === hid.value);
    labEl.textContent = cur ? cur.label : hid.value;
  }
  syncLabel();

  opts.forEach((o) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.dataset.value = o.id;
    li.textContent = o.label;
    if (o.id === hid.value) li.classList.add("is-selected");
    li.addEventListener("click", (e) => {
      e.stopPropagation();
      hid.value = o.id;
      ul.querySelectorAll("li").forEach((x) => x.classList.toggle("is-selected", x.dataset.value === o.id));
      syncLabel();
      closeAllCustomDd();
      if (onChange) onChange(o.id);
    });
    ul.appendChild(li);
  });

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const opening = !wrap.classList.contains("is-open");
    closeAllCustomDd();
    if (opening) {
      wrap.classList.add("is-open");
      ul.classList.remove("hidden");
      btn.setAttribute("aria-expanded", "true");
    }
  });

  wrap.appendChild(hid);
  wrap.appendChild(btn);
  wrap.appendChild(ul);
  container.appendChild(wrap);
}

function mountTimeCategoryDd() {
  mountCustomDd($("time-category-mount"), {
    hiddenId: "category",
    hiddenClass: "",
    initialValue: defaultCategoryId(),
    compact: false,
    onChange: null,
  });
}

document.addEventListener("click", closeAllCustomDd);

function showAppMessage(message) {
  const modal = $("app-message-modal");
  const text = $("app-message-text");
  if (!modal || !text) {
    window.alert(message);
    return;
  }
  text.textContent = message;
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  $("app-message-ok")?.focus();
}

function closeAppMessageModal() {
  const modal = $("app-message-modal");
  if (!modal || modal.classList.contains("hidden")) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  const taskLog = $("task-log-modal");
  if (!taskLog || taskLog.classList.contains("hidden")) {
    document.body.classList.remove("modal-open");
  }
}

function makeTrashButton(ariaLabel, onClick) {
  return makeIconButton("btn-icon-delete", ariaLabel, onClick, iconTrashSvg());
}

function iconTrashSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;
}

function iconEditSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
}

function iconCopySvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
}

function iconDuplicateSvg() {
  /* Twin sheets — distinct from copy’s overlapping offset pages */
  return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="8" height="14" rx="2"/><rect x="13" y="5" width="8" height="14" rx="2"/></svg>`;
}

function makeIconButton(className, ariaLabel, onClick, svgHtml) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.setAttribute("aria-label", ariaLabel);
  b.innerHTML = svgHtml;
  b.addEventListener("click", onClick);
  return b;
}

function splitMinutesForFields(totalMin) {
  const n = Number(totalMin) || 0;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return { hours: h > 0 ? String(h) : "", minutes: m > 0 || h === 0 ? String(m || 0) : "" };
}

function setTaskLogDurationFields(totalMin) {
  const { hours, minutes } = splitMinutesForFields(totalMin);
  $("task-log-hours").value = hours;
  $("task-log-minutes").value = minutes;
}

function renderEntries(entries) {
  const ul = $("entries");
  const empty = $("entries-empty");
  const totalEl = $("day-total");
  ul.innerHTML = "";
  if (!entries.length) {
    empty.classList.remove("hidden");
    totalEl.textContent = "";
    return;
  }
  empty.classList.add("hidden");
  entries.forEach((e, i) => {
    const li = document.createElement("li");
    const main = document.createElement("div");
    main.className = "entry-main";
    const title = document.createElement("div");
    title.textContent = labelById[e.category] || e.category;
    const meta = document.createElement("div");
    meta.className = "entry-meta";
    meta.textContent = e.note || "—";
    main.appendChild(title);
    main.appendChild(meta);

    const timeRow = document.createElement("div");
    timeRow.className = "entry-time-row";
    const parts = [];
    if (e.logged_at) parts.push(fmtClock(e.logged_at));
    if (i > 0 && e.logged_at && entries[i - 1].logged_at) {
      const gap = fmtGapBetween(entries[i - 1].logged_at, e.logged_at);
      if (gap) parts.push(gap);
    }
    if (parts.length) {
      timeRow.textContent = parts.join(" · ");
      main.appendChild(timeRow);
    }

    const right = document.createElement("div");
    right.className = "entry-actions";
    const mins = document.createElement("span");
    mins.className = "entry-min";
    mins.textContent = fmtDuration(e.minutes);
    const entryRef = { ...e };

    const btnEdit = makeIconButton(
      "btn-icon-entry",
      "Edit this log entry",
      () => openEntryLogModal(entryRef, { editIndex: i }),
      iconEditSvg()
    );
    const btnCopy = makeIconButton(
      "btn-icon-entry",
      "Copy to log again",
      () => openEntryLogModal(entryRef, { editIndex: null }),
      iconCopySvg()
    );
    const btnDup = makeIconButton(
      "btn-icon-entry",
      "Duplicate this entry",
      () => duplicateEntry(entryRef),
      iconDuplicateSvg()
    );
    const btnDel = makeTrashButton("Remove this log entry", async () => {
      try {
        const data = await api(`/api/today/entry/${i}`, { method: "DELETE" });
        renderEntries(data.entries);
      } catch (err) {
        showAppMessage(err.message);
      }
    });
    right.appendChild(mins);
    right.appendChild(btnDup);
    right.appendChild(btnCopy);
    right.appendChild(btnEdit);
    right.appendChild(btnDel);
    li.appendChild(main);
    li.appendChild(right);
    ul.appendChild(li);
  });
  const t = totalMinutes(entries);
  totalEl.innerHTML =
    t === 0
      ? ""
      : `Together: <strong>${fmtDuration(t)}</strong> <span class="total-sub">(${t} min)</span>`;
  const modal = $("task-log-modal");
  if (modal && !modal.classList.contains("hidden") && modal.dataset.sourceTaskId) {
    updateTaskLogSumLine(modal.dataset.sourceTaskId);
  }
}

let todoSaveTimer = null;

function scheduleTodoSave() {
  $("todo-status").textContent = "Saving…";
  clearTimeout(todoSaveTimer);
  todoSaveTimer = setTimeout(saveTodosFromBoard, 500);
}

function gatherTodoPayload() {
  const board = $("todo-board");
  const out = { today: [], tomorrow: [], future: [] };
  board.querySelectorAll(".todo-pane").forEach((pane) => {
    const which = pane.dataset.which;
    if (which !== "today" && which !== "tomorrow" && which !== "future") return;
    pane.querySelectorAll(".todo-row").forEach((row) => {
      const text = row.querySelector(".todo-text")?.value.trim() || "";
      if (!text) return;
      const id = row.dataset.taskId || newTaskId();
      row.dataset.taskId = id;
      const pri =
        row.querySelector(".chip.pri.active")?.getAttribute("data-v") || "none";
      const cat =
        row.querySelector("input.todo-task-category")?.value || defaultCategoryId();
      const dateInp = row.querySelector(".due-date");
      let deadline = dateInp && dateInp.value ? dateInp.value : null;
      const done = !!row.querySelector(".todo-done")?.checked;
      out[which].push({ id, text, priority: pri, deadline, done, category: cat });
    });
  });
  return out;
}

function priorityRankCode(p) {
  const x = (p || "none").toLowerCase();
  return { p1: 0, p2: 1, p3: 2, none: 3 }[x] ?? 3;
}

function rowToTask(row) {
  const text = row.querySelector(".todo-text")?.value.trim() || "";
  const pri = row.querySelector(".chip.pri.active")?.getAttribute("data-v") || "none";
  const cat = row.querySelector("input.todo-task-category")?.value || defaultCategoryId();
  const dateInp = row.querySelector(".due-date");
  const deadline = dateInp && dateInp.value ? dateInp.value : null;
  const done = !!row.querySelector(".todo-done")?.checked;
  const id = row.dataset.taskId || "";
  return { id, text, priority: pri, deadline, done, category: cat };
}

function taskSortTuple(t) {
  const done = t.done ? 1 : 0;
  const pr = priorityRankCode(t.priority);
  const dl = t.deadline || "9999-99-99";
  const tx = (t.text || "").toLowerCase();
  return [done, pr, dl, tx];
}

function compareTasksBySort(a, b) {
  const ka = taskSortTuple(a);
  const kb = taskSortTuple(b);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return 0;
}

function labelForWhich(which) {
  if (which === "today") return "Today";
  if (which === "tomorrow") return "Tomorrow";
  return "Future";
}

function countOpenInList(list) {
  return [...list.querySelectorAll(".todo-row")].filter(
    (r) => !r.querySelector(".todo-done")?.checked
  ).length;
}

function refreshAllPaneTitles() {
  document.querySelectorAll(".todo-pane").forEach((section) => {
    const head = section.querySelector(".todo-pane-toggle");
    const list = section.querySelector(".todo-list-inner");
    if (!head || !list) return;
    const which = section.dataset.which;
    const expanded = head.getAttribute("aria-expanded") === "true";
    const n = countOpenInList(list);
    const base = labelForWhich(which);
    head.textContent = expanded ? base : `${base} (${n})`;
  });
}

function wireListDragDrop(list, section) {
  list.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  });
  list.addEventListener("drop", (e) => {
    e.preventDefault();
    const row = draggingTodoRow;
    if (!row) return;
    const addBtn = list.querySelector(".add-task");
    if (!addBtn) return;
    list.insertBefore(row, addBtn);
    reorderTodoPaneFromRow(row);
    scheduleTodoSave();
  });

  section.addEventListener("dragenter", (e) => {
    if (!draggingTodoRow) return;
    const body = section.querySelector(".todo-pane-body");
    const head = section.querySelector(".todo-pane-toggle");
    const which = section.dataset.which;
    if (!body || !head || !which) return;
    if (!body.classList.contains("pane-collapsed")) return;
    body.classList.remove("pane-collapsed");
    head.setAttribute("aria-expanded", "true");
    localStorage.setItem(`ground.todo.pane.${which}.collapsed`, "0");
    refreshAllPaneTitles();
  });
}

function mountTaskLogCategoryDd(initialCat) {
  const mount = $("task-log-category-mount");
  if (!mount) return;
  mount.innerHTML = "";
  const val = categories.some((c) => c.id === initialCat) ? initialCat : defaultCategoryId();
  mountCustomDd(mount, {
    hiddenId: "task-log-category",
    hiddenClass: "",
    initialValue: val,
    compact: false,
    onChange: null,
  });
}

function sumMinutesForTask(entries, taskId) {
  if (!taskId || !entries) return 0;
  return entries.reduce((s, e) => {
    if (e.source_task_id === taskId) return s + (Number(e.minutes) || 0);
    return s;
  }, 0);
}

async function updateTaskLogSumLine(taskId) {
  const el = $("task-log-sum-line");
  if (!el) return;
  if (!taskId) {
    el.textContent = "";
    return;
  }
  try {
    const data = await api("/api/today");
    const m = sumMinutesForTask(data.entries || [], taskId);
    el.textContent =
      m > 0
        ? `Logged for this task today: ${fmtDuration(m)}`
        : "No time logged for this task today yet.";
  } catch {
    el.textContent = "";
  }
}

function resetTaskLogModalUi() {
  const form = $("task-log-form");
  const sum = $("task-log-sum-line");
  const desc = $("task-log-modal-desc");
  const title = $("task-log-modal-title");
  const submit = $("task-log-submit");
  if (form) form.classList.remove("hidden");
  if (sum) sum.classList.add("hidden");
  if (desc) desc.classList.remove("hidden");
  if (title) {
    title.textContent = "Log time";
    title.classList.remove("hidden");
  }
  if (submit) submit.textContent = "Log time";
}

function closeTaskLogModal() {
  const modal = $("task-log-modal");
  if (!modal) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  delete modal.dataset.sourceTaskId;
  delete modal.dataset.editIndex;
  delete modal.dataset.mode;
  const mount = $("task-log-category-mount");
  if (mount) mount.innerHTML = "";
  resetTaskLogModalUi();
  const appMsg = $("app-message-modal");
  if (!appMsg || appMsg.classList.contains("hidden")) {
    document.body.classList.remove("modal-open");
  }
}

function applyTaskLogModalMode(mode, editIndex) {
  const modal = $("task-log-modal");
  const title = $("task-log-modal-title");
  const desc = $("task-log-modal-desc");
  const sum = $("task-log-sum-line");
  const submit = $("task-log-submit");
  if (!modal) return;
  modal.dataset.mode = mode;
  if (editIndex !== null && editIndex !== undefined && editIndex !== "") {
    modal.dataset.editIndex = String(editIndex);
  } else {
    delete modal.dataset.editIndex;
  }
  if (mode === "edit") {
    if (title) title.textContent = "Edit time";
    if (submit) submit.textContent = "Save";
    if (desc) desc.classList.add("hidden");
    if (sum) sum.classList.add("hidden");
  } else if (mode === "task") {
    if (title) title.textContent = "Log time";
    if (submit) submit.textContent = "Log time";
    if (desc) desc.classList.remove("hidden");
    if (sum) sum.classList.remove("hidden");
  } else {
    if (title) title.textContent = "Log time";
    if (submit) submit.textContent = "Log time";
    if (desc) desc.classList.add("hidden");
    if (sum) sum.classList.add("hidden");
  }
}

async function openEntryLogModal(entry, { editIndex }) {
  const modal = $("task-log-modal");
  if (!modal) return;
  resetTaskLogModalUi();
  const isEdit = editIndex !== null && editIndex !== undefined;
  const mode = isEdit ? "edit" : "copy";
  applyTaskLogModalMode(mode, isEdit ? editIndex : null);
  delete modal.dataset.sourceTaskId;
  if (entry.source_task_id) modal.dataset.sourceTaskId = entry.source_task_id;
  const cat = categories.some((c) => c.id === entry.category)
    ? entry.category
    : defaultCategoryId();
  mountTaskLogCategoryDd(cat);
  $("task-log-note").value = (entry.note || "").slice(0, 200);
  if (isEdit) {
    setTaskLogDurationFields(entry.minutes);
  } else {
    $("task-log-hours").value = "";
    $("task-log-minutes").value = "";
  }
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  $("task-log-hours").focus();
}

async function openTaskLogModal(row) {
  const modal = $("task-log-modal");
  if (!modal) return;
  resetTaskLogModalUi();
  const tid = row.dataset.taskId || "";
  const cat =
    row.querySelector("input.todo-task-category")?.value || defaultCategoryId();
  const text = row.querySelector(".todo-text")?.value.trim() || "";
  modal.dataset.sourceTaskId = tid;
  applyTaskLogModalMode("task", null);
  mountTaskLogCategoryDd(cat);
  $("task-log-note").value = text.slice(0, 200);
  $("task-log-hours").value = "";
  $("task-log-minutes").value = "";
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  await updateTaskLogSumLine(tid);
  $("task-log-hours").focus();
}

async function duplicateEntry(entry) {
  const minutes = Number(entry.minutes) || 0;
  if (minutes <= 0) {
    showAppMessage("Nothing to duplicate — this entry has no duration.");
    return;
  }
  const body = {
    minutes,
    category: entry.category || defaultCategoryId(),
    note: entry.note || "",
  };
  if (entry.source_task_id) body.source_task_id = entry.source_task_id;
  try {
    const data = await api("/api/today/entry", {
      method: "POST",
      body: JSON.stringify(body),
    });
    renderEntries(data.entries || []);
    const modal = $("task-log-modal");
    if (modal && !modal.classList.contains("hidden") && modal.dataset.sourceTaskId) {
      await updateTaskLogSumLine(modal.dataset.sourceTaskId);
    }
  } catch (e) {
    let msg = e.message;
    try {
      const j = JSON.parse(msg);
      if (j.error) msg = j.error;
    } catch {
      /* plain */
    }
    showAppMessage(msg);
  }
}

function readTaskLogFormBody() {
  const hoursRaw = $("task-log-hours").value;
  const minutesRaw = $("task-log-minutes").value;
  const h = hoursRaw === "" ? 0 : parseFloat(hoursRaw);
  const m = minutesRaw === "" ? 0 : parseInt(minutesRaw, 10);
  if ((!h || h <= 0) && (!m || m <= 0)) {
    return { error: "Enter hours and/or minutes (total must be more than zero)." };
  }
  if (Number.isNaN(h) || h < 0 || h > 24) {
    return { error: "Hours must be between 0 and 24." };
  }
  if (Number.isNaN(m) || m < 0 || m > 1439) {
    return { error: "Minutes must be between 0 and 1439." };
  }
  const category = $("task-log-category")?.value || defaultCategoryId();
  const note = $("task-log-note").value.trim();
  const body = { category, note };
  if (h > 0) body.hours = h;
  body.minutes = m > 0 ? m : 0;
  return { body };
}

function reorderTodoPaneFromRow(row) {
  const list = row.closest(".todo-list-inner");
  if (!list) return;
  const addBtn = list.querySelector(".add-task");
  const rows = [...list.querySelectorAll(".todo-row")];
  if (rows.length < 2) {
    refreshAllPaneTitles();
    return;
  }
  rows.sort((ra, rb) => compareTasksBySort(rowToTask(ra), rowToTask(rb)));
  rows.forEach((r) => list.insertBefore(r, addBtn));
  refreshAllPaneTitles();
}

async function saveTodosFromBoard() {
  const payload = gatherTodoPayload();
  try {
    await api("/api/todos", {
      method: "POST",
      body: JSON.stringify({
        today: payload.today,
        tomorrow: payload.tomorrow,
        future: payload.future,
      }),
    });
    $("todo-status").textContent = "Saved.";
    setTimeout(() => {
      if ($("todo-status").textContent === "Saved.") $("todo-status").textContent = "";
    }, 2200);
  } catch (e) {
    $("todo-status").textContent = "Could not save.";
  }
}

async function carryoverAction(action, sourceDate, taskId) {
  await api("/api/todos/carryover", {
    method: "POST",
    body: JSON.stringify({ action, sourceDate, taskId }),
  });
  await loadTodos();
}

function createTodoRow(task) {
  const row = document.createElement("div");
  row.className = "todo-row";
  const tid = task.id || newTaskId();
  row.dataset.taskId = tid;
  if (task.done) row.classList.add("todo-row-done");

  const top = document.createElement("div");
  top.className = "todo-row-top";

  const doneCb = document.createElement("input");
  doneCb.type = "checkbox";
  doneCb.className = "todo-done";
  doneCb.checked = !!task.done;
  doneCb.title = "Done";
  doneCb.setAttribute("aria-label", "Mark done");

  const inp = document.createElement("input");
  inp.type = "text";
  inp.className = "todo-text";
  inp.placeholder = "A small intention";
  inp.value = task.text || "";
  inp.maxLength = 400;
  inp.addEventListener("input", scheduleTodoSave);

  const rm = makeTrashButton("Remove this task", () => {
    row.remove();
    refreshAllPaneTitles();
    scheduleTodoSave();
  });

  const grip = document.createElement("span");
  grip.className = "todo-drag-grip";
  grip.draggable = true;
  grip.setAttribute("aria-label", "Drag to move between sections");
  grip.title = "Drag to move between Today, Tomorrow, Future";
  grip.textContent = "⋮⋮";
  grip.addEventListener("dragstart", (e) => {
    draggingTodoRow = row;
    row.classList.add("todo-row-dragging");
    e.dataTransfer.setData("text/plain", tid);
    e.dataTransfer.effectAllowed = "move";
  });
  grip.addEventListener("dragend", () => {
    row.classList.remove("todo-row-dragging");
    draggingTodoRow = null;
  });

  const logBtn = document.createElement("button");
  logBtn.type = "button";
  logBtn.className = "btn-todo-log";
  logBtn.textContent = "Log time";
  logBtn.setAttribute("aria-label", "Log time to today");
  logBtn.addEventListener("click", () => openTaskLogModal(row));

  top.appendChild(grip);
  top.appendChild(doneCb);
  top.appendChild(inp);
  top.appendChild(logBtn);
  top.appendChild(rm);

  const meta = document.createElement("div");
  meta.className = "todo-meta";

  const catRow = document.createElement("div");
  catRow.className = "chip-row";
  const catHint = document.createElement("span");
  catHint.className = "chip-hint";
  catHint.textContent = "Category";
  catRow.appendChild(catHint);
  const catMount = document.createElement("div");
  catMount.className = "todo-category-dd-mount";
  const initCat = categories.some((c) => c.id === task.category)
    ? task.category
    : defaultCategoryId();
  mountCustomDd(catMount, {
    hiddenId: null,
    hiddenClass: "todo-task-category",
    initialValue: initCat,
    compact: true,
    onChange: () => {
      scheduleTodoSave();
    },
  });
  catRow.appendChild(catMount);

  const prRow = document.createElement("div");
  prRow.className = "chip-row";
  const prHint = document.createElement("span");
  prHint.className = "chip-hint";
  prHint.textContent = "Priority";
  prRow.appendChild(prHint);
  const prVal = (task.priority || "none").toLowerCase();
  ["p1", "p2", "p3", "none"].forEach((p) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip pri" + (prVal === p ? " active" : "") + ` p-${p}`;
    b.setAttribute("data-v", p);
    b.textContent = p === "none" ? "—" : p.toUpperCase();
    b.addEventListener("click", () => {
      prRow.querySelectorAll(".chip.pri").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      reorderTodoPaneFromRow(row);
      scheduleTodoSave();
    });
    prRow.appendChild(b);
  });

  meta.appendChild(catRow);
  meta.appendChild(prRow);
  meta.appendChild(buildDeadlineRow(task, row));

  doneCb.addEventListener("change", () => {
    row.classList.toggle("todo-row-done", doneCb.checked);
    reorderTodoPaneFromRow(row);
    refreshAllPaneTitles();
    scheduleTodoSave();
  });

  row.appendChild(top);
  row.appendChild(meta);
  return row;
}

function createCarryoverRow(task, sourceDate) {
  const row = document.createElement("div");
  row.className = "carryover-row";
  const text = document.createElement("p");
  text.className = "carryover-text";
  text.textContent = task.text || "";
  const meta = document.createElement("div");
  meta.className = "carryover-meta";
  const catLab = labelById[task.category] || task.category || "—";
  meta.textContent = `${catLab} · ${(task.priority || "none").toUpperCase()}`;
  const actions = document.createElement("div");
  actions.className = "carryover-actions";

  const btnDone = document.createElement("button");
  btnDone.type = "button";
  btnDone.className = "btn-quiet";
  btnDone.textContent = "Done";
  btnDone.addEventListener("click", () =>
    carryoverAction("done", sourceDate, task.id).catch((e) => showAppMessage(e.message))
  );

  const btnToday = document.createElement("button");
  btnToday.type = "button";
  btnToday.className = "btn-quiet primary-lite";
  btnToday.textContent = "Into today";
  btnToday.addEventListener("click", () =>
    carryoverAction("toToday", sourceDate, task.id).catch((e) => showAppMessage(e.message))
  );

  const btnDel = makeTrashButton("Remove from yesterday", () =>
    carryoverAction("delete", sourceDate, task.id).catch((e) => showAppMessage(e.message))
  );

  actions.appendChild(btnDone);
  actions.appendChild(btnToday);
  actions.appendChild(btnDel);
  row.appendChild(text);
  row.appendChild(meta);
  row.appendChild(actions);
  return row;
}

function renderCarryover(data) {
  const co = data.carryover || {};
  const tasks = co.tasks || [];
  const sourceDate = co.sourceDate || data.yesterdayKey;
  const wrap = document.createElement("div");
  wrap.className = "carryover-panel";
  if (!tasks.length) {
    wrap.classList.add("hidden");
    return wrap;
  }
  const head = document.createElement("h4");
  head.className = "carryover-heading";
  head.textContent = `From ${fmtDate(sourceDate)}`;
  wrap.appendChild(head);
  tasks.forEach((t) => wrap.appendChild(createCarryoverRow(t, sourceDate)));
  return wrap;
}

function renderTodoBoard(data) {
  todayIso = data.todayKey || todayIso;
  tomorrowIso = data.tomorrowKey || tomorrowIso;
  const board = $("todo-board");
  board.innerHTML = "";

  board.appendChild(renderCarryover(data));

  const panes = document.createElement("div");
  panes.className = "todo-stack";

  ["today", "tomorrow", "future"].forEach((which) => {
    const section = document.createElement("section");
    section.className = "todo-pane";
    section.dataset.which = which;

    const expanded =
      localStorage.getItem(`ground.todo.pane.${which}.collapsed`) !== "1";

    const headBtn = document.createElement("button");
    headBtn.type = "button";
    headBtn.className = "todo-pane-toggle";
    headBtn.setAttribute("aria-expanded", expanded ? "true" : "false");

    const body = document.createElement("div");
    body.className = "todo-pane-body" + (expanded ? "" : " pane-collapsed");

    const list = document.createElement("div");
    list.className = "todo-list-inner";
    const tasks = data[which] || [];
    tasks.forEach((t) => list.appendChild(createTodoRow(t)));

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "ghost add-task";
    addBtn.textContent = "Add a line";
    addBtn.addEventListener("click", () => {
      list.insertBefore(
        createTodoRow({
          id: newTaskId(),
          text: "",
          priority: "none",
          deadline: null,
          done: false,
          category: defaultCategoryId(),
        }),
        addBtn
      );
      const rows = list.querySelectorAll(".todo-row");
      rows[rows.length - 1]?.querySelector(".todo-text")?.focus();
      const last = rows[rows.length - 1];
      if (last) reorderTodoPaneFromRow(last);
      refreshAllPaneTitles();
      scheduleTodoSave();
    });
    list.appendChild(addBtn);

    headBtn.addEventListener("click", () => {
      const isOpen = headBtn.getAttribute("aria-expanded") === "true";
      const next = !isOpen;
      headBtn.setAttribute("aria-expanded", next ? "true" : "false");
      body.classList.toggle("pane-collapsed", !next);
      localStorage.setItem(`ground.todo.pane.${which}.collapsed`, next ? "0" : "1");
      refreshAllPaneTitles();
    });

    body.appendChild(list);
    section.appendChild(headBtn);
    section.appendChild(body);

    wireListDragDrop(list, section);
    panes.appendChild(section);
  });

  board.appendChild(panes);
  refreshAllPaneTitles();
}

async function loadTodos() {
  const data = await api("/api/todos");
  renderTodoBoard(data);
}

function renderHistory(payload) {
  const root = $("history");
  root.innerHTML = "";
  const days = payload.days || [];
  if (!days.length) {
    root.innerHTML = "<p class=\"empty\">Nothing logged yet.</p>";
    return;
  }
  for (const day of days) {
    const det = document.createElement("details");
    det.className = "history-day";
    const sum = document.createElement("summary");
    const left = document.createElement("span");
    left.textContent = fmtDate(day.date);
    const right = document.createElement("span");
    right.className = "history-sum-meta";
    const tm = day.totalMinutes || 0;
    right.textContent =
      tm === 0 ? "—" : `${fmtDuration(tm)} · ${day.entryCount} line(s)`;
    sum.appendChild(left);
    sum.appendChild(right);
    det.appendChild(sum);

    const inner = document.createElement("div");
    inner.className = "inner";
    const dayMax = Math.max(
      ...(day.byCategory || []).map((r) => r.minutes),
      1
    );
    (day.byCategory || []).forEach((row) => {
      const pct = dayMax ? Math.round((row.minutes / dayMax) * 100) : 0;
      const rowEl = document.createElement("div");
      rowEl.className = "bar-row";
      rowEl.innerHTML = `
        <span class="bar-label" title="${escapeHtml(row.label)}">${escapeHtml(row.label)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        <span class="bar-mins">${row.minutes}m</span>
      `;
      inner.appendChild(rowEl);
    });
    const ul = document.createElement("ul");
    ul.className = "history-entries";
    (day.entries || []).forEach((e) => {
      const li = document.createElement("li");
      const lab = labelById[e.category] || e.category;
      const clock = e.logged_at ? ` · ${fmtClock(e.logged_at)}` : "";
      li.textContent = `${fmtDuration(e.minutes)} · ${lab}${e.note ? ` — ${e.note}` : ""}${clock}`;
      ul.appendChild(li);
    });
    inner.appendChild(ul);
    det.appendChild(inner);
    root.appendChild(det);
  }
}

function renderAnalytics(payload) {
  const root = $("analytics-root");
  root.innerHTML = "";
  const total = payload.totalMinutes || 0;
  const daysWith = payload.daysWithLogs || 0;
  const avg = payload.avgMinutesOnLoggedDays || 0;
  const byCat = payload.byCategory || [];
  const recent = payload.recentDailyTotals || [];
  const todo = payload.todoStats || {};
  const recentWithTime = recent.filter((d) => (d.totalMinutes || 0) > 0);
  const hasTime = total > 0 || recentWithTime.length > 0;
  const hasTodos = (todo.tasksRecorded || 0) > 0;

  if (!hasTime && !hasTodos) {
    root.innerHTML = "<p class=\"empty\">Nothing in this window yet.</p>";
    return;
  }

  if (hasTime) {
    const summary = document.createElement("div");
    summary.className = "analytics-summary";
    const h = Math.floor(total / 60);
    const m = total % 60;
    summary.innerHTML = `
      <div class="stat">
        <div class="stat-value">${h ? `${h}h ` : ""}${m}m</div>
        <div class="stat-label">Time logged (30d)</div>
      </div>
      <div class="stat">
        <div class="stat-value">${daysWith}</div>
        <div class="stat-label">Days with time</div>
      </div>
      <div class="stat">
        <div class="stat-value">${fmtDuration(avg)}</div>
        <div class="stat-label">Avg on those days</div>
      </div>
    `;
    root.appendChild(summary);

    if (byCat.length) {
      const top = byCat[0];
      const insight = document.createElement("p");
      insight.className = "insight";
      insight.textContent = `Most time went to “${top.label}” (${top.pctOfTotal}% of logged time).`;
      root.appendChild(insight);
    }

    const sec = document.createElement("div");
    sec.className = "analytics-section";
    sec.innerHTML = "<h3>Time by category</h3>";
    const maxM = Math.max(...byCat.map((r) => r.minutes), 1);
    byCat.forEach((row) => {
      const pctBar = Math.round((row.minutes / maxM) * 100);
      const rowEl = document.createElement("div");
      rowEl.className = "bar-row analytics-bar";
      rowEl.innerHTML = `
        <span class="bar-label" title="${escapeHtml(row.label)}">${escapeHtml(row.label)}</span>
        <div class="bar-track"><div class="bar-fill bar-fill-time" style="width:${pctBar}%"></div></div>
        <span class="bar-stat">${fmtDuration(row.minutes)} · ${row.pctOfTotal}%</span>
      `;
      sec.appendChild(rowEl);
    });
    root.appendChild(sec);

    if (recentWithTime.length) {
      const daily = document.createElement("div");
      daily.className = "analytics-section";
      daily.innerHTML = "<h3>Recent time per day</h3>";
      const list = document.createElement("ul");
      list.className = "analytics-daily";
      recentWithTime.forEach((d) => {
        const li = document.createElement("li");
        li.innerHTML = `<span>${fmtDate(d.date)}</span><span>${fmtDuration(d.totalMinutes)}</span>`;
        list.appendChild(li);
      });
      daily.appendChild(list);
      root.appendChild(daily);
    }
  }

  if (hasTodos) {
    const tsec = document.createElement("div");
    tsec.className = "analytics-section analytics-todos";
    tsec.innerHTML = "<h3>Intentions (tasks)</h3>";
    const grid = document.createElement("div");
    grid.className = "analytics-summary";
    grid.innerHTML = `
      <div class="stat">
        <div class="stat-value">${todo.tasksRecorded}</div>
        <div class="stat-label">Tasks in window</div>
      </div>
      <div class="stat">
        <div class="stat-value">${todo.completionRate ?? 0}%</div>
        <div class="stat-label">Marked done</div>
      </div>
      <div class="stat">
        <div class="stat-value">${todo.carryoverOpenNow ?? 0}</div>
        <div class="stat-label">Open from yesterday</div>
      </div>
    `;
    tsec.appendChild(grid);
    const br = todo.taskByCategory || [];
    if (br.length) {
      const tnote = document.createElement("p");
      tnote.className = "analytics-todo-note";
      tnote.textContent = br.map((r) => `${r.label}: ${r.count}`).join(" · ");
      tsec.appendChild(tnote);
    }
    const todoDaysWithEntries = (todo.byDay || []).filter((d) => (d.total || 0) > 0);
    if (todoDaysWithEntries.length) {
      const tlist = document.createElement("ul");
      tlist.className = "analytics-daily";
      todoDaysWithEntries.forEach((d) => {
        const li = document.createElement("li");
        li.innerHTML = `<span>${fmtDate(d.date)}</span><span>${d.total} tasks · ${d.done} done</span>`;
        tlist.appendChild(li);
      });
      tsec.appendChild(tlist);
    }
    root.appendChild(tsec);
  }
}

function setActiveView(view) {
  const sheet = $("view-sheet");
  const hist = $("view-history");
  const ana = $("view-analytics");
  const map = { sheet, history: hist, analytics: ana };
  Object.entries(map).forEach(([k, el]) => {
    const on = k === view;
    el.classList.toggle("hidden", !on);
    el.setAttribute("aria-hidden", on ? "false" : "true");
  });
  document.querySelectorAll(".tab").forEach((b) => {
    const on = b.dataset.view === view;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
}

function setupTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const view = btn.dataset.view;
      setActiveView(view);
      if (view === "history") {
        try {
          const data = await api("/api/history");
          renderHistory(data);
        } catch (e) {
          $("history").innerHTML = `<p class="hint">${escapeHtml(e.message)}</p>`;
        }
      }
      if (view === "analytics") {
        try {
          const data = await api("/api/analytics");
          renderAnalytics(data);
        } catch (e) {
          $("analytics-root").innerHTML = `<p class="hint">${escapeHtml(e.message)}</p>`;
        }
      }
    });
  });
}

async function init() {
  const meta = await api("/api/meta");
  categories = meta.categories || [];
  labelById = Object.fromEntries(categories.map((c) => [c.id, c.label]));
  todayIso = meta.today;
  tomorrowIso = meta.tomorrow;
  $("dateLine").textContent = fmtDate(meta.today);
  mountTimeCategoryDd();

  const today = await api("/api/today");
  renderEntries(today.entries || []);

  await loadTodos();

  $("todo-board").addEventListener(
    "blur",
    (e) => {
      if (e.target.classList.contains("todo-text")) {
        clearTimeout(todoSaveTimer);
        saveTodosFromBoard();
      }
    },
    true
  );

  $("entry-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const hoursRaw = $("hours").value;
    const minutesRaw = $("minutes").value;
    const h = hoursRaw === "" ? 0 : parseFloat(hoursRaw);
    const m = minutesRaw === "" ? 0 : parseInt(minutesRaw, 10);
    if ((!h || h <= 0) && (!m || m <= 0)) {
      showAppMessage("Enter hours and/or minutes (total must be more than zero).");
      return;
    }
    if (Number.isNaN(h) || h < 0 || h > 24) {
      showAppMessage("Hours must be between 0 and 24.");
      return;
    }
    if (Number.isNaN(m) || m < 0 || m > 1439) {
      showAppMessage("Minutes must be between 0 and 1439.");
      return;
    }
    const category = $("category")?.value || defaultCategoryId();
    const note = $("note").value.trim();
    const body = { category, note };
    if (h > 0) body.hours = h;
    body.minutes = m > 0 ? m : 0;
    try {
      const data = await api("/api/today/entry", {
        method: "POST",
        body: JSON.stringify(body),
      });
      $("hours").value = "";
      $("minutes").value = "";
      $("note").value = "";
      $("minutes").focus();
      renderEntries(data.entries);
    } catch (e) {
      let msg = e.message;
      try {
        const j = JSON.parse(msg);
        if (j.error) msg = j.error;
      } catch {
        /* plain text */
      }
      showAppMessage(msg);
    }
  });

  $("app-message-ok")?.addEventListener("click", closeAppMessageModal);
  $("app-message-backdrop")?.addEventListener("click", closeAppMessageModal);

  const taskLogBackdrop = $("task-log-modal-backdrop");
  const taskLogCancel = $("task-log-cancel");
  const taskLogForm = $("task-log-form");
  if (taskLogCancel) taskLogCancel.addEventListener("click", closeTaskLogModal);
  if (taskLogBackdrop) taskLogBackdrop.addEventListener("click", closeTaskLogModal);
  if (taskLogForm) {
    taskLogForm.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const modal = $("task-log-modal");
      const parsed = readTaskLogFormBody();
      if (parsed.error) {
        showAppMessage(parsed.error);
        return;
      }
      const body = parsed.body;
      const taskId = modal?.dataset.sourceTaskId || "";
      if (taskId) body.source_task_id = taskId;
      const submitBtn = $("task-log-submit");
      if (submitBtn) submitBtn.disabled = true;
      try {
        const editIdx = modal?.dataset.editIndex;
        const isEdit = modal?.dataset.mode === "edit" && editIdx !== undefined && editIdx !== "";
        let data;
        if (isEdit) {
          data = await api(`/api/today/entry/${editIdx}`, {
            method: "PUT",
            body: JSON.stringify(body),
          });
          renderEntries(data.entries || []);
          closeTaskLogModal();
        } else {
          data = await api("/api/today/entry", {
            method: "POST",
            body: JSON.stringify(body),
          });
          renderEntries(data.entries || []);
          closeTaskLogModal();
        }
      } catch (e) {
        let msg = e.message;
        try {
          const j = JSON.parse(msg);
          if (j.error) msg = j.error;
        } catch {
          /* plain text */
        }
        showAppMessage(msg);
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const msgModal = $("app-message-modal");
    if (msgModal && !msgModal.classList.contains("hidden")) {
      closeAppMessageModal();
      return;
    }
    const modal = $("task-log-modal");
    if (modal && !modal.classList.contains("hidden")) closeTaskLogModal();
  });

  setupTabs();
}

init().catch((e) => {
  document.body.innerHTML = `<p style="padding:2rem;font-family:system-ui">Could not load app: ${escapeHtml(
    e.message
  )}</p>`;
});
