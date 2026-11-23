import jwt
from bson.errors import InvalidId
from drf_spectacular.utils import extend_schema
from rest_framework.generics import GenericAPIView
from rest_framework import status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response

from authentication.serializers import (
    LoginSerializer,
    RefreshSerializer,
    RegisterSerializer,
    CollegeAdminCreateSerializer,
    AccessTokenSerializer,
    TokenPairSerializer,
)
from authentication.services import (
    authenticate_user,
    create_user,
    issue_token_pair,
    refresh_access_token,
    create_privileged_user,
)
from authentication.permissions import IsMainAdmin
from core.mongo import serialize_document
from core.serializers import UserSummarySerializer


class RegisterView(GenericAPIView):
    serializer_class = RegisterSerializer
    authentication_classes = []
    permission_classes = [AllowAny]

    @extend_schema(request=RegisterSerializer, responses={201: TokenPairSerializer})
    def post(self, request):
        serializer = RegisterSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            user = create_user(**serializer.validated_data)
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_409_CONFLICT)
        return Response(
            {"user": public_user(user), **issue_token_pair(user)},
            status=status.HTTP_201_CREATED,
        )


class LoginView(GenericAPIView):
    serializer_class = LoginSerializer
    authentication_classes = []
    permission_classes = [AllowAny]

    @extend_schema(request=LoginSerializer, responses=TokenPairSerializer)
    def post(self, request):
        serializer = LoginSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = authenticate_user(**serializer.validated_data)
        if user is None:
            return Response(
                {"detail": "Invalid email or password."},
                status=status.HTTP_401_UNAUTHORIZED,
            )
        return Response({"user": public_user(user), **issue_token_pair(user)})


class RefreshView(GenericAPIView):
    serializer_class = RefreshSerializer
    authentication_classes = []
    permission_classes = [AllowAny]

    @extend_schema(
        request=RefreshSerializer,
        responses=AccessTokenSerializer,
    )
    def post(self, request):
        serializer = RefreshSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            access = refresh_access_token(serializer.validated_data["refresh"])
        except (jwt.InvalidTokenError, InvalidId, KeyError, TypeError, ValueError):
            return Response(
                {"detail": "Invalid or expired refresh token."},
                status=status.HTTP_401_UNAUTHORIZED,
            )
        return Response({"access": access, "token_type": "Bearer"})


class MeView(GenericAPIView):
    serializer_class = UserSummarySerializer
    permission_classes = [IsAuthenticated]

    @extend_schema(responses=UserSummarySerializer)
    def get(self, request):
        return Response(
            {
                "id": request.user.id,
                "name": request.user.name,
                "email": request.user.email,
                "role": request.user.role,
            }
        )


class CollegeAdminCreateView(GenericAPIView):
    serializer_class = CollegeAdminCreateSerializer
    permission_classes = [IsAuthenticated, IsMainAdmin]

    @extend_schema(
        request=CollegeAdminCreateSerializer,
        responses={201: UserSummarySerializer},
    )
    def post(self, request):
        serializer = CollegeAdminCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            user = create_privileged_user(
                role="college_admin",
                **serializer.validated_data,
            )
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_409_CONFLICT)
        return Response(public_user(user), status=status.HTTP_201_CREATED)


def public_user(user):
    document = serialize_document(user)
    document.pop("password_hash", None)
    return {
        "id": document["id"],
        "name": document["name"],
        "email": document["email"],
        "role": document["role"],
    }
