import re

from rest_framework import serializers


class RegisterSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=150, required=False, allow_blank=True)
    fullName = serializers.CharField(max_length=150, required=False, allow_blank=True)
    username = serializers.CharField(max_length=30)
    email = serializers.EmailField()
    password = serializers.CharField(min_length=8, write_only=True, trim_whitespace=False)
    confirmPassword = serializers.CharField(write_only=True, trim_whitespace=False)
    role = serializers.CharField(required=False, default="student")
    accountType = serializers.ChoiceField(
        choices=("hustler", "independent", "external"),
        required=False,
        default="hustler",
    )
    referralCode = serializers.CharField(required=False, allow_blank=True)
    emailVerificationToken = serializers.CharField(write_only=True)
    registrationDetails = serializers.DictField(required=False)

    def validate(self, attrs):
        name = attrs.get("fullName") or attrs.get("name")
        if not name or not str(name).strip():
            raise serializers.ValidationError({"fullName": "Name is required."})
        attrs["name"] = str(name).strip()
        attrs["username"] = attrs["username"].strip().lower()
        if not re.fullmatch(r"[a-zA-Z0-9._-]{3,30}", attrs["username"]):
            raise serializers.ValidationError(
                {"username": "Use 3-30 letters, numbers, dots, underscores, or hyphens."}
            )
        if attrs.get("role") != "student":
            raise serializers.ValidationError({"role": "Public registration is only available for students."})
        attrs["accountType"] = "hustler"
        if attrs["confirmPassword"] != attrs["password"]:
            raise serializers.ValidationError({"confirmPassword": "Passwords do not match."})
        return attrs

    def validate_name(self, value):
        if not value.strip():
            raise serializers.ValidationError("Name is required.")
        return value.strip()

    def validate_email(self, value):
        return value.strip().lower()


class CollegeAdminCreateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=150)
    email = serializers.EmailField()
    password = serializers.CharField(min_length=8, write_only=True, trim_whitespace=False)

    def validate_name(self, value):
        if not value.strip():
            raise serializers.ValidationError("Name is required.")
        return value.strip()

    def validate_email(self, value):
        return value.strip().lower()


class LoginSerializer(serializers.Serializer):
    identifier = serializers.CharField(required=False)
    email = serializers.EmailField(required=False)
    role = serializers.ChoiceField(
        choices=("student", "main_admin", "college_admin"),
        required=False,
    )
    password = serializers.CharField(write_only=True, trim_whitespace=False)

    def validate(self, attrs):
        identifier = attrs.get("identifier") or attrs.get("email")
        if not identifier:
            raise serializers.ValidationError({"identifier": "Email or username is required."})
        attrs["email"] = str(identifier).strip().lower()
        attrs["identifier"] = str(identifier).strip().lower()
        return attrs


class UsernameAvailabilitySerializer(serializers.Serializer):
    username = serializers.RegexField(r"^[a-zA-Z0-9._-]{3,30}$", max_length=30)


class RegistrationEmailSerializer(serializers.Serializer):
    email = serializers.EmailField()

    def validate_email(self, value):
        return value.strip().lower()


class RegistrationEmailCodeSerializer(RegistrationEmailSerializer):
    code = serializers.RegexField(r"^\d{6}$", max_length=6)


class ReferralCodeSerializer(serializers.Serializer):
    code = serializers.CharField(max_length=64, trim_whitespace=True)


class RefreshSerializer(serializers.Serializer):
    refresh = serializers.CharField()


class TokenPairSerializer(serializers.Serializer):
    user = serializers.DictField()
    access = serializers.CharField()
    refresh = serializers.CharField()
    token_type = serializers.CharField()
    expires_in = serializers.IntegerField()


class RegistrationPendingSerializer(serializers.Serializer):
    message = serializers.CharField()
    user = serializers.DictField()


class AccessTokenSerializer(serializers.Serializer):
    access = serializers.CharField()
    token_type = serializers.CharField()


class DashboardSessionSerializer(serializers.Serializer):
    user = serializers.DictField()
