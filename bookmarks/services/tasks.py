import functools
import gzip
import logging
import os
import random
import time
from collections.abc import Callable
from datetime import timedelta

import waybackpy
from django.conf import settings
from django.contrib.auth.models import User
from django.db.models import Q
from django.utils import timezone
from huey import crontab
from huey.contrib.djhuey import HUEY as huey
from huey.exceptions import TaskLockedException
from waybackpy.exceptions import TooManyRequestsError, WaybackError

from bookmarks.models import Bookmark, BookmarkAsset, UserProfile
from bookmarks.services import assets, favicon_loader, preview_image_loader
from bookmarks.services.website_loader import load_website_metadata
from bookmarks.utils import get_registrable_domain

logger = logging.getLogger(__name__)
HTML_SNAPSHOT_DISPATCHER_LOCK = huey.lock_task("html-snapshot-dispatcher-lock")


# Create custom decorator for Huey tasks that implements exponential backoff
# Taken from: https://huey.readthedocs.io/en/latest/guide.html#tips-and-tricks
# Retry 1: 60
# Retry 2: 240
# Retry 3: 960
# Retry 4: 3840
# Retry 5: 15360
def task(retries=5, retry_delay=15, retry_backoff=4):
    def deco(fn):
        @functools.wraps(fn)
        def inner(*args, **kwargs):
            task = kwargs.pop("task", None)
            try:
                return fn(*args, **kwargs)
            except TaskLockedException as exc:
                # Task locks are currently only used as workaround to enforce
                # running specific types of tasks (e.g. singlefile snapshots)
                # sequentially. In that case don't reduce the number of retries.
                if task is not None:
                    task.retries = retries
                raise exc
            except Exception as exc:
                if task is not None:
                    task.retry_delay *= retry_backoff
                raise exc

        return huey.task(retries=retries, retry_delay=retry_delay, context=True)(inner)

    return deco


def is_web_archive_integration_active(user: User) -> bool:
    background_tasks_enabled = not settings.LD_DISABLE_BACKGROUND_TASKS
    web_archive_integration_enabled = (
        user.profile.web_archive_integration
        == UserProfile.WEB_ARCHIVE_INTEGRATION_ENABLED
    )

    return background_tasks_enabled and web_archive_integration_enabled


def create_web_archive_snapshot(user: User, bookmark: Bookmark, force_update: bool):
    if is_web_archive_integration_active(user):
        _create_web_archive_snapshot_task(bookmark.id, force_update)


def _create_snapshot(bookmark: Bookmark):
    logger.info(f"Create new snapshot for bookmark. url={bookmark.url}...")
    archive = waybackpy.WaybackMachineSaveAPI(
        bookmark.url, settings.LD_DEFAULT_USER_AGENT, max_tries=1
    )
    archive.save()
    bookmark.web_archive_snapshot_url = archive.archive_url
    bookmark.save(update_fields=["web_archive_snapshot_url"])
    logger.info(f"Successfully created new snapshot for bookmark:. url={bookmark.url}")


@task()
def _create_web_archive_snapshot_task(bookmark_id: int, force_update: bool):
    try:
        bookmark = Bookmark.objects.get(id=bookmark_id)
    except Bookmark.DoesNotExist:
        return

    # Skip if snapshot exists and update is not explicitly requested
    if bookmark.web_archive_snapshot_url and not force_update:
        return

    # Create new snapshot
    try:
        _create_snapshot(bookmark)
        return
    except TooManyRequestsError:
        logger.error(
            f"Failed to create snapshot due to rate limiting. url={bookmark.url}"
        )
    except WaybackError as error:
        logger.error(
            f"Failed to create snapshot. url={bookmark.url}",
            exc_info=error,
        )


@task()
def _load_web_archive_snapshot_task(bookmark_id: int):
    # Loading snapshots from CDX API has been removed, keeping the task function
    # for now to prevent errors when huey tries to run the task
    pass


@task()
def _schedule_bookmarks_without_snapshots_task(user_id: int):
    # Loading snapshots from CDX API has been removed, keeping the task function
    # for now to prevent errors when huey tries to run the task
    pass


def is_favicon_feature_active(user: User) -> bool:
    background_tasks_enabled = not settings.LD_DISABLE_BACKGROUND_TASKS

    return background_tasks_enabled and user.profile.enable_favicons


def is_preview_feature_active(user: User) -> bool:
    return (
        user.profile.enable_preview_images and not settings.LD_DISABLE_BACKGROUND_TASKS
    )


def update_bookmark_favicon(bookmark: Bookmark, new_favicon_file: str):
    if new_favicon_file != bookmark.favicon_file:
        bookmark.favicon_file = new_favicon_file
        bookmark.save(update_fields=["favicon_file"])
        logger.info(
            f"Successfully updated favicon for bookmark. url={bookmark.url} icon={new_favicon_file}"
        )


def load_favicon(user: User, bookmark: Bookmark):
    if is_favicon_feature_active(user):
        cached_favicon = favicon_loader.get_cached_favicon(bookmark.url)
        if cached_favicon:
            update_bookmark_favicon(bookmark, cached_favicon.filename)
            if not cached_favicon.is_stale:
                return
        _load_favicon_task(bookmark.id)


def refresh_favicon(user: User, bookmark: Bookmark):
    if is_favicon_feature_active(user):
        _load_favicon_task(bookmark.id)


@task(retries=3)
def _load_favicon_task(bookmark_id: int):
    try:
        bookmark = Bookmark.objects.get(id=bookmark_id)
    except Bookmark.DoesNotExist:
        return

    logger.info(f"Refresh favicon for bookmark. url={bookmark.url}")

    new_favicon_file = favicon_loader.refresh_favicon(bookmark.url)
    update_bookmark_favicon(bookmark, new_favicon_file)


def schedule_bookmarks_without_favicons(user: User):
    if is_favicon_feature_active(user):
        _schedule_bookmarks_without_favicons_task(user.id)


@task()
def _schedule_bookmarks_without_favicons_task(user_id: int):
    user = User.objects.get(id=user_id)
    bookmarks = Bookmark.objects.filter(favicon_file__exact="", owner=user)

    # TODO: Implement bulk task creation
    for bookmark in bookmarks:
        load_favicon(user, bookmark)


def schedule_refresh_favicons(user: User):
    if is_favicon_feature_active(user) and settings.LD_ENABLE_REFRESH_FAVICONS:
        _schedule_refresh_favicons_task(user.id)


@task()
def _schedule_refresh_favicons_task(user_id: int):
    user = User.objects.get(id=user_id)
    bookmarks = Bookmark.objects.filter(owner=user)

    # TODO: Implement bulk task creation
    for bookmark in bookmarks:
        refresh_favicon(user, bookmark)


def load_preview_image(user: User, bookmark: Bookmark):
    if is_preview_feature_active(user):
        _load_preview_image_task(bookmark.id)


@task()
def delete_preview_image_temp_file(filepath: str):
    logger.debug(
        f"Followed temporary preview image file will be deleted after a while: {filepath}"
    )
    if os.path.exists(filepath):
        os.remove(filepath)
        logger.info(f"Deleted temporary preview image file: {filepath}")


@task()
def _load_preview_image_task(bookmark_id: int):
    try:
        bookmark = Bookmark.objects.get(id=bookmark_id)
    except Bookmark.DoesNotExist:
        return

    logger.info(f"Load preview image for bookmark. url={bookmark.url}")

    new_preview_image_file = preview_image_loader.load_preview_image(
        bookmark.url, bookmark
    )

    if new_preview_image_file != bookmark.preview_image_file:
        bookmark.preview_image_file = new_preview_image_file or ""
        bookmark.save(update_fields=["preview_image_file"])
        logger.info(
            f"Successfully updated preview image for bookmark. url={bookmark.url} preview_image_file={new_preview_image_file}"
        )


def schedule_bookmarks_without_previews(user: User):
    if is_preview_feature_active(user):
        _schedule_bookmarks_without_previews_task(user.id)


@task()
def _schedule_bookmarks_without_previews_task(user_id: int):
    user = User.objects.get(id=user_id)
    bookmarks = Bookmark.objects.filter(
        Q(preview_image_file__exact=""),
        owner=user,
    )

    # TODO: Implement bulk task creation
    for bookmark in bookmarks:
        try:
            _load_preview_image_task(bookmark.id)
        except Exception as exc:
            logging.exception(exc)


def refresh_metadata(bookmark: Bookmark):
    if not settings.LD_DISABLE_BACKGROUND_TASKS:
        _refresh_metadata_task(bookmark.id)


def schedule_metadata_enrichment(
    bookmark: Bookmark,
    overwrite: bool = False,
    ignore_cache: bool = True,
):
    if not settings.LD_DISABLE_BACKGROUND_TASKS:
        _enrich_metadata_task(
            bookmark.id,
            overwrite=overwrite,
            ignore_cache=ignore_cache,
        )


@task(retries=3)
def _enrich_metadata_task(
    bookmark_id: int,
    overwrite: bool = False,
    ignore_cache: bool = True,
):
    try:
        bookmark = Bookmark.objects.get(id=bookmark_id)
    except Bookmark.DoesNotExist:
        return

    logger.info(f"Enrich metadata for bookmark. url={bookmark.url}")

    metadata = load_website_metadata(bookmark.url, ignore_cache=ignore_cache)
    update_fields = []

    if (
        (overwrite or not bookmark.title)
        and metadata.title is not None
        and metadata.title != bookmark.title
    ):
        bookmark.title = metadata.title
        update_fields.append("title")

    if (
        (overwrite or not bookmark.description)
        and metadata.description is not None
        and metadata.description != bookmark.description
    ):
        bookmark.description = metadata.description
        update_fields.append("description")

    if (
        (overwrite or not bookmark.preview_image_remote_url)
        and metadata.preview_image
        and metadata.preview_image != bookmark.preview_image_remote_url
    ):
        bookmark.preview_image_remote_url = metadata.preview_image
        update_fields.append("preview_image_remote_url")

    if update_fields:
        bookmark.date_modified = timezone.now()
        update_fields.append("date_modified")
        bookmark.save(update_fields=update_fields)
        logger.info(f"Successfully enriched metadata for bookmark. url={bookmark.url}")


@task()
def _refresh_metadata_task(bookmark_id: int):
    try:
        bookmark = Bookmark.objects.get(id=bookmark_id)
    except Bookmark.DoesNotExist:
        return

    logger.info(f"Refresh metadata for bookmark. url={bookmark.url}")

    metadata = load_website_metadata(bookmark.url, ignore_cache=True)
    update_fields = []

    if metadata.title or metadata.title == "":
        bookmark.title = metadata.title
        update_fields.append("title")
    if metadata.description or metadata.description == "":
        bookmark.description = metadata.description
        update_fields.append("description")
    if metadata.preview_image:
        bookmark.preview_image_remote_url = metadata.preview_image
        update_fields.append("preview_image_remote_url")
    if metadata.url and metadata.url != bookmark.url:
        bookmark.url = metadata.url
        update_fields.append("url")
    bookmark.date_modified = timezone.now()

    bookmark.save(update_fields=update_fields)
    logger.info(f"Successfully refreshed metadata for bookmark. url={bookmark.url}")

    # 若url变动，则按需更新html快照
    if bookmark.owner.profile.enable_automatic_html_snapshots:
        pending_assets = BookmarkAsset.objects.filter(
            bookmark=bookmark, status=BookmarkAsset.STATUS_PENDING
        )
        if pending_assets.exists():  # 若有下载中的快照，则移除
            pending_assets.delete()

        create_html_snapshot(bookmark)


def is_html_snapshot_feature_active() -> bool:
    return settings.LD_ENABLE_SNAPSHOTS and not settings.LD_DISABLE_BACKGROUND_TASKS


def _kick_html_snapshot_dispatcher():
    _html_snapshot_dispatcher_task()


def _get_html_snapshot_cooldown_seconds(
    randint_func: Callable[[int, int], int] | None = None,
) -> int:
    min_seconds = settings.LD_SNAPSHOT_DOMAIN_COOLDOWN_MIN_SEC
    max_seconds = settings.LD_SNAPSHOT_DOMAIN_COOLDOWN_MAX_SEC
    if max_seconds < min_seconds:
        min_seconds, max_seconds = max_seconds, min_seconds

    randint = randint_func or random.randint
    return randint(min_seconds, max_seconds)


def _get_html_snapshot_dispatcher_tick_seconds() -> int:
    return max(settings.LD_SNAPSHOT_DISPATCHER_TICK_SEC, 1)


def _select_next_html_snapshot_asset(now, next_eligible_at: dict[str, object]):
    pending_assets = (
        BookmarkAsset.objects.filter(
            asset_type=BookmarkAsset.TYPE_SNAPSHOT,
            status=BookmarkAsset.STATUS_PENDING,
        )
        .select_related("bookmark")
        .order_by("-date_created", "-id")
    )

    next_wake_at = None
    for asset in pending_assets:
        domain = get_registrable_domain(asset.bookmark.url)
        eligible_at = next_eligible_at.get(domain)
        if eligible_at is None or eligible_at <= now:
            return asset, None
        if next_wake_at is None or eligible_at < next_wake_at:
            next_wake_at = eligible_at

    return None, next_wake_at


def _get_html_snapshot_dispatcher_sleep_seconds(now, next_wake_at) -> float:
    remaining_seconds = max((next_wake_at - now).total_seconds(), 0)
    if remaining_seconds == 0:
        return 0
    return min(remaining_seconds, _get_html_snapshot_dispatcher_tick_seconds())


def _run_html_snapshot_dispatcher_loop(
    now_func: Callable[[], object] | None = None,
    sleep_func: Callable[[float], None] | None = None,
    cooldown_func: Callable[[], int] | None = None,
):
    now_func = now_func or timezone.now
    sleep_func = sleep_func or time.sleep
    cooldown_func = cooldown_func or _get_html_snapshot_cooldown_seconds
    next_eligible_at: dict[str, object] = {}

    while True:
        now = now_func()
        asset, next_wake_at = _select_next_html_snapshot_asset(now, next_eligible_at)
        if asset is None:
            if next_wake_at is None:
                return
            sleep_seconds = _get_html_snapshot_dispatcher_sleep_seconds(
                now, next_wake_at
            )
            if sleep_seconds > 0:
                sleep_func(sleep_seconds)
            continue

        domain = get_registrable_domain(asset.bookmark.url)
        _create_html_snapshot_task(asset.id)
        next_eligible_at[domain] = now_func() + timedelta(seconds=cooldown_func())


@task(retries=0, retry_delay=0)
def _html_snapshot_dispatcher_task():
    try:
        with HTML_SNAPSHOT_DISPATCHER_LOCK:
            _run_html_snapshot_dispatcher_loop()
    except TaskLockedException:
        logger.debug("HTML snapshot dispatcher already running.")


def create_html_snapshot(bookmark: Bookmark):
    if not is_html_snapshot_feature_active():
        return

    asset = assets.create_snapshot_asset(bookmark)
    asset.save()
    _kick_html_snapshot_dispatcher()


def create_html_snapshots(bookmark_list: list[Bookmark]):
    if not is_html_snapshot_feature_active():
        return

    assets_to_create = []
    for bookmark in bookmark_list:
        asset = assets.create_snapshot_asset(bookmark)
        assets_to_create.append(asset)

    if not assets_to_create:
        return

    BookmarkAsset.objects.bulk_create(assets_to_create)
    _kick_html_snapshot_dispatcher()


# SingleFile does not support running multiple snapshot captures in parallel.
# Keep a periodic fallback that can re-kick the dispatcher if pending work was
# missed due to an interrupted worker or process restart.
@huey.periodic_task(crontab(minute="*"))
def _schedule_html_snapshots_task():
    if BookmarkAsset.objects.filter(
        asset_type=BookmarkAsset.TYPE_SNAPSHOT,
        status=BookmarkAsset.STATUS_PENDING,
    ).exists():
        _kick_html_snapshot_dispatcher()


def _create_html_snapshot_task(asset_id: int):
    try:
        asset = BookmarkAsset.objects.get(id=asset_id)
    except BookmarkAsset.DoesNotExist:
        return

    logger.info(f"Create HTML snapshot for bookmark. url={asset.bookmark.url}")

    try:
        assets.create_snapshot(asset)

        logger.info(
            f"Successfully created HTML snapshot for bookmark. url={asset.bookmark.url}"
        )
    except Exception as error:
        logger.error(
            f"Failed to HTML snapshot for bookmark. url={asset.bookmark.url}",
            exc_info=error,
        )


def create_missing_html_snapshots(user: User) -> int:
    if not is_html_snapshot_feature_active():
        return 0

    bookmarks_without_snapshots = Bookmark.objects.filter(owner=user).exclude(
        bookmarkasset__asset_type=BookmarkAsset.TYPE_SNAPSHOT,
        bookmarkasset__status__in=[
            BookmarkAsset.STATUS_PENDING,
            BookmarkAsset.STATUS_COMPLETE,
        ],
    )
    bookmarks_without_snapshots |= Bookmark.objects.filter(owner=user).exclude(
        bookmarkasset__asset_type=BookmarkAsset.TYPE_SNAPSHOT
    )

    create_html_snapshots(list(bookmarks_without_snapshots))

    return bookmarks_without_snapshots.count()


def create_article(bookmark: Bookmark) -> BookmarkAsset:
    """Create a pending article asset and queue the defuddle task."""
    from bookmarks.services.articles import create_article_asset_pending

    asset = create_article_asset_pending(bookmark)
    _create_article_task(asset.id)
    return asset


def create_html_articles(bookmark_list: list[Bookmark]):
    """Batch create pending article assets and queue defuddle tasks."""
    from bookmarks.services.articles import create_article_asset_pending

    for bookmark in bookmark_list:
        asset = create_article_asset_pending(bookmark)
        _create_article_task(asset.id)


def _load_snapshot_asset_html(snapshot: BookmarkAsset | None) -> str | None:
    """Load HTML content from a snapshot asset, or None if unavailable."""
    if (
        not snapshot
        or snapshot.status != BookmarkAsset.STATUS_COMPLETE
        or snapshot.content_type != BookmarkAsset.CONTENT_TYPE_HTML
        or not snapshot.file
    ):
        return None

    filepath = os.path.join(settings.LD_ASSET_FOLDER, snapshot.file)
    if not os.path.exists(filepath):
        return None

    try:
        if snapshot.gzip:
            with gzip.open(filepath, "rb") as f:
                return f.read().decode("utf-8")
        else:
            with open(filepath, encoding="utf-8") as f:
                return f.read()
    except Exception:
        logger.warning(
            f"Failed to read snapshot for bookmark. url={snapshot.bookmark.url}",
            exc_info=True,
        )
        return None


def _load_snapshot_html(bookmark: Bookmark) -> str | None:
    """Load HTML content from the bookmark's latest snapshot, or None if unavailable."""
    return _load_snapshot_asset_html(bookmark.latest_snapshot)


def _has_custom_snapshot_processor(url: str) -> bool:
    """Check if the domain has a custom snapshot processor configured."""
    from bookmarks.utils import search_config_for_domain

    settings_path = settings.LD_CUSTOM_SNAPSHOT_PROCESSOR_SETTINGS
    if not settings_path or not os.path.exists(settings_path):
        return False

    config = search_config_for_domain(url, settings_path)
    return config is not None


def _create_snapshot_for_article(
    bookmark: Bookmark,
) -> tuple[BookmarkAsset | None, str | None]:
    """Create a snapshot for article parsing and return its asset plus HTML content."""
    asset = assets.create_snapshot_asset(bookmark)
    asset.save()

    try:
        assets.create_snapshot(asset)
        asset.refresh_from_db()
        if asset.status == BookmarkAsset.STATUS_COMPLETE:
            return asset, _load_snapshot_asset_html(asset)
    except Exception:
        logger.warning(
            f"Failed to create snapshot for article. url={bookmark.url}",
            exc_info=True,
        )

    return asset, None


@task(retries=2)
def _create_article_task(asset_id: int):
    """Huey task: fetch page, run defuddle, save parsed article."""
    from bookmarks.services.articles import remove_article, save_article_content

    try:
        asset = BookmarkAsset.objects.get(id=asset_id)
    except BookmarkAsset.DoesNotExist:
        return

    # LIFO dedup: if a newer pending article exists for the same bookmark, skip
    newer_pending = BookmarkAsset.objects.filter(
        bookmark=asset.bookmark,
        asset_type=BookmarkAsset.TYPE_ARTICLE,
        status=BookmarkAsset.STATUS_PENDING,
        date_created__gt=asset.date_created,
    ).exists()
    if newer_pending:
        logger.info(
            f"Skipping stale article task (newer pending exists). url={asset.bookmark.url}"
        )
        remove_article(asset)
        return

    bookmark = asset.bookmark
    logger.info(f"Create article for bookmark. url={bookmark.url}")

    fallback_snapshot = None
    try:
        from bookmarks.services import reader_processor

        # 1. Try existing snapshot
        raw_html = _load_snapshot_html(bookmark)
        if raw_html:
            logger.info(f"Using existing snapshot. url={bookmark.url}")
            result = reader_processor.parse_html(raw_html, url=bookmark.url)
        elif _has_custom_snapshot_processor(bookmark.url):
            # 2. Custom snapshot_processor → create snapshot first, then parse
            logger.info(f"Creating snapshot via custom processor. url={bookmark.url}")
            _snapshot, raw_html = _create_snapshot_for_article(bookmark)
            if not raw_html:
                raise Exception("Failed to create snapshot via custom processor")
            result = reader_processor.parse_html(raw_html, url=bookmark.url)
        else:
            # 3. No snapshot, no custom processor → let defuddle fetch URL directly.
            # If that fails, retry once from a freshly generated snapshot.
            logger.info(f"Parsing URL directly with defuddle. url={bookmark.url}")
            try:
                result = reader_processor.parse_url(bookmark.url)
            except Exception as direct_error:
                logger.info(
                    f"Direct article parsing failed; retrying via generated snapshot. url={bookmark.url}",
                    exc_info=True,
                )
                fallback_snapshot, raw_html = _create_snapshot_for_article(bookmark)
                if not raw_html:
                    raise Exception(
                        "Failed to create fallback snapshot for article"
                    ) from direct_error
                result = reader_processor.parse_html(raw_html, url=bookmark.url)

        # 生成标准 HTML 文档：元数据放 head，正文放 body
        from django.utils.html import escape
        content = result["content"]
        head_parts = []
        if result.get("title"):
            head_parts.append(f'<meta name="title" content="{escape(result["title"])}">')
        if result.get("wordCount"):
            head_parts.append(f'<meta name="word-count" content="{result["wordCount"]}">')
        head = "".join(head_parts)
        title_tag = f"<title>{escape(result['title'])}</title>" if result.get("title") else ""
        content = f"<!DOCTYPE html><html><head>{title_tag}{head}</head><body>{content}</body></html>"

        # Save parsed content
        save_article_content(asset, content, title=result["title"])

        logger.info(f"Successfully created article for bookmark. url={bookmark.url}")
    except Exception as error:
        if fallback_snapshot:
            try:
                assets.remove_asset(fallback_snapshot)
            except Exception:
                logger.warning(
                    f"Failed to clean up generated snapshot after article failure. url={bookmark.url}",
                    exc_info=True,
                )
        try:
            remove_article(asset)
        except Exception:
            logger.warning(
                f"Failed to clean up article asset after processing failure. url={bookmark.url}",
                exc_info=True,
            )
        logger.error(
            f"Failed to create article for bookmark. url={bookmark.url}",
            exc_info=error,
        )
