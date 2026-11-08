(() => {
  const loginMessage = document.getElementById("login-message");
  if (!loginMessage) return;

  const errors = {
    not_configured: "Google Drive sign-in is not configured yet. Follow the setup steps in README.md.",
    cancelled: "Google sign-in was cancelled.",
    state: "Sign-in expired or could not be verified. Please try again.",
    unverified: "Google did not return a verified email address.",
    oauth: "Google sign-in could not be completed. Check the server log and try again.",
    drive_linked: "That Google Drive account is already connected to another Cloudkeep account."
  };
  const error = new URLSearchParams(window.location.search).get("error");
  if (error && errors[error]) loginMessage.textContent = errors[error];

  const form = document.getElementById("login-form");
  const emailInput = document.getElementById("email");
  const passwordInput = document.getElementById("password");
  const confirmField = document.getElementById("confirm-password-field");
  const confirmInput = document.getElementById("confirm-password");
  const submitButton = document.getElementById("submit-login");
  const title = document.getElementById("login-title");
  const description = document.getElementById("login-description");
  const modeToggle = document.getElementById("toggle-auth-mode");
  let createAccount = false;
  let csrf = "";

  modeToggle.addEventListener("click", () => {
    createAccount = !createAccount;
    title.innerHTML = createAccount ? "Make yourself<br>at home." : "Good to have<br>you here.";
    description.textContent = createAccount
      ? "Create an account to keep your backup history in one place."
      : "Log in to check in on your files.";
    passwordInput.autocomplete = createAccount ? "new-password" : "current-password";
    confirmField.hidden = !createAccount;
    confirmInput.required = createAccount;
    submitButton.innerHTML = createAccount
      ? "Create account <span aria-hidden=\"true\">↗</span>"
      : "Log in <span aria-hidden=\"true\">↗</span>";
    modeToggle.textContent = createAccount ? "Log in instead" : "Create an account";
    document.querySelector("#auth-switch").firstChild.textContent =
      createAccount ? "Already have an account? " : "New to Cloudkeep? ";
    loginMessage.textContent = "";
  });

  document.getElementById("forgot-link").addEventListener("click", event => {
    event.preventDefault();
    loginMessage.textContent = "Password reset email is not configured. Contact the app administrator to reset a local account.";
  });

  fetch("/api/session", { credentials: "same-origin" })
    .then(response => {
      if (!response.ok) throw new Error("Could not initialize sign-in.");
      return response.json();
    })
    .then(data => {
      csrf = data.csrf_token;
      if (data.authenticated) window.location.replace("/dashboard.html");
    })
    .catch(() => {
      loginMessage.textContent = "Could not connect to Cloudkeep. Start the Python server and reload this page.";
    });

  form.addEventListener("submit", async event => {
    event.preventDefault();
    loginMessage.textContent = "";
    if (!form.reportValidity()) return;
    if (createAccount && passwordInput.value !== confirmInput.value) {
      loginMessage.textContent = "The passwords do not match.";
      confirmInput.focus();
      return;
    }
    if (!csrf) {
      loginMessage.textContent = "Your sign-in session is not ready. Reload the page and try again.";
      return;
    }
    submitButton.disabled = true;
    try {
      const response = await fetch(createAccount ? "/api/auth/register" : "/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({ email: emailInput.value, password: passwordInput.value })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Sign-in failed. Please try again.");
      window.location.assign("/dashboard.html");
    } catch (requestError) {
      loginMessage.textContent = requestError.message || "Could not connect to Cloudkeep.";
    } finally {
      submitButton.disabled = false;
    }
  });
})();
