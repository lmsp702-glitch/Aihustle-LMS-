from django.urls import path

from submissions.views import SubmissionDetailView, SubmissionListView

urlpatterns = [
    path("", SubmissionListView.as_view(), name="submission-list"),
    path("<str:submission_id>/", SubmissionDetailView.as_view(), name="submission-detail"),
]
