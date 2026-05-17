from fastapi import FastAPI
from app.routes import auth, users
from app.db import engine, Base

app = FastAPI(title="Demo API", version="0.1.0")

Base.metadata.create_all(bind=engine)

app.include_router(auth.router, prefix="/auth", tags=["auth"])
app.include_router(users.router, prefix="/users", tags=["users"])

@app.get("/health")
def health():
    return {"status": "ok"}
