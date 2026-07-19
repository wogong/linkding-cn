"""Import RSS and Atom feeds into a user's bookmarks."""

import html
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from urllib.parse import urljoin, urlparse
from xml.etree import ElementTree

import requests
from django.utils import timezone

from bookmarks.models import (
    Bookmark,
    RssSubscription,
    build_tag_string,
    parse_tag_string,
)
from bookmarks.utils import normalize_url

logger = logging.getLogger(__name__)


class RssFeedError(Exception):
    """Raised when a feed cannot be downloaded or parsed."""


@dataclass
class FeedEntry:
    url: str
    title: str = ""
    description: str = ""
    date_added: datetime | None = None


def _local_name(element):
    return element.tag.rsplit("}", 1)[-1].lower()


def _child_text(element, name):
    for child in element:
        if _local_name(child) == name:
            return (child.text or "").strip()
    return ""


def _entry_link(element):
    # RSS uses a text link, while Atom generally uses a link/@href.
    self_link = ""
    for child in element:
        if _local_name(child) != "link":
            continue
        href = (child.attrib.get("href") or "").strip()
        rel = child.attrib.get("rel", "alternate")
        if href and rel == "alternate":
            return href
        if href and rel == "self":
            self_link = href
        text = (child.text or "").strip()
        if text:
            return text
    if self_link:
        return self_link
    return _child_text(element, "guid")


def _parse_date(value):
    if not value:
        return None
    try:
        parsed = parsedate_to_datetime(value)
    except (TypeError, ValueError, OverflowError):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except (TypeError, ValueError):
            return None
    if timezone.is_naive(parsed):
        parsed = timezone.make_aware(parsed, UTC)
    return parsed


def parse_feed(content, base_url=""):
    """Return entries from RSS 2.0, RSS 1.0, or Atom XML."""
    try:
        root = ElementTree.fromstring(content)
    except ElementTree.ParseError as exc:
        raise RssFeedError("The feed response is not valid XML") from exc

    entries = []
    candidates = [element for element in root.iter() if _local_name(element) in ("item", "entry")]
    for element in candidates:
        link = _entry_link(element)
        if not link:
            continue
        link = urljoin(base_url, html.unescape(link.strip()))
        parsed = urlparse(link)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            continue
        title = _child_text(element, "title")
        description = _child_text(element, "description") or _child_text(element, "summary")
        date_value = (
            _child_text(element, "pubdate")
            or _child_text(element, "published")
            or _child_text(element, "updated")
        )
        entries.append(
            FeedEntry(
                url=link,
                title=html.unescape(title),
                description=html.unescape(description),
                date_added=_parse_date(date_value),
            )
        )
    return entries


def _clean_tags(tags):
    if isinstance(tags, str):
        return parse_tag_string(tags)
    if not isinstance(tags, (list, tuple)):
        return []
    return parse_tag_string(",".join(str(tag) for tag in tags))


def sync_subscription(subscription: RssSubscription, timeout=(5, 30)):
    """Fetch one subscription and create any bookmarks that are not present.

    The return value is suitable for an API response and contains counts for
    newly-created and already-existing entries.
    """
    headers = {"User-Agent": "linkding-rss-import/1.0"}
    if subscription.etag:
        headers["If-None-Match"] = subscription.etag
    if subscription.last_modified:
        headers["If-Modified-Since"] = subscription.last_modified

    try:
        response = requests.get(subscription.url, headers=headers, timeout=timeout)
        if response.status_code == requests.codes.not_modified:
            subscription.last_checked = timezone.now()
            subscription.last_error = ""
            subscription.save(update_fields=["last_checked", "last_error", "date_modified"])
            return {"created": 0, "skipped": 0, "entries": 0, "not_modified": True}
        response.raise_for_status()
        entries = parse_feed(response.content, subscription.url)
    except (requests.RequestException, RssFeedError) as exc:
        subscription.last_checked = timezone.now()
        subscription.last_error = str(exc)[:4000]
        subscription.save(update_fields=["last_checked", "last_error", "date_modified"])
        raise RssFeedError(str(exc)) from exc

    if response.headers.get("ETag"):
        subscription.etag = response.headers["ETag"][:512]
    if response.headers.get("Last-Modified"):
        subscription.last_modified = response.headers["Last-Modified"][:512]

    tag_string = build_tag_string(_clean_tags(subscription.tags))
    from bookmarks.services import bookmarks

    created = skipped = 0
    for entry in entries:
        normalized_url = normalize_url(entry.url)
        if Bookmark.objects.filter(owner=subscription.owner, url_normalized=normalized_url).exists():
            skipped += 1
            continue
        bookmark = Bookmark(
            url=entry.url,
            title=entry.title,
            description=entry.description,
            date_added=entry.date_added,
        )
        bookmarks.create_bookmark(
            bookmark,
            tag_string,
            subscription.owner,
            disable_html_snapshot=True,
        )
        created += 1

    subscription.last_checked = timezone.now()
    subscription.last_error = ""
    subscription.save(
        update_fields=[
            "etag",
            "last_modified",
            "last_checked",
            "last_error",
            "date_modified",
        ]
    )
    return {"created": created, "skipped": skipped, "entries": len(entries), "not_modified": False}
