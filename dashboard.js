(() => {
  const fileList = document.getElementById("dashboard-files");
  const tableWrap = document.getElementById("files-table-wrap");
  const emptyState = document.getElementById("files-empty");
  const noResults = document.getElementById("files-no-results");
  const search = document.getElementById("dashboard-search");
  const refreshTime = document.getElementById("last-checked");
  let uploads = [];

  function fileIcon(name) {
    const lower = name.toLowerCase();
    if (/\.(jpg|jpeg|png|gif|webp|svg|heic)$/.test(lower)) return ["image", "▧"];
    if (/\.pdf$/.test(lower)) return ["pdf", "▤"];
    if (/\.(zip|rar|7z|tar|gz)$/.test(lower)) return ["archive", "▦"];
    return ["", "▤"];
  }

  function renderFiles() {
    const query = search.value.trim().toLocaleLowerCase();
    const visible = uploads
      .filter(upload => upload.name.toLocaleLowerCase().includes(query))
      .slice(0, 7);
    fileList.replaceChildren();
    visible.forEach(upload => {
      const row = document.createElement("tr");
      row.className = "dashboard-file-row";

      const nameCell = document.createElement("td");
      const nameWrap = document.createElement("span");
      nameWrap.className = "dashboard-file-name";
      const [iconType, iconText] = fileIcon(upload.name);
      const icon = document.createElement("span");
      icon.className = `dashboard-file-icon ${iconType}`;
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = iconText;
      const name = document.createElement("span");
      name.className = "dashboard-file-label";
      name.textContent = upload.name;
      name.title = upload.name;
      nameWrap.append(icon, name);
      nameCell.append(nameWrap);

      const sizeCell = document.createElement("td");
      sizeCell.textContent = window.Cloudkeep.formatSize(upload.size);

      const dateCell = document.createElement("td");
      const time = document.createElement("time");
      time.dateTime = upload.created_at;
      time.textContent = window.Cloudkeep.formatDate(upload.created_at);
      dateCell.append(time);

      const statusCell = document.createElement("td");
      const status = document.createElement("span");
      status.className = `dashboard-file-status ${upload.status === "complete" ? "is-complete" : "is-failed"}`;
      const statusIcon = document.createElement("i");
      statusIcon.setAttribute("aria-hidden", "true");
      statusIcon.textContent = upload.status === "complete" ? "✓" : "!";
      status.append(statusIcon, document.createTextNode(upload.status === "complete" ? "Backed up" : "Failed"));
      statusCell.append(status);
      row.append(nameCell, sizeCell, dateCell, statusCell);
      fileList.append(row);
    });

    const hasUploads = uploads.length > 0;
    tableWrap.hidden = !hasUploads || visible.length === 0;
    emptyState.hidden = hasUploads;
    noResults.hidden = !hasUploads || visible.length > 0;
  }

  function updateOverview(session) {
    const completed = uploads.filter(upload => upload.status === "complete");
    const failed = uploads.length - completed.length;
    const bytes = completed.reduce((total, upload) => total + upload.size, 0);
    const completionRate = uploads.length ? Math.round(completed.length / uploads.length * 100) : 0;
    const hour = new Date().getHours();
    const greeting = hour < 12 ? "Good morning," : hour < 18 ? "Good afternoon," : "Good evening,";
    const firstName = session.profile_name?.trim().split(/\s+/)[0] || session.email.split("@")[0];

    document.getElementById("greeting").textContent = `${greeting} ${firstName}`;
    document.getElementById("backup-status").textContent =
      uploads.length === 0 ? "Ready when you are" : failed ? `${failed} need attention` : "Up to date";
    document.getElementById("backup-status-note").textContent =
      uploads.length === 0 ? "No uploads yet" : failed ? `${failed} failed upload${failed === 1 ? "" : "s"}` : "Your uploads are looking good";
    document.getElementById("total-files").textContent = completed.length.toLocaleString();
    document.getElementById("total-size").textContent = `${window.Cloudkeep.formatSize(bytes)} stored`;
    document.getElementById("last-backup").textContent = completed.length
      ? window.Cloudkeep.formatDate(completed[0].created_at)
      : "No uploads yet";
    document.getElementById("drive-status-title").textContent = session.drive_connected ? "Connected" : "Not connected";
    document.getElementById("drive-status-note").textContent = session.drive_connected
      ? session.drive_email || "Google Drive is ready"
      : "Connect to back up files";
    document.getElementById("connection-state").textContent = session.drive_connected ? "Authenticated" : "Not connected";
    document.getElementById("connection-description").textContent = session.drive_connected
      ? "Your Google Drive account is ready for uploads."
      : "Connect Google Drive to start backing up files.";
    document.getElementById("connect-drive").textContent = session.drive_connected
      ? "Connection settings"
      : "Connect Google Drive";
    document.getElementById("usage-percent").textContent = `${completionRate}%`;
    document.getElementById("usage-size").textContent = window.Cloudkeep.formatSize(bytes);
    document.getElementById("usage-complete").textContent = completed.length.toLocaleString();
    document.getElementById("usage-ring").style.setProperty("--usage", `${completionRate}%`);
    document.getElementById("system-state").textContent = "Cloudkeep is online";
    refreshTime.textContent = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit"
    }).format(new Date());
    document.getElementById("home-date").textContent = new Intl.DateTimeFormat(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric"
    }).format(new Date()).toUpperCase();
  }

  async function loadDashboard() {
    try {
      const session = await window.Cloudkeep.initPage();
      if (!session) return;
      const data = await window.Cloudkeep.request("/api/uploads");
      uploads = data.uploads;
      updateOverview(session);
      renderFiles();
    } catch (error) {
      document.getElementById("system-state").textContent = "Could not connect";
      window.Cloudkeep.showNotice(error.message, true);
    }
  }

  search.addEventListener("input", renderFiles);
  loadDashboard();
})();
