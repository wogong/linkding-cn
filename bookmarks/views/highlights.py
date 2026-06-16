import urllib.parse
from collections import OrderedDict

from django.contrib.auth.decorators import login_required
from django.core.paginator import Paginator
from django.db.models import Count as DbCount, Q
from django.http import HttpResponseRedirect, JsonResponse
from django.shortcuts import render
from django.urls import reverse
from django.utils.translation import gettext_lazy as _

from bookmarks import queries
from bookmarks.models import Annotation
from bookmarks.type_defs import HttpRequest

PAGE_SIZE = 50  # fallback, actual value from user_profile.highlights_per_page

SORT_CHOICES = [
    ("date_created", _("Created ↓")),
    ("date_created_asc", _("Created ↑")),
    ("date_modified", _("Modified ↓")),
    ("date_modified_asc", _("Modified ↑")),
    ("random", _("Random")),
]

GROUP_CHOICES = [
    ("none", _("None")),
    ("bookmark", _("Bookmark")),
    ("domain", _("Domain")),
    ("color", _("Color")),
]

SCOPE_CHOICES = [
    ("", _("All")),
    ("highlight", _("Highlights")),
    ("note", _("Annotations")),
]

NOTE_FILTER_CHOICES = [
    ("", _("Off")),
    ("yes", _("Has")),
    ("no", _("Missing")),
]

COLOR_CSS_SOLID = {
    "yellow": "rgba(255,235,0,0.7)",
    "green": "rgba(0,200,83,0.7)",
    "blue": "rgba(66,165,245,0.7)",
    "pink": "rgba(236,64,122,0.7)",
    "primary": "var(--primary-color)",
}
COLOR_LABELS = dict(Annotation.COLOR_CHOICES)

DEFAULT_FILTERS = {
    "sort": "date_created",
    "group_by": "none",
    "scope": "",
    "note_filter": "",
    "colors": "",
}

PREFERENCE_KEYS = ["sort", "group_by", "scope", "note_filter", "colors"]


def _group_annotations(annotations, group_by):
    if group_by == "none":
        return [("", None, [], annotations)]
    groups = OrderedDict()
    for ann in annotations:
        if group_by == "bookmark":
            key = ann.bookmark_id
            label = ann.bookmark.resolved_title
        elif group_by == "domain":
            from urllib.parse import urlparse
            parsed = urlparse(ann.bookmark.url)
            key = parsed.netloc or ann.bookmark.url
            label = key
        elif group_by == "color":
            key = ann.color
            label = COLOR_LABELS.get(ann.color, ann.color)
        else:
            key = "__all__"
            label = ""
        if key not in groups:
            groups[key] = {
                "label": label,
                "color_key": ann.color if group_by == "color" else None,
                "bookmark_id": ann.bookmark_id if group_by == "bookmark" else None,
                "annotations": [],
            }
        groups[key]["annotations"].append(ann)
    return [(g["label"], g.get("color_key"), g.get("bookmark_id"), g["annotations"]) for g in groups.values()]


def _parse_raw_filters(query_dict):
    """Parse filter values from a dict. No preference fallback — raw values only."""
    search_q = query_dict.get("q", "").strip()
    colors_raw = query_dict.get("colors", "").strip()
    colors = [c.strip() for c in colors_raw.split(",") if c.strip()] if colors_raw else []
    search_scope = query_dict.get("scope", "").strip()
    note_filter = query_dict.get("note_filter", "").strip()
    sort = query_dict.get("sort", "date_created").strip()
    group_by = query_dict.get("group_by", "none").strip()
    page_number = query_dict.get("page", "1")
    return {
        "search_q": search_q,
        "colors": colors,
        "search_scope": search_scope,
        "note_filter": note_filter,
        "sort": sort,
        "group_by": group_by,
        "page_number": page_number,
    }


def _merge_with_prefs(query_dict, prefs):
    """Merge URL params with saved preferences. URL params take precedence when key is present."""
    merged = {"q": query_dict.get("q", "")}
    for key in ["colors", "scope", "note_filter", "sort", "group_by"]:
        if key in query_dict:
            merged[key] = query_dict[key]
        elif key in prefs:
            merged[key] = prefs[key]
    merged["page"] = query_dict.get("page", "1")
    return merged


def _sort_to_orm(sort):
    return {
        "date_created": "-date_created",
        "date_created_asc": "date_created",
        "date_modified": "-date_modified",
        "date_modified_asc": "date_modified",
        "random": "random",
    }.get(sort, "-date_created")


def _filters_to_prefs(f):
    """Extract preference dict from parsed filters."""
    return {
        "sort": f["sort"],
        "group_by": f["group_by"],
        "scope": f["search_scope"],
        "note_filter": f["note_filter"],
        "colors": ",".join(f["colors"]),
    }


def _filters_to_query_params(f):
    """Build query params dict from filters (only non-default values)."""
    params = {}
    if f["search_q"]:
        params["q"] = f["search_q"]
    if f["colors"]:
        params["colors"] = ",".join(f["colors"])
    if f["search_scope"]:
        params["scope"] = f["search_scope"]
    if f["note_filter"]:
        params["note_filter"] = f["note_filter"]
    if f["sort"] and f["sort"] != "date_created":
        params["sort"] = f["sort"]
    if f["group_by"] and f["group_by"] != "none":
        params["group_by"] = f["group_by"]
    return params


@login_required
def index(request: HttpRequest):
    if request.method == "POST":
        # Filter form actions (save / apply)
        if "save" in request.POST:
            return _handle_save(request)
        if "apply" in request.POST:
            return _handle_apply(request)
        # Other actions (delete, update_note, etc.)
        return _handle_action(request)

    # GET: merge saved preferences with URL params (URL params take precedence)
    prefs = request.user_profile.highlights_search_preferences or {}
    merged = _merge_with_prefs(request.GET, prefs)
    f = _parse_raw_filters(merged)

    page_size = getattr(request.user_profile, "highlights_per_page", PAGE_SIZE) or PAGE_SIZE
    return _render_list(request, f, prefs, page_size)


def _render_list(request, f, prefs=None, page_size=PAGE_SIZE):
    orm_sort = _sort_to_orm(f["sort"])

    annotations = queries.query_annotations(
        user=request.user,
        search_q=f["search_q"],
        colors=f["colors"] or None,
        search_scope=f["search_scope"],
        note_filter=f["note_filter"],
        sort=orm_sort,
        group_by=f["group_by"],
    )

    paginator = Paginator(annotations, page_size)
    page = paginator.get_page(f["page_number"])
    groups = _group_annotations(page.object_list, f["group_by"])

    summary = annotations.aggregate(
        total_annotations=DbCount("id"),
        total_notes=DbCount("id", filter=Q(note_content__gt="")),
        total_bookmarks=DbCount("bookmark", distinct=True),
    )

    filtered_stats = annotations.values("color").annotate(count=DbCount("id"))
    filtered_color_map = {item["color"]: item["count"] for item in filtered_stats}
    color_stats = []
    for color_key, color_label in Annotation.COLOR_CHOICES:
        color_stats.append({
            "key": color_key,
            "label": color_label,
            "count": filtered_color_map.get(color_key, 0),
            "css_color": COLOR_CSS_SOLID.get(color_key, "var(--primary-color)"),
            "selected": color_key in f["colors"],
        })

    query_params = _filters_to_query_params(f)

    # Check if current filters differ from saved defaults
    effective_prefs = prefs if prefs else DEFAULT_FILTERS
    has_modified_filters = (
        f["search_q"] != ""
        or ",".join(f["colors"]) != effective_prefs.get("colors", "")
        or f["search_scope"] != effective_prefs.get("scope", "")
        or f["note_filter"] != effective_prefs.get("note_filter", "")
        or f["sort"] != effective_prefs.get("sort", "date_created")
        or f["group_by"] != effective_prefs.get("group_by", "none")
    )

    context = {
        "page_title": _("Highlights & Annotations - Linkding"),
        "annotations_page": page,
        "groups": groups,
        "search_q": f["search_q"],
        "colors": f["colors"],
        "colors_raw": ",".join(f["colors"]),
        "search_scope": f["search_scope"],
        "note_filter": f["note_filter"],
        "sort": f["sort"],
        "group_by": f["group_by"],
        "summary": summary,
        "color_stats": color_stats,
        "sort_choices": SORT_CHOICES,
        "group_choices": GROUP_CHOICES,
        "scope_choices": SCOPE_CHOICES,
        "note_filter_choices": NOTE_FILTER_CHOICES,
        "color_choices": Annotation.COLOR_CHOICES,
        "color_css_solid": COLOR_CSS_SOLID,
        "color_labels": COLOR_LABELS,
        "query_string": urllib.parse.urlencode(query_params),
        "has_modified_filters": has_modified_filters,
    }
    return render(request, "bookmarks/highlights/index.html", context)


def _handle_save(request):
    """Save current filter preferences to user profile, then redirect to base URL."""
    f = _parse_raw_filters(request.POST)
    request.user_profile.highlights_search_preferences = _filters_to_prefs(f)
    request.user_profile.save()
    return HttpResponseRedirect(reverse("linkding:bookmarks.highlights"))


def _handle_apply(request):
    """Apply filters: redirect to URL with ALL filter params (so prefs don't override)."""
    f = _parse_raw_filters(request.POST)
    base_url = reverse("linkding:bookmarks.highlights")
    params = urllib.parse.urlencode({
        "q": f["search_q"],
        "colors": ",".join(f["colors"]),
        "scope": f["search_scope"],
        "note_filter": f["note_filter"],
        "sort": f["sort"],
        "group_by": f["group_by"],
    })
    return HttpResponseRedirect(base_url + "?" + params)


def _handle_action(request: HttpRequest):
    action = request.POST.get("action", "")
    if action == "delete":
        return _action_delete_single(request)
    if action == "update_note":
        return _action_update_note(request)
    if action == "change_color":
        return _action_change_color_single(request)
    if action == "bulk_execute":
        return _action_bulk(request)
    return _redirect_back(request)


def _action_delete_single(request):
    ann_id = request.POST.get("annotation_id")
    ann = Annotation.objects.filter(pk=ann_id, bookmark__owner=request.user).first()
    if ann:
        ann.delete()
    if request.headers.get("X-Requested-With") == "XMLHttpRequest":
        return JsonResponse({"ok": True})
    return _redirect_back(request)


def _action_update_note(request):
    ann_id = request.POST.get("annotation_id")
    note = request.POST.get("note_content", "")
    ann = Annotation.objects.filter(pk=ann_id, bookmark__owner=request.user).first()
    if ann:
        ann.note_content = note
        ann.save(update_fields=["note_content", "date_modified"])
    if request.headers.get("X-Requested-With") == "XMLHttpRequest":
        return JsonResponse({"ok": True})
    return _redirect_back(request)


def _action_change_color_single(request):
    ann_id = request.POST.get("annotation_id")
    new_color = request.POST.get("new_color")
    ann = Annotation.objects.filter(pk=ann_id, bookmark__owner=request.user).first()
    if ann and new_color in dict(Annotation.COLOR_CHOICES):
        ann.color = new_color
        ann.save(update_fields=["color", "date_modified"])
    if request.headers.get("X-Requested-With") == "XMLHttpRequest":
        return JsonResponse({"ok": True})
    return _redirect_back(request)


def _action_bulk(request):
    bulk_action = request.POST.get("bulk_action", "")
    annotation_ids = request.POST.getlist("annotation_id")
    # Cross-page IDs from sessionStorage
    session_ids = request.POST.getlist("bulk_session_ids")
    if session_ids:
        annotation_ids = list(set(annotation_ids) | set(session_ids))
    select_across = request.POST.get("bulk_select_across") == "on"

    if select_across:
        f = _parse_raw_filters(request.POST)
        orm_sort = _sort_to_orm(f["sort"])
        qs = queries.query_annotations(
            user=request.user,
            search_q=f["search_q"],
            colors=f["colors"] or None,
            search_scope=f["search_scope"],
            note_filter=f["note_filter"],
            sort=orm_sort,
            group_by="none",
        )
        annotation_ids = list(qs.values_list("id", flat=True))

    if not annotation_ids:
        return _redirect_back(request)

    annotations = Annotation.objects.filter(
        pk__in=annotation_ids, bookmark__owner=request.user
    )

    if bulk_action == "bulk_delete":
        annotations.delete()
    elif bulk_action == "bulk_clear_note":
        annotations.update(note_content="")
    elif bulk_action == "bulk_change_color":
        new_color = request.POST.get("bulk_new_color", "")
        if new_color in dict(Annotation.COLOR_CHOICES):
            annotations.update(color=new_color)

    return _redirect_back(request)


def _redirect_back(request):
    return_url = request.POST.get("return_url", reverse("linkding:bookmarks.highlights"))
    return HttpResponseRedirect(return_url)
