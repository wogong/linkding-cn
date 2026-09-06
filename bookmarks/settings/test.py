"""
Test settings for linkding webapp.
Optimized for speed: in-memory database and task queue, minimal logging.
"""

# ruff: noqa

from .base import *

DEBUG = False

# In-memory database, eliminates file I/O
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": ":memory:",
    }
}

# Task tests enable immediate mode explicitly; views must not run dispatch loops.
HUEY = {
    **HUEY,
    "huey_class": "huey.MemoryHuey",
    "immediate": False,
    "connection": {},
}

# Disable background tasks
LD_DISABLE_BACKGROUND_TASKS = False

# Suppress logging
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"null": {"class": "logging.NullHandler"}},
    "root": {"handlers": ["null"], "level": "WARNING"},
}

# Static files (needed for template rendering)
STATICFILES_DIRS = [
    os.path.join(BASE_DIR, "bookmarks", "styles"),
]
