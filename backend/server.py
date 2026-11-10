import json
import logging
import os
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from telegram_auth import verify_telegram_init_data


ROOT = Path(__file__).resolve().parent
DATABASE = ROOT / "tournament.sqlite3"
HOST = os.environ.get("HOST", "0.0.0.0" if "PORT" in os.environ else "127.0.0.1")
PORT = int(os.environ.get("PORT", "8000"))
logger = logging.getLogger("profcom_lnmu.api")
PRIMARY_ADMIN_ID = 5806282517


class DatabaseConnection:
    def __init__(self, connection, is_postgres=False):
        self.connection = connection
        self.is_postgres = is_postgres

    def execute(self, query, parameters=()):
        if self.is_postgres:
            query = query.replace("?", "%s")
        return self.connection.execute(query, parameters)

    def insert_id(self, query, parameters=()):
        if self.is_postgres:
            return self.execute(query + " RETURNING id", parameters).fetchone()["id"]
        return self.execute(query, parameters).lastrowid


@contextmanager
def connect_db():
    database_url = os.environ.get("DATABASE_URL", "").strip()
    if database_url:
        try:
            import psycopg
            from psycopg.rows import dict_row
        except ImportError as error:
            raise RuntimeError("Встанови залежність psycopg для підключення до PostgreSQL.") from error
        raw_connection = psycopg.connect(database_url, row_factory=dict_row)
        connection = DatabaseConnection(raw_connection, is_postgres=True)
    else:
        raw_connection = sqlite3.connect(DATABASE)
        raw_connection.row_factory = sqlite3.Row
        raw_connection.execute("PRAGMA foreign_keys = ON")
        connection = DatabaseConnection(raw_connection)
    try:
        yield connection
        raw_connection.commit()
    except Exception:
        raw_connection.rollback()
        raise
    finally:
        raw_connection.close()


def integrity_error_types():
    try:
        import psycopg
    except ImportError:
        return (sqlite3.IntegrityError,)
    return sqlite3.IntegrityError, psycopg.IntegrityError


def initialize_database():
    with connect_db() as connection:
        schema = """
            CREATE TABLE IF NOT EXISTS tournaments (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                logo_url TEXT NOT NULL DEFAULT '',
                start_date TEXT NOT NULL,
                end_date TEXT NOT NULL,
                prize_pool INTEGER NOT NULL DEFAULT 0,
                team_limit INTEGER NOT NULL,
                format TEXT NOT NULL CHECK (format IN ('groups', 'playoff', 'both')),
                win_points INTEGER NOT NULL DEFAULT 3,
                status TEXT NOT NULL DEFAULT 'registration',
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS teams (
                id INTEGER PRIMARY KEY,
                tournament_id BIGINT REFERENCES tournaments(id),
                name TEXT NOT NULL,
                tag TEXT NOT NULL,
                captain TEXT NOT NULL,
                contact TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS matches (
                id INTEGER PRIMARY KEY,
                tournament_id BIGINT NOT NULL REFERENCES tournaments(id),
                match_date TEXT NOT NULL,
                match_time TEXT NOT NULL,
                phase TEXT NOT NULL DEFAULT 'groups',
                stage TEXT NOT NULL,
                map TEXT NOT NULL DEFAULT '',
                team_a_id BIGINT REFERENCES teams(id),
                team_b_id BIGINT REFERENCES teams(id),
                score_a INTEGER,
                score_b INTEGER,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS team_players (
                id INTEGER PRIMARY KEY,
                team_id BIGINT NOT NULL REFERENCES teams(id),
                telegram_user_id BIGINT,
                invited_username TEXT NOT NULL,
                username TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active')),
                is_captain INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS player_bans (
                telegram_user_id BIGINT PRIMARY KEY,
                username TEXT NOT NULL DEFAULT '',
                reason TEXT NOT NULL,
                created_at TEXT NOT NULL,
                banned_by BIGINT NOT NULL,
                expires_at TEXT,
                lifted_at TEXT
            );
            CREATE UNIQUE INDEX IF NOT EXISTS teams_tag_unique_ci ON teams (lower(tag));
            CREATE INDEX IF NOT EXISTS team_players_invited_username_ci ON team_players (lower(invited_username));
            CREATE INDEX IF NOT EXISTS team_players_telegram_id_idx ON team_players (telegram_user_id);
            """
        if connection.is_postgres:
            schema = schema.replace("id INTEGER PRIMARY KEY,", "id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,")
            for statement in schema.split(";"):
                if statement.strip():
                    connection.execute(statement)
            connection.execute("ALTER TABLE teams ADD COLUMN IF NOT EXISTS tournament_id BIGINT REFERENCES tournaments(id)")
            connection.execute("ALTER TABLE teams ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'")
            connection.execute("ALTER TABLE matches ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'groups'")
            connection.execute("ALTER TABLE player_bans ADD COLUMN IF NOT EXISTS expires_at TEXT")
            connection.execute("ALTER TABLE player_bans ADD COLUMN IF NOT EXISTS lifted_at TEXT")
        else:
            raw_connection = connection.connection
            raw_connection.executescript(schema.replace(
                "id INTEGER PRIMARY KEY,",
                "id INTEGER PRIMARY KEY AUTOINCREMENT,",
            ))
            team_columns = {row["name"] for row in raw_connection.execute("PRAGMA table_info(teams)")}
            if "tournament_id" not in team_columns:
                raw_connection.execute("ALTER TABLE teams ADD COLUMN tournament_id BIGINT REFERENCES tournaments(id)")
            if "status" not in team_columns:
                raw_connection.execute("ALTER TABLE teams ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'")
            match_columns = {row["name"] for row in raw_connection.execute("PRAGMA table_info(matches)")}
            if "phase" not in match_columns:
                raw_connection.execute("ALTER TABLE matches ADD COLUMN phase TEXT NOT NULL DEFAULT 'groups'")
            ban_columns = {row["name"] for row in raw_connection.execute("PRAGMA table_info(player_bans)")}
            if "expires_at" not in ban_columns:
                raw_connection.execute("ALTER TABLE player_bans ADD COLUMN expires_at TEXT")
            if "lifted_at" not in ban_columns:
                raw_connection.execute("ALTER TABLE player_bans ADD COLUMN lifted_at TEXT")


def current_tournament(connection):
    row = connection.execute(
        "SELECT * FROM tournaments WHERE status != 'archived' ORDER BY id DESC LIMIT 1"
    ).fetchone()
    return dict(row) if row else None


def get_team(connection, team_id):
    row = connection.execute(
        "SELECT id, tournament_id, name, tag, captain, contact, status, created_at FROM teams WHERE id = ?",
        (team_id,),
    ).fetchone()
    return dict(row) if row else None


def get_matches(connection, tournament_id):
    rows = connection.execute(
        """
        SELECT m.id, m.match_date AS date, m.match_time AS time, m.phase, m.stage, m.map,
               m.team_a_id, m.team_b_id, a.tag AS team_a, b.tag AS team_b,
               m.score_a, m.score_b,
               CASE WHEN m.score_a IS NULL THEN 'upcoming' ELSE 'finished' END AS status
        FROM matches m
        LEFT JOIN teams a ON a.id = m.team_a_id
        LEFT JOIN teams b ON b.id = m.team_b_id
        WHERE m.tournament_id = ?
        ORDER BY m.match_date, m.match_time, m.id
        """,
        (tournament_id,),
    ).fetchall()
    return [dict(row) for row in rows]


def get_standings(connection, tournament_id, win_points, groups_only=False):
    teams = connection.execute(
        """
        SELECT id, name, tag FROM teams
        WHERE tournament_id = ? AND status = 'approved'
        ORDER BY lower(name)
        """,
        (tournament_id,),
    ).fetchall()
    results = {
        row["id"]: {"played": 0, "wins": 0, "draws": 0, "losses": 0, "points": 0}
        for row in teams
    }
    phase_filter = "AND phase = 'groups'" if groups_only else ""
    matches = connection.execute(
        """
        SELECT team_a_id, team_b_id, score_a, score_b FROM matches
        WHERE tournament_id = ? AND score_a IS NOT NULL AND team_a_id IS NOT NULL AND team_b_id IS NOT NULL
        """ + phase_filter,
        (tournament_id,),
    ).fetchall()
    for match in matches:
        team_a, team_b = match["team_a_id"], match["team_b_id"]
        if team_a not in results or team_b not in results:
            continue
        results[team_a]["played"] += 1
        results[team_b]["played"] += 1
        if match["score_a"] > match["score_b"]:
            results[team_a]["wins"] += 1
            results[team_a]["points"] += win_points
            results[team_b]["losses"] += 1
        elif match["score_b"] > match["score_a"]:
            results[team_b]["wins"] += 1
            results[team_b]["points"] += win_points
            results[team_a]["losses"] += 1
        else:
            results[team_a]["draws"] += 1
            results[team_b]["draws"] += 1
    standings = [
        {
            "id": team["id"],
            "name": team["name"],
            "tag": team["tag"],
            **results[team["id"]],
        }
        for team in teams
    ]
    return sorted(standings, key=lambda team: (-team["points"], -team["wins"], team["tag"].casefold()))


def get_overview():
    with connect_db() as connection:
        tournament = current_tournament(connection)
        if not tournament:
            return {"tournament": None, "matches": [], "teams": [], "leaderboard": [], "standings": [], "bracket": []}
        teams = [
            dict(row)
            for row in connection.execute(
                """
                SELECT id, name, tag, captain, status, created_at FROM teams
                WHERE tournament_id = ? AND status = 'approved' ORDER BY id
                """,
                (tournament["id"],),
            )
        ]
        matches = get_matches(connection, tournament["id"])
        standings = get_standings(connection, tournament["id"], tournament["win_points"])
        group_standings = get_standings(connection, tournament["id"], tournament["win_points"], groups_only=True)
        leaderboard = [
            {
                "place": index + 1,
                "tag": team["tag"],
                "name": team["name"],
                "points": team["points"],
                "trend": "same",
            }
            for index, team in enumerate(standings)
        ]
        pending_count = connection.execute(
            "SELECT COUNT(*) AS count FROM teams WHERE tournament_id = ? AND status = 'pending'",
            (tournament["id"],),
        ).fetchone()["count"]
        approved_count = len(teams)
        tournament.update(
            registered_teams=approved_count,
            pending_teams=pending_count,
        )
        show_groups = tournament["format"] in ("groups", "both")
        show_playoff = tournament["format"] in ("playoff", "both")
        return {
            "tournament": tournament,
            "matches": matches,
            "teams": teams,
            "leaderboard": leaderboard,
            "standings": group_standings if show_groups else [],
            "bracket": [match for match in matches if match["phase"] == "playoff"] if show_playoff else [],
        }


def error_response(message, status=400):
    return status, {"error": message}


class APIHandler(BaseHTTPRequestHandler):
    server_version = "PROFCOM-LNMU/1.0"

    def end_headers(self):
        origin = self.headers.get("Origin")
        configured_origins = os.environ.get("FRONTEND_ORIGINS", "")
        allowed_origins = {
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            *(value.strip().rstrip("/") for value in configured_origins.split(",") if value.strip()),
        }
        if origin in allowed_origins:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Telegram-Init-Data")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/health":
            self.send_json(200, {"status": "ok"})
        elif path == "/api/overview":
            self.send_json(200, get_overview())
        elif path == "/api/admin/session":
            user = self.require_admin()
            if user:
                self.send_json(200, {"is_admin": True, "user": {
                    "id": user["id"],
                    "first_name": user.get("first_name", ""),
                    "username": user.get("username", ""),
                }})
        elif path == "/api/admin/overview":
            if not self.require_admin():
                return
            self.send_json(200, self.get_admin_overview())
        elif path == "/api/player/invitations":
            user = self.require_telegram_user()
            if user:
                self.send_json(200, self.get_player_invitations(user))
        elif path == "/api/player/status":
            user = self.require_telegram_user()
            if user:
                self.send_json(200, self.get_player_status(user))
        else:
            self.send_json(404, {"error": "Маршрут не знайдено."})

    def do_POST(self):
        path = urlparse(self.path).path
        payload = self.read_payload()
        if payload is None:
            return
        if path == "/api/teams":
            user = self.require_telegram_user()
            if not user:
                return
            status, result = self.register_team(payload, user)
        elif path == "/api/player/invitations/accept":
            user = self.require_telegram_user()
            if not user:
                return
            status, result = self.accept_player_invitation(payload, user)
        elif path.startswith("/api/admin/"):
            user = self.require_admin()
            if not user:
                return
            status, result = self.admin_action(path, payload, user)
        else:
            status, result = error_response("Маршрут не знайдено.", 404)
        self.send_json(status, result)

    def read_payload(self):
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_json(400, {"error": "Некоректний розмір запиту."})
            return None
        if content_length <= 0 or content_length > 16_384:
            self.send_json(400, {"error": "Некоректний розмір запиту."})
            return None
        try:
            payload = json.loads(self.rfile.read(content_length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.send_json(400, {"error": "Надішли коректні JSON-дані."})
            return None
        if not isinstance(payload, dict):
            self.send_json(400, {"error": "Очікується об'єкт із даними."})
            return None
        return payload

    def require_telegram_user(self):
        bot_token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
        if not bot_token:
            self.send_json(503, {"error": "Telegram-авторизацію не налаштовано на сервері."})
            return None

        init_data = self.headers.get("X-Telegram-Init-Data", "")
        user = verify_telegram_init_data(init_data, bot_token)
        if user is None:
            self.send_json(401, {"error": "Не вдалося підтвердити Telegram WebApp. Відкрий застосунок у Telegram ще раз."})
            return None
        return user

    def require_admin(self):
        configured_admins = os.environ.get("TELEGRAM_ADMIN_IDS", "")
        try:
            admin_ids = {PRIMARY_ADMIN_ID}
            admin_ids.update(int(value.strip()) for value in configured_admins.split(",") if value.strip())
        except ValueError:
            logger.error("TELEGRAM_ADMIN_IDS має містити числові Telegram ID через кому.")
            self.send_json(503, {"error": "Сервер має некоректну конфігурацію Telegram адміністраторів."})
            return None
        if any(admin_id <= 0 for admin_id in admin_ids):
            logger.error("TELEGRAM_ADMIN_IDS має містити додатні числові Telegram ID.")
            self.send_json(503, {"error": "Сервер має некоректну конфігурацію Telegram адміністраторів."})
            return None
        user = self.require_telegram_user()
        if user is None:
            return None
        if user["id"] not in admin_ids:
            self.send_json(403, {"error": "Цей Telegram-акаунт не має прав адміністратора."})
            return None
        return user

    @staticmethod
    def clean_string(payload, name, limit, required=True):
        value = payload.get(name, "")
        if not isinstance(value, str):
            raise ValueError(f"Поле «{name}» має бути текстом.")
        value = value.strip()
        if required and not value:
            raise ValueError("Заповни всі обов'язкові поля.")
        if len(value) > limit:
            raise ValueError(f"Поле «{name}» задовге (максимум {limit} символів).")
        return value

    def register_team(self, payload, user):
        try:
            team = {
                field: self.clean_string(payload, field, limit)
                for field, limit in (("name", 60), ("tag", 8), ("captain", 60), ("contact", 80))
            }
            invite_usernames = self.parse_invite_usernames(payload.get("players", ""))
            if len(team["tag"]) < 2 or not re.fullmatch(r"[\w-]+", team["tag"], flags=re.UNICODE):
                raise ValueError("Тег команди має містити 2–8 літер, цифр, _ або -.")
            with connect_db() as connection:
                if self.get_player_ban(connection, user["id"]):
                    return error_response("Твій Telegram-акаунт заблоковано в застосунку. Звернися до адміністратора.", 403)
                tournament = current_tournament(connection)
                if not tournament or tournament["status"] != "registration":
                    return error_response("Зараз немає турніру з відкритою реєстрацією.", 409)
                existing_membership = connection.execute(
                    """
                    SELECT COUNT(*) AS count
                    FROM team_players p JOIN teams t ON t.id = p.team_id
                    WHERE p.telegram_user_id = ? AND t.tournament_id = ? AND t.status != 'rejected'
                    """,
                    (user["id"], tournament["id"]),
                ).fetchone()["count"]
                if existing_membership:
                    return error_response("Ти вже входиш до складу команди цього турніру.", 409)
                team_count = connection.execute(
                    "SELECT COUNT(*) AS count FROM teams WHERE tournament_id = ? AND status != 'rejected'",
                    (tournament["id"],),
                ).fetchone()["count"]
                if team_count >= tournament["team_limit"]:
                    return error_response("Усі місця на турнір уже зайняті.", 409)
                team_id = connection.insert_id(
                    """
                    INSERT INTO teams (tournament_id, name, tag, captain, contact, status, created_at)
                    VALUES (?, ?, ?, ?, ?, 'pending', ?)
                    """,
                    (
                        tournament["id"],
                        team["name"],
                        team["tag"],
                        team["captain"],
                        team["contact"],
                        datetime.now(timezone.utc).isoformat(),
                    ),
                )
                now = datetime.now(timezone.utc).isoformat()
                captain_username = (user.get("username") or "").strip().lstrip("@").lower()
                connection.execute(
                    """
                    INSERT INTO team_players
                    (team_id, telegram_user_id, invited_username, username, status, is_captain, created_at)
                    VALUES (?, ?, ?, ?, 'active', 1, ?)
                    """,
                    (team_id, user["id"], captain_username, captain_username, now),
                )
                for username in invite_usernames:
                    if username == captain_username:
                        raise ValueError("Не додавай Telegram username капітана до списку гравців.")
                    connection.execute(
                        """
                        INSERT INTO team_players (team_id, invited_username, created_at)
                        VALUES (?, ?, ?)
                        """,
                        (team_id, username, now),
                    )
                team.update(id=team_id, tournament_id=tournament["id"], status="pending")
                team["created_at"] = connection.execute(
                    "SELECT created_at FROM teams WHERE id = ?", (team_id,)
                ).fetchone()["created_at"]
            return 201, {"team": team}
        except ValueError as error:
            return error_response(str(error))
        except integrity_error_types():
            return error_response("Такий тег команди вже використовується.", 409)

    @staticmethod
    def parse_invite_usernames(value):
        if not isinstance(value, str):
            raise ValueError("Список гравців має бути текстом.")
        values = [item.strip().lstrip("@").lower() for item in re.split(r"[\s,;]+", value) if item.strip()]
        if len(values) > 4:
            raise ValueError("До складу можна запросити максимум чотирьох гравців, крім капітана.")
        if len(set(values)) != len(values):
            raise ValueError("У списку є повтори Telegram username.")
        if any(not re.fullmatch(r"[a-z0-9_]{5,32}", username) for username in values):
            raise ValueError("Перевір Telegram username гравців (5–32 латинські літери, цифри або _).")
        return values

    @staticmethod
    def get_player_ban(connection, telegram_user_id):
        now = datetime.now(timezone.utc).isoformat()
        row = connection.execute(
            """
            SELECT telegram_user_id, username, reason, created_at, expires_at
            FROM player_bans
            WHERE telegram_user_id = ? AND lifted_at IS NULL
              AND (expires_at IS NULL OR expires_at > ?)
            """,
            (telegram_user_id, now),
        ).fetchone()
        return dict(row) if row else None

    def get_active_sanction(self, telegram_user_id):
        with connect_db() as connection:
            return self.get_player_ban(connection, telegram_user_id)

    def get_player_status(self, user):
        sanction = self.get_active_sanction(user["id"])
        return {"sanction": {
            "reason": sanction["reason"],
            "expires_at": sanction["expires_at"],
        } if sanction else None}

    def get_player_invitations(self, user):
        username = (user.get("username") or "").strip().lstrip("@").lower()
        with connect_db() as connection:
            ban = self.get_player_ban(connection, user["id"])
            invitations = []
            if username and not ban:
                invitations = [
                    dict(row)
                    for row in connection.execute(
                        """
                        SELECT p.id, p.invited_username, t.name AS team_name, t.tag AS team_tag
                        FROM team_players p
                        JOIN teams t ON t.id = p.team_id
                        WHERE lower(p.invited_username) = ? AND p.status = 'invited'
                          AND t.status != 'rejected'
                          AND t.tournament_id = (
                              SELECT id FROM tournaments WHERE status != 'archived' ORDER BY id DESC LIMIT 1
                          )
                        ORDER BY p.id DESC
                        """,
                        (username,),
                    )
                ]
        public_ban = {"reason": ban["reason"], "expires_at": ban["expires_at"]} if ban else None
        return {"invitations": invitations, "ban": public_ban}

    def accept_player_invitation(self, payload, user):
        try:
            invitation_id = self.integer(payload, "invitation_id", 1, 2**31 - 1)
            username = (user.get("username") or "").strip().lstrip("@").lower()
            if not username:
                return error_response("Задай Telegram username у налаштуваннях Telegram, щоб прийняти запрошення.", 400)
            with connect_db() as connection:
                if self.get_player_ban(connection, user["id"]):
                    return error_response("Твій Telegram-акаунт заблоковано в застосунку.", 403)
                invite = connection.execute(
                    """
                    SELECT p.id, p.team_id FROM team_players p
                    JOIN teams t ON t.id = p.team_id
                    WHERE p.id = ? AND lower(p.invited_username) = ? AND p.status = 'invited'
                      AND t.status != 'rejected'
                      AND t.tournament_id = (
                          SELECT id FROM tournaments WHERE status != 'archived' ORDER BY id DESC LIMIT 1
                      )
                    """,
                    (invitation_id, username),
                ).fetchone()
                if not invite:
                    return error_response("Запрошення не знайдено або воно вже використане.", 404)
                existing_membership = connection.execute(
                    """
                    SELECT COUNT(*) AS count
                    FROM team_players p JOIN teams t ON t.id = p.team_id
                    WHERE p.telegram_user_id = ? AND t.tournament_id = (
                        SELECT id FROM tournaments WHERE status != 'archived' ORDER BY id DESC LIMIT 1
                    ) AND t.status != 'rejected'
                    """,
                    (user["id"],),
                ).fetchone()["count"]
                if existing_membership:
                    return error_response("Ти вже входиш до складу команди цього турніру.", 409)
                connection.execute(
                    """
                    UPDATE team_players
                    SET telegram_user_id = ?, username = ?, status = 'active'
                    WHERE id = ?
                    """,
                    (user["id"], username, invitation_id),
                )
            return 200, {"accepted": True}
        except ValueError as error:
            return error_response(str(error))
        except integrity_error_types():
            return error_response("Цей Telegram-акаунт уже доданий до іншого складу.", 409)

    def get_admin_overview(self):
        with connect_db() as connection:
            tournament = current_tournament(connection)
            if not tournament:
                teams = []
                matches = []
            else:
                teams = [
                    dict(row)
                    for row in connection.execute(
                        """
                        SELECT id, name, tag, captain, contact, status, created_at FROM teams
                        WHERE tournament_id = ? ORDER BY id DESC
                        """,
                        (tournament["id"],),
                    )
                ]
                matches = get_matches(connection, tournament["id"])
            players = [
                dict(row)
                for row in connection.execute(
                    """
                    SELECT p.id, p.team_id, p.telegram_user_id, p.invited_username, p.username,
                           p.status, p.is_captain, t.name AS team_name, t.tag AS team_tag
                    FROM team_players p
                    JOIN teams t ON t.id = p.team_id
                    ORDER BY t.id DESC, p.is_captain DESC, p.id
                    """
                )
            ]
            bans = [
                dict(row)
                for row in connection.execute(
                    """
                    SELECT telegram_user_id, username, reason, created_at, expires_at, lifted_at
                    FROM player_bans ORDER BY created_at DESC
                    """
                )
            ]
            now = datetime.now(timezone.utc).isoformat()
            for ban in bans:
                ban["active"] = (
                    ban["lifted_at"] is None
                    and (ban["expires_at"] is None or ban["expires_at"] > now)
                )
            return {
                "tournament": tournament,
                "teams": teams,
                "matches": matches,
                "players": players,
                "bans": bans,
            }

    def admin_action(self, path, payload, admin_user):
        try:
            if path == "/api/admin/tournaments":
                return self.create_tournament(payload)
            approve_match = re.fullmatch(r"/api/admin/teams/(\d+)/(approve|reject)", path)
            if approve_match:
                return self.review_team(int(approve_match.group(1)), approve_match.group(2))
            if path == "/api/admin/matches":
                return self.create_match(payload)
            result_match = re.fullmatch(r"/api/admin/matches/(\d+)/result", path)
            if result_match:
                return self.save_result(int(result_match.group(1)), payload)
            player_match = re.fullmatch(r"/api/admin/players/(\d+)/(ban|unban)", path)
            if player_match:
                return self.update_player_ban(
                    int(player_match.group(1)),
                    player_match.group(2),
                    payload,
                    admin_user["id"],
                )
            return error_response("Маршрут не знайдено.", 404)
        except ValueError as error:
            return error_response(str(error))
        except integrity_error_types() as error:
            logger.info("Admin request conflict: %s", error)
            return error_response("Дані конфліктують із наявними записами.", 409)

    def update_player_ban(self, telegram_user_id, action, payload, admin_id):
        if action == "ban":
            reason = self.clean_string(payload, "reason", 300)
            duration = payload.get("duration")
            durations = {"permanent": None, "1d": 1, "7d": 7, "30d": 30}
            if duration not in durations:
                raise ValueError("Обери постійне блокування або строк 1, 7 чи 30 днів.")
            with connect_db() as connection:
                player = connection.execute(
                    """
                    SELECT username FROM team_players
                    WHERE telegram_user_id = ? ORDER BY id DESC LIMIT 1
                    """,
                    (telegram_user_id,),
                ).fetchone()
                if not player:
                    return error_response("Гравця не знайдено у складах.", 404)
                connection.execute(
                    """
                    INSERT INTO player_bans
                    (telegram_user_id, username, reason, created_at, banned_by, expires_at, lifted_at)
                    VALUES (?, ?, ?, ?, ?, ?, NULL)
                    ON CONFLICT (telegram_user_id) DO UPDATE SET
                        username = excluded.username,
                        reason = excluded.reason,
                        created_at = excluded.created_at,
                        banned_by = excluded.banned_by,
                        expires_at = excluded.expires_at,
                        lifted_at = NULL
                    """,
                    (
                        telegram_user_id,
                        player["username"],
                        reason,
                        datetime.now(timezone.utc).isoformat(),
                        admin_id,
                        (datetime.now(timezone.utc) + timedelta(days=durations[duration])).isoformat()
                        if durations[duration] is not None
                        else None,
                    ),
                )
            return 200, {"sanctioned": True}
        with connect_db() as connection:
            connection.execute(
                """
                UPDATE player_bans SET lifted_at = ?
                WHERE telegram_user_id = ? AND lifted_at IS NULL
                """,
                (datetime.now(timezone.utc).isoformat(), telegram_user_id),
            )
        return 200, {"sanctioned": False}

    def create_tournament(self, payload):
        name = self.clean_string(payload, "name", 100)
        logo_url = self.clean_string(payload, "logo_url", 500, required=False)
        start_date = self.clean_string(payload, "start_date", 10)
        end_date = self.clean_string(payload, "end_date", 10)
        try:
            if datetime.strptime(start_date, "%Y-%m-%d") > datetime.strptime(end_date, "%Y-%m-%d"):
                raise ValueError("Дата завершення має бути не раніше дати початку.")
        except ValueError as error:
            if "Дата завершення" in str(error):
                raise
            raise ValueError("Вкажи дати у форматі РРРР-ММ-ДД.") from error
        format_value = payload.get("format")
        if format_value not in ("groups", "playoff", "both"):
            raise ValueError("Обери таблицю, плей-оф або обидва формати.")
        team_limit = self.integer(payload, "team_limit", 2, 128)
        prize_pool = self.integer(payload, "prize_pool", 0, 100_000_000)
        win_points = self.integer(payload, "win_points", 1, 100)
        with connect_db() as connection:
            connection.execute("UPDATE tournaments SET status = 'archived' WHERE status != 'archived'")
            tournament_id = connection.insert_id(
                """
                INSERT INTO tournaments
                (name, logo_url, start_date, end_date, prize_pool, team_limit, format, win_points, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'registration', ?)
                """,
                (
                    name,
                    logo_url,
                    start_date,
                    end_date,
                    prize_pool,
                    team_limit,
                    format_value,
                    win_points,
                    datetime.now(timezone.utc).isoformat(),
                ),
            )
            created = dict(connection.execute("SELECT * FROM tournaments WHERE id = ?", (tournament_id,)).fetchone())
        return 201, {"tournament": created}

    def review_team(self, team_id, decision):
        new_status = "approved" if decision == "approve" else "rejected"
        with connect_db() as connection:
            tournament = current_tournament(connection)
            team = get_team(connection, team_id)
            if not team or not tournament or team["tournament_id"] != tournament["id"]:
                return error_response("Заявку не знайдено.", 404)
            if team["status"] != "pending":
                return error_response("Ця заявка вже розглянута.", 409)
            if decision == "approve":
                approved = connection.execute(
                    "SELECT COUNT(*) AS count FROM teams WHERE tournament_id = ? AND status = 'approved'",
                    (tournament["id"],),
                ).fetchone()["count"]
                if approved >= tournament["team_limit"]:
                    return error_response("Усі місця на турнір уже зайняті.", 409)
            connection.execute("UPDATE teams SET status = ? WHERE id = ?", (new_status, team_id))
            team["status"] = new_status
        return 200, {"team": team}

    def create_match(self, payload):
        match_date = self.clean_string(payload, "date", 10)
        match_time = self.clean_string(payload, "time", 5)
        stage = self.clean_string(payload, "stage", 40)
        phase = payload.get("phase")
        if phase not in ("groups", "playoff"):
            raise ValueError("Обери груповий етап або плей-оф.")
        map_name = self.clean_string(payload, "map", 40, required=False)
        try:
            datetime.strptime(match_date, "%Y-%m-%d")
            datetime.strptime(match_time, "%H:%M")
        except ValueError as error:
            raise ValueError("Вкажи коректні дату й час матчу.") from error
        team_a_id = self.integer(payload, "team_a_id", 1, 2**31 - 1)
        team_b_id = self.integer(payload, "team_b_id", 1, 2**31 - 1)
        if team_a_id == team_b_id:
            raise ValueError("Обери дві різні команди.")
        with connect_db() as connection:
            tournament = current_tournament(connection)
            if not tournament:
                return error_response("Спочатку створи турнір.", 409)
            for team_id in (team_a_id, team_b_id):
                team = get_team(connection, team_id)
                if not team or team["tournament_id"] != tournament["id"] or team["status"] != "approved":
                    return error_response("Для матчу можна обирати лише підтверджені команди.", 400)
            match_id = connection.insert_id(
                """
                INSERT INTO matches
                (tournament_id, match_date, match_time, phase, stage, map, team_a_id, team_b_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    tournament["id"],
                    match_date,
                    match_time,
                    phase,
                    stage,
                    map_name,
                    team_a_id,
                    team_b_id,
                    datetime.now(timezone.utc).isoformat(),
                ),
            )
            created = next(match for match in get_matches(connection, tournament["id"]) if match["id"] == match_id)
        return 201, {"match": created}

    def save_result(self, match_id, payload):
        score_a = self.integer(payload, "score_a", 0, 99)
        score_b = self.integer(payload, "score_b", 0, 99)
        if score_a == score_b:
            raise ValueError("Матч CS2 не може завершитися нічиєю.")
        with connect_db() as connection:
            tournament = current_tournament(connection)
            if not tournament:
                return error_response("Турнір не знайдено.", 404)
            cursor = connection.execute(
                """
                UPDATE matches SET score_a = ?, score_b = ?
                WHERE id = ? AND tournament_id = ? AND team_a_id IS NOT NULL AND team_b_id IS NOT NULL
                """,
                (score_a, score_b, match_id, tournament["id"]),
            )
            if cursor.rowcount == 0:
                return error_response("Матч не знайдено або в ньому не вказані команди.", 404)
            match = next(match for match in get_matches(connection, tournament["id"]) if match["id"] == match_id)
        return 200, {"match": match}

    @staticmethod
    def integer(payload, name, minimum, maximum):
        value = payload.get(name)
        if isinstance(value, bool):
            raise ValueError(f"Поле «{name}» має бути числом.")
        try:
            number = int(value)
        except (TypeError, ValueError) as error:
            raise ValueError(f"Поле «{name}» має бути числом.") from error
        if number < minimum or number > maximum:
            raise ValueError(f"Поле «{name}» має бути від {minimum} до {maximum}.")
        return number

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format_string, *args):
        logger.info("%s - %s", self.address_string(), format_string % args)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    initialize_database()
    server = ThreadingHTTPServer((HOST, PORT), APIHandler)
    logger.info("PROFCOM LNMU API запущено: http://%s:%s", HOST, PORT)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Зупиняю сервер.")
    finally:
        server.server_close()
