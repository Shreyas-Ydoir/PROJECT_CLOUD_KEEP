import json
import logging
import os
import re
import secrets
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import load_dotenv
from flask import Flask, abort, jsonify, redirect, request, send_from_directory, session
from google.auth.exceptions import GoogleAuthError
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaIoBaseUpload
from cryptography.fernet import Fernet, InvalidToken
from werkzeug.security import check_password_hash, generate_password_hash


BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

SCOPES = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/drive.file",
]
MAX_UPLOAD_FILES = 20
MAX_UPLOAD_BYTES = 100 * 1024 * 1024
MIN_PASSWORD_LENGTH = 12
DRIVE_FOLDER_NAME = "Cloudkeep Backups"

app = Flask(__name__, static_folder=None)
app.config.update(
    SECRET_KEY=os.environ.get("FLASK_SECRET_KEY") or secrets.token_hex(32),
    MAX_CONTENT_LENGTH=MAX_UPLOAD_BYTES,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("COOKIE_SECURE", "false").lower() == "true",
)

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger("cloudkeep")
DATABASE_PATH = Path(os.environ.get("DATABASE_PATH", BASE_DIR / "instance" / "cloudkeep.sqlite3"))


@contextmanager
def get_database():
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def initialize_database():
    with get_database() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                email TEXT PRIMARY KEY,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL,
                first_upload_at TEXT
            )
            """
        )
        user_columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(users)")
        }
        if "first_upload_at" not in user_columns:
            connection.execute("ALTER TABLE users ADD COLUMN first_upload_at TEXT")
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS drive_links (
                user_email TEXT PRIMARY KEY,
                google_email TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS oauth_tokens (
                email TEXT PRIMARY KEY,
                encrypted_credentials BLOB NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS uploads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL,
                drive_file_id TEXT,
                name TEXT NOT NULL,
                size INTEGER NOT NULL,
                mime_type TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('complete', 'failed')),
                error TEXT,
                created_at TEXT NOT NULL,
                timeline_folder_id INTEGER
            )
            """
        )
        upload_columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(uploads)")
        }
        if "timeline_folder_id" not in upload_columns:
            connection.execute("ALTER TABLE uploads ADD COLUMN timeline_folder_id INTEGER")
        connection.execute(
            """
            UPDATE users
            SET first_upload_at = (
                SELECT MIN(created_at) FROM uploads
                WHERE uploads.email = users.email AND uploads.status = 'complete'
            )
            WHERE first_upload_at IS NULL
              AND EXISTS (
                SELECT 1 FROM uploads
                WHERE uploads.email = users.email AND uploads.status = 'complete'
              )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS timeline_folders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_email TEXT NOT NULL,
                name TEXT NOT NULL COLLATE NOCASE,
                created_at TEXT NOT NULL,
                drive_folder_id TEXT,
                prefix TEXT COLLATE NOCASE,
                UNIQUE(user_email, name)
            )
            """
        )
        folder_columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(timeline_folders)")
        }
        if "drive_folder_id" not in folder_columns:
            connection.execute("ALTER TABLE timeline_folders ADD COLUMN drive_folder_id TEXT")
        if "prefix" not in folder_columns:
            connection.execute("ALTER TABLE timeline_folders ADD COLUMN prefix TEXT COLLATE NOCASE")
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS reminders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_email TEXT NOT NULL,
                title TEXT NOT NULL,
                due_date TEXT NOT NULL,
                completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0, 1)),
                created_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS scheduled_deletions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_email TEXT NOT NULL,
                google_email TEXT NOT NULL,
                drive_file_id TEXT NOT NULL,
                file_name TEXT NOT NULL,
                file_size INTEGER NOT NULL DEFAULT 0,
                scheduled_at TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('scheduled', 'deleting', 'trashed', 'failed', 'cancelled')),
                error TEXT,
                created_at TEXT NOT NULL,
                completed_at TEXT
            )
            """
        )
        deletion_columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(scheduled_deletions)")
        }
        if "file_size" not in deletion_columns:
            connection.execute(
                "ALTER TABLE scheduled_deletions ADD COLUMN file_size INTEGER NOT NULL DEFAULT 0"
            )
            connection.execute(
                """
                UPDATE scheduled_deletions
                SET file_size = (
                    SELECT uploads.size FROM uploads
                    WHERE uploads.email = scheduled_deletions.user_email
                      AND uploads.drive_file_id = scheduled_deletions.drive_file_id
                    ORDER BY uploads.id DESC LIMIT 1
                )
                WHERE EXISTS (
                    SELECT 1 FROM uploads
                    WHERE uploads.email = scheduled_deletions.user_email
                      AND uploads.drive_file_id = scheduled_deletions.drive_file_id
                )
                """
            )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS uploads_email_created ON uploads(email, created_at DESC)"
        )
        connection.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS timeline_folders_user_prefix
            ON timeline_folders(user_email, prefix)
            WHERE prefix IS NOT NULL
            """
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS reminders_user_date ON reminders(user_email, due_date)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS scheduled_deletions_due ON scheduled_deletions(status, scheduled_at)"
        )


initialize_database()


def get_fernet():
    key = os.environ.get("TOKEN_ENCRYPTION_KEY")
    if not key:
        raise RuntimeError("TOKEN_ENCRYPTION_KEY is not configured.")
    try:
        return Fernet(key.encode("ascii"))
    except (ValueError, UnicodeEncodeError) as error:
        raise RuntimeError("TOKEN_ENCRYPTION_KEY must be a valid Fernet key.") from error


def get_oauth_client_config():
    client_id = os.environ.get("GOOGLE_CLIENT_ID")
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET")
    if not client_id or not client_secret:
        raise RuntimeError("Google OAuth client credentials are not configured.")
    return {
        "web": {
            "client_id": client_id,
            "client_secret": client_secret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": [oauth_redirect_uri()],
        }
    }


def oauth_redirect_uri():
    return os.environ.get("GOOGLE_REDIRECT_URI", "http://127.0.0.1:5000/oauth2callback")


redirect_uri_parts = urlsplit(oauth_redirect_uri())
if (
    redirect_uri_parts.scheme == "http"
    and redirect_uri_parts.hostname in {"localhost", "127.0.0.1", "::1"}
):
    os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"


def json_error(message, status):
    return jsonify({"error": message}), status


def get_json_object():
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def csrf_is_valid():
    supplied = request.headers.get("X-CSRF-Token", "")
    expected = session.get("csrf_token", "")
    return bool(expected and secrets.compare_digest(supplied, expected))


def require_csrf(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not csrf_is_valid():
            return json_error("Your session expired. Refresh the page and try again.", 403)
        return view(*args, **kwargs)

    return wrapped


def require_user(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("user_email"):
            return json_error("Sign in to continue.", 401)
        return view(*args, **kwargs)

    return wrapped


def credentials_for(email):
    with get_database() as connection:
        row = connection.execute(
            "SELECT encrypted_credentials FROM oauth_tokens WHERE email = ?",
            (email,),
        ).fetchone()
    if row is None:
        return None
    try:
        raw = get_fernet().decrypt(row["encrypted_credentials"])
        return Credentials.from_authorized_user_info(json.loads(raw), SCOPES)
    except (InvalidToken, ValueError, KeyError, TypeError):
        logger.exception("Stored Google credentials could not be decrypted for %s", email)
        return None


def store_credentials(email, credentials):
    encrypted = get_fernet().encrypt(credentials.to_json().encode("utf-8"))
    with get_database() as connection:
        connection.execute(
            """
            INSERT INTO oauth_tokens(email, encrypted_credentials, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(email) DO UPDATE SET
                encrypted_credentials = excluded.encrypted_credentials,
                updated_at = excluded.updated_at
            """,
            (email, encrypted, datetime.now(timezone.utc).isoformat()),
        )


def google_credentials_for(email):
    credentials = credentials_for(email)
    if credentials is None:
        return None
    if credentials.expired and credentials.refresh_token:
        try:
            credentials.refresh(GoogleRequest())
            store_credentials(email, credentials)
        except GoogleAuthError:
            logger.exception("Google credentials expired or were revoked for %s", email)
            return None
    if not credentials.valid:
        return None
    return credentials


def drive_service_for(email):
    credentials = google_credentials_for(email)
    if credentials is None:
        return None
    return build("drive", "v3", credentials=credentials, cache_discovery=False)


def activity_records(email):
    with get_database() as connection:
        rows = connection.execute(
            """
            SELECT
                uploads.id,
                uploads.drive_file_id,
                uploads.name,
                uploads.size,
                uploads.mime_type,
                uploads.status,
                uploads.error,
                uploads.created_at,
                uploads.timeline_folder_id,
                (
                    SELECT scheduled_deletions.scheduled_at
                    FROM scheduled_deletions
                    WHERE scheduled_deletions.user_email = uploads.email
                      AND scheduled_deletions.drive_file_id = uploads.drive_file_id
                      AND scheduled_deletions.status IN ('scheduled', 'deleting')
                    ORDER BY scheduled_deletions.id DESC
                    LIMIT 1
                ) AS scheduled_deletion_at,
                (
                    SELECT scheduled_deletions.completed_at
                    FROM scheduled_deletions
                    WHERE scheduled_deletions.user_email = uploads.email
                      AND scheduled_deletions.drive_file_id = uploads.drive_file_id
                      AND scheduled_deletions.status = 'trashed'
                    ORDER BY scheduled_deletions.id DESC
                    LIMIT 1
                ) AS deleted_at
            FROM uploads
            WHERE uploads.email = ?
            ORDER BY uploads.id DESC
            LIMIT 200
            """,
            (email,),
        ).fetchall()
    return [dict(row) for row in rows]


def sync_drive_status(email, records):
    try:
        service = drive_service_for(email)
    except Exception:
        logger.exception("Could not connect to Google Drive while syncing file status.")
        service = None
    if service is None:
        for record in records:
            record["drive_status"] = "unknown" if record["drive_file_id"] else "not_uploaded"
        return records
    for record in records:
        file_id = record["drive_file_id"]
        if record["status"] != "complete" or not file_id:
            record["drive_status"] = "not_uploaded"
            continue
        try:
            drive_file = service.files().get(
                fileId=file_id,
                fields="id,trashed",
            ).execute()
            record["drive_status"] = "deleted" if drive_file.get("trashed") else "on_drive"
        except HttpError as error:
            if getattr(getattr(error, "resp", None), "status", None) == 404:
                record["drive_status"] = "deleted"
            else:
                logger.exception("Could not check Drive status for file %s.", file_id)
                record["drive_status"] = "unknown"
        except Exception:
            logger.exception("Could not check Drive status for file %s.", file_id)
            record["drive_status"] = "unknown"
    return records


def insert_activity(
    email, name, size, mime_type, status, drive_file_id=None, error=None, timeline_folder_id=None
):
    created_at = datetime.now(timezone.utc).isoformat()
    with get_database() as connection:
        cursor = connection.execute(
            """
            INSERT INTO uploads(
                email, drive_file_id, name, size, mime_type, status, error, created_at, timeline_folder_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (email, drive_file_id, name, size, mime_type, status, error, created_at, timeline_folder_id),
        )
        if status == "complete":
            connection.execute(
                "UPDATE users SET first_upload_at = COALESCE(first_upload_at, ?) WHERE email = ?",
                (created_at, email),
            )
        return {
            "id": cursor.lastrowid,
            "drive_file_id": drive_file_id,
            "name": name,
            "size": size,
            "mime_type": mime_type,
            "status": status,
            "error": error,
            "created_at": created_at,
        }


def link_google_account(user_email, google_email):
    with get_database() as connection:
        linked_user = connection.execute(
            "SELECT user_email FROM drive_links WHERE google_email = ?",
            (google_email,),
        ).fetchone()
        if linked_user and linked_user["user_email"] != user_email:
            return False
        connection.execute(
            """
            INSERT INTO drive_links(user_email, google_email, created_at)
            VALUES (?, ?, ?)
            ON CONFLICT(user_email) DO UPDATE SET
                google_email = excluded.google_email,
                created_at = excluded.created_at
            """,
            (user_email, google_email, datetime.now(timezone.utc).isoformat()),
        )
    return True


def backup_folder_id(service):
    result = service.files().list(
        q=(
            "mimeType = 'application/vnd.google-apps.folder' and trashed = false "
            "and appProperties has { key='cloudkeepBackupFolder' and value='true' }"
        ),
        spaces="drive",
        pageSize=1,
        fields="files(id)",
    ).execute()
    folders = result.get("files", [])
    if folders:
        return folders[0]["id"]
    folder = service.files().create(
        body={
            "name": DRIVE_FOLDER_NAME,
            "mimeType": "application/vnd.google-apps.folder",
            "appProperties": {"cloudkeepBackupFolder": "true"},
        },
        fields="id",
    ).execute()
    return folder["id"]


def drive_error_message(error):
    status = getattr(getattr(error, "resp", None), "status", None)
    if status == 403:
        return "Google Drive rejected the upload. Check Drive storage and API access."
    if status == 401:
        return "Google sign-in expired. Please sign in again."
    return "Google Drive could not save this file. Please try again."


def create_drive_subfolder(service, parent_id, name):
    return service.files().create(
        body={
            "name": name,
            "mimeType": "application/vnd.google-apps.folder",
            "parents": [parent_id],
            "appProperties": {"cloudkeepTimelineFolder": "true"},
        },
        fields="id,name",
    ).execute()


def matching_prefix_folder(email, filename):
    match = re.match(r"^([^_]+)_(.+)$", filename)
    if not match:
        return None
    prefix = match.group(1).strip()
    if not prefix:
        return None
    with get_database() as connection:
        return connection.execute(
            """
            SELECT id, name, drive_folder_id, prefix
            FROM timeline_folders
            WHERE user_email = ? AND prefix = ?
            LIMIT 1
            """,
            (email, prefix),
        ).fetchone()


def ensure_folder_drive_id(service, folder, backup_id):
    if folder["drive_folder_id"]:
        return folder["drive_folder_id"]
    drive_folder = create_drive_subfolder(service, backup_id, folder["name"])
    with get_database() as connection:
        connection.execute(
            "UPDATE timeline_folders SET drive_folder_id = ? WHERE id = ?",
            (drive_folder["id"], folder["id"]),
        )
    return drive_folder["id"]


def move_drive_file(service, file_id, parent_id):
    current = service.files().get(fileId=file_id, fields="parents").execute()
    current_parents = current.get("parents", [])
    if parent_id in current_parents:
        return current
    update = {
        "fileId": file_id,
        "addParents": parent_id,
        "fields": "id,parents",
    }
    if current_parents:
        update["removeParents"] = ",".join(current_parents)
    return service.files().update(**update).execute()


@app.get("/")
def home():
    return send_from_directory(BASE_DIR, "index.html")


@app.get("/<path:filename>")
def static_files(filename):
    allowed = {
        "index.html",
        "login.html",
        "dashboard.html",
        "backup.html",
        "activity.html",
        "planner.html",
        "cleanup.html",
        "profile.html",
        "styles.css",
        "landing.js",
        "auth.js",
        "cloudkeep-common.js",
        "dashboard.js",
        "backup.js",
        "activity.js",
        "planner.js",
        "cleanup.js",
        "profile.js",
    }
    if filename not in allowed:
        abort(404)
    return send_from_directory(BASE_DIR, filename)


@app.get("/oauth2callback")
def oauth_callback():
    state = session.pop("oauth_state", None)
    code_verifier = session.pop("oauth_code_verifier", None)
    if not state or not code_verifier or request.args.get("state") != state:
        return redirect("/login.html?error=state")
    if request.args.get("error"):
        return redirect("/login.html?error=cancelled")
    try:
        flow = Flow.from_client_config(
            get_oauth_client_config(),
            scopes=SCOPES,
            state=state,
            code_verifier=code_verifier,
            redirect_uri=oauth_redirect_uri(),
        )
        flow.fetch_token(authorization_response=request.url)
        credentials = flow.credentials
        userinfo = build(
            "oauth2", "v2", credentials=credentials, cache_discovery=False
        ).userinfo().get().execute()
        email = userinfo.get("email")
        if not email or not userinfo.get("verified_email", False):
            return redirect("/login.html?error=unverified")
        is_connecting_drive = session.get("oauth_intent") == "connect"
        account_email = session.get("user_email") if is_connecting_drive else email
        profile_name = session.get("profile_name") if is_connecting_drive else userinfo.get("name")
        profile_picture = session.get("profile_picture") if is_connecting_drive else userinfo.get("picture")
        auth_method = session.get("auth_method", "email") if is_connecting_drive else "google"
        store_credentials(email, credentials)
        if not link_google_account(account_email, email):
            destination = "/dashboard.html?error=drive_linked" if session.get("user_email") else "/login.html?error=drive_linked"
            return redirect(destination)
        session.clear()
        session["user_email"] = account_email
        session["google_email"] = email
        session["profile_name"] = profile_name
        session["profile_picture"] = profile_picture
        session["auth_method"] = auth_method
        session["csrf_token"] = secrets.token_urlsafe(32)
        return redirect("/dashboard.html")
    except Exception:
        logger.exception("Google OAuth callback failed.")
        return redirect("/login.html?error=oauth")


@app.get("/api/session")
def session_status():
    csrf_token = session.setdefault("csrf_token", secrets.token_urlsafe(32))
    email = session.get("user_email")
    link = None
    user = None
    if email:
        with get_database() as connection:
            link = connection.execute(
                "SELECT google_email FROM drive_links WHERE user_email = ?",
                (email,),
            ).fetchone()
            user = connection.execute(
                "SELECT first_upload_at FROM users WHERE email = ?",
                (email,),
            ).fetchone()
        if link:
            session["google_email"] = link["google_email"]
        else:
            session.pop("google_email", None)
    return jsonify({
        "authenticated": bool(email),
        "email": email,
        "drive_connected": bool(email and session.get("google_email")),
        "drive_email": session.get("google_email"),
        "profile_name": session.get("profile_name"),
        "profile_picture": session.get("profile_picture"),
        "auth_method": session.get("auth_method", "email") if email else None,
        "has_uploaded": bool(email and user and user["first_upload_at"]),
        "csrf_token": csrf_token,
    })


@app.post("/api/auth/register")
@require_csrf
def register():
    data = get_json_object()
    email = str(data.get("email", "")).strip().lower()
    password = data.get("password", "")
    if not isinstance(password, str):
        return json_error("Enter a valid password.", 400)
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        return json_error("Enter a valid email address.", 400)
    if len(password) < MIN_PASSWORD_LENGTH:
        return json_error(f"Use a password with at least {MIN_PASSWORD_LENGTH} characters.", 400)
    if len(password) > 1024:
        return json_error("Password is too long.", 400)
    password_hash = generate_password_hash(password, method="scrypt")
    try:
        with get_database() as connection:
            connection.execute(
                "INSERT INTO users(email, password_hash, created_at) VALUES (?, ?, ?)",
                (email, password_hash, datetime.now(timezone.utc).isoformat()),
            )
    except sqlite3.IntegrityError:
        return json_error("An account with that email already exists. Log in instead.", 409)
    session.clear()
    session["user_email"] = email
    session["auth_method"] = "email"
    session["csrf_token"] = secrets.token_urlsafe(32)
    return jsonify({"ok": True, "email": email}), 201


@app.post("/api/auth/login")
@require_csrf
def password_login():
    data = get_json_object()
    email = str(data.get("email", "")).strip().lower()
    password = data.get("password", "")
    if not isinstance(password, str) or not email or len(password) > 1024:
        return json_error("Email or password is incorrect.", 401)
    with get_database() as connection:
        user = connection.execute(
            "SELECT password_hash FROM users WHERE email = ?",
            (email,),
        ).fetchone()
    if user is None or not check_password_hash(user["password_hash"], password):
        return json_error("Email or password is incorrect.", 401)
    session.clear()
    session["user_email"] = email
    session["auth_method"] = "email"
    session["csrf_token"] = secrets.token_urlsafe(32)
    return jsonify({"ok": True, "email": email})


@app.get("/auth/google")
def google_login():
    try:
        client_config = get_oauth_client_config()
        get_fernet()
        flow = Flow.from_client_config(
            client_config,
            scopes=SCOPES,
            redirect_uri=oauth_redirect_uri(),
        )
        authorization_url, state = flow.authorization_url(
            access_type="offline",
            prompt="consent",
            include_granted_scopes="true",
        )
        session["oauth_state"] = state
        session["oauth_code_verifier"] = flow.code_verifier
        session["oauth_intent"] = "connect" if (
            request.args.get("intent") == "connect" and session.get("user_email")
        ) else "login"
        return redirect(authorization_url)
    except RuntimeError:
        logger.exception("Google sign-in is not configured.")
        return redirect("/login.html?error=not_configured")


@app.get("/api/uploads")
@require_user
def get_uploads():
    email = session["user_email"]
    return jsonify({"uploads": sync_drive_status(email, activity_records(email))})


@app.post("/api/upload")
@require_user
@require_csrf
def upload_files():
    files = request.files.getlist("files")
    if not files:
        return json_error("Choose at least one file to upload.", 400)
    if len(files) > MAX_UPLOAD_FILES:
        return json_error(f"Choose no more than {MAX_UPLOAD_FILES} files at a time.", 400)

    email = session["user_email"]
    google_email = session.get("google_email")
    if not google_email:
        return json_error("Connect Google Drive before uploading files.", 409)
    try:
        service = drive_service_for(google_email)
        if service is None:
            session.pop("google_email", None)
            with get_database() as connection:
                connection.execute("DELETE FROM drive_links WHERE user_email = ?", (email,))
            return json_error("Reconnect Google Drive to continue uploading.", 409)
        folder_id = backup_folder_id(service)
    except HttpError:
        logger.exception("Could not prepare the user's Google Drive backup folder.")
        return json_error("Could not access Google Drive. Check your connection and try again.", 502)
    except Exception:
        logger.exception("Could not authenticate or connect to the user's Google Drive.")
        return json_error("Could not connect to Google Drive. Please sign in again and retry.", 502)

    outcomes = []
    for uploaded_file in files:
        name = (uploaded_file.filename or "").strip()
        mime_type = uploaded_file.mimetype or "application/octet-stream"
        size = 0
        if not name:
            outcomes.append(insert_activity(
                email, "Unnamed file", 0, mime_type, "failed", error="This file has no name."
            ))
            continue
        try:
            target_folder = matching_prefix_folder(email, name)
            target_folder_id = folder_id
            timeline_folder_id = None
            if target_folder is not None:
                target_folder_id = ensure_folder_drive_id(service, target_folder, folder_id)
                timeline_folder_id = target_folder["id"]
            uploaded_file.stream.seek(0, os.SEEK_END)
            size = uploaded_file.stream.tell()
            uploaded_file.stream.seek(0)
            media = MediaIoBaseUpload(
                uploaded_file.stream,
                mimetype=mime_type,
                chunksize=8 * 1024 * 1024,
                resumable=True,
            )
            result = service.files().create(
                body={"name": name, "parents": [target_folder_id]},
                media_body=media,
                fields="id,name,size,mimeType,createdTime",
            ).execute()
            outcomes.append(insert_activity(
                email=email,
                name=result.get("name", name),
                size=int(result.get("size", size)),
                mime_type=result.get("mimeType", mime_type),
                status="complete",
                drive_file_id=result.get("id"),
                timeline_folder_id=timeline_folder_id,
            ))
        except HttpError as error:
            message = drive_error_message(error)
            logger.exception("Google Drive upload failed for %r.", name)
            outcomes.append(insert_activity(
                email, name, size, mime_type, "failed", error=message
            ))
        except Exception:
            logger.exception("Unexpected upload failure for %r.", name)
            outcomes.append(insert_activity(
                email, name, size, mime_type, "failed",
                error="The upload failed unexpectedly. Please try again.",
            ))

    return jsonify({
        "uploads": outcomes,
        "activity": activity_records(email),
        "succeeded": sum(item["status"] == "complete" for item in outcomes),
        "failed": sum(item["status"] == "failed" for item in outcomes),
    })


@app.delete("/api/uploads")
@require_user
@require_csrf
def clear_upload_history():
    email = session["user_email"]
    with get_database() as connection:
        connection.execute(
            "UPDATE scheduled_deletions SET status = 'cancelled' WHERE user_email = ? AND status = 'scheduled'",
            (email,),
        )
        connection.execute("DELETE FROM uploads WHERE email = ?", (email,))
    return jsonify({"uploads": []})


@app.get("/api/timeline")
@require_user
def get_timeline():
    email = session["user_email"]
    with get_database() as connection:
        folders = connection.execute(
            """
            SELECT id, name, created_at, drive_folder_id, prefix FROM timeline_folders
            WHERE user_email = ? ORDER BY name COLLATE NOCASE, id
            """,
            (email,),
        ).fetchall()
    return jsonify({"events": activity_records(email), "folders": [dict(row) for row in folders]})


@app.post("/api/timeline/folders")
@require_user
@require_csrf
def create_timeline_folder():
    data = get_json_object()
    name = data.get("name")
    if not isinstance(name, str):
        return json_error("Enter a folder name.", 400)
    name = name.strip()
    if not name or len(name) > 60:
        return json_error("Folder names must be between 1 and 60 characters.", 400)
    prefix = data.get("prefix", "")
    if not isinstance(prefix, str):
        return json_error("Enter a valid filename prefix.", 400)
    prefix = prefix.strip()
    if prefix and (len(prefix) > 30 or not re.fullmatch(r"[A-Za-z0-9.-]+", prefix)):
        return json_error("Prefixes may contain only letters, numbers, dots, and hyphens.", 400)
    google_email = session.get("google_email")
    if not google_email:
        return json_error("Connect Google Drive before creating folders.", 409)
    try:
        service = drive_service_for(google_email)
        if service is None:
            session.pop("google_email", None)
            return json_error("Reconnect Google Drive before creating folders.", 409)
        parent_id = backup_folder_id(service)
        drive_folder = create_drive_subfolder(service, parent_id, name)
    except HttpError:
        logger.exception("Could not create the Google Drive subfolder %r.", name)
        return json_error("Could not create the folder in Google Drive. Check your connection and try again.", 502)
    except Exception:
        logger.exception("Could not authenticate or connect to Google Drive for folder creation.")
        return json_error("Could not connect to Google Drive. Please sign in again and retry.", 502)
    created_at = datetime.now(timezone.utc).isoformat()
    try:
        with get_database() as connection:
            cursor = connection.execute(
                """
                INSERT INTO timeline_folders(user_email, name, created_at, drive_folder_id, prefix)
                VALUES (?, ?, ?, ?, ?)
                """,
                (session["user_email"], name, created_at, drive_folder["id"], prefix or None),
            )
    except sqlite3.IntegrityError:
        try:
            service.files().delete(fileId=drive_folder["id"]).execute()
        except Exception:
            logger.exception("Could not clean up duplicate Google Drive folder %r.", name)
        return json_error("A folder with that name already exists.", 409)
    return jsonify({
        "folder": {
            "id": cursor.lastrowid,
            "name": name,
            "created_at": created_at,
            "drive_folder_id": drive_folder["id"],
            "prefix": prefix or None,
        }
    }), 201


@app.patch("/api/timeline/events/<int:event_id>/folder")
@require_user
@require_csrf
def assign_timeline_event_folder(event_id):
    data = get_json_object()
    folder_id = data.get("folder_id")
    if folder_id is not None and (isinstance(folder_id, bool) or not isinstance(folder_id, int)):
        return json_error("Choose a valid folder.", 400)
    email = session["user_email"]
    google_email = session.get("google_email")
    with get_database() as connection:
        event = connection.execute(
            "SELECT id, drive_file_id, timeline_folder_id FROM uploads WHERE id = ? AND email = ?",
            (event_id, email),
        ).fetchone()
        if event is None:
            return json_error("Timeline file not found.", 404)
        folder = None
        if folder_id is not None:
            folder = connection.execute(
                "SELECT id, name, drive_folder_id FROM timeline_folders WHERE id = ? AND user_email = ?",
                (folder_id, email),
            ).fetchone()
            if folder is None:
                return json_error("Folder not found.", 404)
            duplicate = connection.execute(
                """
                SELECT 1 FROM uploads
                WHERE email = ? AND timeline_folder_id = ? AND id != ?
                  AND name = (SELECT name FROM uploads WHERE id = ? AND email = ?) COLLATE NOCASE
                LIMIT 1
                """,
                (email, folder_id, event_id, event_id, email),
            ).fetchone()
            if duplicate is not None:
                return json_error("That folder already contains a file with the same name.", 409)
    if not google_email:
        return json_error("Connect Google Drive before moving files between folders.", 409)
    try:
        service = drive_service_for(google_email)
        if service is None:
            return json_error("Reconnect Google Drive before moving files between folders.", 409)
        if folder_id is not None and not folder["drive_folder_id"]:
            backup_id = backup_folder_id(service)
            drive_folder = create_drive_subfolder(service, backup_id, folder["name"])
            with get_database() as connection:
                connection.execute(
                    """
                    UPDATE timeline_folders SET drive_folder_id = ?
                    WHERE id = ? AND user_email = ?
                    """,
                    (drive_folder["id"], folder_id, email),
                )
            parent_id = drive_folder["id"]
        else:
            parent_id = folder["drive_folder_id"] if folder_id is not None else backup_folder_id(service)
        if not parent_id:
            return json_error("The Google Drive folder is unavailable. Reconnect Drive and try again.", 409)
        if event["drive_file_id"]:
            move_drive_file(service, event["drive_file_id"], parent_id)
    except HttpError:
        logger.exception("Could not move Drive file %s to folder %s.", event["drive_file_id"], folder_id)
        return json_error("Could not move the file in Google Drive. Check your connection and try again.", 502)
    except Exception:
        logger.exception("Could not authenticate or connect to Google Drive while moving a file.")
        return json_error("Could not connect to Google Drive. Please sign in again and retry.", 502)
    with get_database() as connection:
        connection.execute(
            "UPDATE uploads SET timeline_folder_id = ? WHERE id = ? AND email = ?",
            (folder_id, event_id, email),
        )
    return jsonify({"ok": True, "folder_id": folder_id})


@app.delete("/api/timeline/folders/<int:folder_id>")
@require_user
@require_csrf
def delete_timeline_folder(folder_id):
    email = session["user_email"]
    google_email = session.get("google_email")
    with get_database() as connection:
        folder = connection.execute(
            "SELECT id, drive_folder_id FROM timeline_folders WHERE id = ? AND user_email = ?",
            (folder_id, email),
        ).fetchone()
        if folder is None:
            return json_error("Folder not found.", 404)
        files = connection.execute(
            """
            SELECT id, drive_file_id FROM uploads
            WHERE timeline_folder_id = ? AND email = ? AND drive_file_id IS NOT NULL
            """,
            (folder_id, email),
        ).fetchall()
    if not google_email:
        return json_error("Connect Google Drive before deleting folders.", 409)
    moved_files = []
    try:
        service = drive_service_for(google_email)
        if service is None:
            return json_error("Reconnect Google Drive before deleting folders.", 409)
        backup_id = backup_folder_id(service)
        for file in files:
            move_drive_file(service, file["drive_file_id"], backup_id)
            moved_files.append(file["drive_file_id"])
        if folder["drive_folder_id"]:
            service.files().delete(fileId=folder["drive_folder_id"]).execute()
    except HttpError:
        logger.exception("Could not remove Google Drive folder %s.", folder_id)
        if moved_files:
            logger.error(
                "Some files were moved back to Cloudkeep Backups before folder deletion failed: %s",
                moved_files,
            )
            if folder["drive_folder_id"]:
                for file_id in moved_files:
                    try:
                        move_drive_file(service, file_id, folder["drive_folder_id"])
                    except Exception:
                        logger.exception("Could not roll back Drive file %s into folder %s.", file_id, folder_id)
        return json_error("Could not remove the folder from Google Drive. Check your connection and try again.", 502)
    except Exception:
        logger.exception("Could not authenticate or connect to Google Drive while deleting a folder.")
        if moved_files and folder["drive_folder_id"]:
            for file_id in moved_files:
                try:
                    move_drive_file(service, file_id, folder["drive_folder_id"])
                except Exception:
                    logger.exception("Could not roll back Drive file %s into folder %s.", file_id, folder_id)
        return json_error("Could not connect to Google Drive. Please sign in again and retry.", 502)
    with get_database() as connection:
        connection.execute(
            "UPDATE uploads SET timeline_folder_id = NULL WHERE timeline_folder_id = ? AND email = ?",
            (folder_id, email),
        )
        connection.execute(
            "DELETE FROM timeline_folders WHERE id = ? AND user_email = ?",
            (folder_id, email),
        )
    return jsonify({"ok": True})


@app.get("/api/reminders")
@require_user
def get_reminders():
    month = request.args.get("month", "")
    if not re.fullmatch(r"\d{4}-\d{2}", month):
        return json_error("Choose a valid calendar month.", 400)
    try:
        month_start = datetime.strptime(month, "%Y-%m")
        next_month = datetime(
            month_start.year + (month_start.month == 12),
            1 if month_start.month == 12 else month_start.month + 1,
            1,
        )
    except ValueError:
        return json_error("Choose a valid calendar month.", 400)
    email = session["user_email"]
    with get_database() as connection:
        rows = connection.execute(
            """
            SELECT id, title, due_date, completed, created_at
            FROM reminders
            WHERE user_email = ? AND due_date >= ? AND due_date < ?
            ORDER BY due_date, completed, id
            """,
            (email, month_start.strftime("%Y-%m-%d"), next_month.strftime("%Y-%m-%d")),
        ).fetchall()
    return jsonify({"reminders": [dict(row) for row in rows]})


@app.post("/api/reminders")
@require_user
@require_csrf
def create_reminder():
    data = get_json_object()
    title = data.get("title", "")
    due_date = data.get("due_date", "")
    if not isinstance(title, str):
        return json_error("Enter a reminder title.", 400)
    title = title.strip()
    if not title or len(title) > 200:
        return json_error("Reminder titles must be between 1 and 200 characters.", 400)
    if not isinstance(due_date, str):
        return json_error("Choose a valid reminder date.", 400)
    try:
        parsed_date = datetime.strptime(due_date, "%Y-%m-%d")
        if parsed_date.strftime("%Y-%m-%d") != due_date:
            raise ValueError
    except ValueError:
        return json_error("Choose a valid reminder date.", 400)
    created_at = datetime.now(timezone.utc).isoformat()
    with get_database() as connection:
        cursor = connection.execute(
            """
            INSERT INTO reminders(user_email, title, due_date, completed, created_at)
            VALUES (?, ?, ?, 0, ?)
            """,
            (session["user_email"], title, due_date, created_at),
        )
    return jsonify({
        "reminder": {
            "id": cursor.lastrowid,
            "title": title,
            "due_date": due_date,
            "completed": 0,
            "created_at": created_at,
        }
    }), 201


@app.patch("/api/reminders/<int:reminder_id>")
@require_user
@require_csrf
def update_reminder(reminder_id):
    data = get_json_object()
    completed = data.get("completed")
    if not isinstance(completed, bool):
        return json_error("Choose whether the reminder is complete.", 400)
    with get_database() as connection:
        cursor = connection.execute(
            "UPDATE reminders SET completed = ? WHERE id = ? AND user_email = ?",
            (int(completed), reminder_id, session["user_email"]),
        )
    if cursor.rowcount == 0:
        return json_error("Reminder not found.", 404)
    return jsonify({"ok": True, "completed": completed})


@app.delete("/api/reminders/<int:reminder_id>")
@require_user
@require_csrf
def delete_reminder(reminder_id):
    with get_database() as connection:
        cursor = connection.execute(
            "DELETE FROM reminders WHERE id = ? AND user_email = ?",
            (reminder_id, session["user_email"]),
        )
    if cursor.rowcount == 0:
        return json_error("Reminder not found.", 404)
    return jsonify({"ok": True})


@app.get("/api/deletions")
@require_user
def get_scheduled_deletions():
    with get_database() as connection:
        rows = connection.execute(
            """
            SELECT id, drive_file_id, file_name, file_size, scheduled_at, status, error, created_at, completed_at
            FROM scheduled_deletions WHERE user_email = ?
            ORDER BY CASE status WHEN 'scheduled' THEN 0 ELSE 1 END, scheduled_at
            LIMIT 200
            """,
            (session["user_email"],),
        ).fetchall()
    return jsonify({"deletions": [dict(row) for row in rows]})


@app.post("/api/deletions")
@require_user
@require_csrf
def schedule_deletion():
    data = get_json_object()
    file_id = data.get("file_id")
    scheduled_at_value = data.get("scheduled_at")
    if not isinstance(file_id, str) or not file_id.strip() or len(file_id) > 256:
        return json_error("Choose a file uploaded to Cloudkeep.", 400)
    if not isinstance(scheduled_at_value, str):
        return json_error("Choose a deletion date and time.", 400)
    try:
        scheduled_at = datetime.fromisoformat(scheduled_at_value.replace("Z", "+00:00"))
        if scheduled_at.tzinfo is None:
            return json_error("The deletion time must include a timezone.", 400)
        scheduled_at = scheduled_at.astimezone(timezone.utc)
    except ValueError:
        return json_error("Choose a valid deletion date and time.", 400)
    now = datetime.now(timezone.utc)
    if scheduled_at <= now:
        return json_error("Choose a future deletion date and time.", 400)
    email = session["user_email"]
    with get_database() as connection:
        connection.execute("BEGIN IMMEDIATE")
        link = connection.execute(
            "SELECT google_email FROM drive_links WHERE user_email = ?",
            (email,),
        ).fetchone()
        if link is None:
            return json_error("Connect Google Drive before scheduling deletion.", 409)
        upload = connection.execute(
            """
            SELECT drive_file_id, name, size FROM uploads
            WHERE email = ? AND drive_file_id = ? AND status = 'complete'
            ORDER BY id DESC LIMIT 1
            """,
            (email, file_id.strip()),
        ).fetchone()
        if upload is None:
            return json_error("That file is not in this account's Cloudkeep upload history.", 404)
        duplicate = connection.execute(
            """
            SELECT 1 FROM scheduled_deletions
            WHERE user_email = ? AND drive_file_id = ? AND status IN ('scheduled', 'deleting')
            """,
            (email, file_id.strip()),
        ).fetchone()
        if duplicate:
            return json_error("A deletion is already scheduled for this file.", 409)
        created_at = now.isoformat()
        cursor = connection.execute(
            """
            INSERT INTO scheduled_deletions(
                user_email, google_email, drive_file_id, file_name, file_size,
                scheduled_at, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?)
            """,
            (
                email,
                link["google_email"],
                upload["drive_file_id"],
                upload["name"],
                upload["size"],
                scheduled_at.isoformat(),
                created_at,
            ),
        )
    return jsonify({
        "deletion": {
            "id": cursor.lastrowid,
            "drive_file_id": upload["drive_file_id"],
            "file_name": upload["name"],
            "file_size": upload["size"],
            "scheduled_at": scheduled_at.isoformat(),
            "status": "scheduled",
            "created_at": created_at,
        }
    }), 201


@app.patch("/api/deletions/<int:deletion_id>")
@require_user
@require_csrf
def reschedule_deletion(deletion_id):
    data = get_json_object()
    scheduled_at_value = data.get("scheduled_at")
    if not isinstance(scheduled_at_value, str):
        return json_error("Choose a deletion date and time.", 400)
    try:
        scheduled_at = datetime.fromisoformat(scheduled_at_value.replace("Z", "+00:00"))
        if scheduled_at.tzinfo is None:
            return json_error("The deletion time must include a timezone.", 400)
        scheduled_at = scheduled_at.astimezone(timezone.utc)
    except ValueError:
        return json_error("Choose a valid deletion date and time.", 400)
    if scheduled_at <= datetime.now(timezone.utc):
        return json_error("Choose a future deletion date and time.", 400)

    with get_database() as connection:
        cursor = connection.execute(
            """
            UPDATE scheduled_deletions SET scheduled_at = ?
            WHERE id = ? AND user_email = ? AND status = 'scheduled'
              AND scheduled_at > ?
            """,
            (
                scheduled_at.isoformat(),
                deletion_id,
                session["user_email"],
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        if cursor.rowcount == 0:
            return json_error("Pending deletion not found or already started.", 404)
    return jsonify({"ok": True, "scheduled_at": scheduled_at.isoformat()})


@app.delete("/api/deletions/<int:deletion_id>")
@require_user
@require_csrf
def cancel_scheduled_deletion(deletion_id):
    with get_database() as connection:
        cursor = connection.execute(
            """
            UPDATE scheduled_deletions SET status = 'cancelled'
            WHERE id = ? AND user_email = ? AND status = 'scheduled'
            """,
            (deletion_id, session["user_email"]),
        )
    if cursor.rowcount == 0:
        return json_error("Scheduled deletion not found or already started.", 404)
    return jsonify({"ok": True})


def process_due_deletions():
    now = datetime.now(timezone.utc).isoformat()
    with get_database() as connection:
        due = connection.execute(
            """
            SELECT id, user_email, google_email, drive_file_id
            FROM scheduled_deletions
            WHERE status = 'scheduled' AND scheduled_at <= ?
            ORDER BY scheduled_at LIMIT 20
            """,
            (now,),
        ).fetchall()
    for item in due:
        with get_database() as connection:
            claimed = connection.execute(
                """
                UPDATE scheduled_deletions SET status = 'deleting'
                WHERE id = ? AND status = 'scheduled'
                """,
                (item["id"],),
            )
            if claimed.rowcount == 0:
                continue
        try:
            service = drive_service_for(item["google_email"])
            if service is None:
                raise RuntimeError("Google Drive credentials are unavailable. Reconnect Drive and schedule deletion again.")
            service.files().update(
                fileId=item["drive_file_id"],
                body={"trashed": True},
                fields="id,trashed",
            ).execute()
        except Exception:
            logger.exception("Scheduled Drive trash action %s failed.", item["id"])
            with get_database() as connection:
                connection.execute(
                    """
                    UPDATE scheduled_deletions SET status = 'failed', error = ?, completed_at = ?
                    WHERE id = ? AND status = 'deleting'
                    """,
                    (
                        "Google Drive could not move this file to trash. Reconnect Drive and try scheduling it again.",
                        datetime.now(timezone.utc).isoformat(),
                        item["id"],
                    ),
                )
        else:
            with get_database() as connection:
                connection.execute(
                    """
                    UPDATE scheduled_deletions SET status = 'trashed', error = NULL, completed_at = ?
                    WHERE id = ? AND status = 'deleting'
                    """,
                    (datetime.now(timezone.utc).isoformat(), item["id"]),
                )


def deletion_scheduler():
    while True:
        try:
            with get_database() as connection:
                recovered = connection.execute(
                    """
                    UPDATE scheduled_deletions SET status = 'scheduled'
                    WHERE status = 'deleting'
                    """
                ).rowcount
            if recovered:
                logger.warning("Requeued %s interrupted scheduled deletion(s).", recovered)
            break
        except Exception:
            logger.exception("Could not recover interrupted scheduled deletions.")
            time.sleep(15)
    while True:
        try:
            process_due_deletions()
        except Exception:
            logger.exception("Scheduled deletion worker encountered an unexpected error.")
        time.sleep(15)


@app.post("/auth/logout")
@require_csrf
def logout():
    session.clear()
    return jsonify({"ok": True})


@app.errorhandler(413)
def request_too_large(_error):
    return json_error("The selected files exceed the 100 MB request limit.", 413)


@app.errorhandler(sqlite3.Error)
def database_error(error):
    logger.error(
        "A database operation failed: %s",
        error,
        exc_info=(type(error), error, error.__traceback__),
    )
    if request.path.startswith("/api/"):
        return json_error("The local activity database is unavailable.", 500)
    return "The local database is unavailable.", 500


if __name__ == "__main__":
    threading.Thread(target=deletion_scheduler, name="cloudkeep-deletions", daemon=True).start()
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "5000")), debug=False)
