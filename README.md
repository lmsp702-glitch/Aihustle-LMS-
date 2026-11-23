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
