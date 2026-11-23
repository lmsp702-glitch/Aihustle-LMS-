HUSTLER_ACCOUNT_TYPES = {"hustler", "external", "independent"}


def is_hustler_account(user):
    return (
        isinstance(user, dict)
        and user.get("role") == "student"
        and user.get("studentType") != "college"
        and user.get("student_type") != "college"
        and (user.get("accountType") or user.get("account_type"))
        in HUSTLER_ACCOUNT_TYPES
    )


def normalize_account_type(user):
    if is_hustler_account(user):
        return "hustler"
    if not isinstance(user, dict):
        return None
    return user.get("accountType") or user.get("account_type")


def hustler_access_error(user):
    if not is_hustler_account(user):
        return None

    approval_status = str(user.get("approvalStatus") or "").strip().lower()
    account_status = str(user.get("status") or "").strip().lower()
    if approval_status == "rejected" or account_status == "rejected":
        return "This Hustler registration was rejected. Contact an administrator for assistance."
    if approval_status != "approved" or account_status == "pending":
        return "Your Hustler account is pending administrator approval."
    if not user.get("is_active", True):
        return "This Hustler account is inactive."
    return None
