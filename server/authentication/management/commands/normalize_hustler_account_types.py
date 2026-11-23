from django.core.management.base import BaseCommand

from core.mongodb import collection


class Command(BaseCommand):
    help = "Safely normalize legacy student account types to hustler."

    def add_arguments(self, parser):
        parser.add_argument(
            "--apply",
            action="store_true",
            help="Update matching student documents; without this flag only report the count.",
        )

    def handle(self, *args, **options):
        query = {
            "role": "student",
            "studentType": {"$ne": "college"},
            "student_type": {"$ne": "college"},
            "$or": [
                {"accountType": {"$in": ["external", "independent"]}},
                {"account_type": {"$in": ["external", "independent"]}},
            ],
        }
        users = collection("users")
        count = users.count_documents(query)
        if not options["apply"]:
            self.stdout.write(
                f"Found {count} legacy Hustler account(s); no records were changed. "
                "Run again with --apply to normalize accountType."
            )
            return

        result = users.update_many(
            query,
            {"$set": {"accountType": "hustler", "account_type": "hustler"}},
        )
        self.stdout.write(
            self.style.SUCCESS(
                f"Normalized {result.modified_count} Hustler account type(s)."
            )
        )
