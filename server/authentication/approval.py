def is_external_user(user):
    return (
        isinstance(user, dict)
        and user.get("role") == "student"
        and user.get("accountType") == "external"
    )


def external_user_access_error(user):
    if not is_external_user(user):
        return None

    approval_status = str(user.get("approvalStatus") or "").strip().lower()
    account_status = str(user.get("status") or "").strip().lower()
    if approval_status == "rejected" or account_status == "rejected":
        return "This External User registration was rejected. Contact an administrator for assistance."
    if approval_status != "approved" or account_status == "pending":
        return "Your External User account is pending administrator approval."
    if not user.get("is_active", True):
        return "This External User account is inactive."
    return None
