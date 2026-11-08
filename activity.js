(() => {
  const list = document.getElementById("activity-list");
  const tableWrap = document.getElementById("activity-table-wrap");
  const empty = document.getElementById("empty-state");
  const search = document.querySelector(".search-box input");
  const filter = document.querySelector(".activity-controls select");
  const sort = document.getElementById("activity-sort");
  const count = document.getElementById("activity-count");
  const clearButton = document.getElementById("clear-activity");
  const clearFiltersButton = document.getElementById("clear-filters");
  const params = new URLSearchParams(window.location.search);
  const dateFilter = /^\d{4}-\d{2}-\d{2}$/.test(params.get("date") || "") ? params.get("date") : "";
  let uploads = [];
  let displayUploads = [];
  search.value = params.get("q") || "";

  function fileIcon(name) {
    const lower = name.toLowerCase();
    if (/\.(jpg|jpeg|png|gif|webp|svg|heic)$/.test(lower)) return ["image", "▧"];
    if (/\.pdf$/.test(lower)) return ["pdf", "▤"];
    if (/\.(zip|rar|7z|tar|gz)$/.test(lower)) return ["archive", "▦"];
    return ["", "▧"];
  }

  function render() {
    const query = search.value.trim().toLowerCase();
    const statusFilter = filter.value;
    const visible = displayUploads.filter(item =>
      item.name.toLowerCase().includes(query) &&
      (statusFilter === "all" || item.status === statusFilter) &&
      (!dateFilter || localDateKey(item.created_at) === dateFilter)
    );
    const [sortField, sortDirection] = sort.value.split("-");
    visible.sort((left, right) => {
      let comparison;
      if (sortField === "name") comparison = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
      else if (sortField === "size") comparison = left.size - right.size;
      else comparison = new Date(left.created_at) - new Date(right.created_at);
      return sortDirection === "asc" ? comparison : -comparison;
    });
    list.replaceChildren();
    visible.forEach(item => {
      const row = document.createElement("tr");
      row.className = "activity-row";
      const timeCell = document.createElement("td");
      const time = document.createElement("time");
      time.className = "activity-date";
      time.dateTime = item.created_at;
      time.textContent = window.Cloudkeep.formatDate(item.created_at);
      timeCell.append(time);

      const nameCell = document.createElement("td");
      const name = document.createElement("span");
      name.className = "activity-file-name";
      name.textContent = item.name;
      name.title = item.name;
      const status = document.createElement("span");
      status.className = `activity-status ${item.status === "failed" ? "status-failed" : ""}`;
      status.textContent = item.status === "complete" ? "Uploaded" : "Failed";
      nameCell.append(name, status);

      const sizeCell = document.createElement("td");
      sizeCell.className = "activity-size";
      sizeCell.textContent = window.Cloudkeep.formatSize(item.size);

      const driveStatusCell = document.createElement("td");
      const driveStatus = document.createElement("span");
      driveStatus.className = "activity-drive-status";
      if (item.drive_status === "deleted") {
        driveStatus.classList.add("is-deleted");
        driveStatus.textContent = "Deleted";
      } else if (item.drive_status === "on_drive") {
        driveStatus.classList.add("is-on-drive");
        driveStatus.textContent = "Still on Drive";
      } else if (item.drive_status === "unknown") {
        driveStatus.classList.add("is-unavailable");
        driveStatus.textContent = "Status unavailable";
      } else {
        driveStatus.classList.add("is-unavailable");
        driveStatus.textContent = "Not uploaded";
      }
      driveStatusCell.append(driveStatus);

      const deletionCell = document.createElement("td");
      deletionCell.className = "activity-deletion-date";
      if (item.scheduled_deletion_at) {
        const deletionTime = document.createElement("time");
        deletionTime.dateTime = item.scheduled_deletion_at;
        deletionTime.textContent = new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "short"
        }).format(new Date(item.scheduled_deletion_at));
        deletionCell.append(deletionTime);
      } else {
        deletionCell.textContent = "Not scheduled";
      }
      row.append(timeCell, nameCell, sizeCell, driveStatusCell, deletionCell);
      if (item.error) row.title = item.error;
      list.append(row);
    });
    const hasNoItems = displayUploads.length === 0;
    empty.hidden = visible.length > 0;
    tableWrap.hidden = visible.length === 0;
    clearButton.disabled = uploads.length === 0;
    clearFiltersButton.hidden = !dateFilter && !search.value && filter.value === "all";
    const realCount = uploads.length;
    count.textContent = `${realCount} ${realCount === 1 ? "file" : "files"}`;
    const completedUploads = uploads.filter(item => item.status === "complete");
    const totalBytes = completedUploads.reduce((total, item) => total + item.size, 0);
    const lastUpload = completedUploads.reduce((latest, item) =>
      !latest || new Date(item.created_at) > new Date(latest.created_at) ? item : latest, null);
    document.getElementById("activity-summary-count").textContent = uploads.length.toLocaleString();
    document.getElementById("activity-summary-size").textContent = window.Cloudkeep.formatSize(totalBytes);
    document.getElementById("activity-summary-last").textContent =
      lastUpload ? window.Cloudkeep.formatDate(lastUpload.created_at) : "—";
    const statusSummary = document.getElementById("activity-summary-status");
    statusSummary.textContent = uploads.length === 0
      ? "No uploads yet"
      : completedUploads.length === uploads.length ? "All uploaded" : "Needs attention";
    statusSummary.classList.toggle("has-failures", completedUploads.length < uploads.length && uploads.length > 0);
    if (hasNoItems) {
      empty.querySelector("h3").textContent = "No uploads to show";
      empty.querySelector("p").textContent = "Files you back up will appear here with their upload status.";
      empty.querySelector("a").hidden = false;
    } else if (!visible.length) {
      empty.querySelector("h3").textContent = "No matching files";
      empty.querySelector("p").textContent = dateFilter
        ? `No uploads were recorded on ${formatFilterDate(dateFilter)}.`
        : "Try changing your search or status filter.";
      empty.querySelector("a").hidden = true;
    }
  }

  function localDateKey(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function formatFilterDate(value) {
    const [year, month, day] = value.split("-").map(Number);
    return new Intl.DateTimeFormat(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric"
    }).format(new Date(year, month - 1, day));
  }

  async function initialize() {
    try {
      const session = await window.Cloudkeep.initPage();
      if (!session) return;
      const data = await window.Cloudkeep.request("/api/uploads");
      uploads = data.uploads;
      displayUploads = uploads;
      render();
    } catch (error) {
      window.Cloudkeep.showNotice(error.message, true);
    }
  }

  search.addEventListener("input", render);
  filter.addEventListener("change", render);
  sort.addEventListener("change", render);
  clearButton.addEventListener("click", async () => {
    if (!uploads.length || !window.confirm("Clear the upload history? This will not delete files from Google Drive, but it will cancel pending scheduled deletions.")) return;
    try {
      await window.Cloudkeep.request("/api/uploads", { method: "DELETE" });
      uploads = [];
      displayUploads = [];
      render();
      window.Cloudkeep.showNotice("Upload history cleared. Files in Google Drive were not changed.");
    } catch (error) {
      window.Cloudkeep.showNotice(error.message, true);
    }
  });
  clearFiltersButton.addEventListener("click", () => {
    window.location.href = "activity.html";
  });

  initialize();
})();
