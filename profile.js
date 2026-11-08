(() => {
  async function loadProfile() {
    try {
      const account = await window.Cloudkeep.initPage();
      if (!account) return;
      const heading = document.getElementById("profile-name");
      const displayName = account.profile_name || "Your account";
      heading.textContent = displayName;
      document.getElementById("profile-email").textContent = account.email;
      document.getElementById("profile-signin-email").textContent = account.email;
      document.getElementById("profile-auth-method").textContent =
        account.auth_method === "google" ? "Google" : "Email and password";
      document.getElementById("profile-drive-email").textContent =
        account.drive_email || "Not connected";
    } catch (error) {
      window.Cloudkeep.showNotice(error.message, true);
    }
  }

  loadProfile();
})();
