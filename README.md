# LMS-Platform
AIHustle Learning Management System with Main Admin, College Sub-Admin, and Student portals.

## Client

Run the client from the `client` directory:

```sh
npm install
npm run dev
```

To create a production build, run `npm run build` in the same directory

## Deploy to Vercel

Import the repository with the project root set to the repository root. The
root `vercel.json` builds the Vite client and sends `/api` requests to the
Express serverless function. Configure `MONGO_URI` and `JWT_SECRET` in the
Vercel project's environment variables. Set `CLIENT_ORIGIN` to the deployed
frontend origin and `VITE_API_URL` to `/api`; add the other server and client
environment variables required by the features you use.

Vercel serverless functions have request-size and execution limits. In
particular, course media uploads may exceed Vercel's request-size limit and
should be uploaded directly to a media provider or served from a separately
hosted backend.
