# AIHustle LMS backend

## Main Admin account

Add these values to `Server/.env` without committing the file:

```env
ADMIN_EMAIL=the-admin-email@example.com
ADMIN_PASSWORD=choose-a-long-unique-password
JWT_SECRET=use-a-random-secret-at-least-32-bytes-long
```

Keep the existing `MONGO_URI` entry pointed at the `LMS` database.
`MONGO_DB_NAME` can explicitly override the database name for isolated test
connections; otherwise, startup uses the database named in `MONGO_URI`.
`ADMIN_PASSWORD` must be at least 12 characters. Generate a JWT secret with:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Seed a Main Admin and start the API:

```sh
npm run seed:admin
npm run dev
```

The seed command creates a `main_admin` account in `admin`, reserves its login
identity in `accountidentities`, and bcrypt-hashes the password. It leaves an
existing account unchanged. Public registration is available only to independent students. New independent
student registrations remain pending
until approved by a Main Admin; the existing college onboarding flow is unchanged.
Independent-student registration requires a server-verified email address before
the account is created. The registration code is a six-digit Gmail OTP; codes
expire after 10 minutes, are stored as keyed hashes, and can be requested once
per minute. Verification is bound to the exact normalized email and is consumed
in the registration transaction.
After a pending independent student is approved and the database transaction
commits, the backend sends an AIHustle-branded confirmation to the student's
registered email. The message links to the frontend at `CLIENT_ORIGIN` and uses
its `/logo.png` asset. Approval-email delivery errors are logged without undoing
approval; only a successful pending-to-approved transition initiates that email.
Rejection email delivery uses the same Gmail SMTP service and is also attempted
only after the decision is saved.

## Account collections and roles

The application uses the database selected by `MONGO_URI` (currently `LMS`).

| Collection | Account/data |
|---|---|
| `admin` | Main Admin (`main_admin`) |
| `sub_admins` | College Sub-Admins (`college_admin`) |
| `students` | Independent Students (`student`, `studentType: "independent"`) |
| `clg_students` | College Students (`student`, `studentType: "college"`, with `collegeId`) |
| `colleges` | College details |
| `courses` | Courses, modules, and lessons |
| `enrollment` | Course enrollments |
| `supporttickets` | Student support requests, replies, status and priority history |
| `complaints` | Student complaints, Main Admin replies and Solved/Unsolved history |
| `feedback` | User feedback and Main Admin reply history |
| `accountidentities` | Normalized login identity-to-collection/document mappings |
| `referralCodes` | External User referral codes and redemption history |
| `referralCodeDailyLimits` | Atomic per-External-User UTC daily generation counters |

Authentication accepts only the `main_admin`, `college_admin`, and `student`
roles. JWTs include the canonical role and the account collection; identity
lookups use `accountidentities`. No `users` collection fallback is used by
authentication. A college has a unique code. Courses support modules, lessons,
assignments, and quizzes; correct quiz answers are not returned to students.
The `accountidentities` collection enforces global case-insensitive username
uniqueness across student and administrator account collections.

## Student feedback, complaints, and support tickets

Feedback and complaints are stored separately from each other and from support
tickets. Feedback records contain the submitting account reference, message,
reply history, and timestamps. Complaint records contain a backend-generated
`complaintId`, student reference, subject, category, description, status,
student name/ID/email snapshot, reply history, status history, and timestamps.
Support tickets continue to use the existing `supporttickets` collection and
API.

Students can create and read only their own feedback and complaints. Only the
Main Admin can list these records, reply to them, or change complaint status.
College Sub-Admins do not receive Feedback or Complaints access. Complaint
statuses are `Unsolved` and `Solved`; status changes are retained in each
record's history. Student views include the saved Main Admin replies.

| Method | Endpoint | Access |
|---|---|---|
| `POST` | `/api/feedback` | Authenticated student |
| `GET` | `/api/feedback/mine` | Authenticated student; own records |
| `GET` | `/api/feedback/admin` | Main Admin |
| `POST` | `/api/feedback/admin/:feedbackId/replies` | Main Admin |
| `POST` | `/api/complaints` | Authenticated student |
| `GET` | `/api/complaints/mine` | Authenticated student; own records |
| `GET` | `/api/complaints/admin` | Main Admin |
| `GET` | `/api/complaints/admin/:complaintId` | Main Admin |
| `POST` | `/api/complaints/admin/:complaintId/replies` | Main Admin |
| `PATCH` | `/api/complaints/admin/:complaintId/status` | Main Admin |

## External User referrals

External Users can generate up to five referral codes per UTC calendar day.
Generation requests are idempotent per authenticated user, and the per-day
counter and new code are written in a MongoDB transaction. Codes are generated
with Node.js cryptographic randomness and expire 15 days after creation.

The referral API is:

| Method | Endpoint | Access |
|---|---|---|
| `POST` | `/api/referrals/generate` | Authenticated External User |
| `GET` | `/api/referrals/me` | Authenticated External User |
| `POST` | `/api/referrals/validate` | Public registration validation |

`POST /api/auth/register` accepts an optional `referralCode`. Registration,
identity creation, and one-time referral redemption happen in the same MongoDB
transaction.
The `referralCodes` collection has unique code and per-user idempotency indexes,
owner/date history and expiry indexes. The daily-counter collection has a
unique owner/UTC-day index. Referral history is retained; no TTL index is used.
Referral history returns only whether the friend registered and their
registration status, not their account identifiers or profile data.

Independent-student referral registration remains pending until approved.
Referral registration status is derived from the referred account's current
approval/account status and is refreshed when the creator loads referral
history; the referral feature does not alter account approval.

## Database backup, integration tests, and reset

The integration test writes real test accounts and learning records only to
`LMS_TEST`, verifies each collection and login mapping, and drops that disposable
database after it finishes. It refuses to run if `LMS_TEST` is not empty.

```powershell
$env:LMS_BACKUP_DIR = 'C:\protected\backup\LMS-before-reset'
npm run backup:database
npm run test:database
npm run reset:database
```

The backup command connects explicitly to `LMS`, writes BSON collection data,
collection/index metadata, and a SHA-256 manifest to an empty directory, then
decodes the BSON and checks counts and hashes. Keep that directory protected;
it contains account data and password hashes.

`reset:database` is read-only and prints the exact current collection/count
deletion plan after checking the verified backup against the live database.
`reset:database:execute` is destructive: it drops only `LMS`, recreates the
application collections and indexes, and seeds only the configured Main Admin.
Do not run it until the backup is verified, the deletion list is reviewed, and
the reset is explicitly approved. The obsolete legacy reset utility has been
removed.

## College Sub-Admin activation

The Main Admin creates a College Sub-Admin without setting a password. The API
stores a hash of a random, single-use activation token and emails the activation
link. The sub-admin sets a password; only its bcrypt hash is stored. Tokens
expire after 24 hours and are invalidated on use. A pending invite can be
resent from the Colleges page.

Configure Gmail SMTP and the public frontend origin in `Server/.env` (or as
environment variables on Render):

```env
CLIENT_ORIGIN=https://your-frontend.example
EMAIL_PROVIDER=gmail
GMAIL_USER=your-gmail-address@gmail.com
GMAIL_APP_PASSWORD=your-google-app-password
EMAIL_FROM="AIHustle LMS <your-gmail-address@gmail.com>"
ADMIN_EMAIL=main-admin@example.com
```

`GMAIL_USER` is the Gmail mailbox used to authenticate, and `EMAIL_FROM` must
use that mailbox as the sender. Gmail sends through `smtp.gmail.com:587` with
STARTTLS required. `GMAIL_APP_PASSWORD` is a Google App Password, not the
regular Gmail password. Enable 2-Step Verification before creating it; enter
the app password without spaces. Keep it private, and never expose it to React
or commit it to source control.

Run `npm run test:email -- <first-controlled-email> <second-controlled-email>`
from `Server` to send registration-style test OTP messages to two different
addresses you control. The command refuses to run when `NODE_ENV=production`,
requires two distinct valid addresses, and never logs either OTP or SMTP
credentials. An SMTP acceptance confirms Gmail accepted the messages; check
both inboxes and spam folders to confirm delivery.

The shared Gmail email service sends registration verification and resend OTPs,
student two-factor codes, email-change verification, independent-student
approval/rejection notifications, college administrator activation,
support-ticket alerts to `ADMIN_EMAIL`, and registration confirmations.
Decision and registration email failures are logged without undoing the saved
database changes. SMTP error logs include error codes only, not provider error
messages, OTPs, passwords, or credentials.

## Student email changes

Student email changes require an 8-digit verification code sent to the new
address. The current email remains active until the code is verified; codes
expire after 15 minutes. This uses the Gmail settings above. Account identity
and student email records are updated together after verification.

## Student email two-factor authentication

Set the Gmail variables above in `Server/.env`; see `.env.example` for the
variable names. Email OTPs are random six-digit values, stored only as keyed
hashes, expire after five minutes, and are limited to five verification
attempts. Resending is limited to once per minute.

Students enable or disable two-factor authentication from Settings after
verifying a code sent to their registered email using Gmail SMTP. When enabled,
password and Google sign-in return a short-lived login challenge instead of an access token.
The normal JWT is issued only after successful OTP verification. The
`emailotpchallenges` collection uses a TTL index to remove expired challenge
records.

## Registration email verification

| Method | Endpoint | Access |
|---|---|---|
| `POST` | `/api/auth/registration/email/send` | Public, rate-limited |
| `POST` | `/api/auth/registration/email/verify` | Public, rate-limited |
| `POST` | `/api/auth/register` | Public; requires a verified-email token |

The public registration form sends a code to `/api/auth/registration/email/send`
with `{ "email": "..." }`, then verifies it at
`/api/auth/registration/email/verify` with the email and six-digit code. A
successful response contains a short-lived signed
`emailVerificationToken`; the registration endpoint validates that token and
atomically consumes its verified database record. A changed email requires a
new verification. Registration OTPs expire after 10 minutes, allow five
incorrect attempts and five requests per email per hour, and have a 60-second
resend cooldown plus IP-based rate limits. The
`registrationemailverifications` collection has a TTL cleanup index.
The existing optional referral code is still redeemed in the same registration
transaction.

## Main Admin course media

Configure `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and
`CLOUDINARY_API_SECRET` in `Server/.env`. Main Admin lesson media is uploaded
through authenticated Multer endpoints:

- `POST /api/admin/courses/:courseId/modules/:moduleId/media/video`
- `POST /api/admin/courses/:courseId/modules/:moduleId/media/resource`
- `POST /api/admin/course-assets/delete`

Videos accept MP4, M4V, MOV, WebM, OGV, AVI, or MKV, with a default 2 GiB limit.
PDF, PNG, JPEG, and WebP resources default to a 50 MiB limit. Set
`COURSE_VIDEO_MAX_BYTES` and `COURSE_RESOURCE_MAX_BYTES` to change those limits.
Uploads are validated by extension, MIME type, and file signature, streamed from
temporary files to Cloudinary, then removed from disk. MongoDB stores the
Cloudinary URLs, public IDs, media metadata, and embedded lesson timestamps;
video and resource bytes are never stored in MongoDB. Cloudinary assets are
deleted only after a course edit removes them and no course still references
their public ID. Thumbnail images continue to use a signed upload request.

## Main Admin AI quiz question generation

Set `GEMINI_API_KEY` in `Server/.env`. The key stays on the backend and is never
sent to the client. Authenticated Main Admins can request reviewable quiz
questions with `POST /api/admin/courses/generate-quiz-questions`:

```json
{
  "lessonContent": "Lesson text...",
  "questionCount": 5,
  "difficulty": "intermediate",
  "questionTypes": ["multiple-choice", "multiple-select", "true-false"]
}
```

`questionTypes` is optional and defaults to all supported types. The endpoint
returns structured question data, including answer indexes, without saving it
to a course or publishing it. Admins can review and edit the response before
using it in a quiz.

## AI assignment grading and human re-evaluation

Assignment submissions use the existing `assignment_submissions` collection and
the backend `GEMINI_API_KEY`. PDF, DOCX, TXT, JPEG, PNG, and WEBP files are
accepted up to 10 MB. DOCX text is extracted on the backend; PDF and image data
is sent to Gemini as inline file content. The API key is never sent to React.

An accepted submission is queued in MongoDB and graded by a backend worker,
independently of the student's browser. Temporary Gemini failures receive up
to three persisted automatic retries with exponential backoff; pending jobs are
recovered after backend restarts, and atomic leases prevent duplicate grading.
Permanent failures and exhausted retries remain mark-free and do not consume
academic attempts. Students cannot manually retry grading. An optional
assignment rubric can be configured per criterion; rubric maximums must add up
to the assignment's points. The workflow statuses are `Submitted`,
`AI Grading`, `AI Graded`, `AI Grading Failed`, `Re-evaluation Requested`,
`Human Review`, and `Final Result`.

Students can request one human re-evaluation after receiving AI marks. Main
Admins can review only those requests in the Reports & Analytics dashboard,
download the original submission, compare AI and human criterion marks, and
publish a final result. Human marks and feedback are stored separately from
the original AI evaluation. Routine submission approvals are disabled; the
legacy pending-approval endpoint returns no submissions, while `scope=all`
remains available as read-only history. The legacy admin evaluation-write
endpoint is also disabled; manual grading is limited to the requested-review
workflow.

Students may make up to three academically failed attempts in a rolling
24-hour window. A third failure locks new submissions until that window
expires; a passing result disables further submissions. Every attempt and its
AI evaluation remains in submission history, while unreadable files and other
AI grading failures remain retryable and do not count as academic failures.
Human re-evaluation requests store the student's selected reasons, an
explanation when “Other” is selected, and optional comments.

Assignment academic results use `(marks obtained / maximum marks) × 100`:
75% or higher is `Passed`, and anything lower is `Failed`. This result is stored
separately from the grading workflow status; completing AI grading does not
mean the student passed. AI and final human marks use the same threshold.

## Course certificates

When a student completes every required trackable lesson and assessment in an
enrolled course, including passing each required assignment, the learning API
stores one certificate record in MongoDB. A unique student/course index
prevents duplicate awards. Independent and college student records are scoped
separately; existing completions are not backfilled.

Main Admin progress reports read earned certificate records for each student.
Authenticated certificate documents are available at
`GET /api/certificates/:certificateId/view` and
`GET /api/certificates/:certificateId/download`; students can access only their
own certificates, while Main Admins can access certificates in reports.

## Google sign-in

Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `Server/.env`, and set the
matching `VITE_GOOGLE_CLIENT_ID` in `client/.env`. Keep the client secret only
on the backend. Configure the OAuth client with the frontend origin as an
authorized JavaScript origin and redirect URI.

The client sends the one-time authorization code and selected canonical role
to `POST /api/auth/google`. The API validates the request origin, exchanges the
code, verifies the ID token and verified email, then finds the existing
`accountidentities` mapping. Google sign-in never creates accounts.

Run the backend with `npm run dev`. For a separately hosted client, set
`VITE_API_BASE_URL` to the backend API base URL before starting or building the
client. The default local API base is `http://localhost:5000/api`.
