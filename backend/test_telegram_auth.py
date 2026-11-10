import hashlib
import hmac
import json
import os
import time
import unittest
from unittest.mock import patch
from urllib.parse import urlencode

from server import APIHandler


def signed_init_data(bot_token, user, auth_date=None):
    fields = {
        "auth_date": str(auth_date if auth_date is not None else int(time.time())),
        "user": json.dumps(user, separators=(",", ":")),
    }
    data_check_string = "\n".join(f"{key}={value}" for key, value in sorted(fields.items()))
    secret_key = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    fields["hash"] = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
    return urlencode(fields)


class TelegramInitDataTests(unittest.TestCase):
    def setUp(self):
        from telegram_auth import verify_telegram_init_data

        self.verify = verify_telegram_init_data
        self.token = "test-bot-token"
        self.user = {"id": 12345, "first_name": "Test"}
        self.now = 1_700_000_000

    def test_accepts_valid_signature(self):
        init_data = signed_init_data(self.token, self.user, self.now)
        self.assertEqual(self.verify(init_data, self.token, now=self.now), self.user)

    def test_rejects_modified_signature(self):
        init_data = signed_init_data(self.token, self.user, self.now).replace("Test", "Fake")
        self.assertIsNone(self.verify(init_data, self.token, now=self.now))

    def test_rejects_stale_init_data(self):
        init_data = signed_init_data(self.token, self.user, self.now - 86_401)
        self.assertIsNone(self.verify(init_data, self.token, now=self.now))

    def test_rejects_future_auth_date(self):
        init_data = signed_init_data(self.token, self.user, self.now + 1)
        self.assertIsNone(self.verify(init_data, self.token, now=self.now))


class AdminAuthorizationTests(unittest.TestCase):
    class Handler(APIHandler):
        def __init__(self, init_data):
            self.headers = {"X-Telegram-Init-Data": init_data}
            self.responses = []

        def send_json(self, status, payload):
            self.responses.append((status, payload))

    def setUp(self):
        self.token = "test-bot-token"
        self.user = {"id": 12345, "first_name": "Test"}
        self.init_data = signed_init_data(self.token, self.user)
        self.env = patch.dict(os.environ, {
            "TELEGRAM_BOT_TOKEN": self.token,
            "TELEGRAM_ADMIN_IDS": "12345",
        })
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_allows_configured_telegram_admin(self):
        handler = self.Handler(self.init_data)
        self.assertEqual(handler.require_admin()["id"], 12345)
        self.assertEqual(handler.responses, [])

    def test_allows_primary_admin_without_environment_id(self):
        os.environ["TELEGRAM_ADMIN_IDS"] = ""
        user = {"id": 5806282517, "first_name": "Primary admin"}
        handler = self.Handler(signed_init_data(self.token, user))
        self.assertEqual(handler.require_admin()["id"], 5806282517)
        self.assertEqual(handler.responses, [])

    def test_rejects_valid_non_admin(self):
        os.environ["TELEGRAM_ADMIN_IDS"] = "99999"
        handler = self.Handler(self.init_data)
        self.assertIsNone(handler.require_admin())
        self.assertEqual(handler.responses[0][0], 403)

    def test_rejects_missing_telegram_identity(self):
        handler = self.Handler("")
        self.assertIsNone(handler.require_admin())
        self.assertEqual(handler.responses[0][0], 401)


if __name__ == "__main__":
    unittest.main()
