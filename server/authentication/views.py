import jwt
from bson import ObjectId
from bson.errors import InvalidId
from django.conf import settings
from drf_spectacular.utils import extend_schema
from rest_framework.generics import GenericAPIView
from rest_framework import status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework import serializers

from authentication.serializers import (
    LoginSerializer,
    RefreshSerializer,
    RegisterSerializer,
    CollegeAdminCreateSerializer,
    AccessTokenSerializer,
    TokenPairSerializer,
    DashboardSessionSerializer,
    RegistrationEmailCodeSerializer,
    RegistrationEmailSerializer,
    RegistrationPendingSerializer,
    ReferralCodeSerializer,
    UsernameAvailabilitySerializer,
)
from authentication.services import (
    authenticate_user,
    get_google_hustler,
    register_google_hustler,
    create_user,
    consume_registration_email_verification,
    issue_token_pair,
    refresh_access_token,
    create_privileged_user,
    send_registration_email_code,
    verify_registration_email_code,
    EmailVerificationConfigurationError,
    EmailVerificationDeliveryError,
    EmailVerificationRateLimitError,
    HustlerAccessDenied,
    HustlerAccountNotFound,
    GoogleHustlerAccountConflict,
)
from authentication.approval import hustler_access_error, normalize_account_type
from authentication.permissions import IsMainAdmin
from core.mongo import serialize_document
from core.mongodb import collection
from core.serializers import UserSummarySerializer
from authentication.google_oauth import (
    GoogleOAuthConfigurationError,
    GoogleOAuthError,
    GoogleOAuthProviderError,
    authenticate_google_authorization_code,
)


class GoogleLoginSerializer(serializers.Serializer):
    code = serializers.CharField(max_length=4096, trim_whitespace=True)
    role = serializers.ChoiceField(choices=("student",), required=False, default="student")


class RegisterView(GenericAPIView):
    serializer_class = RegisterSerializer
    authentication_classes = []
    permission_classes = [AllowAny]

    @extend_schema(
        request=RegisterSerializer,
        responses={201: RegistrationPendingSerializer},
    )
    def post(self, request):
        serializer = RegisterSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            data = dict(serializer.validated_data)
            data.pop("fullName", None)
            data.pop("confirmPassword", None)
            data.pop("role", None)
            data.pop("accountType", None)
            referral_code = data.pop("referralCode", "").strip()
            if referral_code:
                return Response(
                    {
                        "message": (
                            "Referral-code registration is not available in the Django backend yet. "
                            "Remove the referral code to continue."
                        )
                    },
                    status=status.HTTP_501_NOT_IMPLEMENTED,
                )
            verification_token = data.pop("emailVerificationToken")
            data["registration_details"] = data.pop("registrationDetails", None)
            if collection("users").find_one({"username": data["username"]}):
                return Response(
                    {"message": "This username is already in use."},
                    status=status.HTTP_409_CONFLICT,
                )
            if not consume_registration_email_verification(data["email"], verification_token):
                return Response(
                    {"message": "Verify this email address before creating an account."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            user = create_user(**data)
        except ValueError as exc:
            return Response({"message": str(exc)}, status=status.HTTP_409_CONFLICT)
        except EmailVerificationConfigurationError as exc:
            return Response({"message": str(exc)}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        except EmailVerificationDeliveryError as exc:
            return Response({"message": str(exc)}, status=status.HTTP_502_BAD_GATEWAY)
        return Response(
            {
                "message": "Your Hustler account was created and is awaiting administrator approval.",
                "user": public_user(user),
            },
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
        user = authenticate_user(
            email=serializer.validated_data["identifier"],
            password=serializer.validated_data["password"],
        )
        if user is None:
            return Response(
                {"message": "Invalid email or password."},
                status=status.HTTP_401_UNAUTHORIZED,
            )
        requested_role = serializer.validated_data.get("role")
        if requested_role and user.get("role") != requested_role:
            return Response(
                {"message": "Invalid username/email or password."},
                status=status.HTTP_401_UNAUTHORIZED,
            )
        approval_error = hustler_access_error(user)
        if approval_error:
            return Response({"message": approval_error}, status=status.HTTP_403_FORBIDDEN)
        try:
            pair = issue_token_pair(user)
        except HustlerAccessDenied as exc:
            return Response({"message": str(exc)}, status=status.HTTP_403_FORBIDDEN)
        return Response(
            {
                "user": public_user(user),
                "token": pair["access"],
                "access": pair["access"],
                "refresh": pair["refresh"],
                "tokenType": pair.get("token_type", "Bearer"),
                "token_type": pair.get("token_type", "Bearer"),
                "expiresIn": pair.get("expires_in", 0),
            }
        )


class GoogleOAuthView(GenericAPIView):
    serializer_class = GoogleLoginSerializer
    authentication_classes = []
    permission_classes = [AllowAny]

    def _verified_identity(self, request):
        if request.headers.get("X-Requested-With", "").lower() != "xmlhttprequest":
            return None, Response(
                {"message": "Google sign-in request could not be verified."},
                status=status.HTTP_403_FORBIDDEN,
            )

        origin = request.headers.get("Origin", "")
        if origin not in settings.CORS_ALLOWED_ORIGINS:
            return None, Response(
                {"message": "Google sign-in origin is not allowed."},
                status=status.HTTP_403_FORBIDDEN,
            )

        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            identity = authenticate_google_authorization_code(
                serializer.validated_data["code"],
                redirect_uri=origin,
            )
        except GoogleOAuthConfigurationError as exc:
            return None, Response({"message": str(exc)}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        except GoogleOAuthError as exc:
            return None, Response({"message": str(exc)}, status=status.HTTP_401_UNAUTHORIZED)
        except GoogleOAuthProviderError as exc:
            return None, Response({"message": str(exc)}, status=status.HTTP_502_BAD_GATEWAY)
        return identity, None


class GoogleLoginView(GoogleOAuthView):
    @extend_schema(request=GoogleLoginSerializer, responses=TokenPairSerializer)
    def post(self, request):
        identity, error_response = self._verified_identity(request)
        if error_response:
            return error_response
        try:
            user = get_google_hustler(identity)
        except HustlerAccountNotFound as exc:
            return Response({"message": str(exc)}, status=status.HTTP_404_NOT_FOUND)
        except (HustlerAccessDenied, GoogleHustlerAccountConflict) as exc:
            return Response({"message": str(exc)}, status=status.HTTP_403_FORBIDDEN)

        try:
            pair = issue_token_pair(user)
        except HustlerAccessDenied as exc:
            return Response({"message": str(exc)}, status=status.HTTP_403_FORBIDDEN)
        return Response(
            {
                "user": public_user(user),
                "token": pair["access"],
                "access": pair["access"],
                "refresh": pair["refresh"],
                "tokenType": pair.get("token_type", "Bearer"),
                "token_type": pair.get("token_type", "Bearer"),
                "expiresIn": pair.get("expires_in", 0),
            }
        )


class GoogleRegistrationView(GoogleOAuthView):
    @extend_schema(
        request=GoogleLoginSerializer,
        responses={201: RegistrationPendingSerializer},
    )
    def post(self, request):
        identity, error_response = self._verified_identity(request)
        if error_response:
            return error_response
        try:
            user = register_google_hustler(identity)
        except HustlerAccessDenied as exc:
            return Response({"message": str(exc)}, status=status.HTTP_403_FORBIDDEN)
        except GoogleHustlerAccountConflict as exc:
            return Response({"message": str(exc)}, status=status.HTTP_409_CONFLICT)
        except ValueError as exc:
            return Response({"message": str(exc)}, status=status.HTTP_409_CONFLICT)
        return Response(
            {
                "message": "Your Hustler account was created and is awaiting administrator approval.",
                "user": public_user(user),
            },
            status=status.HTTP_201_CREATED,
        )


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
            payload = jwt.decode(
                serializer.validated_data["refresh"],
                settings.SECRET_KEY,
                algorithms=["HS256"],
            )
            user = collection("users").find_one({"_id": ObjectId(payload["sub"])})
        except (jwt.InvalidTokenError, InvalidId, KeyError, TypeError, ValueError):
            return Response(
                {"detail": "Invalid or expired refresh token."},
                status=status.HTTP_401_UNAUTHORIZED,
            )
        if not user:
            return Response({"detail": "Invalid or expired refresh token."}, status=status.HTTP_401_UNAUTHORIZED)
        if hustler_access_error(user):
            return Response(
                {"detail": "Invalid or expired refresh token."},
                status=status.HTTP_401_UNAUTHORIZED,
            )
        return Response(
            {
                "user": public_user(user),
                "token": access,
                "access": access,
                "refresh": serializer.validated_data["refresh"],
                "tokenType": "Bearer",
                "token_type": "Bearer",
            }
        )


class MeView(GenericAPIView):
    serializer_class = UserSummarySerializer
    permission_classes = [IsAuthenticated]

    @extend_schema(responses=UserSummarySerializer)
    def get(self, request):
        return Response(public_user(request.user))


class UsernameAvailabilityView(GenericAPIView):
    serializer_class = UsernameAvailabilitySerializer
    authentication_classes = []
    permission_classes = [AllowAny]

    def get(self, request):
        serializer = self.get_serializer(data=request.query_params)
        serializer.is_valid(raise_exception=True)
        username = serializer.validated_data["username"].strip().lower()
        users = collection("users")
        available = users.find_one({"username": username}) is None
        suggestions = []
        if not available:
            base = username[:26]
            for suffix in range(1, 100):
                candidate = f"{base}{suffix}"
                if users.find_one({"username": candidate}) is None:
                    suggestions.append(candidate)
                if len(suggestions) == 3:
                    break
        return Response({"available": available, "suggestions": suggestions})


class RegistrationEmailSendView(GenericAPIView):
    serializer_class = RegistrationEmailSerializer
    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            retry_after = send_registration_email_code(
                serializer.validated_data["email"]
            )
        except EmailVerificationConfigurationError as exc:
            return Response({"message": str(exc)}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        except EmailVerificationDeliveryError as exc:
            return Response({"message": str(exc)}, status=status.HTTP_502_BAD_GATEWAY)
        except EmailVerificationRateLimitError as exc:
            return Response(
                {"message": str(exc), "retryAfterSeconds": exc.retry_after_seconds},
                status=status.HTTP_429_TOO_MANY_REQUESTS,
            )
        except ValueError as exc:
            return Response({"message": str(exc)}, status=status.HTTP_409_CONFLICT)
        return Response(
            {
                "message": "A verification code has been sent to your email.",
                "retryAfterSeconds": retry_after,
            }
        )


class RegistrationEmailVerifyView(GenericAPIView):
    serializer_class = RegistrationEmailCodeSerializer
    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            token = verify_registration_email_code(
                serializer.validated_data["email"],
                serializer.validated_data["code"],
            )
        except ValueError as exc:
            return Response({"message": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(
            {
                "message": "Email verified successfully.",
                "emailVerificationToken": token,
            }
        )


class DashboardSessionView(GenericAPIView):
    serializer_class = DashboardSessionSerializer
    permission_classes = [IsAuthenticated]

    def get(self, request, role):
        if role not in {"student", "main_admin", "college_admin"}:
            return Response(
                {"message": "Dashboard role is invalid."},
                status=status.HTTP_404_NOT_FOUND,
            )
        if request.user.role != role:
            return Response(
                {"message": "This account does not match the selected dashboard role."},
                status=status.HTTP_403_FORBIDDEN,
            )
        return Response({"user": public_user(request.user)})


class ReferralValidationUnavailableView(GenericAPIView):
    serializer_class = ReferralCodeSerializer
    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        return Response(
            {
                "message": (
                    "Referral-code validation is not available in the Django backend yet."
                )
            },
            status=status.HTTP_501_NOT_IMPLEMENTED,
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
    if isinstance(user, dict):
        document = serialize_document(user)
    else:
        document = {
            "id": user.id,
            "name": user.name,
            "email": user.email,
            "role": user.role,
            "accountType": getattr(user, "account_type", None),
            "studentType": getattr(user, "student_type", None),
            "status": getattr(user, "status", "active"),
            "approvalStatus": getattr(user, "approval_status", None),
            "isActive": getattr(user, "is_active", True),
            "username": getattr(user, "username", None),
            "collegeId": getattr(user, "college_id", None),
        }
    document.pop("password_hash", None)
    return {
        "id": document["id"],
        "name": document.get("name") or document.get("fullName", ""),
        "fullName": document.get("fullName") or document.get("name", ""),
        "email": document["email"],
        "role": document["role"],
        "username": document.get("username"),
        "accountType": normalize_account_type(document),
        "studentType": document.get("studentType"),
        "status": document.get("status", "active"),
        "approvalStatus": document.get("approvalStatus"),
        "isActive": document.get("isActive", document.get("is_active", True)),
        "collegeId": document.get("collegeId") or document.get("college_id"),
    }
