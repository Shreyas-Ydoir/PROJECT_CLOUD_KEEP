(() => {
  const dialog = document.getElementById("info-dialog");
  const label = document.getElementById("info-dialog-label");
  const title = document.getElementById("info-dialog-title");
  const copy = document.getElementById("info-dialog-copy");
  const answers = {
    storage: {
      label: "YOUR FILES",
      title: "Your Drive, your files.",
      copy: "Choose the files you want to back up. Cloudkeep uploads them to a dedicated Cloudkeep Backups folder in the Google Drive account you connect."
    },
    privacy: {
      label: "YOUR PRIVACY",
      title: "You stay in control.",
      copy: "Cloudkeep only uploads files you select. The app uses Google Drive’s limited file access for files it creates, and keeps an activity log so you can see what was uploaded."
    }
  };

  document.querySelectorAll("[data-info]").forEach(button => {
    button.addEventListener("click", () => {
      const answer = answers[button.dataset.info];
      if (!answer) return;
      label.textContent = answer.label;
      title.textContent = answer.title;
      copy.textContent = answer.copy;
      dialog.showModal();
    });
  });

  dialog.querySelector(".info-dialog-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", event => {
    if (event.target === dialog) dialog.close();
  });
})();
