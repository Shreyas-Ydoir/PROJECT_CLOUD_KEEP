# Cloudkeep

Cloudkeep is a local web app with Google sign-in and local email/password
accounts. Users can also connect Google Drive to upload files selected in the
browser to a `Cloudkeep Backups` folder. Its upload log and local account
records are stored in SQLite. The dashboard includes a Planner with an upload
timeline and calendar for account-specific work reminders, plus a separate
scheduled-deletion page.

## Requirements

- Python 3.10 or newer
- A Google Cloud project with the Google Drive API enabled
- An OAuth 2.0 Web application client ID and client secret

## Google setup

1. In [Google Cloud Console](https://console.cloud.google.com/), create or select
   a project and enable **Google Drive API**.
2. Configure the OAuth consent screen. For an app in testing, add the Google
   account you'll use as a test user.
3. Create an OAuth client ID with application type **Web application**.
4. Add `http://127.0.0.1:5000/oauth2callback` as an authorized redirect URI.
   Cloudkeep uses server-side OAuth, so an authorized JavaScript origin is not
   required. The redirect URI must match exactly, including the hostname and
   port; use `127.0.0.1` consistently rather than switching to `localhost`.
5. Copy the client ID and secret into `.env` (instructions below). Do not put
   these credentials in HTML or JavaScript.

Cloudkeep asks for Google sign-in and the `drive.file` scope. That scope lets it
create and manage files that this app creates; it does not grant broad access to
all of the user's Drive files. The first upload creates a `Cloudkeep Backups`
folder in Drive. For local development, Cloudkeep allows OAuthlib's HTTP
callback exception only when the configured callback host is a loopback address
(`127.0.0.1`, `localhost`, or `::1`); use HTTPS for any non-local deployment.

## Test Google sign-in and Drive access

1. Make sure `.env` contains the web client ID and secret, and that
   `GOOGLE_REDIRECT_URI` is exactly
   `http://127.0.0.1:5000/oauth2callback`.
2. If the OAuth consent screen's audience is **External** and its publishing
   status is **Testing**, add the Google account you'll use under **Test users**.
   A testing app only allows listed accounts to authorize.
3. Restart the Flask app after changing `.env`, then open
   <http://127.0.0.1:5000/login.html> and choose **Continue with Google**.
   Complete the Google consent step and confirm you return to the Cloudkeep
   dashboard.
4. Select and upload a small test file. Confirm it appears in the activity log
   and in the `Cloudkeep Backups` folder in the connected Google Drive.

Use the exact local address above throughout the test. A Google `redirect_uri_mismatch`
means the redirect URI in the Cloud OAuth client does not exactly match the
configured `GOOGLE_REDIRECT_URI`. An access-blocked/testing message means the
Google account is not an allowed test user, or the consent screen needs
publishing/verification. Cloudkeep cannot change those Google Cloud settings
for you; they must be updated by someone with access to that Cloud project.

## Run locally on Windows

Open PowerShell in this folder:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
```

Generate the two local secrets and put the output in `.env`:

```powershell
python -c "import secrets; print(secrets.token_hex(32))"
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

Edit `.env` with those values and your Google OAuth client ID and secret, then
start the server:

```powershell
python app.py
```

Open <http://127.0.0.1:5000>. Sign in with Google, choose files, and review
uploads on the activity dashboard.

## Sign-in options

- **Google:** signs in and connects that Google Drive account in one step.
- **Email and password:** creates a local account with a salted, scrypt-hashed
  password. After signing in, use **Connect Google Drive** on the dashboard to
  authorize Drive uploads separately.
- **Profile:** shows the signed-in email, sign-in method, and connected Drive
  account. Google sign-in can show the account's Google profile photo; other
  accounts use an initials avatar.
- **Planner:** the timeline shows backup attempts with search, status filters,
  sorting, refresh, and links to matching upload activity. Create named folders
  with optional unique filename prefixes, assign each file to one folder, and
  switch the view between all, unassigned, or folder contents. A file named
  `prefix_file.ext` is automatically uploaded into the matching prefixed folder
  under `Cloudkeep Backups`; files without a matching prefix stay directly in
  `Cloudkeep Backups`.
  Calendar reminders can be created, marked complete, and deleted; they are
  saved per account in the local SQLite database. Timeline events and reminders
  can be sorted by date, name, size, and completion state.
- **Scheduled deletion:** choose an uploaded Cloudkeep file and a time to move
  it to Google Drive trash. The schedule is stored in SQLite and can be
  cancelled before processing. The page separates future, due, and trashed
  files and shows each item's scheduled date and original upload size. Times are selected in the browser's local
  timezone and stored as UTC. The local Python server must be running at the
  scheduled time; the background worker checks for due actions every 15 seconds.
  Pending actions interrupted by a server restart are requeued on startup.
  Failed Drive actions are recorded in the schedule list and are not retried
  automatically.
- Password-reset email is not available until an email delivery service is
  configured. Local passwords are never stored in plaintext.

## Notes

- The Python server must be running to use Google sign-in and uploads.
- Selected file content is sent to Google Drive and is not retained by
  Cloudkeep. Flask may temporarily spool an upload request to the operating
  system's temporary storage while it is being processed. The local SQLite
  database stores encrypted OAuth credentials and upload metadata/status, not
  the file contents.
- OAuth tokens are encrypted using `TOKEN_ENCRYPTION_KEY`; keep `.env` and the
  `instance` folder private and backed up securely.
- Local email/password accounts and their password hashes are stored in the
  same private SQLite database. The app currently has no password-reset email
  flow.
- Upload requests are limited to 100 MB total and 20 files at a time.
- Files can be selected with the picker or drag-and-drop, reviewed, and then
  uploaded as a batch with a live percentage popup. Browsers expose selected
  names or relative folder paths, not arbitrary absolute paths typed into a text
  field.
- Backup selections, upload activity, planner lists, and scheduled deletion
  groups provide sort controls for their relevant fields.
- Home, Backup, Activity, the Planner timeline, and Scheduled deletion show only
  the account's real records. The Backup picker never preselects files.
- Clearing activity removes only the local upload log; it does not delete any
  files in Drive. Any pending deletion schedules for that account are cancelled
  when the upload history is cleared.
- The Flask development server binds to localhost. Do not expose it publicly
  without adding production-grade deployment, HTTPS, and additional security
  controls.
