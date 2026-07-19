import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("bookmarks", "0089_remove_bookmark_favicon_file"),
    ]

    operations = [
        migrations.CreateModel(
            name="RssSubscription",
            fields=[
                (
                    "id",
                    models.AutoField(
                        auto_created=True, primary_key=True, serialize=False, verbose_name="ID"
                    ),
                ),
                ("url", models.URLField(max_length=2048)),
                ("tags", models.JSONField(blank=True, default=list)),
                ("enabled", models.BooleanField(default=True)),
                ("etag", models.CharField(blank=True, max_length=512)),
                ("last_modified", models.CharField(blank=True, max_length=512)),
                ("last_checked", models.DateTimeField(blank=True, null=True)),
                ("last_error", models.TextField(blank=True)),
                ("date_added", models.DateTimeField(auto_now_add=True)),
                ("date_modified", models.DateTimeField(auto_now=True)),
                (
                    "owner",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="rss_subscriptions",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={"ordering": ["-date_added"]},
        ),
        migrations.AddConstraint(
            model_name="rsssubscription",
            constraint=models.UniqueConstraint(
                fields=("owner", "url"), name="unique_rss_subscription_per_user"
            ),
        ),
    ]
