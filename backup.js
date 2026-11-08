(() => {
  const filePicker = document.getElementById("file-picker");
  const dropZone = document.getElementById("drop-zone");
  const progress = document.getElementById("upload-progress");
  const selectedPanel = document.getElementById("selected-files-panel");
  const selectedList = document.getElementById("selected-file-list");
  const selectedPaths = document.getElementById("selected-paths");
  const uploadButton = document.getElementById("upload-selected");
  const clearButton = document.getElementById("clear-selection");
  const selectedSort = document.getElementById("selected-files-sort");
  const MAX_FILES = 20;
  const MAX_BYTES = 100 * 1024 * 1024;
  let driveConnected = false;
  let selectedFiles = [];
  let uploading = false;

  function filePath(file) {
    return file.webkitRelativePath || file.name;
  }

  function renderSelectedFiles() {
    selectedPanel.hidden = selectedFiles.length === 0;
    document.getElementById("selected-files-count").textContent =
      selectedFiles.length ? `(${selectedFiles.length})` : "";
    selectedList.replaceChildren();
    const orderedFiles = selectedFiles.map((file, index) => ({ file, index }));
    const [field, direction] = selectedSort.value.split("-");
    if (field !== "added") {
      orderedFiles.sort((left, right) => {
        const comparison = field === "name"
          ? filePath(left.file).localeCompare(filePath(right.file), undefined, { sensitivity: "base" })
          : left.file.size - right.file.size;
        return direction === "desc" ? -comparison : comparison;
      });
    } else {
      orderedFiles.sort((left, right) => left.index - right.index);
    }
    selectedPaths.value = orderedFiles.map(({ file }) => filePath(file)).join("\n");
    orderedFiles.forEach(({ file, index }) => {
      const item = document.createElement("li");
      const path = document.createElement("span");
      path.className = "selected-file-path";
      path.textContent = filePath(file);
      const size = document.createElement("small");
      size.textContent = window.Cloudkeep.formatSize(file.size);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "selected-file-remove";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove ${file.name}`);
      remove.disabled = uploading;
      remove.addEventListener("click", () => {
        selectedFiles.splice(index, 1);
        renderSelectedFiles();
      });
      item.append(path, size, remove);
      selectedList.append(item);
    });
    uploadButton.disabled = uploading || !driveConnected || selectedFiles.length === 0;
    clearButton.disabled = uploading;
  }

  function addFiles(fileList) {
    const incoming = [...fileList];
    if (!incoming.length) return;
    const merged = [...selectedFiles];
    incoming.forEach(file => {
      const duplicate = merged.some(existing =>
        filePath(existing) === filePath(file) &&
        existing.size === file.size &&
        existing.lastModified === file.lastModified
      );
      if (!duplicate) merged.push(file);
    });
    if (merged.length > MAX_FILES) {
      window.Cloudkeep.showNotice(`Choose no more than ${MAX_FILES} files at a time.`, true);
      return;
    }
    const totalBytes = merged.reduce((total, file) => total + file.size, 0);
    if (totalBytes > MAX_BYTES) {
      window.Cloudkeep.showNotice("Selected files must total no more than 100 MB.", true);
      return;
    }
    selectedFiles = merged;
    window.Cloudkeep.showNotice("");
    renderSelectedFiles();
  }

  async function initialize() {
    try {
      const session = await window.Cloudkeep.initPage();
      if (!session) return;
      driveConnected = session.drive_connected;
      const connect = document.getElementById("connect-drive");
      connect.hidden = driveConnected;
      dropZone.hidden = !driveConnected;
      document.getElementById("drive-title").textContent =
        driveConnected ? "Ready when you are" : "Connect Google Drive";
      document.getElementById("drive-copy").textContent = driveConnected
        ? `Connected to ${session.drive_email}.`
        : "Authorize your Google account to back up files to your Cloudkeep Backups folder.";
      const uploadData = await window.Cloudkeep.request("/api/uploads");
      const uploads = uploadData.uploads;
      const completed = uploads.filter(upload => upload.status === "complete");
      const totalBytes = completed.reduce((total, upload) => total + upload.size, 0);
      document.getElementById("backup-storage-size").textContent =
        `${window.Cloudkeep.formatSize(totalBytes)} uploaded`;
      document.getElementById("backup-storage-count").textContent =
        `${completed.length} successful ${completed.length === 1 ? "upload" : "uploads"}`;
      const uploadFill = document.getElementById("backup-storage-fill");
      uploadFill.style.width = `${uploads.length ? Math.round(completed.length / uploads.length * 100) : 0}%`;
      const recentList = document.getElementById("backup-recent-list");
      recentList.replaceChildren();
      uploads.slice(0, 3).forEach(upload => {
        const item = document.createElement("li");
        const name = document.createElement("span");
        name.textContent = upload.name;
        name.title = upload.name;
        const details = document.createElement("small");
        details.textContent = `${window.Cloudkeep.formatSize(upload.size)} · ${window.Cloudkeep.formatDate(upload.created_at)}`;
        const status = document.createElement("b");
        status.className = upload.status === "complete" ? "is-complete" : "is-failed";
        status.textContent = upload.status === "complete" ? "Done" : "Failed";
        item.append(name, details, status);
        recentList.append(item);
      });
      if (!uploads.length) {
        const item = document.createElement("li");
        item.textContent = "Your uploads will appear here.";
        recentList.append(item);
      }
      const error = new URLSearchParams(window.location.search).get("error");
      if (error === "drive_linked") {
        window.Cloudkeep.showNotice("That Google Drive account is already connected to another Cloudkeep account.", true);
      }
    } catch (error) {
      window.Cloudkeep.showNotice(error.message, true);
    }
  }

  async function uploadSelectedFiles() {
    if (!selectedFiles.length || !driveConnected || uploading) return;
    const files = [...selectedFiles];
    const body = new FormData();
    files.forEach(file => body.append("files", file, file.name));
    progress.hidden = false;
    progress.textContent = `Uploading 0% · ${files.length} ${files.length === 1 ? "file" : "files"} to Google Drive…`;
    window.Cloudkeep.showNotice("");
    uploading = true;
    filePicker.disabled = true;
    dropZone.classList.add("is-busy");
    renderSelectedFiles();
    try {
      const result = await window.Cloudkeep.uploadWithProgress("/api/upload", body, percentage => {
        progress.textContent = `Uploading ${percentage}% · ${files.length} ${files.length === 1 ? "file" : "files"} to Google Drive…`;
      });
      selectedFiles = files.filter((file, index) => result.uploads[index]?.status === "failed");
      progress.hidden = true;
      renderSelectedFiles();
      window.Cloudkeep.showNotice(
        `${result.succeeded} uploaded${result.failed ? `, ${result.failed} failed. Failed files remain selected so you can retry.` : "."}`,
        result.failed > 0
      );
    } catch (error) {
      progress.hidden = true;
      if (error.status === 409) {
        driveConnected = false;
        document.getElementById("connect-drive").hidden = false;
        dropZone.hidden = true;
        document.getElementById("drive-title").textContent = "Reconnect Google Drive";
        document.getElementById("drive-copy").textContent = "Reconnect your Google account to continue uploading.";
      }
      window.Cloudkeep.showNotice(error.message, true);
    } finally {
      uploading = false;
      filePicker.disabled = false;
      dropZone.classList.remove("is-busy");
      renderSelectedFiles();
    }
  }

  filePicker.addEventListener("change", () => {
    addFiles(filePicker.files);
    filePicker.value = "";
  });
  uploadButton.addEventListener("click", uploadSelectedFiles);
  clearButton.addEventListener("click", () => {
    if (uploading) return;
    selectedFiles = [];
    window.Cloudkeep.showNotice("");
    renderSelectedFiles();
  });
  selectedSort.addEventListener("change", renderSelectedFiles);
  ["dragenter", "dragover"].forEach(name => {
    dropZone.addEventListener(name, event => {
      event.preventDefault();
      event.stopPropagation();
      if (!filePicker.disabled) {
        event.dataTransfer.dropEffect = "copy";
        dropZone.classList.add("is-dragging");
      }
    });
  });
  ["dragleave", "dragend"].forEach(name => {
    dropZone.addEventListener(name, event => {
      event.preventDefault();
      dropZone.classList.remove("is-dragging");
    });
  });
  dropZone.addEventListener("drop", event => {
    event.preventDefault();
    event.stopPropagation();
    dropZone.classList.remove("is-dragging");
    if (event.dataTransfer?.files.length && !uploading) addFiles(event.dataTransfer.files);
  });

  initialize();
})();
