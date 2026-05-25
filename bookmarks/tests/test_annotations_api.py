from django.urls import reverse
from rest_framework import status

from bookmarks.models import Annotation, BookmarkAsset
from bookmarks.tests.helpers import BookmarkFactoryMixin, LinkdingApiTestCase


class AnnotationApiValidationTestCase(LinkdingApiTestCase, BookmarkFactoryMixin):
    def authenticate(self) -> None:
        self.api_token = self.setup_api_token()
        self.client.credentials(HTTP_AUTHORIZATION="Token " + self.api_token.key)

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
                "selector": {
                    "type": "TextQuoteSelector",
                    "exact": "test quote",
                    "prefix": "pre",
                    "suffix": "suf",
                    "start": 1,
                    "end": 9,
                },
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
                "selector": {
                    "type": "TextQuoteSelector",
                    "exact": "test quote",
                    "prefix": "pre",
                    "suffix": "suf",
                    "start": 1,
                    "end": 9,
                },
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
                "selector": {
                    "type": "TextQuoteSelector",
                    "exact": "snapshot quote",
                    "prefix": "pre",
                    "suffix": "suf",
                    "start": 1,
                    "end": 14,
                },
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
            selector={
                "type": "TextQuoteSelector",
                "exact": "legacy quote",
                "prefix": "pre",
                "suffix": "suf",
                "start": 1,
                "end": 12,
            },
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
