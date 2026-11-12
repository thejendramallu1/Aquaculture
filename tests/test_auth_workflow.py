import tempfile
import unittest
from pathlib import Path

from app import create_admin_account, create_app


PASSWORD = "correct-horse-battery-42"


class AuthWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        database_path = Path(self.temp_dir.name) / "test.sqlite3"
        self.app = create_app(database_path=database_path, secret_key="test-key-with-enough-randomness")
        self.app.config.update(TESTING=True)
        create_admin_account("admin@example.test", "Test Admin", PASSWORD, database_path)
        self.admin = self.app.test_client()
        response = self.login(self.admin, "admin@example.test", PASSWORD, "admin")
        self.assertEqual(response.status_code, 200, response.get_json())
        cookie = response.headers["Set-Cookie"]
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Lax", cookie)
        self.create_team_account("Management User", "management@example.test", "management")
        self.create_team_account("Analysis User", "analyst@example.test", "analyst")

    def tearDown(self):
        self.temp_dir.cleanup()

    def headers(self, client):
        token = client.get("/api/session").get_json()["csrfToken"]
        return {"X-CSRF-Token": token}

    def login(self, client, email, password, role):
        response = client.post(
            "/api/login",
            json={"email": email, "password": password, "role": role},
            headers=self.headers(client),
        )
        return response

    def create_team_account(self, name, email, role):
        response = self.admin.post(
            "/api/accounts",
            json={"name": name, "email": email, "password": PASSWORD, "role": role},
            headers=self.headers(self.admin),
        )
        self.assertEqual(response.status_code, 201, response.get_json())

    def register(self, role, name, email):
        client = self.app.test_client()
        response = client.post(
            "/api/register",
            json={"role": role, "name": name, "email": email, "password": PASSWORD},
            headers=self.headers(client),
        )
        self.assertEqual(response.status_code, 201, response.get_json())
        return client

    def test_role_specific_login_and_approval_workflow(self):
        farmer = self.register("farmer", "Farmer One", "farmer@example.test")
        other_farmer = self.register("farmer", "Farmer Two", "farmer-two@example.test")
        vendor = self.register("vendor", "Vendor One", "vendor@example.test")
        self.assertEqual(self.login(farmer, "farmer@example.test", PASSWORD, "vendor").status_code, 401)
        self.assertEqual(self.login(farmer, "farmer@example.test", PASSWORD, "farmer").status_code, 403)

        management = self.app.test_client()
        self.assertEqual(self.login(management, "management@example.test", PASSWORD, "management").status_code, 200)
        pending = management.get("/api/accounts/pending").get_json()["accounts"]
        account_ids = {item["email"]: item["id"] for item in pending}
        for email in ("farmer@example.test", "farmer-two@example.test", "vendor@example.test"):
            response = management.patch(
                f"/api/accounts/{account_ids[email]}/status",
                json={"status": "approved"},
                headers=self.headers(management),
            )
            self.assertEqual(response.status_code, 200, response.get_json())

        self.assertEqual(self.login(farmer, "farmer@example.test", PASSWORD, "farmer").status_code, 200)
        self.assertEqual(self.login(other_farmer, "farmer-two@example.test", PASSWORD, "farmer").status_code, 200)
        self.assertEqual(self.login(vendor, "vendor@example.test", PASSWORD, "vendor").status_code, 200)
        request_response = farmer.post(
            "/api/requests",
            json={
                "farm": "Pond One",
                "fish": "Nile tilapia",
                "water": "Freshwater",
                "culture": "Pond",
                "fishCount": 1000,
                "feedNeedKg": 100,
                "feedPreference": "Natural",
                "notes": "",
            },
            headers=self.headers(farmer),
        )
        self.assertEqual(request_response.status_code, 201, request_response.get_json())
        request_id = request_response.get_json()["id"]
        self.assertEqual(other_farmer.get("/api/data").get_json()["requests"], [])

        inventory_response = vendor.post(
            "/api/inventory",
            json={
                "name": "Tilapia Natural Blend",
                "vendor": "Vendor One",
                "category": "Natural",
                "species": "Nile tilapia",
                "water": "Freshwater",
                "quantityKg": 250,
                "pricePerKg": 1.75,
                "source": "Regional supplier",
            },
            headers=self.headers(vendor),
        )
        self.assertEqual(inventory_response.status_code, 201, inventory_response.get_json())
        feed_id = inventory_response.get_json()["id"]

        self.assertEqual(farmer.patch(f"/api/requests/{request_id}/status", json={"status": "approved"}, headers=self.headers(farmer)).status_code, 403)
        self.assertEqual(management.patch(f"/api/requests/{request_id}/status", json={"status": "approved"}, headers=self.headers(management)).status_code, 200)
        self.assertEqual(management.patch(f"/api/inventory/{feed_id}/status", json={"status": "approved"}, headers=self.headers(management)).status_code, 200)

        analyst = self.app.test_client()
        self.assertEqual(self.login(analyst, "analyst@example.test", PASSWORD, "analyst").status_code, 200)
        analyst_data = analyst.get("/api/data").get_json()
        self.assertEqual([item["id"] for item in analyst_data["requests"]], [request_id])
        self.assertEqual([item["id"] for item in analyst_data["inventory"]], [feed_id])
        recommendation_response = analyst.post(
            "/api/recommendations",
            json={"requestId": request_id},
            headers=self.headers(analyst),
        )
        self.assertEqual(recommendation_response.status_code, 201, recommendation_response.get_json())
        recommendation_id = recommendation_response.get_json()["id"]

        pending_recommendations = self.admin.get("/api/data").get_json()["recommendations"]
        self.assertEqual([item["id"] for item in pending_recommendations], [recommendation_id])
        publish = self.admin.patch(
            f"/api/recommendations/{recommendation_id}/status",
            json={"status": "published"},
            headers=self.headers(self.admin),
        )
        self.assertEqual(publish.status_code, 200, publish.get_json())
        farmer_data = farmer.get("/api/data").get_json()
        self.assertEqual([item["id"] for item in farmer_data["recommendations"]], [recommendation_id])

    def test_csrf_required_for_mutations(self):
        response = self.admin.post(
            "/api/accounts",
            json={"name": "No token", "email": "no-token@example.test", "password": PASSWORD, "role": "analyst"},
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("session token", response.get_json()["error"].lower())

    def test_team_admin_cannot_create_another_admin_through_account_form(self):
        response = self.admin.post(
            "/api/accounts",
            json={"name": "Unexpected Admin", "email": "other-admin@example.test", "password": PASSWORD, "role": "admin"},
            headers=self.headers(self.admin),
        )
        self.assertEqual(response.status_code, 400)

    def test_server_does_not_expose_project_or_database_files(self):
        client = self.app.test_client()
        self.assertEqual(client.get("/app.py").status_code, 404)
        self.assertEqual(client.get("/instance/aquasupply.sqlite3").status_code, 404)
        self.assertIn("no-store", self.admin.get("/api/data").headers["Cache-Control"])

    def test_browser_setup_creates_only_the_first_administrator(self):
        setup_database = Path(self.temp_dir.name) / "setup.sqlite3"
        setup_app = create_app(database_path=setup_database, secret_key="first-setup-test-key")
        setup_app.config.update(TESTING=True)
        client = setup_app.test_client()
        session_response = client.get("/api/session")
        self.assertTrue(session_response.get_json()["setupRequired"])

        response = client.post(
            "/api/setup/administrator",
            json={
                "name": "First Admin",
                "email": "first-admin@example.test",
                "password": PASSWORD,
            },
            headers={"X-CSRF-Token": session_response.get_json()["csrfToken"]},
        )
        self.assertEqual(response.status_code, 201, response.get_json())
        self.assertEqual(response.get_json()["user"]["role"], "admin")
        self.assertFalse(client.get("/api/session").get_json()["setupRequired"])

        late_setup = setup_app.test_client()
        csrf = late_setup.get("/api/session").get_json()["csrfToken"]
        second_response = late_setup.post(
            "/api/setup/administrator",
            json={
                "name": "Second Admin",
                "email": "second-admin@example.test",
                "password": PASSWORD,
            },
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(second_response.status_code, 409)


if __name__ == "__main__":
    unittest.main()
