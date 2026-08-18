"""
Compatibility layer for optional site_adapters integration.

When site_adapters is available, core engine uses its config system.
When not available, core engine uses built-in defaults and skips
site-specific configuration.

This module should be the ONLY place that imports site_adapters from
bookmarks/services/.
"""

import logging
import os

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Availability probe
# ---------------------------------------------------------------------------

_SITE_ADAPTERS_AVAILABLE: bool | None = None


def is_site_adapters_available() -> bool:
    global _SITE_ADAPTERS_AVAILABLE
    if _SITE_ADAPTERS_AVAILABLE is None:
        try:
            import site_adapters  # noqa: F401
            _SITE_ADAPTERS_AVAILABLE = True
        except ImportError:
            _SITE_ADAPTERS_AVAILABLE = False
            logger.info("site_adapters not available — using built-in defaults")
    return _SITE_ADAPTERS_AVAILABLE


# ---------------------------------------------------------------------------
# Config resolver (returns None when site_adapters unavailable)
# ---------------------------------------------------------------------------

def get_metadata_config(url: str, username: str = '') -> dict | None:
    if not is_site_adapters_available():
        return None
    from site_adapters.services.config.resolver import get_metadata_config
    return get_metadata_config(url, username=username)


def get_snapshot_config(url: str, username: str = '') -> dict | None:
    if not is_site_adapters_available():
        return None
    from site_adapters.services.config.resolver import get_snapshot_config
    return get_snapshot_config(url, username=username)


def get_reader_config(url: str, username: str = '') -> dict | None:
    if not is_site_adapters_available():
        return None
    from site_adapters.services.config.resolver import get_reader_config
    return get_reader_config(url, username=username)


# ---------------------------------------------------------------------------
# Execution log
# ---------------------------------------------------------------------------

def log_execution(**kwargs):
    if not is_site_adapters_available():
        return
    from site_adapters.services.execution_log import log_execution
    log_execution(**kwargs)


# ---------------------------------------------------------------------------
# Cookie helpers
# ---------------------------------------------------------------------------

def load_cookie_file(path: str) -> str | None:
    if not is_site_adapters_available():
        return None
    from site_adapters.services.auth.cookies import load_cookie_file
    return load_cookie_file(path)


def verify_and_refresh(cookie_config: dict, url: str, domain_key: str, context: dict) -> str | None:
    if not is_site_adapters_available():
        return None
    from site_adapters.services.auth.cookies import verify_and_refresh
    return verify_and_refresh(cookie_config, url, domain_key, context)


def get_cookie_for_domain(domain_key: str) -> str | None:
    if not is_site_adapters_available():
        return None
    from site_adapters.services.auth.cookies import get_cookie_for_domain
    return get_cookie_for_domain(domain_key)


def generate_temp_cookies_file(domain_key: str, cookie_str: str = '') -> str | None:
    if not is_site_adapters_available():
        return None
    from site_adapters.services.auth.cookies import generate_temp_cookies_file
    return generate_temp_cookies_file(domain_key, cookie_str=cookie_str)


# ---------------------------------------------------------------------------
# Script runner
# ---------------------------------------------------------------------------

def run_script(script_path: str, **kwargs):
    if not is_site_adapters_available():
        logger.warning("site_adapters not available, cannot run script: %s", script_path)
        return None
    from site_adapters.services.engine.script_runner import run_script
    return run_script(script_path, **kwargs)


# ---------------------------------------------------------------------------
# Browser fallback
# ---------------------------------------------------------------------------

def load_metadata_via_browser(url: str, username: str = '') -> dict | None:
    if not is_site_adapters_available():
        return None
    from site_adapters.services.engine.browser_fallback import load_metadata_via_browser
    return load_metadata_via_browser(url, username=username)


# ---------------------------------------------------------------------------
# Validators (built-in fallbacks when site_adapters unavailable)
# ---------------------------------------------------------------------------

_SINGLEFILE_ARGS_FALLBACK = frozenset({
    "--browser-cookies-file", "--browser-script", "--user-agent",
    "--http-proxy-server", "--http-header", "--browser-executable-path",
    "--browser-load-max-time", "--browser-wait-delay", "--browser-wait-until",
    "--remove-hidden-elements", "--remove-frames",
    "--load-deferred-images", "--dump-content", "--error-file",
    "--user-script-enabled", "--compress-CSS", "--compress-HTML",
})

_DEFUDDLE_PARAMS_FALLBACK = frozenset({
    "contentSelector", "removeExactSelectors", "removePartialSelectors",
    "removeHiddenElements", "removeLowScoring", "removeSmallImages",
    "removeImages", "standardize", "url", "markdown", "separateMarkdown",
    "debug", "language", "useAsync", "includeReplies", "profile",
})


def is_known_singlefile_arg(name: str) -> bool:
    if is_site_adapters_available():
        from site_adapters.services.config.validator import is_known_singlefile_arg
        return is_known_singlefile_arg(name)
    return name in _SINGLEFILE_ARGS_FALLBACK


def is_known_defuddle_param(name: str) -> bool:
    if is_site_adapters_available():
        from site_adapters.services.config.validator import is_known_defuddle_param
        return is_known_defuddle_param(name)
    return name in _DEFUDDLE_PARAMS_FALLBACK


# ---------------------------------------------------------------------------
# Built-in browser script path
# ---------------------------------------------------------------------------

def get_snapshot_browser_script_path() -> str:
    """Return path to the built-in snapshot browser script."""
    return os.path.join(os.path.dirname(__file__), 'static', 'snapshot_browser_script.js')
