(() => {
  const fileSelect = document.getElementById("deletion-file");
  const dateInput = document.getElementById("deletion-date");
  const form = document.getElementById("deletion-form");
  const submitButton = form.querySelector('button[type="submit"]');
  let deletionRecords = [];
  const labels = {
    scheduled: "Scheduled",
    deleting: "In progress",
    trashed: "Moved to Drive trash",
    failed: "Failed",
    cancelled: "Cancelled"
  };
  function showError(message) {
    window.Cloudkeep.showNotice(message, true);
  }

  function formatSchedule(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? "Unknown date"
      : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short"
      }).format(date);
  }

  function isDueTodayOrEarlier(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return false;
    const today = new Date();
    date.setHours(0, 0, 0, 0);
    today.setHours(0, 0, 0, 0);
    return date <= today;
  }

  function setMinimumDate() {
    const now = new Date();
    now.setMinutes(now.getMinutes() + 1);
    now.setSeconds(0, 0);
    dateInput.min = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}T${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  }

  function localDateTimeInput(value) {
    const date = new Date(value);
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  }

  async function loadFiles() {
    const [{ uploads }, { deletions }] = await Promise.all([
      window.Cloudkeep.request("/api/uploads"),
      window.Cloudkeep.request("/api/deletions")
    ]);
    const scheduledFileIds = new Set(
      deletions
        .filter(item => item.status === "scheduled" || item.status === "deleting")
        .map(item => item.drive_file_id)
    );
    const candidates = uploads.filter(item =>
      item.status === "complete" && item.drive_file_id && !scheduledFileIds.has(item.drive_file_id)
    );
    fileSelect.replaceChildren();
    if (!candidates.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No uploaded files available";
      fileSelect.append(option);
      fileSelect.disabled = true;
      updateSubmitAvailability();
      return;
    }
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select a backed-up file";
    fileSelect.append(placeholder);
    candidates.forEach(item => {
      const option = document.createElement("option");
      option.value = item.drive_file_id;
      option.textContent = `${item.name} · ${window.Cloudkeep.formatSize(item.size)}`;
      fileSelect.append(option);
    });
    fileSelect.disabled = false;
    updateSubmitAvailability();
  }

  function updateSubmitAvailability() {
    submitButton.disabled = fileSelect.disabled ||
      !Array.from(fileSelect.options).some(option => option.value);
  }

  function renderGroup(listId, emptyId, countId, deletions) {
    const list = document.getElementById(listId);
    list.replaceChildren();
    if (emptyId) document.getElementById(emptyId).hidden = deletions.length > 0;
    document.getElementById(countId).textContent = String(deletions.length);
    const sort = document.querySelector(`[data-sort-list="${listId}"]`);
    const ordered = [...deletions];
    if (sort) {
      const [field, direction] = sort.value.split("-");
      ordered.sort((a, b) => {
        let comparison;
        if (field === "name") comparison = a.file_name.localeCompare(b.file_name, undefined, { sensitivity: "base" });
        else if (field === "size") comparison = a.file_size - b.file_size;
        else {
          const dateA = new Date(a.status === "trashed" ? a.completed_at || a.scheduled_at : a.scheduled_at);
          const dateB = new Date(b.status === "trashed" ? b.completed_at || b.scheduled_at : b.scheduled_at);
          comparison = dateA - dateB;
        }
        return direction === "asc" ? comparison : -comparison;
      });
    }
    ordered.forEach(deletion => {
      const row = document.createElement("article");
      row.className = "deletion-row";
      const name = document.createElement("strong");
      name.className = "deletion-file-name";
      name.textContent = deletion.file_name;
      const when = document.createElement("time");
      const displayDate = deletion.status === "trashed"
        ? deletion.completed_at || deletion.scheduled_at
        : deletion.scheduled_at;
      when.dateTime = displayDate;
      when.textContent = formatSchedule(displayDate);
      const size = document.createElement("span");
      size.className = "deletion-file-size";
      size.textContent = window.Cloudkeep.formatSize(deletion.file_size);
      const status = document.createElement("span");
      status.className = `deletion-status deletion-status-${deletion.status}`;
      const overdue = deletion.status === "scheduled" && new Date(deletion.scheduled_at) < new Date();
      status.textContent = overdue ? "Overdue" : labels[deletion.status] || deletion.status;
      const info = document.createElement("div");
      info.className = "deletion-info";
      info.append(name, when, size, status);
      row.append(info);
      if (deletion.status === "scheduled") {
        const actions = document.createElement("div");
        actions.className = "deletion-actions";
        const change = document.createElement("button");
        change.type = "button";
        change.className = "deletion-change";
        change.textContent = "Edit";
        change.addEventListener("click", () => beginReschedule(deletion, when, actions));
        actions.append(change);
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "deletion-cancel";
        cancel.textContent = "Cancel";
        cancel.addEventListener("click", () => {
          cancelDeletion(deletion.id);
        });
        actions.append(cancel);
        row.append(actions);
      }
      if (deletion.error) {
        const error = document.createElement("p");
        error.className = "deletion-error";
        error.textContent = deletion.error;
        row.append(error);
      }
      list.append(row);
    });
  }

  function beginReschedule(deletion, when, actions) {
    const input = document.createElement("input");
    input.type = "datetime-local";
    input.className = "deletion-edit-date";
    input.value = localDateTimeInput(deletion.scheduled_at);
    const now = new Date();
    now.setMinutes(now.getMinutes() + 1);
    now.setSeconds(0, 0);
    input.min = localDateTimeInput(now.toISOString());
    when.replaceWith(input);

    const save = document.createElement("button");
    save.type = "button";
    save.className = "deletion-change";
    save.textContent = "Save";
    save.addEventListener("click", () => saveReschedule(deletion, input));
    const discard = document.createElement("button");
    discard.type = "button";
    discard.className = "deletion-cancel";
    discard.textContent = "Cancel";
    discard.addEventListener("click", () => render(deletionRecords));
    actions.replaceChildren(save, discard);
    input.focus();
  }

  async function saveReschedule(deletion, input) {
    const scheduledAt = new Date(input.value);
    if (!input.value || Number.isNaN(scheduledAt.getTime()) || scheduledAt <= new Date()) {
      showError("Choose a future deletion date and time.");
      input.focus();
      return;
    }
    try {

      await window.Cloudkeep.request(`/api/deletions/${deletion.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduled_at: scheduledAt.toISOString() })
      });
      await loadDeletions();
      window.Cloudkeep.showNotice("Deletion schedule updated.");
    } catch (error) {
      showError(error.message);
    }
  }

  function render(deletions) {
    deletionRecords = deletions;
    const active = deletionRecords.filter(item =>
      item.status === "scheduled" || item.status === "deleting"
    );
    const pending = active.filter(item => !isDueTodayOrEarlier(item.scheduled_at));
    const today = active.filter(item => isDueTodayOrEarlier(item.scheduled_at));
    const moved = deletions.filter(item => item.status === "trashed");
    const other = deletions.filter(item => item.status === "failed" || item.status === "cancelled");
    renderGroup("deletions-pending", "pending-empty", "pending-count", pending);
    renderGroup("deletions-today", "today-empty", "today-count", today);
    renderGroup("deletions-moved", "moved-empty", "moved-count", moved);
    document.getElementById("deletion-other-card").hidden = other.length === 0;
    renderGroup("deletions-other", null, "other-count", other);
  }

  async function loadDeletions() {
    const { deletions } = await window.Cloudkeep.request("/api/deletions");
    render(deletions);
  }

  document.querySelectorAll(".deletion-sort").forEach(sort => {
    sort.addEventListener("change", () => render(deletionRecords));
  });

  async function cancelDeletion(id) {
    try {
      await window.Cloudkeep.request(`/api/deletions/${id}`, { method: "DELETE" });
      await loadDeletions();
      window.Cloudkeep.showNotice("Scheduled deletion cancelled.");
    } catch (error) {
      showError(error.message);
    }
  }

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const scheduledAt = new Date(dateInput.value);
    if (Number.isNaN(scheduledAt.getTime()) || scheduledAt <= new Date()) {
      showError("Choose a future deletion date and time.");
      return;
    }
    submitButton.disabled = true;
    try {
      await window.Cloudkeep.request("/api/deletions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file_id: fileSelect.value,
          scheduled_at: scheduledAt.toISOString()
        })
      });
      form.reset();
      setMinimumDate();
      await Promise.all([loadFiles(), loadDeletions()]);
      window.Cloudkeep.showNotice("Deletion scheduled. The file will be moved to Google Drive trash at the selected time.");
    } catch (error) {
      showError(error.message);
    } finally {
      updateSubmitAvailability();
    }
  });

  async function initialize() {
    try {
      const session = await window.Cloudkeep.initPage();
      if (!session) return;
      hasUploadedFile = Boolean(session.has_uploaded);
      if (!session.drive_connected) {
        const { uploads } = await window.Cloudkeep.request("/api/uploads");
        hasUploadedFile ||= uploads.some(item => item.status === "complete");
        fileSelect.replaceChildren();
        const option = document.createElement("option");
        option.textContent = "Connect Google Drive to schedule a deletion";
        option.value = "";
        fileSelect.append(option);
        fileSelect.disabled = true;
        submitButton.disabled = true;
        window.Cloudkeep.showNotice("Connect Google Drive before scheduling file deletion.", true);
      } else {
        await loadFiles();
      }
      setMinimumDate();
      await loadDeletions();
    } catch (error) {
      showError(error.message);
    }
  }

  initialize();
})();
