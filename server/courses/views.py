from drf_spectacular.utils import extend_schema
from rest_framework.response import Response

from core.serializers import CourseSerializer
from core.views import MongoResourceView


class CourseListView(MongoResourceView):
    collection_name = "courses"
    serializer_class = CourseSerializer
    http_method_names = ["get", "post", "head", "options"]

    @extend_schema(operation_id="courses_list", responses=CourseSerializer(many=True))
    def get(self, request):
        response = super().get(request)
        if request.user.role != "student" or not isinstance(response.data, list):
            return response
        courses = []
        for item in response.data:
            status_value = str(item.get("status", "")).lower()
            if (
                item.get("published") is False
                or item.get("isPublished") is False
                or item.get("is_published") is False
                or status_value in {"draft", "unpublished", "inactive", "rejected", "archived"}
            ):
                continue
            item.setdefault("_id", item.get("id"))
            item.setdefault("title", item.get("name", "Course"))
            courses.append(item)
        return Response({"courses": courses})

    @extend_schema(
        operation_id="courses_create",
        request=CourseSerializer,
        responses={201: CourseSerializer},
    )
    def post(self, request):
        return super().post(request)


class CourseDetailView(CourseListView):
    http_method_names = ["get", "put", "patch", "delete", "head", "options"]

    @extend_schema(operation_id="courses_retrieve", responses=CourseSerializer)
    def get(self, request, resource_id):
        return super().get(request, resource_id)

    @extend_schema(
        operation_id="courses_replace",
        request=CourseSerializer,
        responses=CourseSerializer,
    )
    def put(self, request, resource_id):
        return super().put(request, resource_id)

    @extend_schema(
        operation_id="courses_update",
        request=CourseSerializer,
        responses=CourseSerializer,
    )
    def patch(self, request, resource_id):
        return super().patch(request, resource_id)

    @extend_schema(operation_id="courses_delete", responses={204: None})
    def delete(self, request, resource_id):
        return super().delete(request, resource_id)
