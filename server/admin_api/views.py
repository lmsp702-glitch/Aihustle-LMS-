from rest_framework.permissions import IsAuthenticated
from rest_framework.generics import GenericAPIView
from rest_framework.response import Response

from core.mongodb import collection
from rest_framework import serializers


class DashboardSerializer(serializers.Serializer):
    users = serializers.IntegerField()
    colleges = serializers.IntegerField()
    courses = serializers.IntegerField()
    assignments = serializers.IntegerField()
    submissions = serializers.IntegerField()


class AdminDashboardView(GenericAPIView):
    serializer_class = DashboardSerializer
    permission_classes = [IsAuthenticated]

    def get(self, request):
        if request.user.role != "main_admin":
            return Response({"detail": "Administrator access is required."}, status=403)
        return Response(
            {
                "users": collection("users").count_documents({}),
                "colleges": collection("colleges").count_documents({}),
                "courses": collection("courses").count_documents({}),
                "assignments": collection("assignments").count_documents({}),
                "submissions": collection("submissions").count_documents({}),
            }
        )
