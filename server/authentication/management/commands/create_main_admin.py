import os

from django.core.management.base import BaseCommand, CommandError

from authentication.services import create_privileged_user
from core.mongodb import collection


class Command(BaseCommand):
    help = "Creates the single initial main_admin account using a one-time setup token."

    def add_arguments(self, parser):
        parser.add_argument("--name", required=True)
        parser.add_argument("--email", required=True)
        parser.add_argument("--password", required=True)
        parser.add_argument("--setup-token", required=True)

    def handle(self, *args, **options):
        configured_token = os.getenv("MAIN_ADMIN_SETUP_TOKEN", "")
        if not configured_token or configured_token == "replace-with-a-one-time-strong-random-token":
            raise CommandError("Configure MAIN_ADMIN_SETUP_TOKEN in the environment first.")
        if options["setup_token"] != configured_token:
            raise CommandError("Invalid main-admin setup token.")
        if collection("users").find_one({"role": "main_admin"}, {"_id": 1}):
            raise CommandError("A main_admin account already exists.")
        try:
            user = create_privileged_user(
                name=options["name"],
                email=options["email"],
                password=options["password"],
                role="main_admin",
            )
        except ValueError as exc:
            raise CommandError(str(exc)) from exc
        self.stdout.write(self.style.SUCCESS(f"Created main_admin account: {user['email']}"))
