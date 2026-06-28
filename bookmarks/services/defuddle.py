import json
import logging
import os
import subprocess
import tempfile

from django.conf import settings

logger = logging.getLogger(__name__)


class DefuddleError(Exception):
    pass


def _normalize_result(data: dict) -> dict:
    """统一 defuddle 输出格式。"""
    return {
        "title": data.get("title", ""),
        "content": data.get("content", ""),
        "description": data.get("description", ""),
        "author": data.get("author", ""),
        "site": data.get("site", ""),
        "wordCount": data.get("wordCount", 0),
    }


def _inject_base_tag(html_content: str, url: str) -> str:
    """注入 <base> 标签以便 defuddle 解析相对链接。"""
    if url and "<base " not in html_content:
        base_tag = f'<base href="{url}">'
        if "<head>" in html_content:
            html_content = html_content.replace("<head>", f"<head>{base_tag}", 1)
        elif "<head " in html_content:
            html_content = html_content.replace("<head", f"{base_tag}<head", 1)
        else:
            html_content = f"<head>{base_tag}</head>{html_content}"
    return html_content


def parse_html(html_content: str, url: str = "") -> dict:
    """
    Parse raw HTML with defuddle and return clean article content.

    Returns dict with keys: title, content, description, author, site, wordCount
    Raises DefuddleError on failure.
    """
    # Find defuddle CLI
    defuddle_bin = os.path.join(settings.BASE_DIR, "node_modules", ".bin", "defuddle")
    if not os.path.exists(defuddle_bin):
        raise DefuddleError(f"defuddle CLI not found at {defuddle_bin}")

    html_content = _inject_base_tag(html_content, url)

    # Write HTML to temp file
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".html", delete=False, encoding="utf-8"
    ) as tmp:
        tmp.write(html_content)
        tmp_path = tmp.name

    try:
        # Run defuddle parse
        cmd = [defuddle_bin, "parse", tmp_path, "--json"]

        env = os.environ.copy()
        env["LANG"] = "en_US.UTF-8"

        result = subprocess.run(
            cmd,
            capture_output=True,
            timeout=30,
            cwd=settings.BASE_DIR,
            env=env,
        )

        if result.returncode != 0:
            stderr = result.stderr.decode("utf-8", errors="replace")
            raise DefuddleError(
                f"defuddle exited with code {result.returncode}: {stderr}"
            )

        output = result.stdout.decode("utf-8").strip()
        if not output:
            raise DefuddleError("defuddle produced no output")

        return _normalize_result(json.loads(output))

    except json.JSONDecodeError as e:
        raise DefuddleError(f"Failed to parse defuddle output: {e}") from e
    except subprocess.TimeoutExpired as e:
        raise DefuddleError("defuddle timed out after 30s") from e
    finally:
        os.unlink(tmp_path)


def parse_url(url: str) -> dict:
    """
    Parse a URL directly with defuddle (defuddle handles fetching).
    Returns dict with keys: title, content, description, author, site, wordCount
    Raises DefuddleError on failure.
    """
    defuddle_bin = os.path.join(settings.BASE_DIR, "node_modules", ".bin", "defuddle")
    if not os.path.exists(defuddle_bin):
        raise DefuddleError(f"defuddle CLI not found at {defuddle_bin}")

    cmd = [defuddle_bin, "parse", url, "--json"]
    env = os.environ.copy()
    env["LANG"] = "en_US.UTF-8"

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            timeout=60,
            cwd=settings.BASE_DIR,
            env=env,
        )

        if result.returncode != 0:
            stderr = result.stderr.decode("utf-8", errors="replace")
            raise DefuddleError(
                f"defuddle exited with code {result.returncode}: {stderr}"
            )

        output = result.stdout.decode("utf-8").strip()
        if not output:
            raise DefuddleError("defuddle produced no output")

        return _normalize_result(json.loads(output))

    except json.JSONDecodeError as e:
        raise DefuddleError(f"Failed to parse defuddle output: {e}") from e
    except subprocess.TimeoutExpired as e:
        raise DefuddleError("defuddle timed out after 60s") from e
