from drf_spectacular.utils import extend_schema

from core.serializers import CollegeSerializer
from core.views import MongoResourceView


class CollegeListView(MongoResourceView):
    collection_name = "colleges"
    serializer_class = CollegeSerializer
    http_method_names = ["get", "post", "head", "options"]

    @extend_schema(operation_id="colleges_list", responses=CollegeSerializer(many=True))
    def get(self, request):
        return super().get(request)

    @extend_schema(
        operation_id="colleges_create",
        request=CollegeSerializer,
        responses={201: CollegeSerializer},
    )
    def post(self, request):
        return super().post(request)


class CollegeDetailView(CollegeListView):
    http_method_names = ["get", "put", "patch", "delete", "head", "options"]

    @extend_schema(operation_id="colleges_retrieve", responses=CollegeSerializer)
    def get(self, request, resource_id):
        return super().get(request, resource_id)

    @extend_schema(
        operation_id="colleges_replace",
        request=CollegeSerializer,
        responses=CollegeSerializer,
    )
    def put(self, request, resource_id):
        return super().put(request, resource_id)

    @extend_schema(
        operation_id="colleges_update",
        request=CollegeSerializer,
        responses=CollegeSerializer,
    )
    def patch(self, request, resource_id):
        return super().patch(request, resource_id)

    @extend_schema(operation_id="colleges_delete", responses={204: None})
    def delete(self, request, resource_id):
        return super().delete(request, resource_id)
