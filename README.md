# LMS-Platform

AIHustle Learning Management System with Main Admin, College Sub-Admin, and Student portals.

The repository contains the React frontend in `client/` and the Python Django REST API backend in `server/`.

## React frontend

Run the frontend from the `client/` directory:

```sh
cd client
npm install
npm run dev
```

Create a production build with:

```sh
npm run build
```

Frontend environment variables are not committed. Configure `VITE_API_URL` when deploying or connecting to a separate backend.

## Django REST API backend

Run the backend from the `server/` directory:

```powershell
cd server
python -m pip install -r requirements.txt
Copy-Item .env.example .env
python manage.py runserver
```

Configure `server/.env` with the Django secret key, MongoDB Atlas URI, database name, JWT settings, and frontend origins. Never commit `.env` or `.venv`.

The API health endpoint is `/api/health/`, the OpenAPI schema is `/api/schema/`, and Swagger UI is `/api/docs/`.

Run backend validation from `server/`:

```powershell
python manage.py check
python manage.py test
```

The backend uses PyMongo for MongoDB Atlas. Django ORM is not used for application data.

## Course video uploads

Course videos are uploaded sequentially from the browser to Cloudinary using a Django-issued signature, then verified by Django before lesson metadata is updated. Videos larger than 20 MiB are sent as ordered 20 MiB chunks with Cloudinary's range and unique-upload headers. Do not parallelize chunks or change the chunk size without measuring against the configured Cloudinary account.

The application currently accepts video files up to 2 GiB. This is only an application-side ceiling; Cloudinary account, plan, and API restrictions can impose a lower maximum size or duration. A prior account-usage inspection reported a 100 MiB video file limit; confirm the current limit in Cloudinary before relying on larger files. No one-hour duration allowance has been verified. The pending signed-upload record currently expires after 55 minutes, so the file transfer must finish within that verification window. The application does not guarantee one-hour or multi-gigabyte uploads, and does not compress or transcode videos. The browser reports per-chunk transfer and Cloudinary response timings in its console to support controlled performance measurements.

Manual lesson transcripts accept plain text or timestamped SRT cues. Timestamped text uses the existing `transcriptCues` data and synchronized Student Dashboard behavior; untimed text is stored in `transcriptText` and displayed without fabricated timestamps. Uploaded SRT files continue to use Cloudinary and the existing cue format.
