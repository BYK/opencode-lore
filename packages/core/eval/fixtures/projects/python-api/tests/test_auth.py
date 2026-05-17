from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

def test_register():
    resp = client.post("/auth/register", params={"email": "a@b.com", "password": "secret"})
    assert resp.status_code == 200
    assert resp.json()["email"] == "a@b.com"

def test_login_wrong_password():
    resp = client.post("/auth/login", params={"email": "a@b.com", "password": "wrong"})
    assert resp.status_code == 401

def test_health():
    resp = client.get("/health")
    assert resp.json() == {"status": "ok"}
