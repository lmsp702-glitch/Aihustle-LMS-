import os
from pathlib import Path

from dotenv import load_dotenv

SERVER_DIR = Path(__file__).resolve().parent.parent
BASE_DIR = SERVER_DIR
ENV_FILE = SERVER_DIR / ".env"
load_dotenv(dotenv_path=ENV_FILE)

SECRET_KEY = os.getenv("DJANGO_SECRET_KEY", "")
if not SECRET_KEY:
    raise RuntimeError("DJANGO_SECRET_KEY must be configured in the environment or .env.")

DEBUG = os.getenv("DEBUG", "False").lower() in {"1", "true", "yes"}
ALLOWED_HOSTS = [
    host.strip()
    for host in os.getenv("ALLOWED_HOSTS", "localhost,127.0.0.1").split(",")
    if host.strip()
]

INSTALLED_APPS = [
    "django.contrib.contenttypes",
    "corsheaders",
    "rest_framework",
    "drf_spectacular",
    "core",
    "authentication",
    "student_api",
    "users",
    "colleges",
    "courses",
    "assignments",
    "submissions",
    "admin_api",
]

MIDDLEWARE = [
    "core.middleware.VideoUploadDiagnosticsMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.common.CommonMiddleware",
    "student_api.middleware.ApiJsonErrorMiddleware",
]

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "course_video_upload": {
            "format": "%(asctime)s %(levelname)s %(message)s",
        },
    },
    "handlers": {
        "course_video_upload_console": {
            "class": "logging.StreamHandler",
            "formatter": "course_video_upload",
        },
    },
    "loggers": {
        "course_video_upload": {
            "handlers": ["course_video_upload_console"],
            "level": "INFO",
            "propagate": False,
        },
    },
}

ROOT_URLCONF = "config.urls"
TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {"context_processors": []},
    }
]
WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

# Application data is accessed through PyMongo; Django's ORM is not used.
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": ":memory:",
    }
}

MONGODB_URI = os.getenv("MONGODB_URI", "")
MONGODB_DATABASE = os.getenv("MONGODB_DATABASE", "aihustle_lms")
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "").strip()
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "").strip()
CLOUDINARY_CLOUD_NAME = os.getenv("CLOUDINARY_CLOUD_NAME", "").strip()
CLOUDINARY_API_KEY = os.getenv("CLOUDINARY_API_KEY", "").strip()
CLOUDINARY_API_SECRET = os.getenv("CLOUDINARY_API_SECRET", "").strip()
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.8-flash").strip() or "gemini-3.8-flash"
GEMINI_FALLBACK_MODEL = os.getenv("GEMINI_FALLBACK_MODEL", "gemini-3.6-flash").strip() or "gemini-3.6-flash"

_gmail_user = os.getenv("GMAIL_USER", "").strip()
_gmail_app_password = os.getenv("GMAIL_APP_PASSWORD", "")
_email_from = os.getenv("EMAIL_FROM", "").strip()
_configured_email_host = os.getenv("EMAIL_HOST", "").strip()

EMAIL_BACKEND = "django.core.mail.backends.smtp.EmailBackend"
EMAIL_HOST = _configured_email_host or (
    "smtp.gmail.com" if _gmail_user and _gmail_app_password else ""
)
EMAIL_PORT = int((os.getenv("EMAIL_PORT") or "587").strip())
EMAIL_USE_TLS = os.getenv("EMAIL_USE_TLS", "True").lower() in {"1", "true", "yes"}
EMAIL_USE_SSL = os.getenv("EMAIL_USE_SSL", "False").lower() in {"1", "true", "yes"}
EMAIL_HOST_USER = os.getenv("EMAIL_HOST_USER", "").strip() or _gmail_user
EMAIL_HOST_PASSWORD = os.getenv("EMAIL_HOST_PASSWORD", "") or _gmail_app_password
DEFAULT_FROM_EMAIL = (
    os.getenv("DEFAULT_FROM_EMAIL", "").strip() or _email_from or EMAIL_HOST_USER
)
EMAIL_TIMEOUT = int((os.getenv("EMAIL_TIMEOUT") or "15").strip())

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "authentication.jwt.JWTAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
    ],
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_PARSER_CLASSES": ["rest_framework.parsers.JSONParser"],
    "UNAUTHENTICATED_USER": None,
}

SPECTACULAR_SETTINGS = {
    "TITLE": "AIHustle LMS API",
    "DESCRIPTION": "JSON REST API for the AIHustle learning management system.",
    "VERSION": "1.0.0",
    "SERVE_INCLUDE_SCHEMA": False,
}

CORS_ALLOWED_ORIGINS = ["http://localhost:5173"]
CORS_ALLOWED_ORIGINS.extend(
    origin.strip()
    for origin in os.getenv(
        "FRONTEND_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173",
    ).split(",")
    if origin.strip()
    and origin.strip() != "*"
    and origin.strip() not in CORS_ALLOWED_ORIGINS
)
CORS_ALLOW_CREDENTIALS = True

JWT_ACCESS_TOKEN_MINUTES = int(os.getenv("JWT_ACCESS_TOKEN_MINUTES", "30"))
JWT_REFRESH_TOKEN_DAYS = int(os.getenv("JWT_REFRESH_TOKEN_DAYS", "7"))

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
USE_TZ = True
TIME_ZONE = "UTC"
