"""Settings for browser tests that access Django from a live-server thread."""

# ruff: noqa

from .dev import *

# SQLite's shared in-memory test database reuses one connection across the
# test and live-server threads. Concurrent browser requests can corrupt Django
# transaction savepoints, so E2E tests use independent connections to a file.
DATABASES["default"]["TEST"] = {
    "NAME": os.path.join(BASE_DIR, "data", "test-e2e.sqlite3"),
}
