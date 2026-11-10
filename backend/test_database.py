import base64
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import server


class DatabaseConnectionTests(unittest.TestCase):
    def test_logo_validation_accepts_supported_image_and_rejects_invalid_data(self):
        webp = base64.b64encode(b"RIFF\x04\x00\x00\x00WEBP").decode("ascii")
        data_url = f"data:image/webp;base64,{webp}"
        self.assertEqual(server.APIHandler.clean_logo(data_url), data_url)
        self.assertEqual(server.APIHandler.clean_logo("https://example.com/logo.png"), "https://example.com/logo.png")
        with self.assertRaises(ValueError):
            server.APIHandler.clean_logo("data:image/png;base64,not-an-image")
        with self.assertRaises(ValueError):
            server.APIHandler.clean_logo("javascript:alert(1)")
        oversized = base64.b64encode(b"RIFF" + b"\x00" * server.MAX_LOGO_BYTES + b"WEBP").decode("ascii")
        with self.assertRaises(ValueError):
            server.APIHandler.clean_logo(f"data:image/webp;base64,{oversized}")

    def test_sqlite_schema_initializes_and_enforces_case_insensitive_tags(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            database = Path(temporary_directory) / "tournament.sqlite3"
            with patch.object(server, "DATABASE", database), patch.dict("os.environ", {"DATABASE_URL": ""}):
                server.initialize_database()
                with server.connect_db() as connection:
                    tournament_id = connection.insert_id(
                        """
                        INSERT INTO tournaments
                        (name, start_date, end_date, team_limit, format, created_at)
                        VALUES (?, ?, ?, ?, ?, ?)
                        """,
                        ("Test tournament", "2026-11-10", "2026-11-11", 8, "groups", "now"),
                    )
                    connection.execute(
                        """
                        INSERT INTO teams
                        (tournament_id, name, tag, captain, contact, created_at)
                        VALUES (?, ?, ?, ?, ?, ?)
                        """,
                        (tournament_id, "Team", "TAG", "Captain", "contact", "now"),
                    )
                    with self.assertRaises(sqlite3.IntegrityError):
                        connection.execute(
                            """
                            INSERT INTO teams
                            (tournament_id, name, tag, captain, contact, created_at)
                            VALUES (?, ?, ?, ?, ?, ?)
                            """,
                            (tournament_id, "Another team", "tag", "Captain", "contact", "now"),
                        )

    def test_tournament_registration_and_results_work_with_sqlite(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            database = Path(temporary_directory) / "tournament.sqlite3"
            with patch.object(server, "DATABASE", database), patch.dict("os.environ", {"DATABASE_URL": ""}):
                server.initialize_database()
                handler = object.__new__(server.APIHandler)
                status, _ = handler.create_tournament({
                    "name": "Test tournament",
                    "logo_url": "",
                    "start_date": "2026-11-10",
                    "end_date": "2026-11-11",
                    "format": "both",
                    "team_limit": 8,
                    "prize_pool": 0,
                    "win_points": 3,
                })
                self.assertEqual(status, 201)

                team_ids = []
                for tag in ("AAA", "BBB"):
                    status, result = handler.register_team({
                        "name": f"Team {tag}",
                        "tag": tag,
                        "captain": "Captain",
                        "contact": "contact",
                    }, {"id": 1000 + len(team_ids), "username": f"captain{len(team_ids)}"})
                    self.assertEqual(status, 201)
                    team_ids.append(result["team"]["id"])

                for team_id in team_ids:
                    self.assertEqual(handler.review_team(team_id, "approve")[0], 200)

                status, result = handler.create_match({
                    "date": "2026-11-10",
                    "time": "18:00",
                    "stage": "Group 1",
                    "phase": "groups",
                    "map": "Mirage",
                    "team_a_id": team_ids[0],
                    "team_b_id": team_ids[1],
                })
                self.assertEqual(status, 201)
                self.assertEqual(handler.save_result(result["match"]["id"], {
                    "score_a": 13,
                    "score_b": 9,
                })[0], 200)

                overview = server.get_overview()
                self.assertEqual(overview["leaderboard"][0]["tag"], "AAA")
                self.assertEqual(overview["leaderboard"][0]["points"], 3)

    def test_telegram_roster_invites_and_temporary_access_restrictions(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            database = Path(temporary_directory) / "tournament.sqlite3"
            with patch.object(server, "DATABASE", database), patch.dict("os.environ", {"DATABASE_URL": ""}):
                server.initialize_database()
                handler = object.__new__(server.APIHandler)
                handler.create_tournament({
                    "name": "Test tournament",
                    "logo_url": "",
                    "start_date": "2026-11-10",
                    "end_date": "2026-11-11",
                    "format": "both",
                    "team_limit": 8,
                    "prize_pool": 0,
                    "win_points": 3,
                })

                status, result = handler.register_team({
                    "name": "Team Alpha",
                    "tag": "ALPHA",
                    "captain": "Captain",
                    "contact": "@captain",
                    "players": "@player_one",
                }, {"id": 1001, "username": "captain"})
                self.assertEqual(status, 201)
                self.assertNotIn("telegram_user_id", result["team"])

                invitations = handler.get_player_invitations({"id": 2002, "username": "player_one"})
                self.assertEqual(len(invitations["invitations"]), 1)
                invitation_id = invitations["invitations"][0]["id"]
                self.assertEqual(
                    handler.accept_player_invitation(
                        {"invitation_id": invitation_id},
                        {"id": 2002, "username": "player_one"},
                    )[0],
                    200,
                )

                admin_overview = handler.get_admin_overview()
                player_ids = {player["telegram_user_id"] for player in admin_overview["players"]}
                self.assertEqual(player_ids, {1001, 2002})
                handler.review_team(result["team"]["id"], "approve")
                public_overview = server.get_overview()
                self.assertNotIn("telegram_user_id", repr(public_overview))
                self.assertNotIn("players", public_overview)

                self.assertEqual(
                    handler.update_player_ban(2002, "ban", {"reason": "Порушення правил", "duration": "1d"}, 1001)[0],
                    200,
                )
                sanction = handler.get_active_sanction(2002)
                self.assertIsNotNone(sanction)
                self.assertEqual(sanction["reason"], "Порушення правил")
                self.assertNotIn("telegram_user_id", handler.get_player_status({"id": 2002})["sanction"])
                self.assertNotIn("telegram_user_id", handler.get_player_invitations({"id": 2002, "username": "player_one"})["ban"])

                self.assertEqual(
                    handler.accept_player_invitation(
                        {"invitation_id": invitation_id},
                        {"id": 2002, "username": "player_one"},
                    )[0],
                    403,
                )
                self.assertEqual(
                    handler.register_team({
                        "name": "Team Blocked",
                        "tag": "BLOCK",
                        "captain": "Blocked player",
                        "contact": "@blocked",
                    }, {"id": 2002, "username": "player_one"})[0],
                    403,
                )
                with server.connect_db() as connection:
                    connection.execute(
                        "UPDATE player_bans SET expires_at = ? WHERE telegram_user_id = ?",
                        ("2000-01-01T00:00:00+00:00", 2002),
                    )
                self.assertIsNone(handler.get_active_sanction(2002))
                self.assertFalse(next(
                    ban for ban in handler.get_admin_overview()["bans"]
                    if ban["telegram_user_id"] == 2002
                )["active"])
                self.assertEqual(handler.update_player_ban(2002, "unban", {}, 1001)[0], 200)

    def test_postgres_adapter_translates_placeholders_and_returns_inserted_id(self):
        class FakeCursor:
            def fetchone(self):
                return {"id": 42}

        class FakeConnection:
            def __init__(self):
                self.query = None
                self.parameters = None

            def execute(self, query, parameters):
                self.query = query
                self.parameters = parameters
                return FakeCursor()

        raw_connection = FakeConnection()
        connection = server.DatabaseConnection(raw_connection, is_postgres=True)
        inserted_id = connection.insert_id(
            "INSERT INTO teams (name) VALUES (?)",
            ("Team",),
        )
        self.assertEqual(inserted_id, 42)
        self.assertEqual(raw_connection.query, "INSERT INTO teams (name) VALUES (%s) RETURNING id")
        self.assertEqual(raw_connection.parameters, ("Team",))


if __name__ == "__main__":
    unittest.main()
