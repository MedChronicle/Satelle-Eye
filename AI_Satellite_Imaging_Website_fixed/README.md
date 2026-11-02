# AI Satellite Imaging Website

A React + TypeScript + Vite front-end for an AI-assisted satellite imaging and disaster-tracking dashboard.

![React](https://img.shields.io/badge/React-18.3-61dafb?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-6.3-646cff?logo=vite&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4.1-38bdf8?logo=tailwindcss&logoColor=white)

## Table of Contents

- [Tech Stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
- [Available Scripts](#available-scripts)
- [Project Structure](#project-structure)
- [Path Aliases](#path-aliases)
- [Environment Variables](#environment-variables)
- [Building for Production](#building-for-production)
- [Deploying](#deploying)
- [Notes](#notes)
- [Troubleshooting](#troubleshooting)

## Tech Stack

| Area | Tools |
| --- | --- |
| UI | React 18, TypeScript |
| Build | Vite 6 |
| Styling | Tailwind CSS 4, tw-animate-css |
| Animation and icons | motion, lucide-react |
| External services | OpenWeather, N2YO, Gemini |

## Prerequisites

- Node.js 20.19 or newer
- npm 10 or newer

Check your versions with:

```bash
node -v
npm -v
```

## Getting Started

```bash
npm install
npm run dev
```

Then open the local URL Vite prints (usually http://localhost:5173).

To test the site on your phone while developing, run the dev server on your network:

```bash
npm run dev:host
```

## Available Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Starts the development server |
| `npm run dev:host` | Starts the dev server and exposes it on your local network |
| `npm run build` | Creates a production build in `dist/` |
| `npm run build:check` | Type-checks, then creates a production build |
| `npm run preview` | Serves the production build locally |
| `npm run typecheck` | Runs TypeScript checking without building |
| `npm run clean` | Deletes the `dist/` folder |

## Project Structure

```text
.
├── public/                 Static files served as-is (favicon, social preview image)
├── src/
│   ├── app/                Application code
│   │   └── services/       API integrations (OpenWeather, N2YO, Gemini)
│   ├── assets/             Images and other bundled assets
│   ├── imports/            Large media such as the background video
│   └── main.tsx            Entry point
├── index.html              HTML template and SEO metadata
├── vite.config.ts          Vite configuration
├── tsconfig.json           TypeScript configuration
├── vercel.json             Vercel deployment settings
└── netlify.toml            Netlify deployment settings
```

## Path Aliases

Use these instead of long relative imports. They work in both Vite and TypeScript.

| Alias | Points to |
| --- | --- |
| `@/` | `src/app/` |
| `@assets/` | `src/assets/` |

Example:

```ts
import { something } from '@/services/example'
```

## Environment Variables

Vite only exposes variables that start with `VITE_`. Create a `.env.local` file in the project root (it should be listed in `.gitignore`):

```bash
VITE_PORT=5173
VITE_HOST=false
VITE_API_URL=
```

| Variable | Purpose | Default |
| --- | --- | --- |
| `VITE_PORT` | Dev server port | `5173` |
| `VITE_HOST` | Set to `true` to expose the dev server on your network | `false` |
| `VITE_API_URL` | If set, requests to `/api` are proxied to this URL in dev | not set |

## Building for Production

```bash
npm run build
```

Output goes to `dist/`. Preview it locally with `npm run preview`.

The production build removes `console` and `debugger` calls, splits vendor libraries into separate cached chunks, and writes hashed filenames into organized folders under `dist/assets/`.

## Deploying

Use one host. You can delete the other host's config file.

### Vercel

Import the repo at vercel.com/new. Vercel auto-detects Vite. The included `vercel.json` sets the build command, output directory, SPA rewrite rule, caching rules, and security headers, so no manual configuration is needed.

Because the config uses `npm ci`, make sure `package-lock.json` is committed.

### Netlify

Import the repo at app.netlify.com. The included `netlify.toml` sets the build command, publish directory, Node version, SPA redirect, caching rules, and security headers.

## Notes

### Background video

The background video lives at `src/imports/space-background.mp4`. If you swap it out:

- Keep it muted-friendly. It always plays muted, so no audio is needed.
- Re-encode it with `-movflags +faststart` so browsers can start playing it before the whole file downloads:

```bash
ffmpeg -i input.mp4 -movflags +faststart -an -c:v libx264 -crf 28 space-background.mp4
```

### Social preview and icons

Add these files to `public/` so link previews and tab icons work:

- `favicon.svg`
- `apple-touch-icon.png` (180x180)
- `og-image.png` (about 1200x630)

### API keys and security

API keys for OpenWeather, N2YO, and Gemini are hardcoded directly inside the files in `src/app/services/`. That's fine for a class project, but this is a client-side app, so anyone can read those keys in the deployed JavaScript bundle (view-source or devtools).

Until you move the keys, follow these rules:

- Swap in your own keys before sharing the repo publicly.
- Never reuse keys tied to a paid account.
- Set usage limits and quotas in each provider's dashboard.
- Restrict keys by HTTP referrer where the provider supports it.

Moving keys into `VITE_` variables keeps them out of your Git history, but they still end up in the built bundle. To keep a key truly secret, call the API through a serverless function (Vercel Functions or Netlify Functions) that holds the key on the server, and have the front-end call your function instead.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Build fails with a Node version error | Upgrade to Node 20.19 or newer |
| `npm ci` fails on Vercel | Commit `package-lock.json` (run `npm install` once locally to create it) |
| Blank page after deploy | Check the browser console, then confirm the host serves `dist/` |
| 404 on refresh at a sub-route | Make sure `vercel.json` or `netlify.toml` is in the repo root |
| Type errors on `npm run build:check` | Run `npm run typecheck` and fix the reported files |
| Favicon or preview image missing | Add the files listed under "Social preview and icons" to `public/` |
