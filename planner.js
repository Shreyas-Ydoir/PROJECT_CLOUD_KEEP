(() => {
  const timelineList = document.getElementById("timeline-list");
  const timelineEmpty = document.getElementById("timeline-empty");
  const timelineSearch = document.getElementById("timeline-search");
  const timelineStatus = document.getElementById("timeline-status");
  const timelineMessage = document.getElementById("timeline-message");
  const timelineRefresh = document.getElementById("timeline-refresh");
  const timelineFolderFilter = document.getElementById("timeline-folder-filter");
  const timelineFolderForm = document.getElementById("timeline-folder-form");
  const timelineFolderName = document.getElementById("timeline-folder-name");
  const timelineFolderPrefix = document.getElementById("timeline-folder-prefix");
  const timelineFolderDelete = document.getElementById("timeline-folder-delete");
  const timelineDateClear = document.getElementById("timeline-date-clear");
  const calendarDays = document.getElementById("calendar-days");
  const reminderList = document.getElementById("reminder-list");
  const reminderMessage = document.getElementById("reminder-message");
  let reminders = [];
  let timelineEvents = [];
  let timelineDisplayEvents = [];
  let timelineFolders = [];
  let calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  let selectedDate = localDateKey(new Date());
  let timelineDateFilter = "";

  function localDateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function formatDay(value) {
    const [year, month, day] = value.split("-").map(Number);
    return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" })
      .format(new Date(year, month - 1, day));
  }

  function isVisibleTimelineEvent(event) {
    return !event.deleted_at ||
      Boolean(timelineDateFilter) &&
      localDateKey(new Date(event.deleted_at)) === timelineDateFilter;
  }

  function renderTimeline(events) {
    const query = timelineSearch.value.trim().toLowerCase();
    const statusFilter = timelineStatus.value;
    const folderFilter = timelineFolderFilter.value;
    const availableEvents = events.filter(isVisibleTimelineEvent);
    const filtered = availableEvents.filter(event =>
      event.name.toLowerCase().includes(query) &&
      (statusFilter === "all"
        ? true
        : statusFilter === "deleted"
          ? Boolean(event.deleted_at)
          : !event.deleted_at && event.status === statusFilter) &&
      (event.deleted_at
        ? !timelineDateFilter || localDateKey(new Date(event.deleted_at)) === timelineDateFilter
        : !timelineDateFilter || localDateKey(new Date(event.created_at)) === timelineDateFilter) &&
      (folderFilter === "all" ||
        (folderFilter === "unassigned"
          ? event.timeline_folder_id === null
          : String(event.timeline_folder_id) === folderFilter))
    );
    const [field, direction] = document.getElementById("timeline-sort").value.split("-");
    const sorted = [...filtered].sort((a, b) => {
      let comparison;
      if (field === "name") comparison = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      else if (field === "size") comparison = a.size - b.size;
      else comparison = new Date(a.created_at) - new Date(b.created_at);
      return direction === "asc" ? comparison : -comparison;
    });
    document.getElementById("timeline-count").textContent =
      `${sorted.length} of ${availableEvents.length} ${availableEvents.length === 1 ? "event" : "events"}`;
    timelineDateClear.hidden = !timelineDateFilter;
    timelineList.replaceChildren();
    timelineEmpty.hidden = availableEvents.length > 0;
    if (availableEvents.length > 0 && sorted.length === 0) {
      const noMatches = document.createElement("p");
      noMatches.className = "timeline-no-matches";
      noMatches.textContent = "No backups match these filters.";
      timelineList.append(noMatches);
    }
    sorted.forEach(event => {
      const deleted = Boolean(event.deleted_at);
      const item = document.createElement("article");
      item.className = `timeline-event ${event.status === "failed" ? "timeline-event-failed" : ""}${deleted ? " timeline-event-deleted" : ""}`;
      const marker = document.createElement("span");
      marker.className = "timeline-marker";
      const content = document.createElement("div");
      content.className = "timeline-content";
      const heading = document.createElement("div");
      heading.className = "timeline-event-heading";
      const activityLink = document.createElement("a");
      activityLink.href = `activity.html?q=${encodeURIComponent(event.name)}`;
      activityLink.title = "Open this file in upload activity";
      activityLink.textContent = event.name;
      const status = document.createElement("span");
      status.className = `timeline-event-status ${event.status === "failed" ? "status-failed" : ""}${deleted ? " status-deleted" : ""}`;
      status.textContent = deleted ? "Deleted" : event.status === "complete" ? "Uploaded" : "Failed";
      heading.append(activityLink, status);
      const meta = document.createElement("p");
      meta.textContent = `${window.Cloudkeep.formatSize(event.size)} · ${event.mime_type}`;
      const eventMeta = document.createElement("div");
      eventMeta.className = "timeline-event-meta";
      const folderSelect = document.createElement("select");
      folderSelect.className = "timeline-event-folder";
      folderSelect.setAttribute("aria-label", `Choose folder for ${event.name}`);
      const unassigned = document.createElement("option");
      unassigned.value = "";
      unassigned.textContent = "Unassigned";
      folderSelect.append(unassigned);
      timelineFolders.forEach(folder => {
        const option = document.createElement("option");
        option.value = String(folder.id);
        option.textContent = folder.prefix ? `${folder.name} (${folder.prefix}_)` : folder.name;
        folderSelect.append(option);
      });
      if (event.timeline_folder_id !== null) {
        folderSelect.value = String(event.timeline_folder_id);
      }
      folderSelect.disabled = deleted;
      folderSelect.addEventListener("change", () => assignTimelineFolder(event, folderSelect));
      eventMeta.append(meta, folderSelect);
      const date = document.createElement("time");
      date.dateTime = deleted ? event.deleted_at : event.created_at;
      date.textContent = deleted
        ? `Deleted ${window.Cloudkeep.formatDate(event.deleted_at)}`
        : window.Cloudkeep.formatDate(event.created_at);
      content.append(heading, eventMeta, date);
      if (event.error) {
        const error = document.createElement("p");
        error.className = "timeline-event-error";
        error.textContent = event.error;
        content.append(error);
      }
      item.append(marker, content);
      timelineList.append(item);
    });
  }

  function renderCalendar() {
    document.getElementById("calendar-month-label").textContent =
      new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(calendarMonth);
    document.getElementById("selected-date-label").textContent = formatDay(selectedDate);
    calendarDays.replaceChildren();
    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();
    const firstWeekday = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const todayKey = localDateKey(new Date());
    const totalCells = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;

    for (let index = 0; index < totalCells; index += 1) {
      const dayNumber = index - firstWeekday + 1;
      if (dayNumber < 1 || dayNumber > daysInMonth) {
        const spacer = document.createElement("span");
        spacer.className = "calendar-day calendar-day-empty";
        spacer.setAttribute("aria-hidden", "true");
        calendarDays.append(spacer);
        continue;
      }
      const dateKey = localDateKey(new Date(year, month, dayNumber));
      const hasReminder = reminders.some(reminder => reminder.due_date === dateKey);
      const day = document.createElement("button");
      day.type = "button";
      day.className = "calendar-day";
      if (dateKey === todayKey) day.classList.add("is-today");
      if (dateKey === selectedDate) day.classList.add("is-selected");
      day.setAttribute("aria-label", `${formatDay(dateKey)}${hasReminder ? ", has reminders" : ""}`);
      if (dateKey === selectedDate) day.setAttribute("aria-pressed", "true");
      day.append(document.createTextNode(String(dayNumber)));
      if (hasReminder) {
        const dot = document.createElement("span");
        dot.className = "calendar-reminder-dot";
        dot.setAttribute("aria-hidden", "true");
        day.append(dot);
      }
      day.addEventListener("click", () => {
        selectedDate = dateKey;
        reminderMessage.textContent = "";
        timelineDateFilter = dateKey;
        renderTimelineFolders();
        renderTimeline(timelineDisplayEvents);
        renderCalendar();
      });
      calendarDays.append(day);
    }
    renderReminders();
  }

  function renderReminders() {
    reminderList.replaceChildren();
    const selected = reminders.filter(reminder => reminder.due_date === selectedDate);
    const reminderSort = document.getElementById("reminder-sort").value;
    if (reminderSort === "added") {
      selected.sort((a, b) => a.id - b.id);
    } else if (reminderSort === "name-asc" || reminderSort === "name-desc") {
      selected.sort((a, b) => {
        const comparison = a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
        return reminderSort === "name-asc" ? comparison : -comparison;
      });
    } else if (reminderSort === "incomplete" || reminderSort === "complete") {
      selected.sort((a, b) => reminderSort === "incomplete"
        ? Number(Boolean(a.completed)) - Number(Boolean(b.completed))
        : Number(Boolean(b.completed)) - Number(Boolean(a.completed)));
    }
    selected.forEach(reminder => {
      const item = document.createElement("li");
      item.className = `reminder-item ${reminder.completed ? "is-complete" : ""}`;
      const complete = document.createElement("input");
      complete.type = "checkbox";
      complete.checked = Boolean(reminder.completed);
      complete.setAttribute("aria-label", `Mark ${reminder.title} ${reminder.completed ? "incomplete" : "complete"}`);
      complete.addEventListener("change", () => updateReminder(reminder, { completed: complete.checked }));
      const title = document.createElement("span");
      title.className = "reminder-title";
      title.textContent = reminder.title;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "reminder-delete";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Delete reminder: ${reminder.title}`);
      remove.addEventListener("click", () => deleteReminder(reminder));
      item.append(complete, title, remove);
      reminderList.append(item);
    });
    if (!selected.length) {
      const empty = document.createElement("li");
      empty.className = "reminder-empty";
      empty.textContent = "No reminders for this day.";
      reminderList.append(empty);
    }
  }

  async function loadReminders() {
    const month = `${calendarMonth.getFullYear()}-${String(calendarMonth.getMonth() + 1).padStart(2, "0")}`;
    try {
      const data = await window.Cloudkeep.request(`/api/reminders?month=${encodeURIComponent(month)}`);
      reminders = data.reminders;
      renderCalendar();
    } catch (error) {
      reminderMessage.textContent = error.message;
    }
  }

  async function updateReminder(reminder, changes) {
    try {
      await window.Cloudkeep.request(`/api/reminders/${reminder.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes)
      });
      await loadReminders();
    } catch (error) {
      reminderMessage.textContent = error.message;
    }
  }

  async function deleteReminder(reminder) {
    try {
      await window.Cloudkeep.request(`/api/reminders/${reminder.id}`, { method: "DELETE" });
      await loadReminders();
    } catch (error) {
      reminderMessage.textContent = error.message;
    }
  }

  async function initialize() {
    try {
      const session = await window.Cloudkeep.initPage();
      if (!session) return;
      await Promise.all([loadTimeline(), loadReminders()]);
    } catch (error) {
      window.Cloudkeep.showNotice(error.message, true);
    }
  }

  async function loadTimeline() {
    timelineRefresh.disabled = true;
    timelineRefresh.textContent = "Loading…";
    timelineMessage.hidden = true;
    try {
      const timeline = await window.Cloudkeep.request("/api/timeline");
      timelineEvents = timeline.events;
      timelineFolders = timeline.folders;
      timelineDisplayEvents = timelineEvents;
      renderTimelineFolders();
      renderTimeline(timelineDisplayEvents);
      renderCalendar();
    } catch (error) {
      timelineMessage.textContent = error.message;
      timelineMessage.hidden = false;
    } finally {
      timelineRefresh.disabled = false;
      timelineRefresh.textContent = "Refresh";
    }
  }

  function renderTimelineFolders() {
    const selected = timelineFolderFilter.value || "all";
    const counts = new Map();
    const availableEvents = timelineEvents.filter(isVisibleTimelineEvent);
    availableEvents.forEach(event => {
      const key = event.timeline_folder_id === null ? "unassigned" : String(event.timeline_folder_id);
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    timelineFolderFilter.replaceChildren();
    const all = document.createElement("option");
    all.value = "all";
    all.textContent = `All files (${availableEvents.length})`;
    timelineFolderFilter.append(all);
    const unassigned = document.createElement("option");
    unassigned.value = "unassigned";
    unassigned.textContent = `Unassigned (${counts.get("unassigned") || 0})`;
    timelineFolderFilter.append(unassigned);
    timelineFolders.forEach(folder => {
      const option = document.createElement("option");
      option.value = String(folder.id);
      option.textContent = folder.prefix
        ? `${folder.name} (${folder.prefix}_) (${counts.get(String(folder.id)) || 0})`
        : `${folder.name} (${counts.get(String(folder.id)) || 0})`;
      timelineFolderFilter.append(option);
    });
    timelineFolderFilter.value = Array.from(timelineFolderFilter.options)
      .some(option => option.value === selected) ? selected : "all";
    timelineFolderDelete.hidden = timelineFolderFilter.value === "all" ||
      timelineFolderFilter.value === "unassigned";
  }

  async function assignTimelineFolder(event, select) {
    select.disabled = true;
    timelineMessage.hidden = true;
    try {
      const folderId = select.value ? Number(select.value) : null;
      await window.Cloudkeep.request(`/api/timeline/events/${event.id}/folder`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder_id: folderId })
      });
      event.timeline_folder_id = folderId;
      renderTimelineFolders();
      renderTimeline(timelineDisplayEvents);
    } catch (error) {
      timelineMessage.textContent = error.message;
      timelineMessage.hidden = false;
      select.value = event.timeline_folder_id === null ? "" : String(event.timeline_folder_id);
      select.disabled = false;
    }
  }

  timelineFolderForm.addEventListener("submit", async event => {
    event.preventDefault();
    const name = timelineFolderName.value.trim();
    const prefix = timelineFolderPrefix.value.trim();
    if (!name) {
      timelineFolderName.focus();
      return;
    }
    timelineMessage.hidden = true;
    try {
      await window.Cloudkeep.request("/api/timeline/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, prefix })
      });
      timelineFolderName.value = "";
      timelineFolderPrefix.value = "";
      await loadTimeline();
      window.Cloudkeep.showNotice(`"${name}" was created in Cloudkeep and Google Drive.`);
    } catch (error) {
      timelineMessage.textContent = error.message;
      timelineMessage.hidden = false;
    }
  });

  timelineFolderDelete.addEventListener("click", async () => {
    const folderId = Number(timelineFolderFilter.value);
    const folder = timelineFolders.find(item => item.id === folderId);
    if (!folder || !window.confirm(`Delete the "${folder.name}" folder? Its files will become unassigned.`)) return;
    timelineFolderDelete.disabled = true;
    try {
      await window.Cloudkeep.request(`/api/timeline/folders/${folderId}`, { method: "DELETE" });
      timelineFolderFilter.value = "all";
      await loadTimeline();
    } catch (error) {
      timelineMessage.textContent = error.message;
      timelineMessage.hidden = false;
    } finally {
      timelineFolderDelete.disabled = false;
    }
  });

  document.getElementById("timeline-sort").addEventListener("change", () => renderTimeline(timelineDisplayEvents));
  timelineSearch.addEventListener("input", () => renderTimeline(timelineDisplayEvents));
  timelineStatus.addEventListener("change", () => renderTimeline(timelineDisplayEvents));
  timelineDateClear.addEventListener("click", () => {
    timelineDateFilter = "";
    renderTimelineFolders();
    renderTimeline(timelineDisplayEvents);
  });
  timelineFolderFilter.addEventListener("change", () => {
    timelineFolderDelete.hidden = timelineFolderFilter.value === "all" ||
      timelineFolderFilter.value === "unassigned";
    renderTimeline(timelineDisplayEvents);
  });
  timelineRefresh.addEventListener("click", loadTimeline);
  document.getElementById("reminder-sort").addEventListener("change", renderReminders);

  document.getElementById("calendar-prev").addEventListener("click", async () => {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
    selectedDate = localDateKey(calendarMonth);
    timelineDateFilter = selectedDate;
    reminderMessage.textContent = "";
    await loadReminders();
    renderTimeline(timelineDisplayEvents);
  });
  document.getElementById("calendar-next").addEventListener("click", async () => {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
    selectedDate = localDateKey(calendarMonth);
    timelineDateFilter = selectedDate;
    reminderMessage.textContent = "";
    await loadReminders();
    renderTimeline(timelineDisplayEvents);
  });
  document.getElementById("calendar-today").addEventListener("click", async () => {
    const today = new Date();
    calendarMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    selectedDate = localDateKey(today);
    timelineDateFilter = selectedDate;
    reminderMessage.textContent = "";
    await loadReminders();
    renderTimeline(timelineDisplayEvents);
  });
  document.getElementById("reminder-form").addEventListener("submit", async event => {
    event.preventDefault();
    const input = document.getElementById("reminder-title");
    const title = input.value.trim();
    if (!title) {
      input.focus();
      return;
    }
    reminderMessage.textContent = "";
    try {
      await window.Cloudkeep.request("/api/reminders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, due_date: selectedDate })
      });
      input.value = "";
      await loadReminders();
    } catch (error) {
      reminderMessage.textContent = error.message;
    }
  });

  initialize();
})();
