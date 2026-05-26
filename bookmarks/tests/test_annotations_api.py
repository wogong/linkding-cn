from django.urls import reverse
from rest_framework import status

from bookmarks.models import Annotation, BookmarkAsset
from bookmarks.services import articles
from bookmarks.tests.helpers import BookmarkFactoryMixin, LinkdingApiTestCase


class AnnotationApiValidationTestCase(LinkdingApiTestCase, BookmarkFactoryMixin):
    def authenticate(self) -> None:
        self.api_token = self.setup_api_token()
        self.client.credentials(HTTP_AUTHORIZATION="Token " + self.api_token.key)

    def _selector(self, exact="test quote", start=1, end=9):
        return {
            "type": "TextQuoteSelector",
            "exact": exact,
            "prefix": "pre",
            "suffix": "suf",
            "start": start,
            "end": end,
        }

    def test_create_annotation_rejects_asset_from_different_bookmark(self):
        self.authenticate()

        bookmark1 = self.setup_bookmark(url="https://example.com/one")
        bookmark2 = self.setup_bookmark(url="https://example.com/two")
        article_asset_other = self.setup_asset(
            bookmark=bookmark2,
            asset_type=BookmarkAsset.TYPE_ARTICLE,
            content_type="text/html",
            status=BookmarkAsset.STATUS_COMPLETE,
            display_name="article-two",
        )

        url = reverse(
            "linkding:bookmark_annotation-list", kwargs={"bookmark_id": bookmark1.id}
        )
        response = self.post(
            url,
            {
                "article_asset": article_asset_other.id,
                "selector": self._selector(),
                "selected_text": "test quote",
                "color": Annotation.COLOR_YELLOW,
                "note_content": "",
            },
            expected_status_code=status.HTTP_400_BAD_REQUEST,
        )

        self.assertIn("article_asset", response.data)

    def test_create_annotation_rejects_non_article_asset_type(self):
        self.authenticate()

        bookmark = self.setup_bookmark(url="https://example.com/one")
        non_article_asset = self.setup_asset(
            bookmark=bookmark,
            asset_type=BookmarkAsset.TYPE_UPLOAD,
            content_type="image/png",
            status=BookmarkAsset.STATUS_COMPLETE,
            display_name="upload",
        )

        url = reverse(
            "linkding:bookmark_annotation-list", kwargs={"bookmark_id": bookmark.id}
        )
        response = self.post(
            url,
            {
                "article_asset": non_article_asset.id,
                "selector": self._selector(),
                "selected_text": "test quote",
                "color": Annotation.COLOR_YELLOW,
                "note_content": "",
            },
            expected_status_code=status.HTTP_400_BAD_REQUEST,
        )

        self.assertIn("article_asset", response.data)

    def test_create_annotation_rejects_snapshot_asset_type(self):
        self.authenticate()

        bookmark = self.setup_bookmark(url="https://example.com/snapshot")
        snapshot_asset = self.setup_asset(
            bookmark=bookmark,
            asset_type=BookmarkAsset.TYPE_SNAPSHOT,
            content_type="text/html",
            status=BookmarkAsset.STATUS_COMPLETE,
            display_name="snapshot-html",
        )

        url = reverse(
            "linkding:bookmark_annotation-list", kwargs={"bookmark_id": bookmark.id}
        )
        response = self.post(
            url,
            {
                "article_asset": snapshot_asset.id,
                "selector": self._selector("snapshot quote", 1, 14),
                "selected_text": "snapshot quote",
                "color": Annotation.COLOR_YELLOW,
                "note_content": "",
            },
            expected_status_code=status.HTTP_400_BAD_REQUEST,
        )

        self.assertIn("article_asset", response.data)

    def test_patch_snapshot_annotation_note_rejected(self):
        self.authenticate()

        bookmark = self.setup_bookmark(url="https://example.com/legacy")
        legacy_snapshot_asset = self.setup_asset(
            bookmark=bookmark,
            asset_type=BookmarkAsset.TYPE_SNAPSHOT,
            content_type="text/html",
            status=BookmarkAsset.STATUS_COMPLETE,
            display_name="legacy-snapshot",
        )
        annotation = Annotation.objects.create(
            bookmark=bookmark,
            article_asset=legacy_snapshot_asset,
            selector=self._selector("legacy quote", 1, 12),
            selected_text="legacy quote",
            color=Annotation.COLOR_YELLOW,
            note_content="before",
        )

        url = reverse("linkding:annotation-detail", kwargs={"pk": annotation.id})
        response = self.patch(
            url,
            {"note_content": "after"},
            expected_status_code=status.HTTP_400_BAD_REQUEST,
        )

        annotation.refresh_from_db()
        self.assertEqual(annotation.note_content, "before")
        self.assertIn("article_asset", response.data)

    def test_create_annotation_rejects_missing_article_asset(self):
        self.authenticate()

        bookmark = self.setup_bookmark(url="https://example.com/missing-article")

        url = reverse(
            "linkding:bookmark_annotation-list", kwargs={"bookmark_id": bookmark.id}
        )
        response = self.post(
            url,
            {
                "selector": self._selector(),
                "selected_text": "test quote",
                "color": Annotation.COLOR_YELLOW,
                "note_content": "",
            },
            expected_status_code=status.HTTP_400_BAD_REQUEST,
        )

        self.assertIn("article_asset", response.data)

    def test_delete_article_asset_preserves_annotation_as_orphan(self):
        bookmark = self.setup_bookmark(url="https://example.com/article")
        article_asset = self.setup_asset(
            bookmark=bookmark,
            asset_type=BookmarkAsset.TYPE_ARTICLE,
            content_type="text/html",
            status=BookmarkAsset.STATUS_COMPLETE,
            display_name="article",
        )
        annotation = Annotation.objects.create(
            bookmark=bookmark,
            article_asset=article_asset,
            selector=self._selector(),
            selected_text="test quote",
            color=Annotation.COLOR_YELLOW,
            note_content="before",
        )

        articles.remove_article(article_asset)

        annotation.refresh_from_db()
        self.assertIsNone(annotation.article_asset)
        self.assertEqual(annotation.note_content, "before")

    def test_patch_orphan_annotation_note_and_restore_article_asset(self):
        self.authenticate()

        bookmark = self.setup_bookmark(url="https://example.com/article")
        old_article = self.setup_asset(
            bookmark=bookmark,
            asset_type=BookmarkAsset.TYPE_ARTICLE,
            content_type="text/html",
            status=BookmarkAsset.STATUS_COMPLETE,
            display_name="old article",
        )
        new_article = self.setup_asset(
            bookmark=bookmark,
            asset_type=BookmarkAsset.TYPE_ARTICLE,
            content_type="text/html",
            status=BookmarkAsset.STATUS_COMPLETE,
            display_name="new article",
        )
        annotation = Annotation.objects.create(
            bookmark=bookmark,
            article_asset=old_article,
            selector=self._selector(),
            selected_text="test quote",
            color=Annotation.COLOR_YELLOW,
            note_content="before",
        )
        articles.remove_article(old_article)

        url = reverse("linkding:annotation-detail", kwargs={"pk": annotation.id})
        self.patch(
            url,
            {"note_content": "after"},
            expected_status_code=status.HTTP_200_OK,
        )
        self.patch(
            url,
            {
                "article_asset": new_article.id,
                "selector": self._selector("test quote", 4, 14),
                "selected_text": "test quote",
            },
            expected_status_code=status.HTTP_200_OK,
        )

        annotation.refresh_from_db()
        self.assertEqual(annotation.note_content, "after")
        self.assertEqual(annotation.article_asset, new_article)
        self.assertEqual(annotation.selector["start"], 4)
