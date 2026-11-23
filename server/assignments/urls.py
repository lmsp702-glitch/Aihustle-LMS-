from django.urls import path

from assignments.views import AssignmentDetailView, AssignmentListView

urlpatterns = [
    path("", AssignmentListView.as_view(), name="assignment-list"),
    path("<str:resource_id>/", AssignmentDetailView.as_view(), name="assignment-detail"),
]
