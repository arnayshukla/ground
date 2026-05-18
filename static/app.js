const $ = (id) => document.getElementById(id);

let categories = [];
let labelById = {};
let projects = [];
let projectLabelById = {};
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
  if (!iso) return "";
  return `${daysFromTodayTo(iso)}d left`;
}

function fmtDeadlineDisplay(iso) {
  if (!iso) return "None";
  return `${fmtDeadlineLabel(iso)} - ${fmtDeadlineRemaining(iso)}`;
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

  const dateInp = document.createElement("input");
  dateInp.type = "date";
  dateInp.className = "due-date sr-picker";
  dateInp.setAttribute("aria-label", "Deadline date");
  dateInp.value = task.deadline || "";

  function sync() {
    const v = dateInp.value;
    display.textContent = fmtDeadlineDisplay(v);
    display.classList.toggle("is-placeholder", !v);
    display.classList.toggle("is-urgent", Boolean(v) && daysFromTodayTo(v) <= 3);
    display.classList.toggle("is-later", Boolean(v) && daysFromTodayTo(v) > 3);
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

function categoryOptions(includeDisabled = false) {
  return categories
    .filter((c) => includeDisabled || c.enabled !== false)
    .map((c) => ({ id: c.id, label: c.label, enabled: c.enabled !== false }));
}

function defaultCategoryId() {
  return categories.find((c) => c.enabled !== false)?.id || categories[0]?.id || "deep_work";
}

function isProjectSelectable(project) {
  return project && !project.archived && !project.end_date;
}

function projectOptions(selectedIds = []) {
  const selected = new Set(selectedIds || []);
  const opts = projects.filter((p) => isProjectSelectable(p) || selected.has(p.id));
  selected.forEach((id) => {
    if (!opts.some((p) => p.id === id)) {
      opts.push({ id, name: id, start_date: null, end_date: null, archived: true, missing: true });
    }
  });
  return opts;
}

function projectIdsFrom(container) {
  if (!container) return [];
  return [...container.querySelectorAll("input.project-id")]
    .map((input) => input.value)
    .filter(Boolean);
}

function projectLabel(id) {
  return projectLabelById[id] || id;
}

function projectLabels(ids) {
  return (ids || []).map(projectLabel);
}

function closeAllProjectPickers() {
  document.querySelectorAll(".project-picker.is-open").forEach((wrap) => {
    wrap.classList.remove("is-open");
    const btn = wrap.querySelector(".project-picker-btn");
    if (btn) btn.setAttribute("aria-expanded", "false");
    const menu = wrap.querySelector(".project-picker-menu");
    if (menu) menu.classList.add("hidden");
  });
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
  const opts = categoryOptions(false);
  if (initialValue && !opts.some((o) => o.id === initialValue)) {
    const existing = categories.find((c) => c.id === initialValue);
    opts.push({
      id: initialValue,
      label: existing ? `${existing.label} (disabled)` : initialValue,
      enabled: false,
    });
  }
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
    closeAllProjectPickers();
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

function mountProjectPicker(container, { selectedIds = [], compact = false, onChange = null } = {}) {
  if (!container) return;
  const selected = new Set((selectedIds || []).filter(Boolean));
  const opts = projectOptions([...selected]);
  container.innerHTML = "";
  container.className = ["project-picker", compact ? "project-picker-compact" : ""]
    .filter(Boolean)
    .join(" ");
  container.addEventListener("click", (e) => e.stopPropagation());

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "project-picker-btn";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  const triggerLabel = document.createElement("span");
  triggerLabel.className = "project-picker-label";
  const caret = document.createElement("span");
  caret.className = "custom-dd-caret";
  caret.setAttribute("aria-hidden", "true");
  caret.textContent = "▾";
  trigger.appendChild(triggerLabel);
  trigger.appendChild(caret);

  const selectedWrap = document.createElement("div");
  selectedWrap.className = "project-selected-chips";

  const menu = document.createElement("div");
  menu.className = "project-picker-menu hidden";
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-multiselectable", "true");

  function syncHidden() {
    container.querySelectorAll("input.project-id").forEach((input) => input.remove());
    selected.forEach((id) => {
      const hid = document.createElement("input");
      hid.type = "hidden";
      hid.className = "project-id";
      hid.value = id;
      container.appendChild(hid);
    });
  }

  function syncDisplay() {
    const ids = [...selected];
    triggerLabel.textContent = ids.length ? `${ids.length} project${ids.length === 1 ? "" : "s"} selected` : "No Project Selected";
    selectedWrap.innerHTML = "";
    ids.forEach((id) => {
      const chip = document.createElement("span");
      chip.className = "project-selected-chip";
      chip.textContent = projectLabel(id);
      selectedWrap.appendChild(chip);
    });
    menu.querySelectorAll(".project-option").forEach((option) => {
      const active = selected.has(option.dataset.projectId);
      option.classList.toggle("active", active);
      option.setAttribute("aria-selected", active ? "true" : "false");
    });
  }

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const opening = !container.classList.contains("is-open");
    closeAllCustomDd();
    closeAllProjectPickers();
    if (opening) {
      container.classList.add("is-open");
      menu.classList.remove("hidden");
      trigger.setAttribute("aria-expanded", "true");
    }
  });

  if (!opts.length) {
    const empty = document.createElement("div");
    empty.className = "project-picker-empty";
    empty.textContent = "Create a project in Settings";
    menu.appendChild(empty);
  }

  opts.forEach((project) => {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "project-option";
    option.dataset.projectId = project.id;
    option.setAttribute("role", "option");
    option.textContent = project.name || project.id;
    option.title = project.name || project.id;
    const active = selected.has(project.id);
    option.classList.toggle("active", active);
    option.classList.toggle("is-inactive", !isProjectSelectable(project));
    option.setAttribute("aria-selected", active ? "true" : "false");
    option.addEventListener("click", () => {
      if (selected.has(project.id)) {
        selected.delete(project.id);
      } else {
        selected.add(project.id);
      }
      syncHidden();
      syncDisplay();
      if (onChange) onChange([...selected]);
    });
    menu.appendChild(option);
  });

  container.appendChild(trigger);
  container.appendChild(selectedWrap);
  container.appendChild(menu);
  syncHidden();
  syncDisplay();
}

function mountTimeProjectPicker(selectedIds = []) {
  mountProjectPicker($("time-project-mount"), {
    selectedIds,
    compact: false,
    onChange: null,
  });
}

document.addEventListener("click", () => {
  closeAllCustomDd();
  closeAllProjectPickers();
});

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

function openSettingsModal() {
  renderCategorySettings();
  renderProjectSettings();
  const modal = $("settings-modal");
  if (!modal) return;
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  $("settings-project-new-name")?.focus();
}

function closeSettingsModal() {
  const modal = $("settings-modal");
  if (!modal || modal.classList.contains("hidden")) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  const taskLog = $("task-log-modal");
  const message = $("app-message-modal");
  if (
    (!taskLog || taskLog.classList.contains("hidden")) &&
    (!message || message.classList.contains("hidden"))
  ) {
    document.body.classList.remove("modal-open");
  }
}

function setSettingsSectionExpanded(which, expanded) {
  const toggle = $(`settings-${which}-toggle`);
  const body = $(`settings-${which}-body`);
  if (!toggle || !body) return;
  toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  body.classList.toggle("pane-collapsed", !expanded);
  localStorage.setItem(`ground.settings.${which}.collapsed`, expanded ? "0" : "1");
}

function initSettingsSectionToggle(which) {
  const toggle = $(`settings-${which}-toggle`);
  if (!toggle) return;
  const expanded = localStorage.getItem(`ground.settings.${which}.collapsed`) !== "1";
  setSettingsSectionExpanded(which, expanded);
  toggle.addEventListener("click", () => {
    const isOpen = toggle.getAttribute("aria-expanded") === "true";
    setSettingsSectionExpanded(which, !isOpen);
  });
}

function setCategories(nextCategories) {
  categories = nextCategories || [];
  labelById = Object.fromEntries(categories.map((c) => [c.id, c.label]));
}

function setProjects(nextProjects) {
  projects = nextProjects || [];
  projectLabelById = Object.fromEntries(projects.map((p) => [p.id, p.name]));
}

async function refreshCategoriesFromServer() {
  const data = await api("/api/categories");
  setCategories(data.categories || []);
  mountTimeCategoryDd();
  renderCategorySettings();
  const today = await api("/api/today");
  renderEntries(today.entries || []);
  await loadTodos();
}

async function refreshProjectsFromServer() {
  const data = await api("/api/projects");
  setProjects(data.projects || []);
  mountTimeProjectPicker(projectIdsFrom($("time-project-mount")));
  renderProjectSettings();
  const today = await api("/api/today");
  renderEntries(today.entries || []);
  await loadTodos();
}

function mountSettingsDateControl(container, { value, placeholder, ariaLabel, onChange }) {
  if (!container) return;
  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "settings-date-control";

  const display = document.createElement("button");
  display.type = "button";
  display.className = "deadline-display settings-date-display";

  const calBtn = document.createElement("button");
  calBtn.type = "button";
  calBtn.className = "btn-calendar";
  calBtn.setAttribute("aria-label", ariaLabel);
  calBtn.innerHTML = calendarIconSvg();

  const input = document.createElement("input");
  input.type = "date";
  input.className = "sr-picker settings-date-input";
  input.value = value || "";
  input.setAttribute("aria-label", ariaLabel);

  function sync() {
    display.textContent = input.value ? fmtDeadlineLabel(input.value) : placeholder;
    display.classList.toggle("is-placeholder", !input.value);
  }

  display.addEventListener("click", () => {
    if (input.value && placeholder !== "Start date") {
      input.value = "";
      sync();
      if (onChange) onChange("");
    } else {
      openDatePicker(input);
    }
  });
  calBtn.addEventListener("click", (e) => {
    e.preventDefault();
    openDatePicker(input);
  });
  input.addEventListener("change", () => {
    sync();
    if (onChange) onChange(input.value);
  });

  wrap.appendChild(display);
  wrap.appendChild(calBtn);
  wrap.appendChild(input);
  container.appendChild(wrap);
  sync();
}

function renderCategorySettings() {
  const list = $("settings-category-list");
  if (!list) return;
  list.innerHTML = "";
  categories.forEach((cat) => {
    const row = document.createElement("div");
    row.className = "settings-category-row";

    const labelInput = document.createElement("input");
    labelInput.type = "text";
    labelInput.className = "settings-category-name";
    labelInput.value = cat.label || cat.id;
    labelInput.maxLength = 80;
    labelInput.setAttribute("aria-label", `Rename ${cat.label || cat.id}`);

    const enabledLabel = document.createElement("label");
    enabledLabel.className = "settings-category-toggle";
    const enabledInput = document.createElement("input");
    enabledInput.type = "checkbox";
    enabledInput.checked = cat.enabled !== false;
    enabledInput.setAttribute("aria-label", `${cat.enabled !== false ? "Disable" : "Enable"} ${cat.label || cat.id}`);
    const enabledText = document.createElement("span");
    enabledText.className = "settings-switch-track";
    enabledText.setAttribute("aria-hidden", "true");
    enabledLabel.appendChild(enabledInput);
    enabledLabel.appendChild(enabledText);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn-icon-delete settings-category-remove";
    removeBtn.setAttribute("aria-label", `Remove ${cat.label || cat.id}`);
    removeBtn.title = "Remove category";
    removeBtn.innerHTML = iconTrashSvg();

    async function updateCategory(patch) {
      try {
        const data = await api(`/api/categories/${encodeURIComponent(cat.id)}`, {
          method: "PUT",
          body: JSON.stringify(patch),
        });
        setCategories(data.categories || []);
        mountTimeCategoryDd();
        renderCategorySettings();
        const today = await api("/api/today");
        renderEntries(today.entries || []);
        await loadTodos();
      } catch (e) {
        showAppMessage(e.message);
      }
    }

    labelInput.addEventListener("blur", () => {
      const next = labelInput.value.trim();
      if (!next || next === cat.label) {
        labelInput.value = cat.label || cat.id;
        return;
      }
      updateCategory({ label: next });
    });
    labelInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        labelInput.blur();
      }
    });
    enabledInput.addEventListener("change", () => {
      updateCategory({ enabled: enabledInput.checked });
    });
    removeBtn.addEventListener("click", async () => {
      const ok = window.confirm(
        `Remove "${cat.label || cat.id}" from category settings? Existing logs and tasks will not be edited.`
      );
      if (!ok) return;
      try {
        const data = await api(`/api/categories/${encodeURIComponent(cat.id)}`, {
          method: "DELETE",
        });
        setCategories(data.categories || []);
        mountTimeCategoryDd();
        renderCategorySettings();
        const today = await api("/api/today");
        renderEntries(today.entries || []);
        await loadTodos();
      } catch (e) {
        showAppMessage(e.message);
      }
    });

    row.appendChild(labelInput);
    row.appendChild(enabledLabel);
    row.appendChild(removeBtn);
    list.appendChild(row);
  });
}

function renderProjectSettings() {
  const list = $("settings-project-list");
  if (!list) return;
  list.innerHTML = "";
  projects.forEach((project) => {
    const row = document.createElement("div");
    row.className = "settings-project-row";

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "settings-project-name";
    nameInput.value = project.name || project.id;
    nameInput.maxLength = 100;
    nameInput.setAttribute("aria-label", `Rename ${project.name || project.id}`);

    const startMount = document.createElement("div");
    startMount.className = "settings-project-date-mount";

    const endMount = document.createElement("div");
    endMount.className = "settings-project-date-mount";

    const archiveLabel = document.createElement("label");
    archiveLabel.className = "settings-category-toggle";
    const archiveInput = document.createElement("input");
    archiveInput.type = "checkbox";
    archiveInput.checked = !project.archived;
    archiveInput.setAttribute("aria-label", `${project.archived ? "Reactivate" : "Archive"} ${project.name || project.id}`);
    const archiveTrack = document.createElement("span");
    archiveTrack.className = "settings-switch-track";
    archiveTrack.setAttribute("aria-hidden", "true");
    archiveLabel.appendChild(archiveInput);
    archiveLabel.appendChild(archiveTrack);

    async function updateProject(patch) {
      try {
        const data = await api(`/api/projects/${encodeURIComponent(project.id)}`, {
          method: "PUT",
          body: JSON.stringify(patch),
        });
        setProjects(data.projects || []);
        mountTimeProjectPicker(projectIdsFrom($("time-project-mount")));
        renderProjectSettings();
        const today = await api("/api/today");
        renderEntries(today.entries || []);
        await loadTodos();
      } catch (e) {
        showAppMessage(e.message);
      }
    }

    nameInput.addEventListener("blur", () => {
      const next = nameInput.value.trim();
      if (!next || next === project.name) {
        nameInput.value = project.name || project.id;
        return;
      }
      updateProject({ name: next });
    });
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        nameInput.blur();
      }
    });
    archiveInput.addEventListener("change", () => {
      updateProject({ archived: !archiveInput.checked });
    });
    mountSettingsDateControl(startMount, {
      value: project.start_date || todayIso || "",
      placeholder: "Start date",
      ariaLabel: `${project.name || project.id} start date`,
      onChange: (value) => {
        if (value) updateProject({ start_date: value });
      },
    });
    mountSettingsDateControl(endMount, {
      value: project.end_date || "",
      placeholder: "End date",
      ariaLabel: `${project.name || project.id} end date`,
      onChange: (value) => updateProject({ end_date: value || null }),
    });

    row.appendChild(nameInput);
    row.appendChild(startMount);
    row.appendChild(endMount);
    row.appendChild(archiveLabel);
    list.appendChild(row);
  });
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

function iconClockSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`;
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
    const pids = e.project_ids || e.projectIds || [];
    if (pids.length) {
      const projectsLine = document.createElement("div");
      projectsLine.className = "entry-projects";
      projectsLine.textContent = projectLabels(pids).map((p) => `#${p}`).join(" ");
      main.appendChild(projectsLine);
    }

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
  const out = {
    today: [],
    tomorrow: [],
    future: [],
    scribble: board.querySelector(".scribble-text")?.value.trim() || "",
  };
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
      const note = row.querySelector(".todo-note")?.value.trim() || "";
      const dateInp = row.querySelector(".due-date");
      let deadline = dateInp && dateInp.value ? dateInp.value : null;
      const done = !!row.querySelector(".todo-done")?.checked;
      const project_ids = projectIdsFrom(row.querySelector(".todo-project-mount"));
      out[which].push({ id, text, note, priority: pri, deadline, done, category: cat, project_ids });
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
  const note = row.querySelector(".todo-note")?.value.trim() || "";
  const dateInp = row.querySelector(".due-date");
  const deadline = dateInp && dateInp.value ? dateInp.value : null;
  const done = !!row.querySelector(".todo-done")?.checked;
  const id = row.dataset.taskId || "";
  const project_ids = projectIdsFrom(row.querySelector(".todo-project-mount"));
  return { id, text, note, priority: pri, deadline, done, category: cat, project_ids };
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
    const title = section.querySelector(".todo-pane-title");
    const toggle = section.querySelector(".todo-pane-toggle");
    const list = section.querySelector(".todo-list-inner");
    if (!title || !toggle || !list) return;
    const which = section.dataset.which;
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    const n = countOpenInList(list);
    const base = labelForWhich(which);
    title.textContent = expanded || n === 0 ? base : `${base} (${n})`;
  });
}

function setTodoPaneExpanded(section, expanded) {
  const body = section.querySelector(".todo-pane-body");
  const toggle = section.querySelector(".todo-pane-toggle");
  const which = section.dataset.which;
  if (!body || !toggle || !which) return;
  toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  body.classList.toggle("pane-collapsed", !expanded);
  localStorage.setItem(`ground.todo.pane.${which}.collapsed`, expanded ? "0" : "1");
  refreshAllPaneTitles();
}

function addTaskToPane(section, list) {
  setTodoPaneExpanded(section, true);
  const row = createTodoRow({
    id: newTaskId(),
    text: "",
    note: "",
    priority: "none",
    deadline: null,
    done: false,
    category: defaultCategoryId(),
    project_ids: [],
  });
  list.appendChild(row);
  row.querySelector(".todo-text")?.focus();
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  refreshAllPaneTitles();
  scheduleTodoSave();
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
    list.appendChild(row);
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
    setTodoPaneExpanded(section, true);
  });
}

function mountTaskLogCategoryDd(initialCat) {
  const mount = $("task-log-category-mount");
  if (!mount) return;
  mount.innerHTML = "";
  const val = initialCat || defaultCategoryId();
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
  const projectMount = $("task-log-project-mount");
  if (projectMount) projectMount.innerHTML = "";
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
  mountTaskLogCategoryDd(entry.category || defaultCategoryId());
  mountProjectPicker($("task-log-project-mount"), {
    selectedIds: entry.project_ids || entry.projectIds || [],
    compact: false,
    onChange: null,
  });
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
  const project_ids = projectIdsFrom(row.querySelector(".todo-project-mount"));
  const text = row.querySelector(".todo-text")?.value.trim() || "";
  modal.dataset.sourceTaskId = tid;
  applyTaskLogModalMode("task", null);
  mountTaskLogCategoryDd(cat);
  mountProjectPicker($("task-log-project-mount"), {
    selectedIds: project_ids,
    compact: false,
    onChange: null,
  });
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
    project_ids: entry.project_ids || entry.projectIds || [],
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
  const project_ids = projectIdsFrom($("task-log-project-mount"));
  const body = { category, note, project_ids };
  if (h > 0) body.hours = h;
  body.minutes = m > 0 ? m : 0;
  return { body };
}

function reorderTodoPaneFromRow(row) {
  const list = row.closest(".todo-list-inner");
  if (!list) return;
  const rows = [...list.querySelectorAll(".todo-row")];
  if (rows.length < 2) {
    refreshAllPaneTitles();
    return;
  }
  rows.sort((ra, rb) => compareTasksBySort(rowToTask(ra), rowToTask(rb)));
  rows.forEach((r) => list.appendChild(r));
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
        scribble: payload.scribble,
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
  logBtn.setAttribute("aria-label", "Log time to today");
  logBtn.title = "Log time";
  logBtn.innerHTML = iconClockSvg();
  logBtn.addEventListener("click", () => openTaskLogModal(row));

  top.appendChild(doneCb);
  top.appendChild(inp);
  top.appendChild(logBtn);
  top.appendChild(rm);
  top.appendChild(grip);

  const meta = document.createElement("div");
  meta.className = "todo-meta";

  const metaControls = document.createElement("div");
  metaControls.className = "todo-meta-controls";

  const selectRow = document.createElement("div");
  selectRow.className = "todo-select-row";
  const projectMount = document.createElement("div");
  projectMount.className = "todo-project-mount";
  mountProjectPicker(projectMount, {
    selectedIds: task.project_ids || task.projectIds || [],
    compact: true,
    onChange: () => scheduleTodoSave(),
  });

  const catMount = document.createElement("div");
  catMount.className = "todo-category-dd-mount";
  mountCustomDd(catMount, {
    hiddenId: null,
    hiddenClass: "todo-task-category",
    initialValue: task.category || defaultCategoryId(),
    compact: true,
    onChange: () => {
      scheduleTodoSave();
    },
  });
  selectRow.appendChild(projectMount);
  selectRow.appendChild(catMount);

  const noteInp = document.createElement("textarea");
  noteInp.className = "todo-note";
  noteInp.placeholder = "Notes";
  noteInp.value = task.note || "";
  noteInp.maxLength = 500;
  noteInp.setAttribute("aria-label", "Task notes");
  noteInp.addEventListener("input", scheduleTodoSave);

  const prRow = document.createElement("div");
  prRow.className = "chip-row priority-row";
  const prVal = (task.priority || "none").toLowerCase();
  ["p1", "p2", "p3"].forEach((p) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip pri" + (prVal === p ? " active" : "") + ` p-${p}`;
    b.setAttribute("data-v", p);
    b.textContent = p.toUpperCase();
    b.addEventListener("click", () => {
      prRow.querySelectorAll(".chip.pri").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      reorderTodoPaneFromRow(row);
      scheduleTodoSave();
    });
    prRow.appendChild(b);
  });

  metaControls.appendChild(selectRow);
  metaControls.appendChild(prRow);
  metaControls.appendChild(buildDeadlineRow(task, row));
  meta.appendChild(metaControls);
  meta.appendChild(noteInp);

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

function createScribblePane(text) {
  const section = document.createElement("section");
  section.className = "scribble-pane";

  const expanded =
    localStorage.getItem("ground.todo.pane.scribble.collapsed") !== "1";

  const headBtn = document.createElement("button");
  headBtn.type = "button";
  headBtn.className = "todo-pane-toggle scribble-toggle";
  headBtn.setAttribute("aria-expanded", expanded ? "true" : "false");
  const headLabel = document.createElement("span");
  headLabel.textContent = "Scribble";
  const headIcon = document.createElement("span");
  headIcon.className = "pane-toggle-icon";
  headIcon.setAttribute("aria-hidden", "true");
  headBtn.appendChild(headIcon);
  headBtn.appendChild(headLabel);

  const body = document.createElement("div");
  body.className = "scribble-body" + (expanded ? "" : " pane-collapsed");

  const textarea = document.createElement("textarea");
  textarea.className = "scribble-text";
  textarea.placeholder = "Thoughts before they become actionables";
  textarea.maxLength = 5000;
  textarea.value = text || "";
  textarea.setAttribute("aria-label", "Scribble notes");
  textarea.addEventListener("input", scheduleTodoSave);

  headBtn.addEventListener("click", () => {
    const isOpen = headBtn.getAttribute("aria-expanded") === "true";
    const next = !isOpen;
    headBtn.setAttribute("aria-expanded", next ? "true" : "false");
    body.classList.toggle("pane-collapsed", !next);
    localStorage.setItem("ground.todo.pane.scribble.collapsed", next ? "0" : "1");
  });

  body.appendChild(textarea);
  section.appendChild(headBtn);
  section.appendChild(body);
  return section;
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
  const pids = task.project_ids || task.projectIds || [];
  const projectText = pids.length ? ` · ${projectLabels(pids).map((p) => `#${p}`).join(" ")}` : "";
  meta.textContent = `${catLab} · ${(task.priority || "none").toUpperCase()}${projectText}`;
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
  panes.appendChild(createScribblePane(data.scribble || ""));

  ["today", "tomorrow", "future"].forEach((which) => {
    const section = document.createElement("section");
    section.className = "todo-pane";
    section.dataset.which = which;

    const tasks = data[which] || [];
    const storedCollapsed = localStorage.getItem(`ground.todo.pane.${which}.collapsed`);
    const expanded =
      storedCollapsed === null
        ? which === "today" && tasks.length > 0
        : storedCollapsed !== "1";

    const header = document.createElement("div");
    header.className = "todo-pane-header";

    const headBtn = document.createElement("button");
    headBtn.type = "button";
    headBtn.className = "todo-pane-toggle";
    headBtn.setAttribute("aria-expanded", expanded ? "true" : "false");
    headBtn.innerHTML = `<span class="pane-toggle-icon" aria-hidden="true"></span><span class="todo-pane-title"></span>`;

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "add-task";
    addBtn.setAttribute("aria-label", `Add ${labelForWhich(which).toLowerCase()} intention`);
    addBtn.title = `Add ${labelForWhich(which).toLowerCase()} intention`;
    addBtn.textContent = "+";

    const body = document.createElement("div");
    body.className = "todo-pane-body" + (expanded ? "" : " pane-collapsed");

    const list = document.createElement("div");
    list.className = "todo-list-inner";
    tasks.forEach((t) => list.appendChild(createTodoRow(t)));

    addBtn.addEventListener("click", () => addTaskToPane(section, list));

    headBtn.addEventListener("click", () => {
      const isOpen = headBtn.getAttribute("aria-expanded") === "true";
      setTodoPaneExpanded(section, !isOpen);
    });

    body.appendChild(list);
    header.appendChild(headBtn);
    header.appendChild(addBtn);
    section.appendChild(header);
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
      const pids = e.project_ids || e.projectIds || [];
      const projectText = pids.length ? ` · ${projectLabels(pids).map((p) => `#${p}`).join(" ")}` : "";
      li.textContent = `${fmtDuration(e.minutes)} · ${lab}${projectText}${e.note ? ` — ${e.note}` : ""}${clock}`;
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
  const projectHighlights = payload.projectHighlights || [];
  const recentWithTime = recent.filter((d) => (d.totalMinutes || 0) > 0);
  const hasTime = total > 0 || recentWithTime.length > 0;
  const hasTodos = (todo.tasksRecorded || 0) > 0;
  const hasProjects = projectHighlights.length > 0;

  if (!hasTime && !hasTodos && !hasProjects) {
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

  if (hasProjects) {
    const psec = document.createElement("div");
    psec.className = "analytics-section analytics-projects";
    psec.innerHTML = "<h3>Project highlights</h3>";
    const maxProjectMinutes = Math.max(...projectHighlights.map((p) => p.totalMinutes || 0), 1);
    projectHighlights.forEach((project) => {
      const row = document.createElement("div");
      row.className = "project-highlight" + (project.active ? "" : " is-inactive");
      const pct = Math.round(((project.totalMinutes || 0) / maxProjectMinutes) * 100);
      const notes = (project.recentNotes || []).map((n) => escapeHtml(n.note)).join(" · ");
      row.innerHTML = `
        <div class="project-highlight-head">
          <span>${escapeHtml(project.label)}</span>
          <span>${project.active ? "Active" : "Finished"}</span>
        </div>
        <div class="bar-track"><div class="bar-fill bar-fill-time" style="width:${pct}%"></div></div>
        <div class="project-highlight-meta">
          ${fmtDuration(project.totalMinutes || 0)} · ${project.openTasks || 0} open · ${project.doneTasks || 0} done
        </div>
        ${notes ? `<div class="project-highlight-notes">${notes}</div>` : ""}
      `;
      psec.appendChild(row);
    });
    root.appendChild(psec);
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
  setCategories(meta.categories || []);
  setProjects(meta.projects || []);
  todayIso = meta.today;
  tomorrowIso = meta.tomorrow;
  $("dateLine").textContent = fmtDate(meta.today);
  mountTimeCategoryDd();
  mountTimeProjectPicker();

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
    const project_ids = projectIdsFrom($("time-project-mount"));
    const body = { category, note, project_ids };
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
      mountTimeProjectPicker();
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

  $("settings-open")?.addEventListener("click", openSettingsModal);
  $("settings-close")?.addEventListener("click", closeSettingsModal);
  $("settings-backdrop")?.addEventListener("click", closeSettingsModal);
  $("settings-category-form")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const input = $("settings-category-new");
    const label = input?.value.trim() || "";
    if (!label) return;
    try {
      const data = await api("/api/categories", {
        method: "POST",
        body: JSON.stringify({ label }),
      });
      if (input) input.value = "";
      setCategories(data.categories || []);
      mountTimeCategoryDd();
      renderCategorySettings();
      const today = await api("/api/today");
      renderEntries(today.entries || []);
      await loadTodos();
      input?.focus();
    } catch (e) {
      showAppMessage(e.message);
    }
  });

  initSettingsSectionToggle("projects");
  initSettingsSectionToggle("categories");
  mountSettingsDateControl($("settings-project-new-start-mount"), {
    value: todayIso || "",
    placeholder: "Start date",
    ariaLabel: "Project start date",
    onChange: null,
  });
  $("settings-project-form")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const nameInput = $("settings-project-new-name");
    const startInput = $("settings-project-new-start-mount")?.querySelector(".settings-date-input");
    const name = nameInput?.value.trim() || "";
    const start_date = startInput?.value || todayIso;
    if (!name) return;
    try {
      const data = await api("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name, start_date }),
      });
      if (nameInput) nameInput.value = "";
      mountSettingsDateControl($("settings-project-new-start-mount"), {
        value: todayIso || "",
        placeholder: "Start date",
        ariaLabel: "Project start date",
        onChange: null,
      });
      setProjects(data.projects || []);
      mountTimeProjectPicker(projectIdsFrom($("time-project-mount")));
      renderProjectSettings();
      const today = await api("/api/today");
      renderEntries(today.entries || []);
      await loadTodos();
      nameInput?.focus();
    } catch (e) {
      showAppMessage(e.message);
    }
  });

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
