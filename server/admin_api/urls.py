from django.urls import path

from admin_api.views import AdminDashboardView

urlpatterns = [
    path("dashboard/", AdminDashboardView.as_view(), name="admin-dashboard"),
]
