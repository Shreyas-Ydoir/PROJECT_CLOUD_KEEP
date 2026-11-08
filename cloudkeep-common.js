(() => {
  let csrfToken = "";

  async function initPage() {
    const response = await fetch("/api/session", { credentials: "same-origin" });
    if (!response.ok) throw new Error("Could not read the sign-in session.");
    const data = await response.json();
    if (!data.authenticated) {
      window.location.replace("/login.html");
      return null;
    }
    csrfToken = data.csrf_token;
    updateProfileAvatars(data);
    const account = document.getElementById("account-email");
    if (account) account.textContent = data.email;
    document.querySelectorAll("[data-logout]").forEach(button => {
      button.addEventListener("click", logout);
    });
    return data;
  }

  function profileInitials(name, email) {
    const words = (name || "").trim().split(/\s+/).filter(Boolean);
    if (words.length > 1) return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
    const localPart = (words[0] || email.split("@")[0]).replace(/[^a-z0-9]/gi, "");
    return (localPart.slice(0, 2) || "?").toUpperCase();
  }

  function updateProfileAvatars(data) {
    const initials = profileInitials(data.profile_name, data.email);
    document.querySelectorAll("[data-profile-avatar]").forEach(avatar => {
      avatar.setAttribute("aria-label", `Profile for ${data.email}`);
      const initialsElement = avatar.querySelector("[data-profile-initials]");
      if (initialsElement) initialsElement.textContent = initials;
      const picture = avatar.querySelector("[data-profile-picture]");
      if (!picture || !data.profile_picture) return;
      picture.addEventListener("error", () => {
        picture.hidden = true;
      }, { once: true });
      picture.addEventListener("load", () => {
        picture.hidden = false;
        if (initialsElement) initialsElement.hidden = true;
      }, { once: true });
      picture.src = data.profile_picture;
    });
  }

  async function request(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (csrfToken && options.method && options.method !== "GET") {
      headers.set("X-CSRF-Token", csrfToken);
    }
    const response = await fetch(url, {
      credentials: "same-origin",
      ...options,
      headers
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      window.location.assign("/login.html");
      throw new Error("Your sign-in session has expired.");
    }
    if (!response.ok) {
      const error = new Error(data.error || "The request could not be completed.");
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function uploadWithProgress(url, body, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      xhr.withCredentials = true;
      if (csrfToken) xhr.setRequestHeader("X-CSRF-Token", csrfToken);
      xhr.upload.addEventListener("progress", event => {
        if (event.lengthComputable && onProgress) {
          onProgress(Math.round(event.loaded / event.total * 100));
        }
      });
      xhr.addEventListener("load", () => {
        let data = {};
        try {
          data = JSON.parse(xhr.responseText || "{}");
        } catch {
          reject(new Error("The upload response was invalid."));
          return;
        }
        if (xhr.status === 401) {
          window.location.assign("/login.html");
          reject(new Error("Your sign-in session has expired."));
          return;
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          const error = new Error(data.error || "The upload could not be completed.");
          error.status = xhr.status;
          reject(error);
          return;
        }
        resolve(data);
      });
      xhr.addEventListener("error", () => reject(new Error("The upload connection failed.")));
      xhr.addEventListener("abort", () => reject(new Error("The upload was cancelled.")));
      xhr.send(body);
    });
  }

  async function logout() {
    try {
      await request("/auth/logout", { method: "POST" });
      window.location.assign("/");
    } catch (error) {
      showNotice(error.message, true);
    }
  }

  function showNotice(message, isError = false) {
    const notice = document.getElementById("page-message");
    if (!notice) return;
    notice.replaceChildren();
    notice.hidden = !message;
    notice.classList.toggle("notice-error", isError);
    if (!message) return;
    const text = document.createElement("p");
    text.textContent = message;
    notice.append(text);
  }

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let size = bytes / 1024;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? "Unknown date"
      : new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      }).format(date);
  }

  window.Cloudkeep = { initPage, request, uploadWithProgress, showNotice, formatSize, formatDate };
})();
